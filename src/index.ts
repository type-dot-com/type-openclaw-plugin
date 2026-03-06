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

import path from "node:path";
import {
  clearAccountState,
  getAccountContextForAccount,
  getAccountState,
  getOutboundForAccount,
  getPluginRuntime,
  resolveEffectiveAccountId,
  setPluginRuntime,
} from "./accountState.js";
import { agentTools } from "./agentTools.js";
import { fetchChannelsCached, resolveChannelId } from "./channels.js";
import {
  DEFAULT_TYPE_WS_URL,
  listAccountIds,
  resolveAccount,
} from "./config.js";
import { TypeConnection } from "./connection.js";
import { uploadMediaForType } from "./mediaUpload.js";
import {
  failStreamSession,
  failStreamSessionsForAccount,
  handleInboundMessage,
  type PluginRuntime,
  pauseStreamSessionsForAccount,
  rejectStreamAck,
  resolveStreamAck,
  resumeStreamSessionsForAccount,
} from "./messageHandler.js";
import { TypeOutboundHandler } from "./outbound.js";
import {
  isLikelyTypeTargetId,
  normalizeTypeTarget,
} from "./targetNormalization.js";
import {
  captureException,
  initializeTelemetry,
  teardownTelemetry,
} from "./telemetry.js";

const STREAM_ALREADY_ACTIVE_ERROR = "Stream already active for this message";

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveEffectiveMediaLocalRoots(params: {
  configuredRoots: readonly string[];
  requestedRoots?: readonly string[];
}): readonly string[] | undefined {
  const normalizeRoots = (roots: readonly string[]): string[] =>
    Array.from(new Set(roots.map((root) => path.resolve(root))));

  const configuredRoots =
    params.configuredRoots.length > 0
      ? normalizeRoots(params.configuredRoots)
      : [];
  const requestedRoots =
    params.requestedRoots && params.requestedRoots.length > 0
      ? normalizeRoots(params.requestedRoots)
      : [];

  if (configuredRoots.length === 0) {
    return requestedRoots.length > 0 ? requestedRoots : undefined;
  }
  if (requestedRoots.length === 0) {
    return configuredRoots;
  }

  const intersection = new Set<string>();
  for (const configuredRoot of configuredRoots) {
    for (const requestedRoot of requestedRoots) {
      if (isPathWithinRoot(configuredRoot, requestedRoot)) {
        intersection.add(configuredRoot);
      } else if (isPathWithinRoot(requestedRoot, configuredRoot)) {
        intersection.add(requestedRoot);
      }
    }
  }

  if (intersection.size === 0) {
    throw new Error(
      "Requested mediaLocalRoots do not overlap with configured channels.type.mediaLocalRoots",
    );
  }

  return Array.from(intersection);
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
    chatTypes: ["direct", "channel", "thread"] satisfies readonly string[],
    media: true,
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
      hint: "Use a Type target id (for example `ch_*` or `agsess_*`).",
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
      const effectiveAccountId = resolveEffectiveAccountId(accountId);
      const outbound = getOutboundForAccount(effectiveAccountId);
      if (!outbound) {
        return { ok: false, error: "Not connected" };
      }
      try {
        const account = resolveAccount(cfg ?? {}, effectiveAccountId);
        const channelId = await resolveChannelId(to, account);
        const sent = outbound.sendMessage(channelId, text, replyToId);
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
      mediaLocalRoots,
      replyToId,
      cfg,
      accountId,
    }: {
      to: string;
      text: string;
      mediaUrl: string;
      mediaLocalRoots?: readonly string[];
      replyToId?: string;
      cfg?: Record<string, unknown>;
      accountId?: string | null;
    }): Promise<
      { ok: true; channel: string } | { ok: false; error: string }
    > => {
      const effectiveAccountId = resolveEffectiveAccountId(accountId);
      const outbound = getOutboundForAccount(effectiveAccountId);
      if (!outbound) {
        return { ok: false, error: "Not connected" };
      }
      try {
        const account = resolveAccount(cfg ?? {}, effectiveAccountId);
        const accountContext = getAccountContextForAccount(effectiveAccountId);
        const resolvedWsUrl =
          account.wsUrl === DEFAULT_TYPE_WS_URL && accountContext?.wsUrl
            ? accountContext.wsUrl
            : account.wsUrl;
        const uploadAccount = {
          token: account.token || accountContext?.token || "",
          wsUrl: resolvedWsUrl,
          agentId: account.agentId || accountContext?.agentId || "",
        };
        const effectiveMediaLocalRoots = resolveEffectiveMediaLocalRoots({
          configuredRoots: account.mediaLocalRoots,
          requestedRoots: mediaLocalRoots,
        });
        const channelId = await resolveChannelId(to, account);

        const uploadedMedia = await uploadMediaForType({
          mediaUrl,
          mediaLocalRoots: effectiveMediaLocalRoots,
          channelId,
          account: uploadAccount,
        });

        const caption = text.trim().length > 0 ? text : "Sent an attachment.";
        const sent = outbound.sendMessage(channelId, caption, replyToId, [
          uploadedMedia.fileId,
        ]);
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

  agentTools,

  gateway: {
    startAccount: async (ctx: {
      cfg: Record<string, unknown>;
      accountId: string;
      account: { token: string; wsUrl: string };
      runtime: PluginRuntime;
      abortSignal: AbortSignal;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }) => {
      const accountId = ctx.accountId;
      const state = getAccountState(accountId);

      if (ctx.abortSignal.aborted) {
        ctx.log?.info(
          `[type] Account "${accountId}" abort signal already fired, skipping startAccount`,
        );
        return;
      }

      if (state.connectionState !== "disconnected") {
        ctx.log?.info(
          `[type] Account "${accountId}" already ${state.connectionState}, skipping duplicate startAccount`,
        );
        return;
      }
      state.connectionState = "connecting";

      const runtime = getPluginRuntime() ?? ctx.runtime;
      const accountConfig = resolveAccount(ctx.cfg, accountId ?? undefined);
      const token = ctx.account.token || accountConfig.token;
      const wsUrl = ctx.account.wsUrl || accountConfig.wsUrl;
      const agentId = accountConfig.agentId;

      initializeTelemetry({ token, wsUrl, agentId });

      const connection = new TypeConnection({
        token,
        wsUrl,
        onMessage: (event) => {
          if (state.connection !== connection) return;

          if (event.type === "success") {
            const reqType = (event as { requestType?: string }).requestType;
            console.log(`[type:${accountId}] Server success: ${reqType}`);
            if (reqType === "stream_start") {
              const messageId =
                "messageId" in event && typeof event.messageId === "string"
                  ? event.messageId
                  : undefined;
              resolveStreamAck(messageId, accountId);
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
            if (
              errEvt.requestType === "stream_start" &&
              errEvt.error === STREAM_ALREADY_ACTIVE_ERROR
            ) {
              resolveStreamAck(errEvt.messageId, accountId);
              return;
            }

            console.error(
              `[type:${accountId}] Server error: ${errEvt.requestType} — ${errEvt.error}`,
              errEvt.details ?? "",
            );
            const error = new Error(errEvt.error ?? "stream request failed");
            captureException(error, {
              properties: {
                source: "server_error",
                requestType: errEvt.requestType,
                messageId: errEvt.messageId,
                details: errEvt.details,
              },
            });
            if (
              errEvt.messageId &&
              (errEvt.requestType === "stream_start" ||
                errEvt.requestType === "stream_event" ||
                errEvt.requestType === "stream_finish" ||
                errEvt.requestType === "stream_heartbeat")
            ) {
              failStreamSession(
                errEvt.messageId,
                errEvt.requestType,
                error,
                accountId,
              );
            }
            if (errEvt.requestType === "stream_start") {
              rejectStreamAck(error, errEvt.messageId, accountId);
            }
            return;
          }

          if (event.type !== "message") return;
          if (!state.outbound) return;

          const acknowledged = connection.send({
            type: "trigger_received",
            messageId: event.messageId,
            receivedAt: Date.now(),
          });
          if (!acknowledged) {
            console.error(
              `[type:${accountId}] Failed to send trigger_received ack for ${event.messageId}`,
            );
            captureException(new Error("Failed to send trigger_received ack"), {
              properties: { source: "trigger_ack", messageId: event.messageId },
            });
            return;
          }

          handleInboundMessage({
            msg: event,
            accountId,
            account: { token, wsUrl, agentId },
            cfg: ctx.cfg,
            runtime,
            outbound: state.outbound,
            log: ctx.log,
          });
        },
        onConnected: () => {
          if (state.connection !== connection) return;
          state.connectionState = "connected";
          resumeStreamSessionsForAccount(accountId);
          ctx.log?.info(`[type:${accountId}] WebSocket connected`);
        },
        onDisconnected: (event) => {
          if (state.connection !== connection) return;

          if (event.willReconnect) {
            state.connectionState = "connecting";
            ctx.log?.info(
              `[type:${accountId}] WebSocket disconnected, reconnecting`,
            );
            pauseStreamSessionsForAccount(accountId);
            return;
          }

          state.connectionState = "disconnected";
          ctx.log?.info(`[type:${accountId}] WebSocket disconnected`);
          failStreamSessionsForAccount(
            accountId,
            new Error(event.reason || "WebSocket disconnected"),
          );
        },
      });

      state.connection = connection;
      state.outbound = new TypeOutboundHandler(connection);
      state.context = { token, wsUrl, agentId };

      connection.connect();

      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => {
          state.connectionState = "disconnected";
          failStreamSessionsForAccount(
            accountId,
            new Error("Account shutdown"),
          );
          connection.disconnect();
          teardownTelemetry(agentId);
          state.connection = null;
          state.outbound = null;
          state.context = null;
          clearAccountState(accountId);
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
    setPluginRuntime(api.runtime);
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
