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
import {
  handleInboundMessage,
  type PluginRuntime,
  rejectStreamAck,
  resolveStreamAck,
} from "./messageHandler.js";
import { TypeOutboundHandler } from "./outbound.js";

// Module-level runtime reference (set during register, used in gateway)
let pluginRuntime: PluginRuntime | null = null;
let _activeConnection: TypeConnection | null = null;
let activeOutbound: TypeOutboundHandler | null = null;
let connectionState: "disconnected" | "connecting" | "connected" =
  "disconnected";

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
    chatTypes: ["direct", "channel", "thread"] satisfies readonly string[],
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
    deliveryMode: "direct" satisfies string,
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
      const sent = activeOutbound.sendMessage(to, text, replyToId);
      if (!sent) {
        return { ok: false, error: "Failed to send message" };
      }
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

      const connection = new TypeConnection({
        token,
        wsUrl,
        onMessage: (event) => {
          if (event.type === "success") {
            const reqType = (event as { requestType?: string }).requestType;
            console.log(`[type] Server success: ${reqType}`);
            if (reqType === "stream_start") {
              const messageId =
                "messageId" in event && typeof event.messageId === "string"
                  ? event.messageId
                  : undefined;
              resolveStreamAck(messageId);
            }
            return;
          }
          if (event.type === "error") {
            const errEvt = event as {
              requestType?: string;
              error?: string;
              details?: unknown;
              messageId?: string;
            };
            console.error(
              `[type] Server error: ${errEvt.requestType} — ${errEvt.error}`,
              errEvt.details ?? "",
            );
            if (errEvt.requestType === "stream_start") {
              rejectStreamAck(
                new Error(errEvt.error ?? "stream_start failed"),
                errEvt.messageId,
              );
            }
            return;
          }

          if (event.type !== "message") return;
          if (!activeOutbound) return;

          handleInboundMessage({
            msg: event,
            accountId,
            cfg: ctx.cfg,
            runtime,
            outbound: activeOutbound,
            log: ctx.log,
          });
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

export type { TypeAccountConfig } from "./config.js";
// Re-export components for advanced usage
export { TypeConnection } from "./connection.js";
export { TypeOutboundHandler } from "./outbound.js";
export type {
  TypeInboundEvent,
  TypeMessageEvent,
  TypeOutboundMessage,
} from "./protocol.js";
