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

function createMessage(messageId: string): TypeMessageEvent {
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
            if (!messageId) {
              return Promise.reject(new Error("Missing MessageSid"));
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
});
