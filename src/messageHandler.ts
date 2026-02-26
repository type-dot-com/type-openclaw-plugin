/**
 * Inbound Message Handler
 *
 * Handles a single inbound message from Type: builds the OpenClaw
 * inbound context, creates a StreamSession, and dispatches through
 * the standard OpenClaw agent reply pipeline.
 */

import { z } from "zod";
import { resolveApiOriginFromWsUrl } from "./apiOrigin.js";
import type { TypeMessageEvent } from "./protocol.js";
import { type StreamOutbound, StreamSession } from "./streamSession.js";
import { createToolEvents } from "./toolEvents.js";

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
}

type InboundFile = NonNullable<TypeMessageEvent["files"]>[number];
type InboundFileWithDownloadUrl = InboundFile & {
  downloadUrl?: string;
  url?: string;
};

const sessionsByMessageId = new Map<string, StreamSession>();
const pendingAckOrder: string[] = [];
const dispatchCompletedMessageIds = new Set<string>();
const deferredCleanupByMessageId = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const DEFERRED_ACK_CLEANUP_MS = 6000;
const NO_REPLY_SENTINEL = "NO_REPLY";
const NO_REPLY_SHORT_SENTINEL = "NO";
const FILE_URL_FETCH_TIMEOUT_MS = 10_000;
const downloadUrlResponseSchema = z.object({
  downloadUrl: z.string().url().optional(),
});
type ThreadTriggerContext = NonNullable<
  NonNullable<TypeMessageEvent["context"]>["thread"]
>;

function resolveDownloadUrl(
  file: InboundFileWithDownloadUrl,
): string | undefined {
  const resolvedUrl = file.url ?? file.downloadUrl;
  if (typeof resolvedUrl !== "string" || resolvedUrl.length === 0) {
    return undefined;
  }
  return resolvedUrl;
}

function trackSession(messageId: string, session: StreamSession): void {
  const existing = sessionsByMessageId.get(messageId);
  if (existing) {
    untrackSession(messageId);
  }
  dispatchCompletedMessageIds.delete(messageId);
  sessionsByMessageId.set(messageId, session);
}

function untrackSession(messageId: string): void {
  sessionsByMessageId.delete(messageId);
  dispatchCompletedMessageIds.delete(messageId);
  const idx = pendingAckOrder.indexOf(messageId);
  if (idx >= 0) {
    pendingAckOrder.splice(idx, 1);
  }
  const cleanupTimer = deferredCleanupByMessageId.get(messageId);
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    deferredCleanupByMessageId.delete(messageId);
  }
}

function markSessionAwaitingAck(messageId: string): void {
  if (!pendingAckOrder.includes(messageId)) {
    pendingAckOrder.push(messageId);
  }
}

function resolveSessionForAck(messageId?: string): StreamSession | null {
  if (messageId) {
    const byId = sessionsByMessageId.get(messageId);
    return byId?.isAwaitingAck ? byId : null;
  }

  while (pendingAckOrder.length > 0) {
    const nextMessageId = pendingAckOrder[0];
    const session = sessionsByMessageId.get(nextMessageId);
    if (session?.isAwaitingAck) {
      return session;
    }
    pendingAckOrder.shift();
  }

  return null;
}

function cleanupTrackedSessionIfComplete(messageId: string): void {
  const session = sessionsByMessageId.get(messageId);
  if (!session) {
    dispatchCompletedMessageIds.delete(messageId);
    return;
  }

  if (!dispatchCompletedMessageIds.has(messageId)) {
    return;
  }

  if (session.isAwaitingAck) {
    return;
  }

  untrackSession(messageId);
}

function scheduleDeferredAckCleanup(messageId: string): void {
  if (deferredCleanupByMessageId.has(messageId)) {
    return;
  }
  const timer = setTimeout(() => {
    deferredCleanupByMessageId.delete(messageId);
    cleanupTrackedSessionIfComplete(messageId);
  }, DEFERRED_ACK_CLEANUP_MS);
  deferredCleanupByMessageId.set(messageId, timer);
}

