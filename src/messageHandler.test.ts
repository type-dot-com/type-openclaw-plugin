import { describe, expect, test } from "bun:test";
import {
  handleInboundMessage,
  type PluginRuntime,
  resolveStreamAck,
} from "./messageHandler.js";
import type { TypeMessageEvent } from "./protocol.js";
import type { StreamOutbound } from "./streamSession.js";

function hasOnPartialReply(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> & {
  onPartialReply: (payload: { text?: string }) => void;
} {
  return typeof value?.onPartialReply === "function";
}

function getMessageIdFromContext(ctx: Record<string, unknown>): string | null {
  const value = ctx.MessageSid;
  return typeof value === "string" ? value : null;
}

function createMessage(
  messageId: string,
  overrides: Partial<TypeMessageEvent> = {},
): TypeMessageEvent {
  return {
    type: "message",
    messageId,
    channelId: "ch_1",
    channelName: "general",
    parentMessageId: null,
    sender: { id: "user_1", name: "User" },
    content: "hello",
    mentionsAgent: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("messageHandler stream ack routing", () => {
  test("routes stream_start acks to the matching message session", async () => {
    const started: string[] = [];
    const tokenChunksByMessage = new Map<string, string[]>();
    const finished: string[] = [];

    const outbound: StreamOutbound = {
      startStream(messageId: string): boolean {
        started.push(messageId);
        return true;
      },
      streamToken(messageId: string, text: string): boolean {
        const chunks = tokenChunksByMessage.get(messageId) ?? [];
        chunks.push(text);
        tokenChunksByMessage.set(messageId, chunks);
        return true;
      },
      streamEvent(): boolean {
        return true;
      },
      finishStream(messageId: string): boolean {
        finished.push(messageId);
        return true;
      },
    };

    const dispatchResolvers = new Map<string, () => void>();
    const textByMessageId = new Map<string, string>([
      ["msg_1", "First reply"],
      ["msg_2", "Second reply"],
    ]);

    const runtime: PluginRuntime = {
      channel: {
        reply: {
          finalizeInboundContext(
            ctx: Record<string, unknown>,
          ): Record<string, unknown> {
            return ctx;
          },
          dispatchReplyWithBufferedBlockDispatcher(opts): Promise<void> {
            const messageId = getMessageIdFromContext(opts.ctx);
            expect(messageId).not.toBeNull();
            if (!messageId) {
              return Promise.resolve();
            }

            if (hasOnPartialReply(opts.replyOptions)) {
              opts.replyOptions.onPartialReply({
                text: textByMessageId.get(messageId) ?? "fallback",
              });
            }

            return new Promise<void>((resolve) => {
              dispatchResolvers.set(messageId, resolve);
            });
          },
        },
      },
    };

    handleInboundMessage({
      msg: createMessage("msg_1"),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });
    handleInboundMessage({
      msg: createMessage("msg_2"),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    expect(started).toEqual(["msg_1", "msg_2"]);
    expect(tokenChunksByMessage.size).toBe(0);

    resolveStreamAck("msg_unknown");
    expect(tokenChunksByMessage.get("msg_1")).toBeUndefined();
    expect(tokenChunksByMessage.get("msg_2")).toBeUndefined();

    resolveStreamAck("msg_2");
    expect(tokenChunksByMessage.get("msg_1")).toBeUndefined();
    expect(tokenChunksByMessage.get("msg_2")).toEqual(["Second reply"]);

    resolveStreamAck("msg_1");
    expect(tokenChunksByMessage.get("msg_1")).toEqual(["First reply"]);

    dispatchResolvers.get("msg_1")?.();
    dispatchResolvers.get("msg_2")?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(finished.sort()).toEqual(["msg_1", "msg_2"]);
  });

  test("flushes and finishes when ack arrives after dispatch has already completed", async () => {
    const calls: Array<{ kind: "start" | "token" | "finish"; value: string }> =
      [];

    const outbound: StreamOutbound = {
      startStream(messageId: string): boolean {
        calls.push({ kind: "start", value: messageId });
        return true;
      },
      streamToken(messageId: string, text: string): boolean {
        calls.push({ kind: "token", value: `${messageId}:${text}` });
        return true;
      },
      streamEvent(): boolean {
        return true;
      },
      finishStream(messageId: string): boolean {
        calls.push({ kind: "finish", value: messageId });
        return true;
      },
    };

    const runtime: PluginRuntime = {
      channel: {
        reply: {
          finalizeInboundContext(
            ctx: Record<string, unknown>,
          ): Record<string, unknown> {
            return ctx;
          },
          dispatchReplyWithBufferedBlockDispatcher(opts): Promise<void> {
            if (hasOnPartialReply(opts.replyOptions)) {
              opts.replyOptions.onPartialReply({ text: "Late ack reply" });
            }
            return Promise.resolve();
          },
        },
      },
    };

    handleInboundMessage({
      msg: createMessage("msg_late_ack"),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([{ kind: "start", value: "msg_late_ack" }]);

    resolveStreamAck("msg_late_ack");

    expect(calls).toEqual([
      { kind: "start", value: "msg_late_ack" },
      { kind: "token", value: "msg_late_ack:Late ack reply" },
      { kind: "finish", value: "msg_late_ack" },
    ]);
  });

  test("embeds thread history in BodyForAgent while preserving RawBody", async () => {
    let capturedContext: Record<string, unknown> | null = null;

    const outbound: StreamOutbound = {
      startStream(): boolean {
        return true;
      },
      streamToken(): boolean {
        return true;
      },
      streamEvent(): boolean {
        return true;
      },
      finishStream(): boolean {
        return true;
      },
    };

    const runtime: PluginRuntime = {
      channel: {
        reply: {
          finalizeInboundContext(
            ctx: Record<string, unknown>,
          ): Record<string, unknown> {
            capturedContext = ctx;
            return ctx;
          },
          dispatchReplyWithBufferedBlockDispatcher(): Promise<void> {
            return Promise.resolve();
          },
        },
      },
    };

    const message = createMessage("msg_ctx", {
      content: "Please summarize this thread.",
      parentMessageId: "msg_parent",
      context: {
        triggeringUser: {
          id: "user_1",
          name: "Alice",
          email: "alice@example.com",
        },
        channel: {
          id: "ch_1",
          name: "general",
          description: "Team chat",
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
              messageId: "msg_old_1",
              role: "user",
              content: "What happened?",
              timestamp: 1700000000000,
              parentMessageId: null,
              sender: {
                id: "user_1",
                name: "Alice",
                email: "alice@example.com",
              },
            },
            {
              messageId: "msg_old_2",
              role: "assistant",
              content: "A deployment failed.",
              timestamp: 1700000001000,
              parentMessageId: "msg_parent",
              sender: null,
            },
          ],
        },
        recentMessages: null,
      },
    });

    handleInboundMessage({
      msg: message,
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    expect(capturedContext).not.toBeNull();
    if (!capturedContext) {
      return;
    }

    const bodyValue = capturedContext.Body;
    expect(typeof bodyValue).toBe("string");
    if (typeof bodyValue !== "string") {
      return;
    }
    expect(bodyValue).toContain("Thread title: Incident follow-up");
    expect(bodyValue).toContain("Conversation history:");
    expect(bodyValue).toContain("- Alice: What happened?");
    expect(bodyValue).toContain("- Assistant: A deployment failed.");
    expect(bodyValue).toContain(
      "Current message: Please summarize this thread.",
    );

    expect(capturedContext.RawBody).toBe("Please summarize this thread.");
    expect(capturedContext.CommandBody).toBe("Please summarize this thread.");
    expect(capturedContext.ChatType).toBe("thread");
    expect(capturedContext.BodyForAgent).toBe(bodyValue);
    expect(capturedContext.BodyForCommands).toBe(
      "Please summarize this thread.",
    );

    const inboundHistoryValue = capturedContext.InboundHistory;
    expect(Array.isArray(inboundHistoryValue)).toBe(true);
    if (!Array.isArray(inboundHistoryValue)) {
      return;
    }
    expect(inboundHistoryValue).toHaveLength(2);
    const firstEntry = inboundHistoryValue[0];
    const secondEntry = inboundHistoryValue[1];
    expect(firstEntry).toBeTruthy();
    expect(secondEntry).toBeTruthy();
    expect(typeof firstEntry).toBe("object");
    expect(typeof secondEntry).toBe("object");
    if (
      !firstEntry ||
      typeof firstEntry !== "object" ||
      !secondEntry ||
      typeof secondEntry !== "object"
    ) {
      return;
    }
    expect(firstEntry).toMatchObject({
      sender: "Alice",
      body: "What happened?",
      timestamp: 1700000000000,
    });
    expect(secondEntry).toMatchObject({
      sender: "Assistant",
      body: "A deployment failed.",
      timestamp: 1700000001000,
    });

    const untrustedContextValue = capturedContext.UntrustedContext;
    expect(Array.isArray(untrustedContextValue)).toBe(true);
    if (!Array.isArray(untrustedContextValue)) {
      return;
    }
    expect(untrustedContextValue.length).toBeGreaterThan(0);
    expect(untrustedContextValue.join("\n")).toContain(
      "Channel metadata (untrusted):",
    );
    expect(untrustedContextValue.join("\n")).toContain(
      "Thread metadata (untrusted):",
    );

    expect(capturedContext.TypeTriggerContext).toEqual(message.context);
  });
});
