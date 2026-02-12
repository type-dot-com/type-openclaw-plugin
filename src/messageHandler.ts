/**
 * Inbound Message Handler
 *
 * Handles a single inbound message from Type: builds the OpenClaw
 * inbound context, creates a StreamSession, and dispatches through
 * the standard OpenClaw agent reply pipeline.
 */

import type { TypeOutboundHandler } from "./outbound.js";
import type { TypeMessageEvent } from "./protocol.js";
import { StreamSession } from "./streamSession.js";
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

// Active stream session — one at a time per connection.
// Exposed via resolveStreamAck / rejectStreamAck for the server
// response handler in index.ts to call.
let activeStreamSession: StreamSession | null = null;

/**
 * Resolve the pending stream_start ack on the active session.
 */
export function resolveStreamAck(): void {
  activeStreamSession?.onAck();
}

/**
 * Reject the pending stream_start ack on the active session.
 */
export function rejectStreamAck(error: Error): void {
  activeStreamSession?.onAckError(error);
}

/**
 * Handle a single inbound message trigger from Type.
 */
export function handleInboundMessage(params: {
  msg: TypeMessageEvent;
  accountId: string;
  cfg: Record<string, unknown>;
  runtime: PluginRuntime;
  outbound: TypeOutboundHandler;
  log?: Logger;
}): void {
  const { msg, accountId, cfg, runtime, outbound, log } = params;

  log?.info(
    `[type] Inbound message from ${msg.sender?.name ?? "unknown"} in ${msg.channelName ?? msg.channelId}`,
  );

  try {
    const chatType = msg.parentMessageId ? "thread" : "channel";
    const senderId = msg.sender?.id ?? "unknown";
    const senderName = msg.sender?.name ?? "Unknown";
    const messageBody = msg.content ?? "";

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

    const session = new StreamSession(outbound, msg.messageId);
    activeStreamSession = session;

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
          },
        },
      })
      .then(() => {
        if (session.isStarted) {
          session.finish();
        }
        activeStreamSession = null;
      })
      .catch((err: unknown) => {
        console.error(
          `[type] Stream dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (session.isStarted) {
          session.finish();
        }
        activeStreamSession = null;
      });
  } catch (err) {
    log?.error(
      `[type] Message dispatch error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
