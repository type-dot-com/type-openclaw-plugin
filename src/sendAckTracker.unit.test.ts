import { afterEach, describe, expect, test } from "bun:test";
import type { SendAckResult, SendAckWaitResult } from "./sendAckTracker.js";
import {
  rejectAllPendingSendAcks,
  rejectSendAck,
  resolveSendAck,
  waitForSendAck,
} from "./sendAckTracker.js";

const PRIMARY_ACCOUNT_ID = "acct_primary";
const SECONDARY_ACCOUNT_ID = "acct_secondary";

function makeAck(overrides: Partial<SendAckResult> = {}): SendAckResult {
  return {
    messageId: "",
    channelId: null,
    parentMessageId: null,
    channelName: null,
    channelType: null,
    chatType: null,
    timestamp: null,
    ...overrides,
  };
}

afterEach(() => {
  // Clean up any lingering pending sends
  rejectAllPendingSendAcks(PRIMARY_ACCOUNT_ID);
  rejectAllPendingSendAcks(SECONDARY_ACCOUNT_ID);
});

describe("sendAckTracker", () => {
  function expectSendError(
    result: SendAckWaitResult,
    expectedMessage: string,
  ): void {
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "error") {
      throw new Error("Expected a send error result");
    }
    expect(result.error.message).toBe(expectedMessage);
  }

  test("resolves when resolveSendAck is called with matching requestId", async () => {
    const promise = waitForSendAck(PRIMARY_ACCOUNT_ID, "req-1");

    const ack = makeAck({
      messageId: "msg_123",
      channelId: "ch_456",
      channelName: "general",
      channelType: "default",
      chatType: "channel",
      timestamp: 1700000000000,
    });
    const resolved = resolveSendAck(PRIMARY_ACCOUNT_ID, "req-1", ack);

    expect(resolved).toBe(true);
    const result = await promise;
    expect(result).toEqual({ ok: true, ack });
  });

  test("resolves with thread metadata when present", async () => {
    const promise = waitForSendAck(PRIMARY_ACCOUNT_ID, "req-2");

    resolveSendAck(
      PRIMARY_ACCOUNT_ID,
      "req-2",
      makeAck({
        messageId: "msg_789",
        channelId: "ch_456",
        parentMessageId: "msg_parent",
        chatType: "thread",
      }),
    );

    const result = await promise;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.ack.parentMessageId).toBe("msg_parent");
    expect(result.ack.chatType).toBe("thread");
  });

  test("resolves with DM session metadata", async () => {
    const promise = waitForSendAck(PRIMARY_ACCOUNT_ID, "req-dm");

    resolveSendAck(
      PRIMARY_ACCOUNT_ID,
      "req-dm",
      makeAck({
        messageId: "msg_dm",
        channelType: "agent_dm",
        chatType: "dm",
      }),
    );

    const result = await promise;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.ack.channelType).toBe("agent_dm");
    expect(result.ack.chatType).toBe("dm");
  });

  test("rejects when rejectSendAck is called", async () => {
    const promise = waitForSendAck(PRIMARY_ACCOUNT_ID, "req-3");

    const rejected = rejectSendAck(
      PRIMARY_ACCOUNT_ID,
      "req-3",
      new Error("Channel not found"),
    );
    expect(rejected).toBe(true);

    const result = await promise;
    expectSendError(result, "Channel not found");
  });

  test("rejects on timeout", async () => {
    const promise = waitForSendAck(PRIMARY_ACCOUNT_ID, "req-timeout", 50);
    await expect(promise).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  test("returns false when resolving non-existent requestId", () => {
    expect(resolveSendAck(PRIMARY_ACCOUNT_ID, "non-existent", makeAck())).toBe(
      false,
    );
  });

  test("returns false when rejecting non-existent requestId", () => {
    expect(
      rejectSendAck(PRIMARY_ACCOUNT_ID, "non-existent", new Error("test")),
    ).toBe(false);
  });

  test("rejectAllPendingSendAcks rejects pending sends for one account only", async () => {
    const promise1 = waitForSendAck(PRIMARY_ACCOUNT_ID, "req-all");
    const promise2 = waitForSendAck(SECONDARY_ACCOUNT_ID, "req-all");

    rejectAllPendingSendAcks(PRIMARY_ACCOUNT_ID);
    resolveSendAck(
      SECONDARY_ACCOUNT_ID,
      "req-all",
      makeAck({ messageId: "msg_other" }),
    );

    expectSendError(await promise1, "Connection lost");
    await expect(promise2).resolves.toEqual({
      ok: true,
      ack: makeAck({ messageId: "msg_other" }),
    });
  });

  test("does not resolve same requestId twice", async () => {
    const promise = waitForSendAck(PRIMARY_ACCOUNT_ID, "req-once");

    resolveSendAck(
      PRIMARY_ACCOUNT_ID,
      "req-once",
      makeAck({ messageId: "msg_1" }),
    );

    // Second resolve should return false (already consumed)
    const secondResolve = resolveSendAck(
      PRIMARY_ACCOUNT_ID,
      "req-once",
      makeAck({ messageId: "msg_2" }),
    );
    expect(secondResolve).toBe(false);

    const result = await promise;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.ack.messageId).toBe("msg_1");
  });
});
