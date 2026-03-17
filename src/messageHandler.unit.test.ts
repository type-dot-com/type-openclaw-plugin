import { describe, expect, test } from "bun:test";
import {
  handleInboundMessage,
  type PluginRuntime,
  pauseStreamSessionsForAccount,
  resolveStreamAck,
  resumeStreamSessionsForAccount,
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
    channelType: "default",
    parentMessageId: null,
    conversationRootMessageId: null,
    replyTarget: {
      channelId: "ch_1",
      parentMessageId: null,
    },
    chatType: "channel",
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
      streamHeartbeat(): boolean {
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

    resolveStreamAck("msg_unknown", "acct_1");
    expect(tokenChunksByMessage.get("msg_1")).toBeUndefined();
    expect(tokenChunksByMessage.get("msg_2")).toBeUndefined();

    resolveStreamAck("msg_2", "acct_1");
    expect(tokenChunksByMessage.get("msg_1")).toBeUndefined();
    expect(tokenChunksByMessage.get("msg_2")).toEqual(["Second reply"]);

    resolveStreamAck("msg_1", "acct_1");
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
      streamHeartbeat(): boolean {
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

    resolveStreamAck("msg_late_ack", "acct_1");

    expect(calls).toEqual([
      { kind: "start", value: "msg_late_ack" },
      { kind: "token", value: "msg_late_ack:Late ack reply" },
      { kind: "finish", value: "msg_late_ack" },
    ]);
  });

  test("re-sends stream_start after reconnect before the initial ack arrives", async () => {
    const calls: Array<{ kind: "start" | "token" | "finish"; value: string }> =
      [];
    let resolveDispatch: (() => void) | null = null;

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
      streamHeartbeat(): boolean {
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
              opts.replyOptions.onPartialReply({ text: "Reconnect reply" });
            }

            return new Promise<void>((resolve) => {
              resolveDispatch = resolve;
            });
          },
        },
      },
    };

    handleInboundMessage({
      msg: createMessage("msg_reconnect"),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    expect(calls).toEqual([{ kind: "start", value: "msg_reconnect" }]);

    pauseStreamSessionsForAccount("acct_1");
    resumeStreamSessionsForAccount("acct_1");

    expect(calls).toEqual([
      { kind: "start", value: "msg_reconnect" },
      { kind: "start", value: "msg_reconnect" },
    ]);

    resolveStreamAck("msg_reconnect", "acct_1");

    expect(calls).toEqual([
      { kind: "start", value: "msg_reconnect" },
      { kind: "start", value: "msg_reconnect" },
      { kind: "token", value: "msg_reconnect:Reconnect reply" },
    ]);

    resolveDispatch?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([
      { kind: "start", value: "msg_reconnect" },
      { kind: "start", value: "msg_reconnect" },
      { kind: "token", value: "msg_reconnect:Reconnect reply" },
      { kind: "finish", value: "msg_reconnect" },
    ]);
  });

  test("suppresses NO_REPLY sentinel text from being streamed", async () => {
    const started: string[] = [];
    const tokenChunks: string[] = [];
    const finished: string[] = [];

    const outbound: StreamOutbound = {
      startStream(messageId: string): boolean {
        started.push(messageId);
        return true;
      },
      streamToken(_messageId: string, text: string): boolean {
        tokenChunks.push(text);
        return true;
      },
      streamEvent(): boolean {
        return true;
      },
      streamHeartbeat(): boolean {
        return true;
      },
      finishStream(messageId: string): boolean {
        finished.push(messageId);
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
              opts.replyOptions.onPartialReply({ text: "NO_REPLY" });
            }
            return Promise.resolve();
          },
        },
      },
    };

    handleInboundMessage({
      msg: createMessage("msg_no_reply"),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([]);
    expect(tokenChunks).toEqual([]);
    expect(finished).toEqual([]);
  });

  test("suppresses short NO sentinel when a tool event was emitted", async () => {
    const started: string[] = [];
    const tokenChunks: string[] = [];
    const finished: string[] = [];

    const outbound: StreamOutbound = {
      startStream(messageId: string): boolean {
        started.push(messageId);
        return true;
      },
      streamToken(_messageId: string, text: string): boolean {
        tokenChunks.push(text);
        return true;
      },
      streamEvent(): boolean {
        return true;
      },
      streamHeartbeat(): boolean {
        return true;
      },
      finishStream(messageId: string): boolean {
        finished.push(messageId);
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
          async dispatchReplyWithBufferedBlockDispatcher(opts): Promise<void> {
            await opts.dispatcherOptions.deliver({}, {
              kind: "tool",
            } as Record<string, unknown>);
            if (hasOnPartialReply(opts.replyOptions)) {
              opts.replyOptions.onPartialReply({ text: "NO" });
            }
          },
        },
      },
    };

    handleInboundMessage({
      msg: createMessage("msg_no_with_tool"),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([]);
    expect(tokenChunks).toEqual([]);
    expect(finished).toEqual([]);
  });

  test("preserves buffered NO_REPLY prefix when partials are split across chunks", async () => {
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
      streamHeartbeat(): boolean {
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
              opts.replyOptions.onPartialReply({ text: "N" });
              opts.replyOptions.onPartialReply({ text: "ot now" });
            }
            return Promise.resolve();
          },
        },
      },
    };

    handleInboundMessage({
      msg: createMessage("msg_split_sentinel"),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([{ kind: "start", value: "msg_split_sentinel" }]);

    resolveStreamAck("msg_split_sentinel", "acct_1");

    expect(calls).toEqual([
      { kind: "start", value: "msg_split_sentinel" },
      { kind: "token", value: "msg_split_sentinel:Not now" },
      { kind: "finish", value: "msg_split_sentinel" },
    ]);
  });

  test("does not suppress legitimate short replies that start with NO", async () => {
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
      streamHeartbeat(): boolean {
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
              opts.replyOptions.onPartialReply({ text: "NO" });
            }
            return Promise.resolve();
          },
        },
      },
    };

    handleInboundMessage({
      msg: createMessage("msg_legit_no"),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([{ kind: "start", value: "msg_legit_no" }]);

    resolveStreamAck("msg_legit_no", "acct_1");

    expect(calls).toEqual([
      { kind: "start", value: "msg_legit_no" },
      { kind: "token", value: "msg_legit_no:NO" },
      { kind: "finish", value: "msg_legit_no" },
    ]);
  });

  test("preserves raw thread message and exposes structured context", async () => {
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
      streamHeartbeat(): boolean {
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
      chatType: "thread",
      content: "Please summarize this thread.",
      parentMessageId: "msg_parent",
      conversationRootMessageId: "msg_parent",
      replyTarget: {
        channelId: "ch_1",
        parentMessageId: "msg_parent",
      },
      context: {
        triggeringUser: {
          id: "user_1",
          name: "Alice",
        },
        channel: {
          id: "ch_1",
          name: "general",
          description: "Team chat",
          visibility: "public",
          channelType: "default",
          members: [
            {
              id: "user_1",
              name: "Alice",
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

    expect(capturedContext.Body).toBe("Please summarize this thread.");
    expect(capturedContext.RawBody).toBe("Please summarize this thread.");
    expect(capturedContext.CommandBody).toBe("Please summarize this thread.");
    expect(capturedContext.ChatType).toBe("channel");
    expect(capturedContext.To).toBe("ch_1");
    expect(capturedContext.BodyForAgent).toBe("Please summarize this thread.");
    expect(capturedContext.BodyForCommands).toBe(
      "Please summarize this thread.",
    );
    expect(capturedContext.ThreadStarterBody).toBe("What happened?");
    expect(capturedContext.ThreadHistoryBody).toBe(
      "Assistant: A deployment failed.",
    );
    expect(capturedContext.MessageThreadId).toBe("msg_parent");
    expect(capturedContext.ReplyToId).toBe("msg_parent");
    expect(capturedContext.TypeChannelType).toBe("default");
    expect(capturedContext.TypeConversationRootMessageId).toBe("msg_parent");
    expect(capturedContext.TypeReplyTarget).toEqual({
      channelId: "ch_1",
      parentMessageId: "msg_parent",
    });

    const inboundHistoryValue = capturedContext.InboundHistory;
    expect(inboundHistoryValue).toBeUndefined();

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
    expect(untrustedContextValue.join("\n")).toContain(
      "Title: Incident follow-up",
    );

    expect(capturedContext.TypeTriggerContext).toEqual(message.context);
  });

  test("does not infer a thread reply target from legacy parent fields", async () => {
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
      streamHeartbeat(): boolean {
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

    handleInboundMessage({
      msg: createMessage("msg_ctx_missing_target", {
        chatType: "thread",
        parentMessageId: "msg_parent",
        conversationRootMessageId: "msg_parent",
        replyTarget: {
          channelId: "ch_1",
          parentMessageId: null,
        },
      }),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    expect(capturedContext).not.toBeNull();
    if (!capturedContext) {
      return;
    }

    expect(capturedContext.MessageThreadId).toBeNull();
    expect(capturedContext.ReplyToId).toBeNull();
    expect(capturedContext.TypeConversationRootMessageId).toBe("msg_parent");
    expect(capturedContext.TypeReplyTarget).toEqual({
      channelId: "ch_1",
      parentMessageId: null,
    });
  });

  test("keeps attached file metadata out of BodyForAgent", async () => {
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
      streamHeartbeat(): boolean {
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

    handleInboundMessage({
      msg: createMessage("msg_with_file", {
        content: "can you see this image",
        files: [
          {
            id: "file_123",
            filename: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1024,
          },
        ],
      }),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    expect(capturedContext).not.toBeNull();
    if (!capturedContext) {
      return;
    }

    expect(capturedContext.Body).toBe("can you see this image");
    expect(capturedContext.BodyForAgent).toBe("can you see this image");
    expect(capturedContext.RawBody).toBe("can you see this image");
    const untrustedContextValue = capturedContext.UntrustedContext;
    expect(Array.isArray(untrustedContextValue)).toBe(true);
    if (!Array.isArray(untrustedContextValue)) {
      return;
    }
    expect(untrustedContextValue.join("\n")).toContain(
      "Attached files (untrusted):",
    );
    expect(untrustedContextValue.join("\n")).toContain(
      "- screenshot.png (id: file_123, type: image/png, sizeBytes: 1024)",
    );
  });

  test("resolves inbound file IDs into MediaUrls when account config is present", async () => {
    let capturedContext: Record<string, unknown> | null = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.includes("/files/download-url")) {
        return new Response(
          JSON.stringify({
            downloadUrl: "https://files.example.com/signed-image.png",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

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
      streamHeartbeat(): boolean {
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

    try {
      handleInboundMessage({
        msg: createMessage("msg_with_file_url", {
          content: "can you inspect this image",
          files: [
            {
              id: "file_456",
              filename: "example.png",
              mimeType: "image/png",
              sizeBytes: 2048,
            },
          ],
        }),
        accountId: "acct_1",
        account: {
          token: "ta_test_token",
          wsUrl: "wss://type.example.com/api/agents/ws",
          agentId: "agent_123",
        },
        cfg: {},
        runtime,
        outbound,
      });

      for (let i = 0; i < 50 && !capturedContext; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const expectedUrl = "https://files.example.com/signed-image.png";

      expect(capturedContext).not.toBeNull();
      if (!capturedContext) {
        return;
      }

      expect(capturedContext.MediaUrl).toBe(expectedUrl);
      expect(capturedContext.MediaUrls).toEqual([expectedUrl]);
      expect(capturedContext.MediaType).toBe("image/png");
      expect(capturedContext.MediaTypes).toEqual(["image/png"]);
      expect(capturedContext.Files).toEqual([
        {
          id: "file_456",
          filename: "example.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          downloadUrl: expectedUrl,
          url: expectedUrl,
        },
      ]);
      const bodyForAgent = capturedContext.BodyForAgent;
      expect(bodyForAgent).toBe("can you inspect this image");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes owner allowlist through to OpenClaw context", async () => {
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
      streamHeartbeat(): boolean {
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

    handleInboundMessage({
      msg: createMessage("msg_owner"),
      accountId: "acct_1",
      account: {
        token: "ta_test_token",
        wsUrl: "wss://type.example.com/api/agents/ws",
        agentId: "agent_123",
        ownerAllowFrom: ["user_1"],
      },
      cfg: {},
      runtime,
      outbound,
    });

    expect(capturedContext).not.toBeNull();
    if (!capturedContext) {
      return;
    }

    expect(capturedContext.OwnerAllowFrom).toEqual(["user_1"]);
  });

  test("treats agent dm roots as direct messages with an explicit reply target", async () => {
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
      streamHeartbeat(): boolean {
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

    handleInboundMessage({
      msg: createMessage("msg_placeholder", {
        channelId: "ch_dm",
        channelName: "Type",
        channelType: "agent_dm",
        chatType: "dm",
        content: "can you take a look",
        conversationRootMessageId: "msg_user_root",
        replyTarget: {
          channelId: "ch_dm",
          parentMessageId: "msg_user_root",
        },
        context: {
          triggeringUser: {
            id: "user_1",
            name: "Alice",
          },
          channel: {
            id: "ch_dm",
            name: "Type",
            description: null,
            visibility: "private",
            channelType: "agent_dm",
            members: [],
          },
          thread: null,
          recentMessages: null,
        },
      }),
      accountId: "acct_1",
      cfg: {},
      runtime,
      outbound,
    });

    expect(capturedContext).not.toBeNull();
    if (!capturedContext) {
      return;
    }

    expect(capturedContext.ChatType).toBe("direct");
    expect(capturedContext.To).toBe("ch_dm");
    expect(capturedContext.MessageThreadId).toBe("msg_user_root");
    expect(capturedContext.ReplyToId).toBe("msg_user_root");
    expect(capturedContext.SessionKey).toBe("agent:main:type:msg_user_root");
    expect(capturedContext.TypeChannelType).toBe("agent_dm");
    expect(capturedContext.TypeConversationRootMessageId).toBe("msg_user_root");
    expect(capturedContext.TypeReplyTarget).toEqual({
      channelId: "ch_dm",
      parentMessageId: "msg_user_root",
    });
  });
});
