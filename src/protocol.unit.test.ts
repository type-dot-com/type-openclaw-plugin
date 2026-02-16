import { describe, expect, it } from "bun:test";
import { typeInboundEventSchema } from "./protocol.js";

describe("typeInboundEventSchema", () => {
  describe("message events", () => {
    it("parses a valid message event", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "message",
        messageId: "msg_abc123",
        channelId: "ch_456",
        channelName: "general",
        parentMessageId: null,
        sender: { id: "user_1", name: "Alice" },
        content: "Hello world",
        mentionsAgent: true,
        timestamp: Date.now(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("message");
      }
    });

    it("parses a message event with null sender and content", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "message",
        messageId: "msg_abc123",
        channelId: "ch_456",
        channelName: null,
        parentMessageId: "msg_parent",
        sender: null,
        content: null,
        mentionsAgent: false,
        timestamp: Date.now(),
      });

      expect(result.success).toBe(true);
    });

    it("parses a message event with rich trigger context", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "message",
        messageId: "msg_abc123",
        channelId: "ch_456",
        channelName: "general",
        parentMessageId: "msg_parent",
        sender: { id: "user_1", name: "Alice" },
        content: "Please summarize this thread",
        mentionsAgent: true,
        timestamp: Date.now(),
        context: {
          triggeringUser: {
            id: "user_1",
            name: "Alice",
            email: "alice@example.com",
          },
          channel: {
            id: "ch_456",
            name: "general",
            description: "General chat",
            visibility: "public",
            members: [
              {
                id: "user_1",
                name: "Alice",
                email: "alice@example.com",
                role: "owner",
                avatarUrl: null,
              },
            ],
          },
          thread: {
            parentMessageId: "msg_parent",
            threadTitle: "Incident follow-up",
            messages: [
              {
                messageId: "msg_parent",
                role: "user",
                content: "What happened?",
                timestamp: Date.now(),
                parentMessageId: null,
                sender: {
                  id: "user_1",
                  name: "Alice",
                  email: "alice@example.com",
                },
              },
            ],
          },
          recentMessages: null,
        },
      });

      expect(result.success).toBe(true);
    });

    it("rejects a message event missing required fields", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "message",
        messageId: "msg_abc123",
        // missing channelId, channelName, etc.
      });

      expect(result.success).toBe(false);
    });
  });

  describe("ping events", () => {
    it("parses a valid ping event", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "ping",
        timestamp: Date.now(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("ping");
      }
    });

    it("rejects a ping event missing timestamp", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "ping",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("success events", () => {
    it("parses a success event without messageId", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "success",
        requestType: "stream_start",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("success");
      }
    });

    it("parses a success event with messageId", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "success",
        requestType: "stream_start",
        messageId: "msg_123",
      });

      expect(result.success).toBe(true);
      if (result.success && result.data.type === "success") {
        expect(result.data.messageId).toBe("msg_123");
      }
    });
  });

  describe("error events", () => {
    it("parses a valid error event", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "error",
        requestType: "send",
        error: "Channel not found",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("error");
      }
    });

    it("parses an error event with details", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "error",
        requestType: "send",
        error: "Validation failed",
        details: { field: "content" },
      });

      expect(result.success).toBe(true);
    });

    it("rejects an error event missing the error field", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "error",
        requestType: "send",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("unknown types", () => {
    it("rejects events with unknown type", () => {
      const result = typeInboundEventSchema.safeParse({
        type: "unknown_type",
        data: "something",
      });

      expect(result.success).toBe(false);
    });

    it("rejects events missing the type discriminator", () => {
      const result = typeInboundEventSchema.safeParse({
        messageId: "msg_123",
        content: "hello",
      });

      expect(result.success).toBe(false);
    });

    it("rejects non-object input", () => {
      expect(typeInboundEventSchema.safeParse("string").success).toBe(false);
      expect(typeInboundEventSchema.safeParse(123).success).toBe(false);
      expect(typeInboundEventSchema.safeParse(null).success).toBe(false);
    });
  });
});
