/**
 * Outbound Message Handler
 *
 * Wraps the WebSocket connection with typed methods for sending
 * messages and streaming responses back to Type.
 */

import type { TypeConnection } from "./connection.js";

export class TypeOutboundHandler {
  constructor(private readonly connection: TypeConnection) {}

  /**
   * Send a non-streaming full response to a triggered message.
   */
  respond(messageId: string, content: string): boolean {
    return this.connection.send({
      type: "respond",
      messageId,
      content,
    });
  }

  /**
   * Send a proactive message to a channel.
   */
  sendMessage(
    channelId: string,
    content: string,
    parentMessageId?: string,
  ): boolean {
    return this.connection.send({
      type: "send",
      channelId,
      content,
      parentMessageId,
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
   * Finalize a streaming response.
   */
  finishStream(messageId: string): boolean {
    return this.connection.send({
      type: "stream_finish",
      messageId,
    });
  }
}
