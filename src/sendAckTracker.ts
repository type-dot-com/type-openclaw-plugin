/**
 * Send ACK Tracker
 *
 * Tracks pending outbound `send` messages and resolves/rejects
 * promises when the server's success or error response arrives.
 * Uses a client-generated `requestId` for correlation.
 */

const SEND_ACK_TIMEOUT_MS = 15_000;
const KEY_SEP = "\0";

export interface SendAckResult {
  messageId: string;
  channelId: string | null;
  parentMessageId: string | null;
  channelName: string | null;
  channelType: string | null;
  chatType: string | null;
  timestamp: number | null;
}

export type SendAckWaitResult =
  | { ok: true; ack: SendAckResult }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "error"; error: Error };

interface PendingSend {
  settle: (result: SendAckWaitResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingSends = new Map<string, PendingSend>();

function pendingSendKey(accountId: string, requestId: string): string {
  return `${accountId}${KEY_SEP}${requestId}`;
}

export function waitForSendAck(
  accountId: string,
  requestId: string,
  timeoutMs = SEND_ACK_TIMEOUT_MS,
): Promise<SendAckWaitResult> {
  return new Promise<SendAckWaitResult>((resolve) => {
    const key = pendingSendKey(accountId, requestId);
    const timeoutId = setTimeout(() => {
      pendingSends.delete(key);
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);

    pendingSends.set(key, { settle: resolve, timeoutId });
  });
}

export function resolveSendAck(
  accountId: string,
  requestId: string,
  result: SendAckResult,
): boolean {
  const key = pendingSendKey(accountId, requestId);
  const pending = pendingSends.get(key);
  if (!pending) return false;
  clearTimeout(pending.timeoutId);
  pendingSends.delete(key);
  pending.settle({ ok: true, ack: result });
  return true;
}

export function rejectSendAck(
  accountId: string,
  requestId: string,
  error: Error,
): boolean {
  const key = pendingSendKey(accountId, requestId);
  const pending = pendingSends.get(key);
  if (!pending) return false;
  clearTimeout(pending.timeoutId);
  pendingSends.delete(key);
  pending.settle({ ok: false, reason: "error", error });
  return true;
}

export function rejectAllPendingSendAcks(accountId: string): void {
  const error = new Error("Connection lost");
  const keyPrefix = `${accountId}${KEY_SEP}`;
  for (const [key, pending] of pendingSends) {
    if (!key.startsWith(keyPrefix)) {
      continue;
    }
    clearTimeout(pending.timeoutId);
    pendingSends.delete(key);
    pending.settle({ ok: false, reason: "error", error });
  }
}
