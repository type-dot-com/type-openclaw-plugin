/**
 * Stream Session
 *
 * Manages the lifecycle of a single streaming response: lazy
 * stream_start, ack gating, token/event buffering, and finish.
 */

import type { z } from "zod";
import type { ToolEventPayload, ToolEventPayloadSchema } from "./toolEvents.js";

const ACK_TIMEOUT_MS = 5000;

export interface StreamOutbound {
  startStream: (messageId: string) => boolean;
  streamToken: (messageId: string, text: string) => boolean;
  streamEvent: (
    messageId: string,
    event: z.infer<typeof ToolEventPayloadSchema>,
  ) => boolean;
  finishStream: (messageId: string) => boolean;
}

export class StreamSession {
  readonly #outbound: StreamOutbound;
  readonly #messageId: string;

  #failed = false;
  #started = false;
  #ready = false;
  #finishRequested = false;
  #finishSent = false;
  #lastSentLength = 0;

  #pendingTokens: string[] = [];
  #pendingToolEvents: ToolEventPayload[] = [];
  #pendingAck: { resolve: () => void; reject: (err: Error) => void } | null =
    null;
  #ackTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(outbound: StreamOutbound, messageId: string) {
    this.#outbound = outbound;
    this.#messageId = messageId;
  }

  get isFailed(): boolean {
    return this.#failed;
  }

  get isStarted(): boolean {
    return this.#started;
  }

  get isAwaitingAck(): boolean {
    return this.#pendingAck !== null;
  }

  /**
   * Lazily send stream_start if not already started.
   * Sets up the ack promise with a timeout. Call onAck() / onAckError()
   * from the server response handler to resolve/reject.
   */
  ensureStarted(): void {
    if (this.#started || this.#failed) return;

    const sent = this.#outbound.startStream(this.#messageId);
    if (!sent) {
      this.#markSendFailed({
        kind: "stream_start",
        message: "startStream send failed (connection not open)",
      });
      return;
    }
    this.#started = true;

    this.#pendingAck = {
      resolve: () => {
        this.#clearAckTimeout();
        this.#ready = true;
        this.#flushBuffers();
        if (this.#finishRequested && !this.#finishSent && !this.#failed) {
          this.#sendFinish();
        }
      },
      reject: (err: Error) => {
        this.#clearAckTimeout();
        this.#markSendFailed({
          kind: "stream_start",
          message: `stream_start rejected: ${err.message}`,
        });
      },
    };

    this.#ackTimeoutId = setTimeout(() => {
      this.#ackTimeoutId = null;
      if (this.#pendingAck) {
        this.#pendingAck.reject(new Error("stream_start ack timeout"));
        this.#pendingAck = null;
      }
    }, ACK_TIMEOUT_MS);
  }

  /**
   * Called by the server response handler when stream_start is acknowledged.
   */
  onAck(): void {
    if (this.#pendingAck) {
      this.#pendingAck.resolve();
      this.#pendingAck = null;
    }
  }

  /**
   * Called by the server response handler when stream_start fails.
   */
  onAckError(error: Error): void {
    if (this.#pendingAck) {
      this.#pendingAck.reject(error);
      this.#pendingAck = null;
    }
  }

  /**
   * Send a text token delta. Computes the delta from accumulated text,
   * buffering if the stream_start ack hasn't arrived yet.
   */
  sendToken(fullText: string): void {
    if (this.#failed || this.#finishSent) return;

    const delta = fullText.slice(this.#lastSentLength);
    if (delta.length === 0) return;
    this.#lastSentLength = fullText.length;

    this.ensureStarted();
    if (this.#failed) return;

    if (this.#ready) {
      const sent = this.#outbound.streamToken(this.#messageId, delta);
      if (!sent) {
        this.#markSendFailed({
          kind: "stream_token",
          message: "streamToken send failed (connection not open)",
        });
      }
    } else {
      this.#pendingTokens.push(delta);
    }
  }

  /**
   * Send a tool event (tool-call, tool-result, etc.), buffering if needed.
   */
  sendToolEvent(event: ToolEventPayload): void {
    if (this.#failed || this.#finishSent) return;

    this.ensureStarted();
    if (this.#failed) return;

    if (this.#ready) {
      const sent = this.#outbound.streamEvent(this.#messageId, event);
      if (!sent) {
        this.#markSendFailed({
          kind: "stream_event",
          eventKind: event.kind,
          message: "streamEvent send failed (connection not open)",
        });
      }
    } else {
      this.#pendingToolEvents.push(event);
    }
  }

  /**
   * Finalize the stream. Call after dispatch completes (success or error).
   */
  finish(): void {
    if (!this.#started || this.#failed || this.#finishSent) return;
    this.#finishRequested = true;

    if (!this.#ready) return;

    this.#sendFinish();
  }

  #sendFinish(): void {
    if (this.#failed) {
      this.#finishRequested = false;
      return;
    }
    const finished = this.#outbound.finishStream(this.#messageId);
    if (!finished) {
      this.#markSendFailed({
        kind: "stream_finish",
        message:
          "finishStream send failed (connection not open), stream will idle-timeout on server",
      });
      return;
    }
    this.#finishSent = true;
    this.#finishRequested = false;
  }

  #clearAckTimeout(): void {
    if (this.#ackTimeoutId) {
      clearTimeout(this.#ackTimeoutId);
      this.#ackTimeoutId = null;
    }
  }

  #flushBuffers(): void {
    // Flush tool events first (they came before text)
    for (const evt of this.#pendingToolEvents) {
      if (this.#failed) break;
      const sent = this.#outbound.streamEvent(this.#messageId, evt);
      if (!sent) {
        this.#markSendFailed({
          kind: "stream_event",
          eventKind: evt.kind,
          message: "streamEvent send failed (connection not open)",
        });
        break;
      }
    }
    this.#pendingToolEvents.length = 0;

    // Then flush text tokens
    for (const text of this.#pendingTokens) {
      if (this.#failed) break;
      const sent = this.#outbound.streamToken(this.#messageId, text);
      if (!sent) {
        this.#markSendFailed({
          kind: "stream_token",
          message: "streamToken send failed (connection not open)",
        });
      }
    }
    this.#pendingTokens.length = 0;
  }

  #markSendFailed(params: {
    kind: "stream_start" | "stream_token" | "stream_event" | "stream_finish";
    message: string;
    eventKind?: string;
  }): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#clearAckTimeout();
    this.#pendingAck = null;
    this.#finishRequested = false;
    this.#pendingTokens.length = 0;
    this.#pendingToolEvents.length = 0;

    const context = {
      messageId: this.#messageId,
      sendKind: params.kind,
      eventKind: params.eventKind ?? null,
    };
    console.error(`[type] ${params.message}`, context);
  }
}
