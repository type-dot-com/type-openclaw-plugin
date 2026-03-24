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

  agentTools,

  gateway: {
    startAccount,
  },
};

export default {
  id: "type",
  name: "Type",
  description: "Type team chat integration via duplex WebSocket",
  register(api: {
    runtime: PluginRuntime;
    registerChannel: (opts: { plugin: typeof typePlugin }) => void;
  }) {
    setPluginRuntime(api.runtime);
    api.registerChannel({ plugin: typePlugin });
  },
};

export type { TypeAccountConfig } from "./config.js";
// Re-export components for advanced usage
export { TypeConnection } from "./connection.js";
export { TypeOutboundHandler } from "./outbound.js";
export type {
  TypeInboundEvent,
  TypeMessageEvent,
  TypeOutboundMessage,
} from "./protocol.js";
