/**
 * Inbound Message Handler
 *
 * Handles a single inbound message from Type: builds the OpenClaw
 * inbound context, creates a StreamSession, and dispatches through
 * the standard OpenClaw agent reply pipeline.
 */

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

const sessionsByMessageId = new Map<string, StreamSession>();
const pendingAckOrder: string[] = [];
const dispatchCompletedMessageIds = new Set<string>();
const deferredCleanupByMessageId = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const DEFERRED_ACK_CLEANUP_MS = 6000;

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
            email: context.triggeringUser.email,
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
            members: context.channel.members.map((member) => ({
              id: member.id,
              name: member.name,
              email: member.email,
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

  return blocks;
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
 * Handle a single inbound message trigger from Type.
 */
export function handleInboundMessage(params: {
  msg: TypeMessageEvent;
  accountId: string;
  cfg: Record<string, unknown>;
  runtime: PluginRuntime;
  outbound: StreamOutbound;
  log?: Logger;
}): void {
  const { msg, accountId, cfg, runtime, outbound, log } = params;

  log?.info(
    `[type] Inbound message from ${msg.sender?.name ?? "unknown"} in ${msg.channelName ?? msg.channelId}`,
  );

  try {
    const chatType = "channel";
    const senderId = msg.sender?.id ?? "unknown";
    const senderName = msg.sender?.name ?? "Unknown";
    const messageBody = msg.content ?? "";
    const inboundHistory = buildInboundHistory(msg);
    const untrustedContext = buildUntrustedContextBlocks(msg);
    const threadContext = msg.context?.thread;
    const channelContext = msg.context?.channel;

    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: messageBody,
      BodyForAgent: messageBody,
      BodyForCommands: messageBody,
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
      GroupChannel: channelContext?.name ?? msg.channelName ?? msg.channelId,
      GroupSubject: channelContext?.description ?? null,
      SenderName: senderName,
      SenderId: senderId,
      ThreadLabel: threadContext?.threadTitle ?? null,
      InboundHistory: inboundHistory.length > 0 ? inboundHistory : undefined,
      UntrustedContext:
        untrustedContext.length > 0 ? untrustedContext : undefined,
      Provider: "type",
      Surface: "type",
      MessageSid: msg.messageId,
      Timestamp: msg.timestamp,
      TypeTriggerContext: msg.context ?? null,
    });

    const session = new StreamSession(outbound, msg.messageId);
    trackSession(msg.messageId, session);

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
            if (info.kind === "tool" && payload.text) {
              if (session.isFailed) return;
              const [toolCall, toolResult] = createToolEvents(payload.text);
              session.sendToolEvent(toolCall);
              session.sendToolEvent(toolResult);
              if (session.isStarted) {
                markSessionAwaitingAck(msg.messageId);
              }
            }
            // Other kinds (block, final) are no-op — onPartialReply handles text
          },
          onSkip: (_payload, info) => {
            console.log(`[type] Reply skipped: ${JSON.stringify(info)}`);
          },
          onError: (err, info) => {
            console.error(`[type] Reply error: ${err} ${JSON.stringify(info)}`);
          },
        },
        replyOptions: {
          disableBlockStreaming: true,
          onPartialReply: (payload: { text?: string }) => {
            if (!payload.text || session.isFailed) return;
            session.sendToken(payload.text);
            if (session.isStarted) {
              markSessionAwaitingAck(msg.messageId);
            }
          },
        },
      })
      .then(() => {
        if (session.isStarted) {
          session.finish();
        }
        markSessionDispatchComplete(msg.messageId);
      })
      .catch((err: unknown) => {
        console.error(
          `[type] Stream dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
}
