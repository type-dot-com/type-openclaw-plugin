/**
 * Type WebSocket Protocol Types
 *
 * Defines the message types exchanged over the duplex WebSocket
 * between the OpenClaw plugin and the Type server.
 */

// ---------------------------------------------------------------------------
// Inbound: Type Server -> Plugin
// ---------------------------------------------------------------------------

export interface TypeMessageEvent {
  type: "message";
  messageId: string;
  channelId: string;
  channelName: string | null;
  parentMessageId: string | null;
  sender: {
    id: string;
    name: string;
  } | null;
  content: string | null;
  mentionsAgent: boolean;
  timestamp: number;
}

export interface TypePingEvent {
  type: "ping";
  timestamp: number;
}

export interface TypeSuccessEvent {
  type: "success";
  requestType: string;
  messageId?: string;
}

export interface TypeErrorEvent {
  type: "error";
  requestType: string;
  error: string;
  details?: unknown;
}

export type TypeInboundEvent =
  | TypeMessageEvent
  | TypePingEvent
  | TypeSuccessEvent
  | TypeErrorEvent;

// ---------------------------------------------------------------------------
// Outbound: Plugin -> Type Server
// ---------------------------------------------------------------------------

export interface PongMessage {
  type: "pong";
}

export interface SendMessage {
  type: "send";
  channelId: string;
  content: string;
  parentMessageId?: string;
}

export interface RespondMessage {
  type: "respond";
  messageId: string;
  content: string;
}

export interface StreamStartMessage {
  type: "stream_start";
  messageId: string;
}

export interface StreamEventMessage {
  type: "stream_event";
  messageId: string;
  event: {
    kind: string;
    [key: string]: unknown;
  };
}

export interface StreamFinishMessage {
  type: "stream_finish";
  messageId: string;
}

export type TypeOutboundMessage =
  | PongMessage
  | SendMessage
  | RespondMessage
  | StreamStartMessage
  | StreamEventMessage
  | StreamFinishMessage;
