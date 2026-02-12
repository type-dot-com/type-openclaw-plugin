/**
 * Type WebSocket Protocol Types
 *
 * Defines the message types exchanged over the duplex WebSocket
 * between the OpenClaw plugin and the Type server.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Inbound: Type Server -> Plugin (Zod schemas + inferred types)
// ---------------------------------------------------------------------------

const typeMessageEventSchema = z.object({
  type: z.literal("message"),
  messageId: z.string(),
  channelId: z.string(),
  channelName: z.string().nullable(),
  parentMessageId: z.string().nullable(),
  sender: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  content: z.string().nullable(),
  mentionsAgent: z.boolean(),
  timestamp: z.number(),
});

const typePingEventSchema = z.object({
  type: z.literal("ping"),
  timestamp: z.number(),
});

const typeSuccessEventSchema = z.object({
  type: z.literal("success"),
  requestType: z.string(),
  messageId: z.string().optional(),
});

const typeErrorEventSchema = z.object({
  type: z.literal("error"),
  requestType: z.string(),
  error: z.string(),
  details: z.unknown().optional(),
});

export const typeInboundEventSchema = z.discriminatedUnion("type", [
  typeMessageEventSchema,
  typePingEventSchema,
  typeSuccessEventSchema,
  typeErrorEventSchema,
]);

export type TypeMessageEvent = z.infer<typeof typeMessageEventSchema>;
export type TypePingEvent = z.infer<typeof typePingEventSchema>;
export type TypeSuccessEvent = z.infer<typeof typeSuccessEventSchema>;
export type TypeErrorEvent = z.infer<typeof typeErrorEventSchema>;
export type TypeInboundEvent = z.infer<typeof typeInboundEventSchema>;

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
