/**
 * Inbound Message Handler
 *
 * Handles a single inbound message from Type: builds the OpenClaw
 * inbound context, creates a StreamSession, and dispatches through
 * the standard OpenClaw agent reply pipeline.
 */

import { z } from "zod";
import { resolveApiOriginFromWsUrl } from "./apiOrigin.js";
import { cleanupScope, runInScope } from "./askUserState.js";
import type { TypeMessageEvent } from "./protocol.js";
import { ReplyTextProcessor } from "./replyTextProcessor.js";
import { type StreamOutbound, StreamSession } from "./streamSession.js";
import { captureEvent, captureException } from "./telemetry.js";

/**
 * Minimal typing for the OpenClaw plugin SDK runtime.
 */
export interface PluginRuntime {
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

export interface Logger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

interface TypeInboundAccountContext {
  token: string;
  wsUrl: string;
  agentId: string;
  ownerAllowFrom?: readonly string[];
}

type InboundFile = NonNullable<TypeMessageEvent["files"]>[number];
type InboundFileWithDownloadUrl = InboundFile & {
  downloadUrl?: string;
  url?: string;
};
type InboundHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
};

/**
 * Composite key for session maps: `${accountId}\0${messageId}`.
 * Prevents cross-account collisions when multiple accounts may process
 * messages with overlapping IDs.
 */
const KEY_SEP = "\0";

function sessionKey(accountId: string, messageId: string): string {
  return `${accountId}${KEY_SEP}${messageId}`;
}

function parseSessionKey(key: string): {
  accountId: string;
  messageId: string;
} {
  const idx = key.indexOf(KEY_SEP);
  return {
    accountId: key.substring(0, idx),
    messageId: key.substring(idx + 1),
  };
}

function resolveCompositeKey(
  messageId?: string,
  accountId?: string,
): string | undefined {
  if (messageId && accountId) return sessionKey(accountId, messageId);
  return undefined;
}

const sessionsByKey = new Map<string, StreamSession>();
const pendingAckOrder: string[] = [];
const dispatchCompletedKeys = new Set<string>();
const deferredCleanupByKey = new Map<string, ReturnType<typeof setTimeout>>();
const DEFERRED_ACK_CLEANUP_MS = 6000;
const FILE_URL_FETCH_TIMEOUT_MS = 10_000;
const downloadUrlResponseSchema = z.object({
  downloadUrl: z.string().url().optional(),
});
type ThreadTriggerContext = NonNullable<
  NonNullable<TypeMessageEvent["context"]>["thread"]
>;

function resolveToolCallId(info: Record<string, unknown>): string | undefined {
  const directCandidates = [
    info.toolCallId,
    info.tool_call_id,
    info.callId,
    info.call_id,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  const nestedCandidates = [info.tool, info.payload, info.event];
  for (const nested of nestedCandidates) {
    if (!nested || typeof nested !== "object") continue;
    const nestedRecord = nested as Record<string, unknown>;
    const nestedDirect = [
      nestedRecord.toolCallId,
      nestedRecord.tool_call_id,
      nestedRecord.callId,
      nestedRecord.call_id,
    ];
    for (const candidate of nestedDirect) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
  }

  return undefined;
}

function resolveDownloadUrl(
  file: InboundFileWithDownloadUrl,
): string | undefined {
  const resolvedUrl = file.url ?? file.downloadUrl;
  if (typeof resolvedUrl !== "string" || resolvedUrl.length === 0) {
    return undefined;
  }
  return resolvedUrl;
}

function trackSession(key: string, session: StreamSession): void {
  const existing = sessionsByKey.get(key);
  if (existing) {
    untrackSession(key);
  }
  dispatchCompletedKeys.delete(key);
  sessionsByKey.set(key, session);
}

function untrackSession(key: string): void {
  sessionsByKey.delete(key);
  dispatchCompletedKeys.delete(key);
  const idx = pendingAckOrder.indexOf(key);
  if (idx >= 0) {
    pendingAckOrder.splice(idx, 1);
  }
  const cleanupTimer = deferredCleanupByKey.get(key);
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    deferredCleanupByKey.delete(key);
  }
}

function markSessionAwaitingAck(key: string): void {
  if (!pendingAckOrder.includes(key)) {
    pendingAckOrder.push(key);
  }
}

