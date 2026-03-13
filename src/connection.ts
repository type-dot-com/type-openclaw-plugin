/**
 * WebSocket Connection Manager
 *
 * Manages the WebSocket connection to the Type server using partysocket
 * for automatic reconnection with exponential backoff and message buffering.
 *
 * Handles:
 * - Authentication via Authorization header
 * - Automatic reconnection with exponential backoff
 * - App-level ping/pong keepalive
 * - Message buffering during brief disconnections
 */

import type { CloseEvent } from "partysocket/ws";
import ReconnectingWebSocket from "partysocket/ws";
import WS from "ws";
import {
  type TypeInboundEvent,
  type TypeOutboundMessage,
  typeInboundEventSchema,
} from "./protocol.js";
import { captureEvent, captureException } from "./telemetry.js";

const PING_INTERVAL_MS = 30_000;
const MAX_ENQUEUED_MESSAGES = 4_096;

// Close codes that should NOT trigger reconnection
const PERMANENT_CLOSE_CODES = new Set([
  4000, // Replaced by another connection — don't reconnect (avoids storm)
]);

export interface ConnectionConfig {
  token: string;
  wsUrl: string;
  onMessage: (event: TypeInboundEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (event: {
    code: number;
    reason: string;
    willReconnect: boolean;
  }) => void;
}

/**
 * Creates a WebSocket class that injects the Authorization header.
 * partysocket calls `new WebSocket(url, protocols)` internally,
 * so we extend `ws` to add the auth header in the constructor.
 */
function createAuthWsClass(token: string) {
  return class AuthWebSocket extends WS {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  };
}

export class TypeConnection {
  private ws: ReconnectingWebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private manuallyClosed = false;
  private reconnectPending = false;
  private readonly config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  connect(): void {
    if (this.ws) {
      return;
    }

    this.manuallyClosed = false;
    const ws = new ReconnectingWebSocket(this.config.wsUrl, [], {
      WebSocket: createAuthWsClass(
        this.config.token,
      ) as unknown as typeof globalThis.WebSocket,
      minReconnectionDelay: 1_000,
      maxReconnectionDelay: 60_000,
      reconnectionDelayGrowFactor: 2,
      connectionTimeout: 30_000,
      maxRetries: Number.POSITIVE_INFINITY,
      maxEnqueuedMessages: MAX_ENQUEUED_MESSAGES,
    });

    ws.addEventListener("open", () => {
      this.clearReconnectPending();
      this.startPingInterval();
      console.log("[Type WS] Connected");
      captureEvent("ws_connected", { wsUrl: this.config.wsUrl });
      this.config.onConnected?.();
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const data =
        typeof event.data === "string" ? event.data : String(event.data);
      this.handleMessage(data);
    });

    ws.addEventListener("error", (event: Event) => {
      const errorEvent = event as ErrorEvent;
      const message = errorEvent.message ?? "unknown";
      console.error("[Type WS] Connection error:", message);
      captureEvent("ws_error", { error: message });
      captureException(new Error(`WebSocket connection error: ${message}`), {
        properties: { source: "websocket_error" },
      });
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      const willReconnect =
        !this.manuallyClosed &&
        !PERMANENT_CLOSE_CODES.has(event.code) &&
        ws.shouldReconnect;

      console.warn("[Type WS] Connection closed", {
        code: event.code,
        reason: event.reason,
        willReconnect,
      });
      captureEvent("ws_disconnected", {
        code: event.code,
        reason: event.reason,
        willReconnect,
      });

      this.stopPingInterval();
      this.config.onDisconnected?.({
        code: event.code,
        reason: event.reason,
        willReconnect,
      });

      if (!willReconnect) {
        this.clearReconnectPending();
        console.warn(
          `[Type WS] Stopping reconnection after close code ${event.code}`,
        );
        ws.close();
        if (this.ws === ws) {
          this.ws = null;
        }
      }
    });

    this.ws = ws;
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearReconnectPending();
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  requestReconnectOnce(reason = "reconnect requested"): boolean {
    if (this.reconnectPending) {
      return false;
    }
    this.reconnectPending = true;
    this.reconnect(reason);
    return true;
  }

  reconnect(reason = "reconnect requested"): void {
    this.manuallyClosed = false;
    this.stopPingInterval();
    if (!this.ws) {
      this.connect();
      return;
    }
    this.ws.reconnect(1012, reason.slice(0, 123));
  }

  send(message: TypeOutboundMessage): boolean {
    if (!this.ws || this.manuallyClosed) {
      return false;
    }
    try {
      if (
        this.ws.readyState === ReconnectingWebSocket.CLOSED &&
        !this.ws.shouldReconnect
      ) {
        return false;
      }
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  sendNow(message: TypeOutboundMessage): boolean {
    if (!this.ws || this.manuallyClosed) {
      return false;
    }
    if (this.ws.readyState !== ReconnectingWebSocket.OPEN) {
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
    return this.ws?.readyState === ReconnectingWebSocket.OPEN;
  }

  // --- Internal ---

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      this.send({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private clearReconnectPending(): void {
    this.reconnectPending = false;
  }

  private handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      console.error(`[Type WS] Failed to parse message (${raw.length} bytes)`);
      captureException(new Error("Failed to parse WebSocket message"), {
        properties: { source: "message_parse", rawLength: raw.length },
      });
      return;
    }

    const parsed = typeInboundEventSchema.safeParse(json);
    if (!parsed.success) {
      const msgType =
        typeof json === "object" && json !== null
          ? (json as Record<string, unknown>).type
          : undefined;
      console.error(
        `[Type WS] Unknown message shape (${raw.length} bytes, type=${String(msgType)})`,
      );
      captureException(new Error("Unknown WebSocket message shape"), {
        properties: {
          source: "message_parse",
          rawLength: raw.length,
          type: msgType,
        },
      });
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
}
