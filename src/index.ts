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

import { fetchChannelsCached, resolveChannelId } from "./channels.js";
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
    isConfigured: (
      account: { token?: string },
      _cfg: Record<string, unknown>,
    ): boolean => Boolean(account.token),
  },

  directory: {
    listGroups: async ({
      cfg,
      accountId,
      query,
      limit,
    }: {
      cfg: Record<string, unknown>;
      accountId?: string | null;
      query?: string;
      limit?: number;
      runtime?: unknown;
    }): Promise<
      { id: string; name: string; kind: "group"; description?: string }[]
    > => {
      const account = resolveAccount(cfg, accountId ?? undefined);
      if (!account.token) return [];
      let channels: Awaited<ReturnType<typeof fetchChannelsCached>>;
      try {
        channels = await fetchChannelsCached(account);
      } catch {
        return [];
      }
      if (query) {
        const q = query.toLowerCase();
        channels = channels.filter(
          (ch) =>
            ch.name.toLowerCase().includes(q) ||
            (ch.description ?? "").toLowerCase().includes(q),
        );
      }
      if (limit !== undefined && limit > 0) {
        channels = channels.slice(0, limit);
      }
      return channels.map((ch) => ({
        id: ch.id,
        name: ch.name,
        kind: "group" as const,
        description: ch.description ?? undefined,
      }));
    },
  },

  resolver: {
    resolveTargets: async ({
      cfg,
      accountId,
      inputs,
      kind,
    }: {
      cfg: Record<string, unknown>;
      accountId?: string | null;
      inputs: string[];
      kind?: "user" | "group";
      runtime?: unknown;
    }): Promise<
      {
        input: string;
        resolved: boolean;
        id?: string;
        name?: string;
        kind?: "group";
      }[]
    > => {
      if (kind === "user") {
        return inputs.map((input) => ({ input, resolved: false }));
      }
      const account = resolveAccount(cfg, accountId ?? undefined);
      if (!account.token) {
        return inputs.map((input) => ({ input, resolved: false }));
      }
      let channels: Awaited<ReturnType<typeof fetchChannelsCached>>;
      try {
        channels = await fetchChannelsCached(account);
      } catch {
        return inputs.map((input) => ({ input, resolved: false }));
      }
      const byId = new Map(channels.map((ch) => [ch.id, ch]));

      return inputs.map((input) => {
        const normalized = input.startsWith("#") ? input.slice(1) : input;
        const match =
          byId.get(input) ??
          channels.find(
            (ch) => ch.name.toLowerCase() === normalized.toLowerCase(),
          );
        if (!match) return { input, resolved: false };
        return {
          input,
          resolved: true,
          id: match.id,
          name: match.name,
          kind: "group" as const,
        };
      });
    },
  },

  outbound: {
    deliveryMode: "direct" satisfies string,
    textChunkLimit: 4000,

    resolveTarget: ({
      to,
    }: {
      cfg?: Record<string, unknown>;
      to?: string;
      allowFrom?: string[];
      accountId?: string | null;
      mode?: string;
    }): { ok: true; to: string } | { ok: false; error: string } => {
      if (!to) {
        return { ok: false, error: "Target channel ID is required" };
      }
      return { ok: true, to };
    },

    sendText: async ({
      to,
      text,
      replyToId,
      cfg,
      accountId,
    }: {
      to: string;
      text: string;
      replyToId?: string;
      cfg?: Record<string, unknown>;
      accountId?: string | null;
    }): Promise<
      { ok: true; channel: string } | { ok: false; error: string }
    > => {
      if (!activeOutbound) {
        return { ok: false, error: "Not connected" };
      }
      try {
        const account = resolveAccount(cfg ?? {}, accountId ?? undefined);
        const channelId = await resolveChannelId(to, account);
        const sent = activeOutbound.sendMessage(channelId, text, replyToId);
        if (!sent) {
          return { ok: false, error: "Failed to send message" };
        }
        return { ok: true, channel: "type" };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    sendMedia: async ({
      to,
      text,
      mediaUrl,
      replyToId,
      cfg,
      accountId,
    }: {
      to: string;
      text: string;
      mediaUrl: string;
      replyToId?: string;
      cfg?: Record<string, unknown>;
      accountId?: string | null;
    }): Promise<
      { ok: true; channel: string } | { ok: false; error: string }
    > => {
      if (!activeOutbound) {
        return { ok: false, error: "Not connected" };
      }
      try {
        const account = resolveAccount(cfg ?? {}, accountId ?? undefined);
        const channelId = await resolveChannelId(to, account);
        const caption = text || `[Media: ${mediaUrl}]`;
        const sent = activeOutbound.sendMessage(channelId, caption, replyToId);
        if (!sent) {
          return { ok: false, error: "Failed to send message" };
        }
        return { ok: true, channel: "type" };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
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
