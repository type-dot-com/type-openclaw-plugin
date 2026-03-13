const ACK_CONFIRMATION_TIMEOUT_MS = 10_000;
const TRACKER_RETENTION_MS = 5 * 60_000;
const KEY_SEP = "\0";

interface TrackedInboundTrigger {
  dispatched: boolean;
  serverAcknowledged: boolean;
  ackTimeoutId: ReturnType<typeof setTimeout> | null;
  cleanupTimeoutId: ReturnType<typeof setTimeout> | null;
  onAckTimeout: () => void;
}

export interface InboundTriggerSnapshot {
  dispatched: boolean;
  serverAcknowledged: boolean;
}

export interface NoteInboundTriggerAckAttemptResult {
  shouldDispatch: boolean;
  wasDuplicate: boolean;
}

const trackedInboundTriggers = new Map<string, TrackedInboundTrigger>();

function toKey(accountId: string, messageId: string): string {
  return `${accountId}${KEY_SEP}${messageId}`;
}

function clearAckTimeout(entry: TrackedInboundTrigger): void {
  if (!entry.ackTimeoutId) return;
  clearTimeout(entry.ackTimeoutId);
  entry.ackTimeoutId = null;
}

function clearCleanupTimeout(entry: TrackedInboundTrigger): void {
  if (!entry.cleanupTimeoutId) return;
  clearTimeout(entry.cleanupTimeoutId);
  entry.cleanupTimeoutId = null;
}

function scheduleCleanup(
  key: string,
  entry: TrackedInboundTrigger,
  retentionMs: number,
): void {
  clearCleanupTimeout(entry);
  entry.cleanupTimeoutId = setTimeout(() => {
    const current = trackedInboundTriggers.get(key);
    if (current === entry) {
      trackedInboundTriggers.delete(key);
    }
  }, retentionMs);
}

export function getInboundTriggerSnapshot(
  accountId: string,
  messageId: string,
): InboundTriggerSnapshot | null {
  const tracked = trackedInboundTriggers.get(toKey(accountId, messageId));
  if (!tracked) return null;
  return {
    dispatched: tracked.dispatched,
    serverAcknowledged: tracked.serverAcknowledged,
  };
}

export function noteInboundTriggerAckAttempt(params: {
  accountId: string;
  messageId: string;
  onAckTimeout: () => void;
  ackTimeoutMs?: number;
  retentionMs?: number;
}): NoteInboundTriggerAckAttemptResult {
  const key = toKey(params.accountId, params.messageId);
  let tracked = trackedInboundTriggers.get(key);
  const wasDuplicate = Boolean(tracked);

  if (!tracked) {
    tracked = {
      dispatched: false,
      serverAcknowledged: false,
      ackTimeoutId: null,
      cleanupTimeoutId: null,
      onAckTimeout: params.onAckTimeout,
    };
    trackedInboundTriggers.set(key, tracked);
  } else {
    tracked.onAckTimeout = params.onAckTimeout;
  }

  if (!tracked.serverAcknowledged) {
    clearAckTimeout(tracked);
    tracked.ackTimeoutId = setTimeout(() => {
      tracked.ackTimeoutId = null;
      if (!tracked.serverAcknowledged) {
        tracked.onAckTimeout();
      }
    }, params.ackTimeoutMs ?? ACK_CONFIRMATION_TIMEOUT_MS);
  }

  scheduleCleanup(key, tracked, params.retentionMs ?? TRACKER_RETENTION_MS);

  const shouldDispatch = !tracked.dispatched && !tracked.serverAcknowledged;
  if (shouldDispatch) {
    tracked.dispatched = true;
  }

  return {
    shouldDispatch,
    wasDuplicate,
  };
}

export function confirmInboundTriggerDelivery(
  accountId: string,
  messageId: string,
): void {
  const tracked = trackedInboundTriggers.get(toKey(accountId, messageId));
  if (!tracked) return;
  tracked.serverAcknowledged = true;
  clearAckTimeout(tracked);
  scheduleCleanup(toKey(accountId, messageId), tracked, TRACKER_RETENTION_MS);
}

export function clearInboundTriggerTrackingForAccount(accountId: string): void {
  const prefix = `${accountId}${KEY_SEP}`;
  for (const [key, tracked] of trackedInboundTriggers.entries()) {
    if (!key.startsWith(prefix)) continue;
    clearAckTimeout(tracked);
    clearCleanupTimeout(tracked);
    trackedInboundTriggers.delete(key);
  }
}