function markSessionDispatchComplete(messageId: string): void {
  dispatchCompletedMessageIds.add(messageId);
  cleanupTrackedSessionIfComplete(messageId);
  const session = sessionsByMessageId.get(messageId);
  if (session?.isAwaitingAck) {
    scheduleDeferredAckCleanup(messageId);
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

function buildInboundHistory(msg: TypeMessageEvent): Array<{
  sender: string;
  body: string;
  timestamp?: number;
}> {
  const context = msg.context;
  if (!context) {
    return [];
  }

  const sourceMessages =
    context.thread?.messages ?? context.recentMessages ?? [];
  const inboundHistory = sourceMessages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => {
      const entry: { sender: string; body: string; timestamp?: number } = {
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
    });

  return inboundHistory;
}

function buildUntrustedContextBlocks(msg: TypeMessageEvent): string[] {
  const context = msg.context;
  if (!context) {
    return [];
  }
  const blocks: string[] = [];

  if (context.triggeringUser) {
    blocks.push(
      [
        "Triggering user metadata (untrusted):",
        "```json",
        JSON.stringify(
          {
            id: context.triggeringUser.id,
            name: context.triggeringUser.name,
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
    );
  }

  if (context.channel) {
    blocks.push(
      [
        "Channel metadata (untrusted):",
        "```json",
        JSON.stringify(
          {
            id: context.channel.id,
            name: context.channel.name,
            description: context.channel.description,
            visibility: context.channel.visibility,
            members: (context.channel.members ?? []).map((member) => ({
              id: member.id,
              name: member.name,
              role: member.role,
              avatarUrl: member.avatarUrl,
            })),
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
    );
  }

  if (context.thread) {
    blocks.push(
      [
        "Thread metadata (untrusted):",
        "```json",
        JSON.stringify(
          {
            parentMessageId: context.thread.parentMessageId,
            threadTitle: context.thread.threadTitle,
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
    );
  }

  const files = msg.files;
  if (files && files.length > 0) {
    blocks.push(
      [
        "Attached files (untrusted):",
        "```json",
        JSON.stringify(
          files.map((f) => ({
            id: f.id,
            filename: f.filename,
            mimeType: f.mimeType,
            sizeBytes: f.sizeBytes,
          })),
          null,
          2,
        ),
        "```",
      ].join("\n"),
    );
  }

  return blocks;
}

function buildBodyForAgent(params: {
  messageBody: string;
  inboundHistory: Array<{ sender: string; body: string; timestamp?: number }>;
  threadContext: ThreadTriggerContext | null | undefined;
  files: InboundFileWithDownloadUrl[] | undefined;
}): string {
  const { messageBody, inboundHistory, threadContext, files } = params;

  if (
    inboundHistory.length === 0 &&
    !threadContext?.threadTitle &&
    (!files || files.length === 0)
  ) {
    return messageBody;
  }

  const sections: string[] = [];

  if (threadContext?.threadTitle) {
    sections.push(`Thread title: ${threadContext.threadTitle}`);
  }

  if (inboundHistory.length > 0) {
    const historyLines = inboundHistory.map(
      (entry) => `- ${entry.sender}: ${entry.body}`,
    );
    sections.push(["Conversation history:", ...historyLines].join("\n"));
  }

  if (files && files.length > 0) {
    const fileLines = files.map((file) => {
      const resolvedUrl = resolveDownloadUrl(file);
      return `- ${file.filename} (id: ${file.id}, type: ${file.mimeType}, sizeBytes: ${file.sizeBytes}${resolvedUrl ? `, url: ${resolvedUrl}` : ""})`;
    });
    sections.push(["Attached files:", ...fileLines].join("\n"));
  }

  sections.push(`Current message: ${messageBody}`);
  return sections.join("\n\n");
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
 * Falls back to the oldest pending session when messageId is missing.
 */
export function resolveStreamAck(messageId?: string): void {
  const session = resolveSessionForAck(messageId);
  if (!session) return;
  session.onAck();
  if (messageId) {
    const idx = pendingAckOrder.indexOf(messageId);
    if (idx >= 0) {
      pendingAckOrder.splice(idx, 1);
    }
    cleanupTrackedSessionIfComplete(messageId);
    return;
  }
  const pendingMessageId = pendingAckOrder.shift();
  if (pendingMessageId) {
    cleanupTrackedSessionIfComplete(pendingMessageId);
  }
}

/**
 * Reject the pending stream_start ack on a specific session.
 * Falls back to the oldest pending session when messageId is missing.
 */
export function rejectStreamAck(error: Error, messageId?: string): void {
  const session = resolveSessionForAck(messageId);
  if (!session) return;
  session.onAckError(error);
  if (messageId) {
    const idx = pendingAckOrder.indexOf(messageId);
    if (idx >= 0) {
      pendingAckOrder.splice(idx, 1);
    }
    cleanupTrackedSessionIfComplete(messageId);
    return;
  }
  const pendingMessageId = pendingAckOrder.shift();
  if (pendingMessageId) {
    cleanupTrackedSessionIfComplete(pendingMessageId);
  }
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
): void {
  const session = sessionsByMessageId.get(messageId);
  if (!session) return;
  session.failFromServer(requestType, error);
  cleanupTrackedSessionIfComplete(messageId);
}

/**
 * Fail all active stream sessions. Called on WebSocket disconnect to
 * immediately clean up orphan sessions instead of waiting for heartbeat
 * timeouts.
 */
export function failAllStreamSessions(error: Error): void {
  for (const messageId of [...sessionsByMessageId.keys()]) {
    failStreamSession(messageId, "stream_start", error);
    untrackSession(messageId);
  }
}

const bindingsConfigSchema = z.object({
  bindings: z
    .array(
      z.object({
        agentId: z.string().optional(),
        match: z.object({ channel: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

function resolveAgentFromBindings(
  cfg: Record<string, unknown>,
  channel: string,
): string | undefined {
  const parsed = bindingsConfigSchema.safeParse(cfg);
  if (!parsed.success) return undefined;
  const bindings = parsed.data.bindings ?? [];
  for (const binding of bindings) {
    if (binding.match?.channel === channel && binding.agentId) {
      return binding.agentId;
    }
  }
  return undefined;
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
      const untrustedContext = buildUntrustedContextBlocks(msg);
      const threadContext = msg.context?.thread;
      const channelContext = msg.context?.channel;
      const bodyForAgent = buildBodyForAgent({
        messageBody,
        inboundHistory,
        threadContext,
        files: effectiveFiles,
      });

      log?.info(
        `[type] Trigger context summary: threadMessages=${threadContext?.messages.length ?? 0}, recentMessages=${msg.context?.recentMessages?.length ?? 0}`,
      );

      const agentId = resolveAgentFromBindings(cfg, "type") ?? "main";

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
        ChatType: msg.chatType,
        ConversationLabel: msg.channelName ?? msg.channelId,
        GroupChannel: channelContext?.name ?? msg.channelName ?? msg.channelId,
        GroupSubject: channelContext?.description ?? null,
        SenderName: senderName,
        SenderId: senderId,
        ThreadLabel: threadContext?.threadTitle ?? null,
        InboundHistory: inboundHistory.length > 0 ? inboundHistory : undefined,
        UntrustedContext:
          untrustedContext.length > 0 ? untrustedContext : undefined,
        Files: normalizedFiles,
        ...mediaContextFields,
        Provider: "type",
        Surface: "type",
        MessageSid: msg.messageId,
        Timestamp: msg.timestamp,
        TypeTriggerContext: msg.context ?? null,
      });

      const session = new StreamSession(outbound, msg.messageId);
      trackSession(msg.messageId, session);
      let pendingNoReplyCandidateText: string | null = null;
      let noReplySuppressed = false;
      let sawToolEvent = false;

      const getEffectiveNoReplySentinels = (): readonly string[] =>
        sawToolEvent
          ? [NO_REPLY_SENTINEL, NO_REPLY_SHORT_SENTINEL]
          : [NO_REPLY_SENTINEL];

      const sendPartialReplyText = (text: string, isFinalAttempt: boolean) => {
        if (session.isFailed || noReplySuppressed) return;
        const trimmed = text.trim();
        if (trimmed.length === 0) return;

        const pendingCandidate = pendingNoReplyCandidateText;
        const candidateText = pendingCandidate
          ? text.startsWith(pendingCandidate)
            ? text
            : `${pendingCandidate}${text}`
          : text;
        const upperTrimmed = candidateText.trim().toUpperCase();
        const effectiveSentinels = getEffectiveNoReplySentinels();
        if (effectiveSentinels.includes(upperTrimmed)) {
          // Sentinel used by OpenClaw to suppress a follow-up assistant message
          // after a direct tool-send. Never forward this text to Type.
          noReplySuppressed = true;
          pendingNoReplyCandidateText = null;
          return;
        }

        const isPossibleSentinelPrefix = effectiveSentinels.some((sentinel) =>
          sentinel.startsWith(upperTrimmed),
        );
        if (isPossibleSentinelPrefix) {
          pendingNoReplyCandidateText = candidateText;
          if (!isFinalAttempt) {
            return;
          }
        } else {
          pendingNoReplyCandidateText = null;
        }

        session.sendToken(candidateText);
        if (session.isStarted) {
          markSessionAwaitingAck(msg.messageId);
        }
      };

      const flushPendingNoReplyCandidate = () => {
        if (!pendingNoReplyCandidateText || noReplySuppressed) return;
        const pendingText = pendingNoReplyCandidateText;
        pendingNoReplyCandidateText = null;
        sendPartialReplyText(pendingText, true);
      };

      void runtime.channel.reply
        .dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            deliver: async (
              payload: { text?: string },
              info: Record<string, unknown>,
            ) => {
              // Handle tool results as native tool-call + tool-result stream
              // events so they render as collapsible cards in Type's UI.
              if (info.kind === "tool") {
                sawToolEvent = true;
                if (session.isFailed) return;
                if (payload.text) {
                  const [toolCall, toolResult] = createToolEvents(payload.text);
                  session.sendToolEvent(toolCall);
                  session.sendToolEvent(toolResult);
                }
                session.resetTextAccumulator();
                if (session.isStarted && !session.isFailed) {
                  markSessionAwaitingAck(msg.messageId);
                }
              }
              // Other kinds (block, final) are no-op — onPartialReply handles text
            },
            onSkip: (_payload, info) => {
              console.log(`[type] Reply skipped: ${JSON.stringify(info)}`);
            },
            onError: (err, info) => {
              console.error(
                `[type] Reply error: ${err} ${JSON.stringify(info)}`,
              );
            },
          },
          replyOptions: {
            disableBlockStreaming: true,
            onPartialReply: (payload: { text?: string }) => {
              if (!payload.text || session.isFailed) return;
              sendPartialReplyText(payload.text, false);
            },
          },
        })
        .then(() => {
          flushPendingNoReplyCandidate();
          if (session.isStarted) {
            session.finish();
          }
          markSessionDispatchComplete(msg.messageId);
        })
        .catch((err: unknown) => {
          console.error(
            `[type] Stream dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          flushPendingNoReplyCandidate();
          if (session.isStarted) {
            session.finish();
          }
          markSessionDispatchComplete(msg.messageId);
        });
    } catch (err) {
      log?.error(
        `[type] Message dispatch error: ${err instanceof Error ? err.message : String(err)}`,
      );
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