function resolveSessionForAck(
  messageId?: string,
  accountId?: string,
): { session: StreamSession; key: string } | null {
  if (messageId) {
    const key = resolveCompositeKey(messageId, accountId);
    if (!key) return null;
    const session = sessionsByKey.get(key);
    if (!session?.isAwaitingAck) return null;
    return { session, key };
  }

  // Walk pendingAckOrder and find the first session that matches the account
  let i = 0;
  while (i < pendingAckOrder.length) {
    const key = pendingAckOrder[i];
    const session = sessionsByKey.get(key);
    if (!session) {
      pendingAckOrder.splice(i, 1);
      continue;
    }
    if (!session.isAwaitingAck) {
      pendingAckOrder.splice(i, 1);
      continue;
    }
    // If accountId is specified, skip sessions from other accounts
    if (accountId && parseSessionKey(key).accountId !== accountId) {
      i++;
      continue;
    }
    return { session, key };
  }

  return null;
}

function cleanupTrackedSessionIfComplete(key: string): void {
  const session = sessionsByKey.get(key);
  if (!session) {
    dispatchCompletedKeys.delete(key);
    return;
  }

  if (!dispatchCompletedKeys.has(key)) {
    return;
  }

  if (session.isAwaitingAck) {
    return;
  }

  untrackSession(key);
}

function scheduleDeferredAckCleanup(key: string): void {
  if (deferredCleanupByKey.has(key)) {
    return;
  }
  const timer = setTimeout(() => {
    deferredCleanupByKey.delete(key);
    cleanupTrackedSessionIfComplete(key);
  }, DEFERRED_ACK_CLEANUP_MS);
  deferredCleanupByKey.set(key, timer);
}

function markSessionDispatchComplete(key: string): void {
  dispatchCompletedKeys.add(key);
  cleanupTrackedSessionIfComplete(key);
  const session = sessionsByKey.get(key);
  if (session?.isAwaitingAck) {
    scheduleDeferredAckCleanup(key);
  }
}

function resolveHistorySenderLabel(message: {
  role: "user" | "assistant";
  sender: { name: string } | null;
}): string {
  return (
    message.sender?.name ??
    (message.role === "assistant" ? "Assistant" : "User")
  );
}

function toInboundHistoryEntry(message: {
  role: "user" | "assistant";
  content: string;
  timestamp: number | null;
  sender: { name: string } | null;
}): InboundHistoryEntry {
  const entry: InboundHistoryEntry = {
    sender: resolveHistorySenderLabel({
      role: message.role,
      sender: message.sender ? { name: message.sender.name } : null,
    }),
    body: message.content,
  };
  if (typeof message.timestamp === "number") {
    entry.timestamp = message.timestamp;
  }
  return entry;
}

function buildInboundHistory(msg: TypeMessageEvent): InboundHistoryEntry[] {
  const sourceMessages = msg.context?.recentMessages ?? [];
  return sourceMessages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => toInboundHistoryEntry(message));
}
function buildBodyForAgent(params: {
  messageBody: string;
  files: InboundFileWithDownloadUrl[] | undefined;
}): string {
  const { messageBody, files } = params;
  if (messageBody.trim().length > 0) {
    return messageBody;
  }
  if (files && files.length > 0) {
    return "See attached files.";
  }
  return messageBody;
}

function buildThreadBodies(
  threadContext: ThreadTriggerContext | null | undefined,
): {
  threadStarterBody?: string;
  threadHistoryBody?: string;
} {
  const threadMessages =
    threadContext?.messages.filter(
      (message) => message.content.trim().length > 0,
    ) ?? [];
  const [starter, ...history] = threadMessages;

  const threadStarterBody = starter?.content.trim()
    ? starter.content
    : undefined;
  const threadHistoryBody =
    history.length > 0
      ? history
          .map((message) => {
            const entry = toInboundHistoryEntry(message);
            return `${entry.sender}: ${entry.body}`;
          })
          .join("\n\n")
      : undefined;

  return {
    threadStarterBody,
    threadHistoryBody,
  };
}

