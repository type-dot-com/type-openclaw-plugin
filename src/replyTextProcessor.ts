/**
 * Reply Text Processor
 *
 * Encapsulates the mutable state and sentinel-detection logic used when
 * processing streamed reply text from OpenClaw. Extracted from
 * messageHandler.ts to reduce nesting and isolate testable logic.
 */

import { consumePendingAskUserQuestion } from "./askUserState.js";
import type { StreamSession } from "./streamSession.js";
import { createToolEvents, parseToolText } from "./toolEvents.js";

const NO_REPLY_SENTINEL = "NO_REPLY";
const NO_REPLY_SHORT_SENTINEL = "NO";
const NEEDS_REPLY_SENTINEL = "NEEDS_REPLY";
const ASK_USER_TOOL_NAMES = new Set(["askuser", "ask_user", "ask user"]);

export interface ReplyTextResult {
  needsReply: boolean;
  needsReplyQuestion: string | undefined;
}

/**
 * Processes streamed reply text, detecting sentinel values and ask_user
 * tool calls. Owns all mutable state that was previously scattered as
 * loose variables in the message handler closure.
 */
export class ReplyTextProcessor {
  readonly #session: StreamSession;
  readonly #onSessionStarted: () => void;

  #pendingCandidate: string | null = null;
  #noReplySuppressed = false;
  #sawToolEvent = false;
  #needsReply = false;
  #needsReplyQuestion: string | undefined;

  constructor(session: StreamSession, onSessionStarted: () => void) {
    this.#session = session;
    this.#onSessionStarted = onSessionStarted;
  }

  get result(): ReplyTextResult {
    return {
      needsReply: this.#needsReply,
      needsReplyQuestion: this.#needsReplyQuestion,
    };
  }

  markToolEventSeen(): void {
    this.#sawToolEvent = true;
  }

  /**
   * Process a partial reply text chunk. Call with `isFinalAttempt: true`
   * when flushing remaining buffered text after the stream ends.
   */
  processText(text: string, isFinalAttempt: boolean): void {
    if (this.#session.isFailed || this.#noReplySuppressed) return;
    if (text.trim().length === 0) return;

    const candidateText = this.#buildCandidateText(text);
    const upperTrimmed = candidateText.trim().toUpperCase();

    if (this.#checkNoReplySentinel(upperTrimmed)) return;
    if (
      this.#checkNeedsReplySentinel(upperTrimmed, candidateText, isFinalAttempt)
    )
      return;
    if (this.#checkSentinelPrefix(candidateText, upperTrimmed, isFinalAttempt))
      return;

    this.#sendToken(candidateText);
  }

  /**
   * Handle a tool delivery event. Returns true if the tool was an
   * ask_user that was intercepted (caller should skip normal tool
   * forwarding).
   */
  handleToolDelivery(text: string, opts?: { toolCallId?: string }): boolean {
    this.markToolEventSeen();
    if (this.#session.isFailed) return false;

    const parsed = parseToolText(text);
    const normalizedName = parsed.toolName.toLowerCase().trim();
    const isAskUser =
      ASK_USER_TOOL_NAMES.has(normalizedName) ||
      (normalizedName === "tool" &&
        ASK_USER_TOOL_NAMES.has(parsed.toolOutput.toLowerCase().trim()));

    if (isAskUser) {
      this.#needsReply = true;
      const trimmedOutput = parsed.toolOutput.trim();
      const outputIsToolName =
        normalizedName === "tool" &&
        ASK_USER_TOOL_NAMES.has(trimmedOutput.toLowerCase());
      this.#needsReplyQuestion =
        consumePendingAskUserQuestion(opts?.toolCallId) ||
        (outputIsToolName ? undefined : trimmedOutput || undefined);
      this.#session.resetTextAccumulator();
      return true;
    }

    const [toolCall, toolResult] = createToolEvents(text);
    this.#session.sendToolEvent(toolCall);
    this.#session.sendToolEvent(toolResult);
    this.#session.resetTextAccumulator();
    if (this.#session.isStarted && !this.#session.isFailed) {
      this.#onSessionStarted();
    }
    return false;
  }

  /**
   * Flush any buffered sentinel-candidate text as a final attempt.
   */
  flush(): void {
    if (!this.#pendingCandidate || this.#noReplySuppressed) return;
    const pending = this.#pendingCandidate;
    this.#pendingCandidate = null;
    this.processText(pending, true);
  }

  // -- Private helpers --

  #buildCandidateText(text: string): string {
    if (!this.#pendingCandidate) return text;
    const combined = text.startsWith(this.#pendingCandidate)
      ? text
      : `${this.#pendingCandidate}${text}`;
    return combined;
  }

  #effectiveSentinels(): readonly string[] {
    return this.#sawToolEvent
      ? [NO_REPLY_SENTINEL, NO_REPLY_SHORT_SENTINEL]
      : [NO_REPLY_SENTINEL];
  }

  #checkNoReplySentinel(upperTrimmed: string): boolean {
    if (!this.#effectiveSentinels().includes(upperTrimmed)) return false;
    this.#noReplySuppressed = true;
    this.#pendingCandidate = null;
    return true;
  }

  #checkNeedsReplySentinel(
    upperTrimmed: string,
    candidateText: string,
    isFinalAttempt: boolean,
  ): boolean {
    if (!upperTrimmed.startsWith(`${NEEDS_REPLY_SENTINEL}:`)) return false;
    if (!isFinalAttempt) {
      this.#pendingCandidate = candidateText;
      return true;
    }
    this.#needsReply = true;
    this.#needsReplyQuestion =
      candidateText.trim().slice(`${NEEDS_REPLY_SENTINEL}:`.length).trim() ||
      undefined;
    this.#pendingCandidate = null;
    return true;
  }

  #checkSentinelPrefix(
    candidateText: string,
    upperTrimmed: string,
    isFinalAttempt: boolean,
  ): boolean {
    const isPossiblePrefix =
      this.#effectiveSentinels().some((s) => s.startsWith(upperTrimmed)) ||
      NEEDS_REPLY_SENTINEL.startsWith(upperTrimmed);

    if (!isPossiblePrefix) {
      this.#pendingCandidate = null;
      return false;
    }

    // Possible prefix — buffer unless this is the final attempt
    if (!isFinalAttempt) {
      this.#pendingCandidate = candidateText;
      return true;
    }
    return false;
  }

  #sendToken(text: string): void {
    this.#pendingCandidate = null;
    this.#session.sendToken(text);
    if (this.#session.isStarted) {
      this.#onSessionStarted();
    }
  }
}
