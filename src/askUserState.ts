/**
 * Shared state for the ask_user tool.
 *
 * The ask_user tool's execute function stores the question text here,
 * and the messageHandler's deliver callback retrieves it. This avoids
 * a circular dependency between index.ts and messageHandler.ts.
 *
 * OpenClaw's formatToolAggregate strips the question from the delivered
 * payload (verbose mode produces "🧩 Ask User" without the question),
 * so this module bridges the gap.
 *
 * Questions are stored in a keyed map (by toolCallId) and tagged with
 * a scopeId (messageId) so the FIFO fallback only consumes questions
 * from the same dispatch — preventing cross-session stealing when
 * multiple agents share a gateway process.
 *
 * Scope propagation uses AsyncLocalStorage so concurrent dispatches
 * each see their own scopeId without a shared mutable global.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface PendingEntry {
  scopeId: string;
  question: string;
}

const pendingQuestions = new Map<string, PendingEntry>();
const scopeStorage = new AsyncLocalStorage<string>();

/**
 * Run a function within a dispatch scope. The scopeId propagates through
 * the entire async chain (promises, setTimeout, etc.) without shared
 * mutable globals. Replaces the old beginScope/endScope pattern.
 */
export function runInScope<T>(scopeId: string, fn: () => T): T {
  return scopeStorage.run(scopeId, fn);
}

/**
 * Clean up any unconsumed questions for the given scope.
 * Call in .then()/.catch() after a dispatch completes.
 */
export function cleanupScope(scopeId: string): void {
  for (const [key, entry] of pendingQuestions) {
    if (entry.scopeId === scopeId) pendingQuestions.delete(key);
  }
}

export function setPendingAskUserQuestion(
  key: string,
  question: string | undefined,
): void {
  if (!question) {
    pendingQuestions.delete(key);
    return;
  }
  pendingQuestions.set(key, {
    scopeId: scopeStorage.getStore() ?? "unknown",
    question,
  });
}

/**
 * Retrieve and clear a pending question (consume-once).
 *
 * When called with a key, looks up that specific toolCallId (any scope)
 * and returns undefined on miss (no FIFO fallback).
 * When no key is provided, falls back to the oldest entry within the
 * given scopeId — preventing cross-session stealing when multiple
 * agents share a gateway process.
 */
export function consumePendingAskUserQuestion(
  key: string | undefined,
  scopeId?: string,
): string | undefined {
  if (key) {
    const entry = pendingQuestions.get(key);
    if (entry !== undefined) {
      pendingQuestions.delete(key);
      return entry.question;
    }
    // Key was provided but didn't match — don't fall through to FIFO
    // which could consume an unrelated entry.
    return undefined;
  }
  // FIFO fallback only when no specific toolCallId was requested
  const targetScope = scopeId ?? scopeStorage.getStore();
  if (!targetScope) return undefined;
  for (const [k, entry] of pendingQuestions) {
    if (entry.scopeId === targetScope) {
      pendingQuestions.delete(k);
      return entry.question;
    }
  }
  return undefined;
}

/**
 * Wait for a pending question to appear, then consume it.
 *
 * OpenClaw calls the deliver callback BEFORE the tool's execute function,
 * so the question may not be stored yet when deliver fires. This function
 * polls briefly (up to ~100ms) for execute to populate the map.
 */
export async function waitForPendingAskUserQuestion(
  key: string | undefined,
  scopeId?: string,
): Promise<string | undefined> {
  // Try immediate consumption first
  const immediate = consumePendingAskUserQuestion(key, scopeId);
  if (immediate !== undefined) return immediate;

  // Poll a few times with short delays for execute to catch up
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = consumePendingAskUserQuestion(key, scopeId);
    if (result !== undefined) return result;
  }
  return undefined;
}
