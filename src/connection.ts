/**
 * WebSocket Connection Manager
 *
 * Manages the WebSocket connection to the Type server. Handles:
 * - Authentication via Authorization header
 * - Automatic reconnection with exponential backoff + jitter
 * - Ping/pong keepalive
 * - Message sending and receiving
 */

import WebSocket from "ws";
import {
  type TypeInboundEvent,
  type TypeOutboundMessage,
  typeInboundEventSchema,
} from "./protocol.js";

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;
const PING_INTERVAL_MS = 30000; // App-level keepalive every 30s
const CONTROL_PING_INTERVAL_MS = 20000; // WebSocket control-frame ping every 20s
const LIVENESS_STALE_MS = 45000;
const HEALTH_CHECK_INTERVAL_MS = 5000;

export interface ConnectionConfig {
  token: string;
  wsUrl: string;
  onMessage: (event: TypeInboundEvent) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export class TypeConnection {
  private ws: WebSocket | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private appPingInterval: ReturnType<typeof setInterval> | null = null;
  private controlPingInterval: ReturnType<typeof setInterval> | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private connectedAtMs: number | null = null;
  private lastInboundAtMs: number | null = null;
  private lastControlPongAtMs: number | null = null;
  private readonly config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  connect(): void {
    this.stopped = false;
    this.doConnect();
  }

  disconnect(): void {
    this.stopped = true;
    this.stopKeepaliveIntervals();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private startKeepaliveIntervals(ws: WebSocket): void {
    this.stopKeepaliveIntervals();

    this.appPingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const sent = this.send({ type: "ping" });
      if (!sent) {
        console.warn("[Type WS] Failed to send app-level ping");
      }
    }, PING_INTERVAL_MS);

    this.controlPingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch (error) {
        console.warn("[Type WS] Failed to send control-frame ping", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, CONTROL_PING_INTERVAL_MS);

    this.healthCheckInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const nowMs = Date.now();
      const mostRecentActivityMs = Math.max(
        this.lastInboundAtMs ?? 0,
        this.lastControlPongAtMs ?? 0,
      );
      const idleForMs = nowMs - mostRecentActivityMs;
      if (idleForMs <= LIVENESS_STALE_MS) return;

      console.warn("[Type WS] Connection appears stale; terminating socket", {
        idleForMs,
        livenessThresholdMs: LIVENESS_STALE_MS,
      });
      ws.terminate();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopKeepaliveIntervals(): void {
    if (this.appPingInterval) {
      clearInterval(this.appPingInterval);
      this.appPingInterval = null;
    }
    if (this.controlPingInterval) {
      clearInterval(this.controlPingInterval);
      this.controlPingInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  send(message: TypeOutboundMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // --- Internal ---

  private doConnect(): void {
    if (this.stopped) return;

    const ws = new WebSocket(this.config.wsUrl, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      const nowMs = Date.now();
      this.connectedAtMs = nowMs;
      this.lastInboundAtMs = nowMs;
      this.lastControlPongAtMs = nowMs;
      this.reconnectAttempts = 0;
      this.startKeepaliveIntervals(ws);
      console.log("[Type WS] Connected");
      this.config.onConnected?.();
    });

    ws.on("message", (data: WebSocket.Data) => {
      this.lastInboundAtMs = Date.now();
      this.handleMessage(data.toString());
    });

    ws.on("pong", () => {
      this.lastControlPongAtMs = Date.now();
    });

    ws.on("error", (err: Error) => {
      console.error("[Type WS] Connection error:", err.message);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const nowMs = Date.now();
      const connectedAtMs = this.connectedAtMs;
      const lastInboundAtMs = this.lastInboundAtMs;
      const lastControlPongAtMs = this.lastControlPongAtMs;
      console.warn("[Type WS] Connection closed", {
        code,
        reason: reason.toString("utf8"),
        connectionAgeMs: connectedAtMs === null ? null : nowMs - connectedAtMs,
        lastInboundAgeMs:
          lastInboundAtMs === null ? null : nowMs - lastInboundAtMs,
        lastControlPongAgeMs:
          lastControlPongAtMs === null ? null : nowMs - lastControlPongAtMs,
      });

      this.ws = null;
      this.connectedAtMs = null;
      this.lastInboundAtMs = null;
      this.lastControlPongAtMs = null;
      this.stopKeepaliveIntervals();
      this.config.onDisconnected?.();
      // Code 4000 = replaced by another connection — don't reconnect (avoids storm)
      if (!this.stopped && code !== 4000) {
        this.scheduleReconnect();
      }
    });
  }

  private handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      console.error("[Type WS] Failed to parse message:", raw);
      return;
    }

    const parsed = typeInboundEventSchema.safeParse(json);
    if (!parsed.success) {
      console.error("[Type WS] Unknown message shape:", raw);
      return;
    }

    const msg = parsed.data;

    // Handle ping/pong internally (keepalive)
    if (msg.type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if (msg.type === "pong") {
      // Acknowledgement of our keepalive ping — no action needed
      return;
    }

    // Forward all other events to the callback
    this.config.onMessage(msg);
  }

  private scheduleReconnect(): void {
    const baseDelay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    // Add jitter to prevent thundering herd
    const delay = Math.round(baseDelay * (0.5 + Math.random() * 0.5));
    this.reconnectAttempts++;
    console.log(
      `[Type WS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`,
    );
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.doConnect();
    }, delay);
  }
}
