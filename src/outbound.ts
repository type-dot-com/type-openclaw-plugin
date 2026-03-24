/**
 * Outbound Message Handler
 *
 * Wraps the WebSocket connection with typed methods for sending
 * messages and streaming responses back to Type.
 */

import { randomUUID } from "node:crypto";
import {
  getAccountContextForAccount,
  getOutboundForAccount,
  resolveEffectiveAccountId,
} from "./accountState.js";
import { resolveChannelId } from "./channels.js";
import { DEFAULT_TYPE_WS_URL, resolveAccount } from "./config.js";
import type { TypeConnection } from "./connection.js";
import { resolveParentMessageIdForSend } from "./inboundRoutingState.js";
import {
  resolveEffectiveMediaLocalRoots,
  uploadMediaForType,
} from "./mediaUpload.js";
import { waitForSendAck } from "./sendAckTracker.js";

export class TypeOutboundHandler {
  constructor(private readonly connection: TypeConnection) {}

  /**
   * Send a non-streaming full response to a triggered message.
   */
  respond(
    messageId: string,
    content: string,
    fileIds?: string[],
    opts?: { needsReply?: boolean; question?: string },
  ): boolean {
    return this.connection.send({
      type: "respond",
      messageId,
      content,
      ...(fileIds?.length ? { fileIds } : {}),
      ...(opts?.needsReply ? { needsReply: true } : {}),
      ...(opts?.question ? { question: opts.question } : {}),
    });
  }

  /**
   * Send a proactive message to a channel.
   * Returns the requestId for ACK correlation alongside the send status.
   */
  sendMessage(
    channelId: string,
    content: string,
    parentMessageId?: string,
    fileIds?: string[],
  ): { sent: boolean; requestId: string } {
    const requestId = randomUUID();
    const sent = this.connection.send({
      type: "send",
      channelId,
      content,
      parentMessageId,
      requestId,
      ...(fileIds?.length ? { fileIds } : {}),
    });
    return { sent, requestId };
  }

  /**
   * Begin a streaming response for a triggered message.
   */
  startStream(messageId: string): boolean {
    return this.connection.send({
      type: "stream_start",
      messageId,
    });
  }

  /**
   * Send a streaming token (text delta).
   */
  streamToken(messageId: string, text: string): boolean {
    return this.connection.send({
      type: "stream_event",
      messageId,
      event: { kind: "token", text },
    });
  }

  /**
   * Send a generic stream event (tool-call, tool-result, etc.).
   */
  streamEvent(
    messageId: string,
    event: { kind: string; [key: string]: unknown },
  ): boolean {
    return this.connection.send({
      type: "stream_event",
      messageId,
      event,
    });
  }

  /**
   * Keep an active stream alive while no tokens/events are emitted.
   */
  streamHeartbeat(messageId: string): boolean {
    return this.connection.send({
      type: "stream_heartbeat",
      messageId,
    });
  }

  /**
   * Finalize a streaming response.
   */
  finishStream(
    messageId: string,
    fileIds?: string[],
    opts?: { needsReply?: boolean; question?: string },
  ): boolean {
    return this.connection.send({
      type: "stream_finish",
      messageId,
      ...(fileIds?.length ? { fileIds } : {}),
      ...(opts?.needsReply ? { needsReply: true } : {}),
      ...(opts?.question ? { question: opts.question } : {}),
    });
  }
}

export type SendSuccessResult = {
  ok: true;
  channel: string;
  messageId: string;
  channelId: string | null;
  parentMessageId: string | null;
  channelName: string | null;
  channelType: string | null;
  chatType: string | null;
  timestamp: number | null;
};

export type SendResult = SendSuccessResult | { ok: false; error: string };

