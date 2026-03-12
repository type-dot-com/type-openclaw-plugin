/**
 * Telemetry Client
 *
 * Reports errors, exceptions, and events to the Type server's telemetry
 * endpoint (`POST /api/agents/:agentId/telemetry`). The server forwards
 * these to PostHog and structured logging.
 *
 * Supports multiple accounts: each account registers its own config,
 * and logs are flushed to all active accounts' endpoints.
 *
 * Requires `initializeTelemetry()` to be called with account context
 * before `captureException()` or `captureEvent()` will do anything.
 * All operations are fire-and-forget and never throw.
 */

import { resolveApiOriginFromWsUrl } from "./apiOrigin.js";

const TELEMETRY_TIMEOUT_MS = 5_000;
const BATCH_INTERVAL_MS = 5_000;
const MAX_BATCH_SIZE = 50;

interface TelemetryConfig {
  token: string;
  wsUrl: string;
  agentId: string;
}

interface TelemetryLogEntry {
  level: "error" | "warn" | "info";
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
  error?: { message: string; name?: string; stack?: string };
}

const accounts = new Map<string, TelemetryConfig>();
const pendingLogs: TelemetryLogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function initializeTelemetry(accountConfig: TelemetryConfig): void {
  accounts.set(accountConfig.agentId, accountConfig);

  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flushTelemetry();
    }, BATCH_INTERVAL_MS);
  }
}

export function teardownTelemetry(agentId?: string): void {
  if (agentId) {
    // Single-account teardown: save config for final flush, then remove
    const savedConfig = accounts.get(agentId);
    accounts.delete(agentId);

    if (accounts.size > 0) return;

    // Last account removed — stop timer and flush remaining logs
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (savedConfig && pendingLogs.length > 0) {
      void flushWithConfig(savedConfig);
    }
  } else {
    // Global teardown: flush with any available config, then clear all
    const anyConfig = accounts.values().next().value as
      | TelemetryConfig
      | undefined;

    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (anyConfig && pendingLogs.length > 0) {
      void flushWithConfig(anyConfig);
    }
    accounts.clear();
  }
}

export function captureException(
  error: unknown,
  context?: { properties?: Record<string, unknown> },
): void {
  if (accounts.size === 0) return;

  const err = error instanceof Error ? error : new Error(String(error));

  pendingLogs.push({
    level: "error",
    message: err.message,
    timestamp: new Date().toISOString(),
    context: {
      source: "openclaw-type",
      ...context?.properties,
    },
    error: {
      message: err.message,
      name: err.name,
      stack: err.stack,
    },
  });

  // Flush immediately if batch is full
  if (pendingLogs.length >= MAX_BATCH_SIZE) {
    void flushTelemetry();
  }
}

export function captureEvent(
  message: string,
  properties?: Record<string, unknown>,
): void {
  if (accounts.size === 0) return;

  pendingLogs.push({
    level: "info",
    message,
    timestamp: new Date().toISOString(),
    context: {
      source: "openclaw-type",
      ...properties,
    },
  });

  if (pendingLogs.length >= MAX_BATCH_SIZE) {
    void flushTelemetry();
  }
}

async function flushTelemetry(): Promise<void> {
  if (pendingLogs.length === 0) return;

  // Use the first available account config
  const config = accounts.values().next().value;
  if (!config) return;

  await flushWithConfig(config);
}

async function flushWithConfig(config: TelemetryConfig): Promise<void> {
  if (pendingLogs.length === 0) return;

  const logs = pendingLogs.splice(0, MAX_BATCH_SIZE);

  const apiOrigin = resolveApiOriginFromWsUrl(config.wsUrl);
  if (!apiOrigin) return;
  const url = `${apiOrigin}/api/agents/${encodeURIComponent(config.agentId)}/telemetry`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "openclaw-type",
        logs,
      }),
      signal: controller.signal,
    });
  } catch {
    // Silently drop — telemetry should never block the plugin
  } finally {
    clearTimeout(timeoutId);
  }
}
