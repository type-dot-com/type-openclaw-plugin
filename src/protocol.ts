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

const typeTriggerUserSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const typeChannelMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
  avatarUrl: z.string().nullable(),
});

const typeChannelContextSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  visibility: z.enum(["public", "private"]),
  members: z.array(typeChannelMemberSchema),
});

const typeHistoryMessageSchema = z.object({
  messageId: z.string().nullable(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number().nullable(),
  parentMessageId: z.string().nullable(),
  sender: typeTriggerUserSchema.nullable(),
});

const typeThreadContextSchema = z.object({
  parentMessageId: z.string(),
  threadTitle: z.string().nullable(),
  messages: z.array(typeHistoryMessageSchema),
});

const typeTriggerContextSchema = z.object({
  triggeringUser: typeTriggerUserSchema.nullable(),
  channel: typeChannelContextSchema.nullable(),
  thread: typeThreadContextSchema.nullable(),
  recentMessages: z.array(typeHistoryMessageSchema).nullable(),
});

const typeMessageEventSchema = z.object({
  type: z.literal("message"),
  messageId: z.string(),
  channelId: z.string(),
  channelName: z.string().nullable(),
  parentMessageId: z.string().nullable(),
  chatType: z.enum(["channel", "thread", "dm"]),
  sender: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  content: z.string().nullable(),
  mentionsAgent: z.boolean(),
  timestamp: z.number(),
  context: typeTriggerContextSchema.nullable().optional(),
});

const typePingEventSchema = z.object({
  type: z.literal("ping"),
  timestamp: z.number(),
});

const typePongEventSchema = z.object({
  type: z.literal("pong"),
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
  messageId: z.string().optional(),
  details: z.unknown().optional(),
});

export const typeInboundEventSchema = z.discriminatedUnion("type", [
  typeMessageEventSchema,
  typePingEventSchema,
  typePongEventSchema,
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

export interface PingMessage {
  type: "ping";
}

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
  | PingMessage
  | PongMessage
  | SendMessage
  | RespondMessage
  | StreamStartMessage
  | StreamEventMessage
  | StreamFinishMessage;
