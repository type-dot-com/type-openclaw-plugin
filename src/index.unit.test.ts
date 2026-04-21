import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  clearAccountState,
  getAccountState,
  setPluginRuntime,
} from "./accountState.js";
import plugin from "./index.js";
import { handleInboundMessage, type PluginRuntime } from "./messageHandler.js";
import type { TypeOutboundHandler } from "./outbound.js";
import type { TypeMessageEvent } from "./protocol.js";
import { rejectSendAck, resolveSendAck } from "./sendAckTracker.js";
import type { StreamOutbound } from "./streamSession.js";

const TEST_ACCOUNT_ID = "acct_test";

const runtime: PluginRuntime = {
  channel: {
    reply: {
      finalizeInboundContext(
        ctx: Record<string, unknown>,
      ): Record<string, unknown> {
        return ctx;
      },
      dispatchReplyWithBufferedBlockDispatcher(): Promise<void> {
        return Promise.resolve();
      },
    },
  },
};

const cfg = {
  channels: {
    type: {
      accounts: {
        [TEST_ACCOUNT_ID]: {
          token: "ta_test_token",
          wsUrl: "wss://type.example.com/api/agents/ws",
          agentId: "agent_123",
        },
      },
    },
  },
} satisfies Record<string, unknown>;

let registeredPlugin: {
  outbound: {
    sendText(args: {
      to: string;
      text: string;
      replyToId?: string;
      cfg?: Record<string, unknown>;
      accountId?: string | null;
    }): Promise<{ ok: true; channel: string } | { ok: false; error: string }>;
  };
} | null = null;

beforeAll(() => {
  setPluginRuntime(runtime);
  registeredPlugin = plugin.channelPlugin as unknown as typeof registeredPlugin;
});

afterEach(() => {
  clearAccountState(TEST_ACCOUNT_ID);
});

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

function installMockOutbound(): {
  calls: Array<[string, string, string | undefined, string[] | undefined]>;
};
function installMockOutbound(options?: {
  ack?: "success" | "error";
  errorMessage?: string;
}): {
  calls: Array<[string, string, string | undefined, string[] | undefined]>;
} {
  const calls: Array<
    [string, string, string | undefined, string[] | undefined]
  > = [];
  const state = getAccountState(TEST_ACCOUNT_ID);
  state.connectionState = "connected";
  let requestCounter = 0;
  state.outbound = {
    sendMessage(
      channelId: string,
      content: string,
      parentMessageId?: string,
      fileIds?: string[],
    ): { sent: boolean; requestId: string } {
      calls.push([channelId, content, parentMessageId, fileIds]);
      const requestId = `mock-request-id-${requestCounter++}`;
      queueMicrotask(() => {
        if (options?.ack === "error") {
          rejectSendAck(
            TEST_ACCOUNT_ID,
            requestId,
            new Error(options.errorMessage ?? "Channel not found"),
          );
          return;
        }

        resolveSendAck(TEST_ACCOUNT_ID, requestId, {
          messageId: `mock-msg-${requestCounter}`,
          channelId,
          parentMessageId: parentMessageId ?? null,
          channelName: null,
          channelType: null,
          chatType: null,
          timestamp: null,
        });
      });
      return { sent: true, requestId };
    },
  } as unknown as TypeOutboundHandler;

  return { calls };
}

function createInboundOutbound(): StreamOutbound {
  return {
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
}

describe("type outbound reply routing", () => {
  test("sends with an explicit reply target when replyToId is provided", async () => {
    const { calls } = installMockOutbound();
    expect(registeredPlugin).not.toBeNull();
    if (!registeredPlugin) {
      return;
    }

    const result = await registeredPlugin.outbound.sendText({
      to: "ch_shared",
      text: "reply",
      replyToId: "msg_explicit_parent",
      cfg,
      accountId: TEST_ACCOUNT_ID,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ["ch_shared", "reply", "msg_explicit_parent", undefined],
    ]);
  });

  test("uses the inbound reply target from the current dispatch scope", async () => {
    const { calls } = installMockOutbound();
    expect(registeredPlugin).not.toBeNull();
    if (!registeredPlugin) {
      return;
    }

    let result: { ok: boolean } | null = null;
    const dispatchRuntime: PluginRuntime = {
      channel: {
        reply: {
          finalizeInboundContext(
            ctx: Record<string, unknown>,
          ): Record<string, unknown> {
            return ctx;
          },
          async dispatchReplyWithBufferedBlockDispatcher(): Promise<void> {
            result = await registeredPlugin.outbound.sendText({
              to: "ch_thread",
              text: "reply",
              cfg,
              accountId: TEST_ACCOUNT_ID,
            });
          },
        },
      },
    };

    handleInboundMessage({
      msg: createMessage("msg_thread", {
        channelId: "ch_thread",
        parentMessageId: "msg_parent",
        conversationRootMessageId: "msg_parent",
        replyTarget: {
          channelId: "ch_thread",
          parentMessageId: "msg_parent",
        },
        chatType: "thread",
      }),
      accountId: TEST_ACCOUNT_ID,
      cfg: {},
      runtime: dispatchRuntime,
      outbound: createInboundOutbound(),
    });

    // sendTextToType now awaits server ACK, so needs extra microtask ticks
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(calls).toEqual([["ch_thread", "reply", "msg_parent", undefined]]);
  });

  test("errors when a thread reply is missing an explicit target", async () => {
    const { calls } = installMockOutbound();
    expect(registeredPlugin).not.toBeNull();
    if (!registeredPlugin) {
      return;
    }

    let result: { ok: boolean } | null = null;
    const dispatchRuntime: PluginRuntime = {
      channel: {
        reply: {
          finalizeInboundContext(
            ctx: Record<string, unknown>,
          ): Record<string, unknown> {
            return ctx;
          },
          async dispatchReplyWithBufferedBlockDispatcher(): Promise<void> {
            result = await registeredPlugin.outbound.sendText({
              to: "ch_thread",
              text: "reply",
              cfg,
              accountId: TEST_ACCOUNT_ID,
            });
          },
        },
      },
    };

    handleInboundMessage({
      msg: createMessage("msg_thread_missing_target", {
        channelId: "ch_thread",
        parentMessageId: "msg_old_parent",
        conversationRootMessageId: "msg_old_parent",
        replyTarget: {
          channelId: "ch_thread",
          parentMessageId: null,
        },
        chatType: "thread",
      }),
      accountId: TEST_ACCOUNT_ID,
      cfg: {},
      runtime: dispatchRuntime,
      outbound: createInboundOutbound(),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(result).toEqual({
      ok: false,
      error: "Explicit reply target is required for this Type conversation",
    });
    expect(calls).toEqual([]);
  });

  test("surfaces server send errors instead of treating them as success", async () => {
    const { calls } = installMockOutbound({
      ack: "error",
      errorMessage: "Channel not found",
    });
    expect(registeredPlugin).not.toBeNull();
    if (!registeredPlugin) {
      return;
    }

    const result = await registeredPlugin.outbound.sendText({
      to: "ch_shared",
      text: "reply",
      cfg,
      accountId: TEST_ACCOUNT_ID,
    });

    expect(result).toEqual({ ok: false, error: "Channel not found" });
    expect(calls).toEqual([["ch_shared", "reply", undefined, undefined]]);
  });
});