function fromAckResult(params: {
  ackResult: Awaited<ReturnType<typeof waitForSendAck>>;
  channelId: string;
  parentMessageId?: string;
}): SendResult {
  if (params.ackResult.ok) {
    return {
      ok: true,
      channel: "type",
      messageId: params.ackResult.ack.messageId,
      channelId: params.ackResult.ack.channelId,
      parentMessageId: params.ackResult.ack.parentMessageId,
      channelName: params.ackResult.ack.channelName,
      channelType: params.ackResult.ack.channelType,
      chatType: params.ackResult.ack.chatType,
      timestamp: params.ackResult.ack.timestamp,
    };
  }

  if (params.ackResult.reason === "timeout") {
    return {
      ok: true,
      channel: "type",
      messageId: "",
      channelId: params.channelId,
      parentMessageId: params.parentMessageId ?? null,
      channelName: null,
      channelType: null,
      chatType: null,
      timestamp: null,
    };
  }

  return {
    ok: false,
    error: params.ackResult.error.message,
  };
}

export async function sendTextToType(params: {
  to: string;
  text: string;
  replyToId?: string;
  cfg?: Record<string, unknown>;
  accountId?: string | null;
}): Promise<SendResult> {
  const effectiveAccountId = resolveEffectiveAccountId(params.accountId);
  const outbound = getOutboundForAccount(effectiveAccountId);
  if (!outbound || !effectiveAccountId) {
    return { ok: false, error: "Not connected" };
  }
  try {
    const account = resolveAccount(params.cfg ?? {}, effectiveAccountId);
    const accountContext = getAccountContextForAccount(effectiveAccountId);
    const mergedAccount = {
      ...account,
      token: account.token || accountContext?.token || "",
      wsUrl:
        account.wsUrl === DEFAULT_TYPE_WS_URL && accountContext?.wsUrl
          ? accountContext.wsUrl
          : account.wsUrl,
      agentId: account.agentId || accountContext?.agentId || "",
    };
    const channelId = await resolveChannelId(params.to, mergedAccount);
    const routingResult = resolveParentMessageIdForSend({
      channelId,
      replyToId: params.replyToId,
    });
    if (!routingResult.ok) {
      return routingResult;
    }
    const { sent, requestId } = outbound.sendMessage(
      channelId,
      params.text,
      routingResult.parentMessageId,
    );
    if (!sent) {
      return { ok: false, error: "Failed to send message" };
    }
    const ackResult = await waitForSendAck(effectiveAccountId, requestId);
    return fromAckResult({
      ackResult,
      channelId,
      parentMessageId: routingResult.parentMessageId,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendMediaToType(params: {
  to: string;
  text: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  replyToId?: string;
  cfg?: Record<string, unknown>;
  accountId?: string | null;
}): Promise<SendResult> {
  const effectiveAccountId = resolveEffectiveAccountId(params.accountId);
  const outbound = getOutboundForAccount(effectiveAccountId);
  if (!outbound || !effectiveAccountId) {
    return { ok: false, error: "Not connected" };
  }
  try {
    const account = resolveAccount(params.cfg ?? {}, effectiveAccountId);
    const accountContext = getAccountContextForAccount(effectiveAccountId);
    const mergedAccount = {
      ...account,
      token: account.token || accountContext?.token || "",
      wsUrl:
        account.wsUrl === DEFAULT_TYPE_WS_URL && accountContext?.wsUrl
          ? accountContext.wsUrl
          : account.wsUrl,
      agentId: account.agentId || accountContext?.agentId || "",
    };
    const effectiveMediaLocalRoots = resolveEffectiveMediaLocalRoots({
      configuredRoots: account.mediaLocalRoots,
      requestedRoots: params.mediaLocalRoots,
    });
    const channelId = await resolveChannelId(params.to, mergedAccount);

    const routingResult = resolveParentMessageIdForSend({
      channelId,
      replyToId: params.replyToId,
    });
    if (!routingResult.ok) {
      return routingResult;
    }

    const uploadedMedia = await uploadMediaForType({
      mediaUrl: params.mediaUrl,
      mediaLocalRoots: effectiveMediaLocalRoots,
      channelId,
      account: mergedAccount,
    });

    const caption =
      params.text.trim().length > 0 ? params.text : "Sent an attachment.";
    const { sent, requestId } = outbound.sendMessage(
      channelId,
      caption,
      routingResult.parentMessageId,
      [uploadedMedia.fileId],
    );
    if (!sent) {
      return { ok: false, error: "Failed to send message" };
    }
    const ackResult = await waitForSendAck(effectiveAccountId, requestId);
    return fromAckResult({
      ackResult,
      channelId,
      parentMessageId: routingResult.parentMessageId,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
