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
 * Questions are stored in a keyed map (by toolCallId) so concurrent
 * sessions across accounts don't overwrite each other.
 */

const pendingQuestions = new Map<string, string>();

export function setPendingAskUserQuestion(
  key: string,
  question: string | undefined,
): void {
  if (!question) {
    pendingQuestions.delete(key);
    return;
  }
  pendingQuestions.set(key, question);
}

/**
 * Retrieve and clear a pending question (consume-once).
 */
export function consumePendingAskUserQuestion(
  key: string | undefined,
): string | undefined {
  if (!key) return undefined;
  const question = pendingQuestions.get(key);
  pendingQuestions.delete(key);
  return question;
}