function buildUntrustedContext(params: {
  channelContext:
    | NonNullable<NonNullable<TypeMessageEvent["context"]>["channel"]>
    | null
    | undefined;
  threadContext: ThreadTriggerContext | null | undefined;
  files: InboundFileWithDownloadUrl[] | undefined;
}): string[] | undefined {
  const entries: string[] = [];
  const { channelContext, threadContext, files } = params;

  if (channelContext) {
    const lines = ["Channel metadata (untrusted):"];
    lines.push(`- Name: ${channelContext.name}`);
    if (channelContext.description) {
      lines.push(`- Description: ${channelContext.description}`);
    }
    lines.push(`- Visibility: ${channelContext.visibility}`);
    if (channelContext.members.length > 0) {
      const memberLabels = channelContext.members.map(
        (member) => `${member.name} (${member.role})`,
      );
      lines.push(`- Scoped members: ${memberLabels.join(", ")}`);
    }
    entries.push(lines.join("\n"));
  }

  if (threadContext) {
    const lines = ["Thread metadata (untrusted):"];
    lines.push(`- Parent message ID: ${threadContext.parentMessageId}`);
    if (threadContext.threadTitle) {
      lines.push(`- Title: ${threadContext.threadTitle}`);
    }
    lines.push(`- Prior message count: ${threadContext.messages.length}`);
    entries.push(lines.join("\n"));
  }

  if (files && files.length > 0) {
    const fileLines = files.map((file) => {
      const resolvedUrl = resolveDownloadUrl(file);
      return `- ${file.filename} (id: ${file.id}, type: ${file.mimeType}, sizeBytes: ${file.sizeBytes}${resolvedUrl ? `, url: ${resolvedUrl}` : ""})`;
    });
    entries.push(["Attached files (untrusted):", ...fileLines].join("\n"));
  }

  return entries.length > 0 ? entries : undefined;
}

function resolveOpenClawChatType(
  chatType: TypeMessageEvent["chatType"],
): "direct" | "channel" {
  return chatType === "dm" ? "direct" : "channel";
}

