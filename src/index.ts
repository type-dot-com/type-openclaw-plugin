/**
 * OpenClaw Type Channel Plugin
 *
 * Registers a Type channel with OpenClaw, enabling bidirectional
 * communication via a single duplex WebSocket connection.
 *
 * Follows the same pattern as openclaw-mqtt: stores api.runtime at
 * registration time, then uses runtime.channel.reply.* to dispatch
 * inbound messages through the standard OpenClaw agent pipeline.
 */

import { listAccountIds, resolveAccount } from "./config.js";
import { TypeConnection } from "./connection.js";
import { TypeOutboundHandler } from "./outbound.js";
import type { TypeMessageEvent } from "./protocol.js";

// Module-level runtime reference (set during register, used in gateway)
let pluginRuntime: PluginRuntime | null = null;
let _activeConnection: TypeConnection | null = null;
let activeOutbound: TypeOutboundHandler | null = null;
let connectionState: "disconnected" | "connecting" | "connected" =
  "disconnected";

// Minimal typing for the OpenClaw plugin SDK runtime
interface PluginRuntime {
  channel: {
    reply: {
      finalizeInboundContext: (
        ctx: Record<string, unknown>,
      ) => Record<string, unknown>;
      dispatchReplyWithBufferedBlockDispatcher: (opts: {
        ctx: Record<string, unknown>;
        cfg: Record<string, unknown>;
        dispatcherOptions: {
          deliver: (
            payload: { text?: string },
            info: Record<string, unknown>,
          ) => Promise<void>;
          onSkip?: (payload: unknown, info: Record<string, unknown>) => void;
          onError?: (err: unknown, info: Record<string, unknown>) => void;
        };
        replyOptions?: Record<string, unknown>;
      }) => Promise<void>;
    };
  };
}

