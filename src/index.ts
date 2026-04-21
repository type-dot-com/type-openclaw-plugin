/**
 * OpenClaw Type Channel Plugin
 *
 * Registers a Type channel with OpenClaw, enabling bidirectional
 * communication via duplex WebSocket connections.
 *
 * Supports multiple accounts (following the Discord/Telegram pattern),
 * where each account maintains its own WebSocket connection to a
 * different Type agent.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { setPluginRuntime } from "./accountState.js";
import { agentTools } from "./agentTools.js";
import { fetchChannelsCached } from "./channels.js";
import { inspectAccount, listAccountIds, resolveAccount } from "./config.js";
import { startAccount } from "./gateway.js";
import type { PluginRuntime } from "./messageHandler.js";
import { sendMediaToType, sendTextToType } from "./outbound.js";
import {
  isLikelyTypeTargetId,
  normalizeTypeTarget,
} from "./targetNormalization.js";

const TYPE_MESSAGE_ACTIONS: ReadonlySet<string> = new Set([
  "send",
  "reply",
  "thread-reply",
]);

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
    media: true,
    reactions: false,
    threads: true,
  },

  config: {
    listAccountIds: (cfg: Record<string, unknown>) => listAccountIds(cfg),
    resolveAccount: (cfg: Record<string, unknown>, accountId?: string) =>
      resolveAccount(cfg, accountId),
    inspectAccount: (cfg: Record<string, unknown>, accountId?: string) =>
      inspectAccount(cfg, accountId),
    isConfigured: (
      account: { token?: string },
      _cfg: Record<string, unknown>,
    ): boolean => Boolean(account.token),
  },

  security: {
    dm: {
      channelKey: "type",
      resolvePolicy: (account: { ownerAllowFrom?: readonly string[] }) =>
        account.ownerAllowFrom && account.ownerAllowFrom.length > 0
          ? ("allowlist" as const)
          : ("open" as const),
      resolveAllowFrom: (account: { ownerAllowFrom?: readonly string[] }) =>
        account.ownerAllowFrom ? [...account.ownerAllowFrom] : [],
      defaultPolicy: "open" as const,
    },
  },

  threading: {
    topLevelReplyToMode: "thread" as const,
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
        const normalizedInput = normalizeTypeTarget(input);
        const normalized = normalizedInput.startsWith("#")
          ? normalizedInput.slice(1)
          : normalizedInput;
        const match =
          byId.get(normalizedInput) ??
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

  messaging: {
    normalizeTarget: (raw: string): string => normalizeTypeTarget(raw),
    targetResolver: {
      hint: "Use the `target_channel_id` field (`ch_*`) as `to`. To reply in a thread, set `replyToId` to the `target_thread_id` field (`msg_*`). Never use channel names as targets.",
      looksLikeId: (raw: string, normalized: string): boolean =>
        isLikelyTypeTargetId(raw) || isLikelyTypeTargetId(normalized),
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
      const normalizedTo = to ? normalizeTypeTarget(to) : "";
      if (!normalizedTo) {
        return { ok: false, error: "Target channel ID is required" };
      }
      return { ok: true, to: normalizedTo };
    },

    sendText: (params: Parameters<typeof sendTextToType>[0]) =>
      sendTextToType(params),
    sendMedia: (params: Parameters<typeof sendMediaToType>[0]) =>
      sendMediaToType(params),
  },

  actions: {
    supportsAction: ({ action }: { action: string }): boolean =>
      TYPE_MESSAGE_ACTIONS.has(action),

    describeMessageTool: (): {
      actions: string[];
      capabilities: string[];
    } => ({
      actions: [...TYPE_MESSAGE_ACTIONS],
      capabilities: [],
    }),

    handleAction: async (ctx: {
      action: string;
      params: Record<string, unknown>;
      cfg?: Record<string, unknown>;
      accountId?: string | null;
    }): Promise<{ details: unknown }> => {
      const readStr = (value: unknown): string | undefined =>
        typeof value === "string" && value.trim().length > 0
          ? value.trim()
          : undefined;

      const to =
        readStr(ctx.params.to) ??
        readStr(ctx.params.channelId) ??
        readStr(ctx.params.target);
      if (!to) {
        return {
          details: {
            ok: false,
            error: "Type message action requires a channel target",
          },
        };
      }

      const text =
        readStr(ctx.params.message) ??
        readStr(ctx.params.text) ??
        readStr(ctx.params.content) ??
        "";

      const replyToId =
        readStr(ctx.params.replyTo) ??
        readStr(ctx.params.threadId) ??
        readStr(ctx.params.parentId) ??
        readStr(ctx.params.parentMessageId);

      const result = await sendTextToType({
        to,
        text,
        replyToId,
        accountId: ctx.accountId ?? null,
        cfg: ctx.cfg,
      });
      return { details: result };
    },
  },

  agentTools,

  gateway: {
    startAccount,
  },
};

// Structural interface so the emitted .d.ts doesn't reference the SDK's
// internal `DefinedChannelPluginEntry` type alias (which isn't exported).
interface TypeChannelEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly register: (...args: never[]) => void;
  readonly channelPlugin: typeof typePlugin;
  readonly configSchema: unknown;
  readonly setChannelRuntime?: (runtime: PluginRuntime) => void;
}

const typeChannelEntry: TypeChannelEntry = defineChannelPluginEntry({
  id: "type",
  name: "Type",
  description: "Type team chat integration via duplex WebSocket",
  plugin: typePlugin,
  setRuntime: setPluginRuntime,
});

export default typeChannelEntry;

export type { TypeAccountConfig } from "./config.js";
// Re-export components for advanced usage
export { TypeConnection } from "./connection.js";
export { TypeOutboundHandler } from "./outbound.js";
export type {
  TypeInboundEvent,
  TypeMessageEvent,
  TypeOutboundMessage,
} from "./protocol.js";
