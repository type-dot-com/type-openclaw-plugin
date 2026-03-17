/**
 * Outbound Message Handler
 *
 * Wraps the WebSocket connection with typed methods for sending
 * messages and streaming responses back to Type.
 */

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
   */
  sendMessage(
    channelId: string,
    content: string,
    parentMessageId?: string,
    fileIds?: string[],
  ): boolean {
    return this.connection.send({
      type: "send",
      channelId,
      content,
      parentMessageId,
      ...(fileIds?.length ? { fileIds } : {}),
    });
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

export async function sendTextToType(params: {
  to: string;
  text: string;
  replyToId?: string;
  cfg?: Record<string, unknown>;
  accountId?: string | null;
}): Promise<{ ok: true; channel: string } | { ok: false; error: string }> {
  const effectiveAccountId = resolveEffectiveAccountId(params.accountId);
  const outbound = getOutboundForAccount(effectiveAccountId);
  if (!outbound) {
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
    const sent = outbound.sendMessage(
      channelId,
      params.text,
      routingResult.parentMessageId,
    );
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
}

export async function sendMediaToType(params: {
  to: string;
  text: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  replyToId?: string;
  cfg?: Record<string, unknown>;
  accountId?: string | null;
}): Promise<{ ok: true; channel: string } | { ok: false; error: string }> {
  const effectiveAccountId = resolveEffectiveAccountId(params.accountId);
  const outbound = getOutboundForAccount(effectiveAccountId);
  if (!outbound) {
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
    const sent = outbound.sendMessage(
      channelId,
      caption,
      routingResult.parentMessageId,
      [uploadedMedia.fileId],
    );
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
}
