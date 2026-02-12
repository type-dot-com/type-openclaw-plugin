/**
 * Stream Session
 *
 * Manages the lifecycle of a single streaming response: lazy
 * stream_start, ack gating, token/event buffering, and finish.
 */

import type { TypeOutboundHandler } from "./outbound.js";
import type { ToolEventPayload } from "./toolEvents.js";

const ACK_TIMEOUT_MS = 5000;

export class StreamSession {
  readonly #outbound: TypeOutboundHandler;
  readonly #messageId: string;

  #failed = false;
  #started = false;
  #ready = false;
  #lastSentLength = 0;

  #pendingTokens: string[] = [];
  #pendingToolEvents: ToolEventPayload[] = [];
  #pendingAck: { resolve: () => void; reject: (err: Error) => void } | null =
    null;
  #ackTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(outbound: TypeOutboundHandler, messageId: string) {
    this.#outbound = outbound;
    this.#messageId = messageId;
  }

  get isFailed(): boolean {
    return this.#failed;
  }

  get isStarted(): boolean {
    return this.#started;
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
      console.error("[type] startStream send failed (connection not open)");
      this.#failed = true;
      return;
    }
    this.#started = true;

    this.#pendingAck = {
      resolve: () => {
        this.#clearAckTimeout();
        this.#ready = true;
        this.#flushBuffers();
      },
      reject: (err: Error) => {
        this.#clearAckTimeout();
        console.error(`[type] stream_start rejected: ${err.message}`);
        this.#failed = true;
        this.#pendingTokens.length = 0;
        this.#pendingToolEvents.length = 0;
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
    if (this.#failed) return;

    const delta = fullText.slice(this.#lastSentLength);
    if (delta.length === 0) return;
    this.#lastSentLength = fullText.length;

    this.ensureStarted();
    if (this.#failed) return;

    if (this.#ready) {
      const sent = this.#outbound.streamToken(this.#messageId, delta);
      if (!sent) {
        console.error("[type] streamToken send failed (connection not open)");
        this.#failed = true;
      }
    } else {
      this.#pendingTokens.push(delta);
    }
  }

  /**
   * Send a tool event (tool-call, tool-result, etc.), buffering if needed.
   */
  sendToolEvent(event: ToolEventPayload): void {
    if (this.#failed) return;

    this.ensureStarted();
    if (this.#failed) return;

    if (this.#ready) {
      this.#outbound.streamEvent(this.#messageId, event);
    } else {
      this.#pendingToolEvents.push(event);
    }
  }

  /**
   * Finalize the stream. Call after dispatch completes (success or error).
   */
  finish(): void {
    if (!this.#started) return;
    const finished = this.#outbound.finishStream(this.#messageId);
    if (!finished) {
      console.error(
        "[type] finishStream send failed (connection not open), stream will idle-timeout on server",
      );
    }
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
      this.#outbound.streamEvent(this.#messageId, evt);
    }
    this.#pendingToolEvents.length = 0;

    // Then flush text tokens
    for (const text of this.#pendingTokens) {
      if (this.#failed) break;
      const sent = this.#outbound.streamToken(this.#messageId, text);
      if (!sent) {
        console.error("[type] streamToken send failed (connection not open)");
        this.#failed = true;
      }
    }
    this.#pendingTokens.length = 0;
  }
}
