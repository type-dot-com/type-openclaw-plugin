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

            // Lazy stream_start: don't send until the first onPartialReply
            // fires (i.e., actual text is being generated). This avoids the
            // 30s idle timeout when the agent spends time on tool calls.
            //
            // Since onPartialReply is synchronous, we buffer deltas until
            // the stream_start ack arrives, then flush them.
            let streamFailed = false;
            let streamStarted = false;
            let streamReady = false;
            let lastSentLength = 0;

            // Buffers waiting on stream_start ack
            const pendingTokens: string[] = [];
            const pendingToolEvents: Array<{
              kind: string;
              [key: string]: unknown;
            }> = [];

            const startStreamAndFlush = () => {
              if (!activeOutbound) return;
              const started = activeOutbound.startStream(msg.messageId);
              if (!started) {
                console.error(
                  "[type] startStream send failed (connection not open)",
                );
                streamFailed = true;
                return;
              }
              streamStarted = true;

              // When ack arrives, flush buffered events
              let ackTimeoutId: ReturnType<typeof setTimeout> | null = null;
              pendingStreamStart = {
                resolve: () => {
                  if (ackTimeoutId) {
                    clearTimeout(ackTimeoutId);
                    ackTimeoutId = null;
                  }
                  streamReady = true;
                  // Flush tool events first (they came before text)
                  for (const evt of pendingToolEvents) {
                    if (streamFailed || !activeOutbound) break;
                    activeOutbound.streamEvent(msg.messageId, evt);
                  }
                  pendingToolEvents.length = 0;
                  // Then flush text tokens
                  for (const text of pendingTokens) {
                    if (streamFailed || !activeOutbound) break;
                    const sent = activeOutbound.streamToken(
                      msg.messageId,
                      text,
                    );
                    if (!sent) {
                      console.error(
                        "[type] streamToken send failed (connection not open)",
                      );
                      streamFailed = true;
                    }
                  }
                  pendingTokens.length = 0;
                },
                reject: (err: Error) => {
                  if (ackTimeoutId) {
                    clearTimeout(ackTimeoutId);
                    ackTimeoutId = null;
                  }
                  console.error(`[type] stream_start rejected: ${err.message}`);
                  streamFailed = true;
                  pendingTokens.length = 0;
                  pendingToolEvents.length = 0;
                },
              };
              // Timeout after 5s in case server never responds
              ackTimeoutId = setTimeout(() => {
                ackTimeoutId = null;
                if (pendingStreamStart) {
                  pendingStreamStart.reject(
                    new Error("stream_start ack timeout"),
                  );
                  pendingStreamStart = null;
                }
              }, 5000);
            };

            // Dispatch with onPartialReply for token-level streaming.
            // onPartialReply fires with accumulated text as the model
            // generates; we compute the delta and send/buffer it.
            void runtime.channel.reply
              .dispatchReplyWithBufferedBlockDispatcher({
                ctx: ctxPayload,
                cfg: ctx.cfg,
                dispatcherOptions: {
                  deliver: async (
                    payload: { text?: string },
                    info: Record<string, unknown>,
                  ) => {
                    // Handle tool results as native tool-call + tool-result
                    // stream events so they render as collapsible cards in
                    // Type's UI (matching how internal agents show tools).
                    if (info.kind === "tool" && payload.text) {
                      if (!activeOutbound || streamFailed) return;

                      // Start stream if not started
                      if (!streamStarted) {
                        startStreamAndFlush();
                      }
                      if (streamFailed) return;

                      // Parse tool name from the formatted text.
                      // Format is typically: "📚 Read: /path/to/file" or
                      // "🧪 Exec: command here\noutput..."
                      const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                      const textContent = payload.text.trim();
                      // Strip leading emoji (1-2 chars + space)
                      const stripped = textContent.replace(
                        /^(?:\p{Emoji}|\uFE0F|\u200D)+\s*/u,
                        "",
                      );
                      // Tool name is everything before the first ":"
                      const colonIdx = stripped.indexOf(":");
                      const toolName =
                        colonIdx > 0
                          ? stripped.slice(0, colonIdx).trim()
                          : "tool";
                      const toolOutput =
                        colonIdx > 0
                          ? stripped.slice(colonIdx + 1).trim()
                          : stripped;

                      const sendToolEvent = (event: {
                        kind: string;
                        [key: string]: unknown;
                      }) => {
                        if (streamReady && activeOutbound) {
                          activeOutbound.streamEvent(msg.messageId, event);
                        } else {
                          // Buffer as a special marker for flush
                          pendingToolEvents.push(event);
                        }
                      };

                      // Send tool-call (running) then tool-result (completed)
                      // back-to-back. Server processes sequentially so the
                      // status transitions running → completed immediately.
                      sendToolEvent({
                        kind: "tool-call",
                        toolCallId,
                        toolName,
                        input: toolOutput
                          ? { command: toolOutput.split("\n")[0] }
                          : {},
                      });
                      sendToolEvent({
                        kind: "tool-result",
                        toolCallId,
                        toolName,
                        outcomes: [
                          { kind: "text", toolName, text: toolOutput },
                        ],
                      });
                    }
                    // Other kinds (block, final) are no-op - onPartialReply handles text streaming
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
                  onPartialReply: (payload: { text?: string }) => {
                    if (!payload.text || !activeOutbound || streamFailed)
                      return;
                    const delta = payload.text.slice(lastSentLength);
                    if (delta.length === 0) return;
                    lastSentLength = payload.text.length;

                    // First activity: kick off stream_start
                    if (!streamStarted) {
                      startStreamAndFlush();
                    }

                    if (streamFailed) return;

                    if (streamReady) {
                      // Ack already received — send directly
                      const sent = activeOutbound.streamToken(
                        msg.messageId,
                        delta,
                      );
                      if (!sent) {
                        console.error(
                          "[type] streamToken send failed (connection not open)",
                        );
                        streamFailed = true;
                      }
                    } else {
                      // Still waiting for ack — buffer
                      pendingTokens.push(delta);
                    }
                  },
                  // Note: onToolResult is overwritten by dispatch-from-config.js,
                  // so tool results come through the deliver callback instead.
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
