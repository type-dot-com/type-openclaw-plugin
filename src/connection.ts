/**
 * WebSocket Connection Manager
 *
 * Manages the WebSocket connection to the Type server. Handles:
 * - Authentication via token in query string
 * - Automatic reconnection with exponential backoff + jitter
 * - Ping/pong keepalive
 * - Message sending and receiving
 */

import WebSocket from "ws";
import type { TypeInboundEvent, TypeOutboundMessage } from "./protocol.js";

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;

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
  private reconnectAttempts = 0;
  private stopped = false;
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
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

    const url = `${this.config.wsUrl}?token=${encodeURIComponent(this.config.token)}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
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
      this.config.onDisconnected?.();
      // Code 4000 = replaced by another connection — don't reconnect (avoids storm)
      if (!this.stopped && code !== 4000) {
        this.scheduleReconnect();
      }
    });
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error("[Type WS] Failed to parse message:", raw);
      return;
    }

    if (typeof msg.type !== "string") return;

    // Handle ping internally
    if (msg.type === "ping") {
      this.send({ type: "pong" });
      return;
    }

    // Forward all other events to the callback
    this.config.onMessage(msg as unknown as TypeInboundEvent);
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
