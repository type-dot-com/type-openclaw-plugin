import { afterEach, describe, expect, test } from "bun:test";
import {
  clearInboundTriggerTrackingForAccount,
  confirmInboundTriggerDelivery,
  getInboundTriggerSnapshot,
  noteInboundTriggerAckAttempt,
} from "./inboundTriggerTracker.js";

const ACCOUNT_IDS = [
  "acct_inbound_tracker_dispatch",
  "acct_inbound_tracker_confirm",
  "acct_inbound_tracker_retry",
];

afterEach(() => {
  for (const accountId of ACCOUNT_IDS) {
    clearInboundTriggerTrackingForAccount(accountId);
  }
});

describe("inboundTriggerTracker", () => {
  test("dispatches only once while a trigger is awaiting server confirmation", () => {
    const firstAttempt = noteInboundTriggerAckAttempt({
      accountId: ACCOUNT_IDS[0],
      messageId: "msg_dispatch",
      ackTimeoutMs: 50,
      onAckTimeout: () => {},
    });

    expect(firstAttempt).toEqual({
      shouldDispatch: true,
      wasDuplicate: false,
    });
    expect(getInboundTriggerSnapshot(ACCOUNT_IDS[0], "msg_dispatch")).toEqual({
      dispatched: true,
      serverAcknowledged: false,
    });

    const duplicateAttempt = noteInboundTriggerAckAttempt({
      accountId: ACCOUNT_IDS[0],
      messageId: "msg_dispatch",
      ackTimeoutMs: 50,
      onAckTimeout: () => {},
    });

    expect(duplicateAttempt).toEqual({
      shouldDispatch: false,
      wasDuplicate: true,
    });
  });

  test("marks delivery confirmed and cancels the ack timeout", async () => {
    let timeoutCount = 0;

    noteInboundTriggerAckAttempt({
      accountId: ACCOUNT_IDS[1],
      messageId: "msg_confirm",
      ackTimeoutMs: 15,
      onAckTimeout: () => {
        timeoutCount += 1;
      },
    });

    confirmInboundTriggerDelivery(ACCOUNT_IDS[1], "msg_confirm");
    await Bun.sleep(30);

    expect(timeoutCount).toBe(0);
    expect(getInboundTriggerSnapshot(ACCOUNT_IDS[1], "msg_confirm")).toEqual({
      dispatched: true,
      serverAcknowledged: true,
    });
  });

  test("re-arms the ack timeout for retries without redispatching", async () => {
    let timeoutCount = 0;

    noteInboundTriggerAckAttempt({
      accountId: ACCOUNT_IDS[2],
      messageId: "msg_retry",
      ackTimeoutMs: 15,
      onAckTimeout: () => {
        timeoutCount += 1;
      },
    });

    await Bun.sleep(30);
    expect(timeoutCount).toBe(1);

    const retryAttempt = noteInboundTriggerAckAttempt({
      accountId: ACCOUNT_IDS[2],
      messageId: "msg_retry",
      ackTimeoutMs: 15,
      onAckTimeout: () => {
        timeoutCount += 1;
      },
    });

    expect(retryAttempt).toEqual({
      shouldDispatch: false,
      wasDuplicate: true,
    });

    await Bun.sleep(30);
    expect(timeoutCount).toBe(2);
  });
});