async function resolveFileDownloadUrls(params: {
  files: InboundFile[];
  account: TypeInboundAccountContext;
  log?: Logger;
}): Promise<InboundFileWithDownloadUrl[]> {
  const { files, account, log } = params;

  if (files.length === 0) {
    return [];
  }

  const apiOrigin = resolveApiOriginFromWsUrl(account.wsUrl);
  if (!apiOrigin || !account.agentId || !account.token) {
    return files;
  }

  const endpoint = `${apiOrigin}/api/agents/${encodeURIComponent(account.agentId)}/files/download-url`;

  return Promise.all(
    files.map(async (file) => {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          signal: AbortSignal.timeout(FILE_URL_FETCH_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${account.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fileId: file.id }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payloadParse = downloadUrlResponseSchema.safeParse(
          await response.json(),
        );
        if (!payloadParse.success) {
          throw new Error("Invalid download URL response payload");
        }

        if (payloadParse.data.downloadUrl) {
          return {
            ...file,
            downloadUrl: payloadParse.data.downloadUrl,
            url: payloadParse.data.downloadUrl,
          };
        }
      } catch (err) {
        log?.error(
          `[type] Failed to resolve download URL for ${file.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return file;
    }),
  );
}

function buildMediaContextFields(
  files: InboundFileWithDownloadUrl[] | undefined,
): {
  MediaUrls?: string[];
  MediaUrl?: string;
  MediaTypes?: string[];
  MediaType?: string;
} {
  if (!files || files.length === 0) {
    return {};
  }

  const withDownloadUrl = files
    .map((file) => ({ file, resolvedUrl: resolveDownloadUrl(file) }))
    .filter(
      (
        entry,
      ): entry is { file: InboundFileWithDownloadUrl; resolvedUrl: string } =>
        typeof entry.resolvedUrl === "string" && entry.resolvedUrl.length > 0,
    );
  if (withDownloadUrl.length === 0) {
    return {};
  }

  const mediaUrls = withDownloadUrl.map((entry) => entry.resolvedUrl);
  const mediaTypes = withDownloadUrl.map((entry) => entry.file.mimeType);

  return {
    MediaUrls: mediaUrls,
    MediaUrl: mediaUrls[0],
    MediaTypes: mediaTypes,
    MediaType: mediaTypes[0],
  };
}

/**
 * Resolve the pending stream_start ack on a specific session.
 * Falls back to the oldest pending session for the given account
 * when messageId is missing.
 */
export function resolveStreamAck(messageId?: string, accountId?: string): void {
  const result = resolveSessionForAck(messageId, accountId);
  if (!result) return;
  result.session.onAck();
  const idx = pendingAckOrder.indexOf(result.key);
  if (idx >= 0) {
    pendingAckOrder.splice(idx, 1);
  }
  cleanupTrackedSessionIfComplete(result.key);
}

/**
 * Reject the pending stream_start ack on a specific session.
 * Falls back to the oldest pending session for the given account
 * when messageId is missing.
 */
export function rejectStreamAck(
  error: Error,
  messageId?: string,
  accountId?: string,
): void {
  const result = resolveSessionForAck(messageId, accountId);
  if (!result) return;
  result.session.onAckError(error);
  const idx = pendingAckOrder.indexOf(result.key);
  if (idx >= 0) {
    pendingAckOrder.splice(idx, 1);
  }
  cleanupTrackedSessionIfComplete(result.key);
}

/**
 * Mark a tracked stream session as failed after server-side stream rejection.
 */
export function failStreamSession(
  messageId: string,
  requestType:
    | "stream_start"
    | "stream_event"
    | "stream_finish"
    | "stream_heartbeat",
  error: Error,
  accountId?: string,
): void {
  const key = resolveCompositeKey(messageId, accountId);
  if (!key) return;
  const session = sessionsByKey.get(key);
  if (!session) return;
  session.failFromServer(requestType, error);
  cleanupTrackedSessionIfComplete(key);
}

/**
 * Pause stream sessions for a specific account while the transport reconnects.
 */
export function pauseStreamSessionsForAccount(accountId: string): void {
  const prefix = `${accountId}${KEY_SEP}`;
  for (const [key, session] of sessionsByKey.entries()) {
    if (key.startsWith(prefix)) {
      session.handleTransportDisconnected();
    }
  }
}

/**
 * Resume stream sessions for a specific account after the transport reconnects.
 */
export function resumeStreamSessionsForAccount(accountId: string): void {
  const prefix = `${accountId}${KEY_SEP}`;
  for (const [key, session] of sessionsByKey.entries()) {
    if (key.startsWith(prefix)) {
      session.handleTransportReconnected();
    }
  }
}

/**
 * Fail all active stream sessions. Called as a last resort when the entire
 * plugin is shutting down.
 */
export function failAllStreamSessions(error: Error): void {
  for (const key of [...sessionsByKey.keys()]) {
    const { messageId, accountId } = parseSessionKey(key);
    failStreamSession(messageId, "stream_start", error, accountId);
    untrackSession(key);
  }
}

/**
 * Fail only the stream sessions belonging to a specific account.
 * Called on per-account WebSocket disconnect to avoid failing sessions
 * from other still-connected accounts.
 */
export function failStreamSessionsForAccount(
  accountId: string,
  error: Error,
): void {
  const prefix = `${accountId}${KEY_SEP}`;
  for (const key of [...sessionsByKey.keys()]) {
    if (key.startsWith(prefix)) {
      const session = sessionsByKey.get(key);
      if (session) {
        session.failFromServer("stream_start", error);
      }
      untrackSession(key);
    }
  }
}

const bindingsConfigSchema = z.object({
  bindings: z
    .array(
      z.object({
        agentId: z.string().optional(),
        match: z
          .object({
            channel: z.string(),
            accountId: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

type BindingsConfig = z.infer<typeof bindingsConfigSchema>;

/**
 * Resolve the OpenClaw agent ID for session key scoping.
 *
 * OpenClaw parses the `agent:<id>` prefix from SessionKey to determine
 * which agent workspace/sessions to use. This MUST be the OpenClaw agent
 * ID (from bindings), not the Type agent ID or account key.
 *
 * Resolution order:
 * 1. Binding matching both channel + accountId (most specific)
 * 2. Binding matching channel only (legacy single-account)
 * 3. Binding with no match (wildcard fallback)
 * 4. Fallback to "main"
 */
function resolveAgentIdForSession(
  cfg: BindingsConfig,
  accountId: string,
): string {
  const bindings = cfg.bindings ?? [];

  // Pass 1: match on both channel and accountId
  for (const binding of bindings) {
    if (
      binding.match?.channel === "type" &&
      binding.match.accountId === accountId &&
      binding.agentId
    ) {
      return binding.agentId;
    }
  }

  // Pass 2: match on channel only (legacy / wildcard)
  for (const binding of bindings) {
    if (
      binding.match?.channel === "type" &&
      !binding.match.accountId &&
      binding.agentId
    ) {
      return binding.agentId;
    }
  }

  // Pass 3: binding with no match acts as a wildcard
  for (const binding of bindings) {
    if (!binding.match && binding.agentId) {
      return binding.agentId;
    }
  }

  return "main";
}

/**
 * Handle a single inbound message trigger from Type.
 */
export function handleInboundMessage(params: {
  msg: TypeMessageEvent;
  accountId: string;
  account?: TypeInboundAccountContext;
  cfg: Record<string, unknown>;
  runtime: PluginRuntime;
  outbound: StreamOutbound;
  log?: Logger;
}): void {
  const { msg, accountId, account, cfg, runtime, outbound, log } = params;

  log?.info(
    `[type] Inbound message from ${msg.sender?.name ?? "unknown"} in ${msg.channelName ?? msg.channelId}`,
  );

  captureEvent("message_received", {
    messageId: msg.messageId,
    channelId: msg.channelId,
    chatType: msg.chatType,
    mentionsAgent: msg.mentionsAgent,
    hasFiles: (msg.files?.length ?? 0) > 0,
    accountId,
  });

  const inboundFiles = msg.files ? [...msg.files] : undefined;

  const dispatchWithResolvedFiles = (
    resolvedFiles: InboundFileWithDownloadUrl[] | undefined,
  ): void => {
    try {
      const effectiveFiles: InboundFileWithDownloadUrl[] | undefined =
        resolvedFiles ?? inboundFiles;
      const mediaContextFields = buildMediaContextFields(effectiveFiles);
      const normalizedFiles = (effectiveFiles ?? []).map((file) => ({
        ...file,
        url: file.url ?? file.downloadUrl,
      }));
      const senderId = msg.sender?.id ?? "unknown";
      const senderName = msg.sender?.name ?? "Unknown";
      const messageBody = msg.content ?? "";
      const inboundHistory = buildInboundHistory(msg);
      const threadContext = msg.context?.thread;
      const channelContext = msg.context?.channel;
      const { threadStarterBody, threadHistoryBody } =
        buildThreadBodies(threadContext);
      const untrustedContext = buildUntrustedContext({
        channelContext,
        threadContext,
        files: effectiveFiles,
      });
      const bodyForAgent = buildBodyForAgent({
        messageBody,
        files: effectiveFiles,
      });

      log?.info(
        `[type] Trigger context summary: threadMessages=${threadContext?.messages.length ?? 0}, recentMessages=${msg.context?.recentMessages?.length ?? 0}`,
      );

      const parsedCfg = bindingsConfigSchema.safeParse(cfg);
      const agentId = resolveAgentIdForSession(
        parsedCfg.success ? parsedCfg.data : { bindings: [] },
        accountId,
      );

      const ctxPayload = runtime.channel.reply.finalizeInboundContext({
        Body: bodyForAgent,
        BodyForAgent: bodyForAgent,
        BodyForCommands: messageBody,
        RawBody: messageBody,
        CommandBody: messageBody,
        CommandAuthorized: true,
        From: `type:${senderId}`,
        // Use the concrete conversation id so "message send" can infer a valid
        // reply target for this channel/thread.
        To: msg.channelId,
        SessionKey: (() => {
          switch (msg.chatType) {
            case "thread":
              return msg.parentMessageId
                ? `agent:${agentId}:type:${msg.parentMessageId}`
                : `agent:${agentId}:type:${msg.channelId}:${msg.messageId}`;
            case "dm":
              return `agent:${agentId}:type:${msg.channelId}`;
            default:
              return `agent:${agentId}:type:${msg.channelId}:${msg.messageId}`;
          }
        })(),
        AccountId: accountId,
        ChatType: resolveOpenClawChatType(msg.chatType),
        ConversationLabel: msg.channelName ?? msg.channelId,
        GroupChannel: channelContext?.name ?? msg.channelName ?? msg.channelId,
        GroupSubject: channelContext?.description ?? null,
        SenderName: senderName,
        SenderId: senderId,
        ThreadLabel: threadContext?.threadTitle ?? null,
        InboundHistory: inboundHistory.length > 0 ? inboundHistory : undefined,
        ThreadStarterBody: threadStarterBody,
        ThreadHistoryBody: threadHistoryBody,
        MessageThreadId:
          msg.chatType === "thread"
            ? (msg.parentMessageId ?? msg.messageId)
            : undefined,
        ReplyToId: msg.parentMessageId ?? undefined,
        UntrustedContext: untrustedContext,
        OwnerAllowFrom:
          account?.ownerAllowFrom && account.ownerAllowFrom.length > 0
            ? [...account.ownerAllowFrom]
            : undefined,
        Files: normalizedFiles,
        ...mediaContextFields,
        Provider: "type",
        Surface: "type",
        MessageSid: msg.messageId,
        Timestamp: msg.timestamp,
        TypeTriggerContext: msg.context ?? null,
      });

      const session = new StreamSession(outbound, msg.messageId);
      const key = sessionKey(accountId, msg.messageId);
      trackSession(key, session);
      const processor = new ReplyTextProcessor(
        session,
        () => markSessionAwaitingAck(key),
        msg.messageId,
      );

      runInScope(msg.messageId, () => {
        try {
          void runtime.channel.reply
            .dispatchReplyWithBufferedBlockDispatcher({
              ctx: ctxPayload,
              cfg,
              dispatcherOptions: {
                deliver: async (
                  payload: { text?: string },
                  info: Record<string, unknown>,
                ) => {
                  if (info.kind !== "tool") return;
                  if (!payload.text) {
                    processor.markToolEventSeen();
                    return;
                  }
                  const intercepted = await processor.handleToolDelivery(
                    payload.text,
                    {
                      toolCallId: resolveToolCallId(info),
                    },
                  );
                  if (intercepted) return;
                },
                onSkip: (_payload, info) => {
                  console.log(`[type] Reply skipped: ${JSON.stringify(info)}`);
                },
                onError: (err, info) => {
                  console.error(
                    `[type] Reply error: ${err} ${JSON.stringify(info)}`,
                  );
                  captureException(
                    err instanceof Error ? err : new Error(String(err)),
                    { properties: { source: "reply_error", ...info } },
                  );
                },
              },
              replyOptions: {
                disableBlockStreaming: true,
                onPartialReply: (payload: { text?: string }) => {
                  if (!payload.text || session.isFailed) return;
                  processor.processText(payload.text, false);
                },
              },
            })
            .then(() => {
              processor.flush();
              cleanupScope(msg.messageId);
              const { needsReply, needsReplyQuestion } = processor.result;
              if (session.isStarted || needsReply) {
                session.finish(
                  needsReply
                    ? { needsReply: true, question: needsReplyQuestion }
                    : undefined,
                );
              }
              markSessionDispatchComplete(key);
              captureEvent("message_processed", {
                messageId: msg.messageId,
                channelId: msg.channelId,
                chatType: msg.chatType,
                accountId,
                success: true,
              });
            })
            .catch((err: unknown) => {
              cleanupScope(msg.messageId);
              console.error(
                `[type] Stream dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              captureException(
                err instanceof Error ? err : new Error(String(err)),
                {
                  properties: {
                    source: "stream_dispatch",
                    messageId: msg.messageId,
                  },
                },
              );
              processor.flush();
              if (session.isStarted) {
                session.finish();
              }
              markSessionDispatchComplete(key);
              captureEvent("message_processed", {
                messageId: msg.messageId,
                channelId: msg.channelId,
                chatType: msg.chatType,
                accountId,
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        } catch (syncErr) {
          cleanupScope(msg.messageId);
          processor.flush();
          if (session.isStarted) {
            session.finish();
          }
          markSessionDispatchComplete(key);
          throw syncErr;
        }
      });
    } catch (err) {
      log?.error(
        `[type] Message dispatch error: ${err instanceof Error ? err.message : String(err)}`,
      );
      captureEvent("message_processed", {
        messageId: msg.messageId,
        channelId: msg.channelId,
        chatType: msg.chatType,
        accountId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (
    inboundFiles &&
    inboundFiles.length > 0 &&
    account?.token &&
    account.wsUrl &&
    account.agentId
  ) {
    void resolveFileDownloadUrls({
      files: inboundFiles,
      account,
      log,
    })
      .then((resolvedFiles) => {
        dispatchWithResolvedFiles(resolvedFiles);
      })
      .catch((err) => {
        log?.error(
          `[type] File download URL resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        dispatchWithResolvedFiles(inboundFiles);
      });
    return;
  }

  dispatchWithResolvedFiles(inboundFiles);
}