const typePlugin = {
  id: "type",
  meta: {
    id: "type",
    label: "Type",
    selectionLabel: "Type (Team Chat)",
    docsPath: "/channels/type",
    blurb: "Type team chat integration via WebSocket.",
  },

  capabilities: {
    chatTypes: ["direct", "channel", "thread"] as const,
    media: false,
    reactions: false,
    threads: true,
  },

  config: {
    listAccountIds: (cfg: Record<string, unknown>) => listAccountIds(cfg),
    resolveAccount: (cfg: Record<string, unknown>, accountId?: string) =>
      resolveAccount(cfg, accountId),
  },

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,

    sendText: async ({
      to,
      text,
      replyToId,
    }: {
      to: string;
      text: string;
      replyToId?: string;
    }) => {
      if (!activeOutbound) {
        return { ok: false, error: "Not connected" };
      }
      activeOutbound.sendMessage(to, text, replyToId);
      return { ok: true, channel: "type" };
    },
  },

  gateway: {
    startAccount: async (ctx: {
      cfg: Record<string, unknown>;
      accountId: string;
      account: { token: string; wsUrl: string };
      runtime: PluginRuntime;
      abortSignal: AbortSignal;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }) => {
      // Guard against duplicate or racing startAccount calls
      if (connectionState !== "disconnected") {
        ctx.log?.info(
          `Type connection already ${connectionState}, skipping duplicate startAccount`,
        );
        return;
      }
      connectionState = "connecting";

      const runtime = pluginRuntime ?? ctx.runtime;
      const { token, wsUrl } = ctx.account;
      const accountId = ctx.accountId;

      // Gate for awaiting stream_start ack before sending stream_event.
      // Only one stream is active at a time per connection, so a single
      // pending promise is sufficient.
      let pendingStreamStart: {
        resolve: () => void;
        reject: (err: Error) => void;
      } | null = null;

      const connection = new TypeConnection({
        token,
        wsUrl,
        onMessage: (event) => {
          // Handle server success/error responses
          if (event.type === "success") {
            const reqType = (event as { requestType?: string }).requestType;
            console.log(`[type] Server success: ${reqType}`);
            if (reqType === "stream_start" && pendingStreamStart) {
              pendingStreamStart.resolve();
              pendingStreamStart = null;
            }
            return;
          }
          if (event.type === "error") {
            const errEvt = event as {
              requestType?: string;
              error?: string;
              details?: unknown;
            };
            console.error(
              `[type] Server error: ${errEvt.requestType} — ${errEvt.error}`,
              errEvt.details ?? "",
            );
            if (errEvt.requestType === "stream_start" && pendingStreamStart) {
              pendingStreamStart.reject(
                new Error(errEvt.error ?? "stream_start failed"),
              );
              pendingStreamStart = null;
            }
            return;
          }

          if (event.type !== "message") return;

          const msg = event as TypeMessageEvent;
          ctx.log?.info(
            `[type] Inbound message from ${msg.sender?.name ?? "unknown"} in ${msg.channelName ?? msg.channelId}`,
          );

          try {
            const chatType = msg.parentMessageId ? "thread" : "channel";
            const senderId = msg.sender?.id ?? "unknown";
            const senderName = msg.sender?.name ?? "Unknown";
            const messageBody = msg.content ?? "";

            // Build the inbound context using OpenClaw's standard pipeline
            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
              Body: messageBody,
              RawBody: messageBody,
              CommandBody: messageBody,
              CommandAuthorized: true,
              From: `type:${senderId}`,
              To: `type:${accountId}`,
              SessionKey: msg.parentMessageId
                ? `agent:main:type:${msg.parentMessageId}`
                : `agent:main:type:${msg.channelId}:${msg.messageId}`,
              AccountId: accountId,
              ChatType: chatType,
              ConversationLabel: msg.channelName ?? msg.channelId,
              SenderName: senderName,
              SenderId: senderId,
              Provider: "type",
              Surface: "type",
              MessageSid: msg.messageId,
              Timestamp: msg.timestamp,
            });

            // Dispatch through the standard agent reply pipeline with block-level streaming.
            // deliver is called per text block as the agent generates, enabling
            // progressive delivery. Each block is streamed to Type as a token event.
            //
            // IMPORTANT: stream_start must be acked by the server before sending
            // stream_event, because the server does async DB validation before
            // creating the stream state. Without this gate, stream_event arrives
            // before the state exists and gets rejected.
            let streamStarted = false;
            let streamFailed = false;
            let streamReady: Promise<void> | null = null;
            void runtime.channel.reply
              .dispatchReplyWithBufferedBlockDispatcher({
                ctx: ctxPayload,
                cfg: ctx.cfg,
                dispatcherOptions: {
                  deliver: async (payload) => {
                    if (!payload.text || !activeOutbound || streamFailed)
                      return;
                    console.log(
                      `[type] deliver: streamStarted=${streamStarted}, textLen=${payload.text.length}`,
                    );
                    if (!streamStarted) {
                      // Create a promise that resolves when server acks stream_start
                      streamReady = new Promise<void>((resolve, reject) => {
                        pendingStreamStart = { resolve, reject };
                        // Timeout after 5s in case server never responds
                        setTimeout(() => {
                          if (pendingStreamStart) {
                            pendingStreamStart.reject(
                              new Error("stream_start ack timeout"),
                            );
                            pendingStreamStart = null;
                          }
                        }, 5000);
                      });
                      const started = activeOutbound.startStream(msg.messageId);
                      if (!started) {
                        console.error(
                          "[type] startStream send failed (connection not open)",
                        );
                        streamFailed = true;
                        pendingStreamStart = null;
                        return;
                      }
                      streamStarted = true;
                    }
                    // Wait for server to ack stream_start before sending tokens
                    try {
                      await streamReady;
                    } catch (err) {
                      console.error(
                        `[type] stream_start rejected: ${err instanceof Error ? err.message : String(err)}`,
                      );
                      streamFailed = true;
                      return;
                    }
                    const sent = activeOutbound.streamToken(
                      msg.messageId,
                      payload.text,
                    );
                    if (!sent) {
                      console.error(
                        "[type] streamToken send failed (connection not open)",
                      );
                      streamFailed = true;
                    }
                  },
                  onSkip: (_payload, info) => {
                    console.log(
                      `[type] Reply skipped: ${JSON.stringify(info)}`,
                    );
                  },
                  onError: (err, info) => {
                    console.error(
                      `[type] Reply error: ${err} ${JSON.stringify(info)}`,
                    );
                  },
                },
                replyOptions: {
                  disableBlockStreaming: false,
                },
              })
              .then(() => {
                if (streamStarted && activeOutbound) {
                  const finished = activeOutbound.finishStream(msg.messageId);
                  if (!finished) {
                    console.error(
                      "[type] finishStream send failed (connection not open), stream will idle-timeout on server",
                    );
                  }
                }
              })
              .catch((err: unknown) => {
                console.error(
                  `[type] Stream dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                if (streamStarted && activeOutbound) {
                  const finished = activeOutbound.finishStream(msg.messageId);
                  if (!finished) {
                    console.error(
                      "[type] finishStream send failed after dispatch error, stream will idle-timeout on server",
                    );
                  }
                }
              });
          } catch (err) {
            ctx.log?.error(
              `[type] Message dispatch error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        onConnected: () => {
          connectionState = "connected";
          ctx.log?.info("[type] WebSocket connected");
        },
        onDisconnected: () => {
          connectionState = "disconnected";
          ctx.log?.info("[type] WebSocket disconnected");
        },
      });

      _activeConnection = connection;
      activeOutbound = new TypeOutboundHandler(connection);

      connection.connect();

      // Wait for abort signal, then clean up
      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => {
          connectionState = "disconnected";
          connection.disconnect();
          _activeConnection = null;
          activeOutbound = null;
          resolve();
        });
      });
    },
  },
};

/**
 * OpenClaw plugin entry point.
 * Follows the object-with-register pattern from openclaw/plugin-sdk.
 */
const plugin = {
  id: "type",
  name: "Type",
  description: "Type team chat integration via duplex WebSocket",
  register(api: {
    runtime: PluginRuntime;
    registerChannel: (opts: { plugin: typeof typePlugin }) => void;
  }) {
    pluginRuntime = api.runtime;
    api.registerChannel({ plugin: typePlugin });
  },
};

export default plugin;

export type { TypeAccountConfig, TypeChannelConfig } from "./config.js";
// Re-export components for advanced usage
export { TypeConnection } from "./connection.js";
export { TypeOutboundHandler } from "./outbound.js";
export type {
  TypeInboundEvent,
  TypeMessageEvent,
  TypeOutboundMessage,
} from "./protocol.js";
