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
const PING_INTERVAL_MS = 30000; // Client-side keepalive every 30s
const PONG_TIMEOUT_FACTOR = 3; // Force reconnect after N missed pongs

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
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private _reconnectAttempts = 0;
  private stopped = false;
  private _lastPongAt: number = 0;
  private _consecutiveAckFailures = 0;
  private readonly config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  get reconnectAttempts(): number {
    return this._reconnectAttempts;
  }

  get lastPongAt(): number {
    return this._lastPongAt;
  }

  get consecutiveAckFailures(): number {
    return this._consecutiveAckFailures;
  }

  /** Record a stream_start ack success (resets failure counter). */
  recordAckSuccess(): void {
    this._consecutiveAckFailures = 0;
  }

  /** Record a stream_start ack failure. Force reconnect after 3 in a row. */
  recordAckFailure(): void {
    this._consecutiveAckFailures++;
    if (this._consecutiveAckFailures >= 3) {
      console.error(
        `[Type WS] ${this._consecutiveAckFailures} consecutive ack failures — forcing reconnect`,
      );
      this.forceReconnect();
    }
  }

  connect(): void {
    this.stopped = false;
    this.doConnect();
  }

  disconnect(): void {
    this.stopped = true;
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  /** Force-close the current connection and trigger reconnect. */
  private forceReconnect(): void {
    if (this.stopped) return;
    console.warn("[Type WS] Forcing reconnect...");
    this.stopPingInterval();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.scheduleReconnect();
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this._lastPongAt = Date.now(); // assume healthy at connect
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Check for pong timeout before sending next ping
        const sincePong = Date.now() - this._lastPongAt;
        if (sincePong > PING_INTERVAL_MS * PONG_TIMEOUT_FACTOR) {
          console.error(
            `[Type WS] No pong received in ${(sincePong / 1000).toFixed(0)}s — forcing reconnect`,
          );
          this.forceReconnect();
          return;
        }
        this.send({ type: "ping" });
      }
    }, PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
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
      this._reconnectAttempts = 0;
      this._consecutiveAckFailures = 0;
      this.startPingInterval();
      this.config.onConnected?.();
    });

    ws.on("message", (data: WebSocket.Data) => {
      this.handleMessage(data.toString());
    });

    ws.on("error", (err: Error) => {
      console.error("[Type WS] Connection error:", err.message);
    });

    ws.on("close", (code: number) => {
      this.ws = null;
      this.stopPingInterval();
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
      this._lastPongAt = Date.now();
      return;
    }

    // Forward all other events to the callback
    this.config.onMessage(msg);
  }

  private scheduleReconnect(): void {
    const baseDelay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this._reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    // Add jitter to prevent thundering herd
    const delay = Math.round(baseDelay * (0.5 + Math.random() * 0.5));
    this._reconnectAttempts++;
    console.log(
      `[Type WS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this._reconnectAttempts})...`,
    );
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.doConnect();
    }, delay);
  }
}
