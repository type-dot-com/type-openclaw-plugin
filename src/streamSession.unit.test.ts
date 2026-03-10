import { describe, expect, test } from "bun:test";
import { type StreamOutbound, StreamSession } from "./streamSession.js";

type OutboundCall =
  | { kind: "start"; messageId: string }
  | { kind: "token"; messageId: string; text: string }
  | {
      kind: "finish";
      messageId: string;
      needsReply?: boolean;
      question?: string;
    };

function createOutboundRecorder(calls: OutboundCall[]): StreamOutbound {
  return {
    startStream(messageId: string): boolean {
      calls.push({ kind: "start", messageId });
      return true;
    },
    streamToken(messageId: string, text: string): boolean {
      calls.push({ kind: "token", messageId, text });
      return true;
    },
    streamEvent(): boolean {
      return true;
    },
    streamHeartbeat(): boolean {
      return true;
    },
    finishStream(
      messageId: string,
      _fileIds?: string[],
      opts?: { needsReply?: boolean; question?: string },
    ): boolean {
      calls.push({
        kind: "finish",
        messageId,
        ...(opts?.needsReply ? { needsReply: true } : {}),
        ...(opts?.question ? { question: opts.question } : {}),
      });
      return true;
    },
  };
}

describe("StreamSession", () => {
  test("queues finish until stream_start ack is received", () => {
    const calls: OutboundCall[] = [];
    const session = new StreamSession(createOutboundRecorder(calls), "msg_1");

    session.sendToken("Hello");
    session.finish();

    expect(calls).toEqual([{ kind: "start", messageId: "msg_1" }]);

    session.onAck();

    expect(calls).toEqual([
      { kind: "start", messageId: "msg_1" },
      { kind: "token", messageId: "msg_1", text: "Hello" },
      { kind: "finish", messageId: "msg_1" },
    ]);
  });

  test("stops sending after server rejects stream_event", () => {
    const calls: OutboundCall[] = [];
    const session = new StreamSession(createOutboundRecorder(calls), "msg_2");

    session.sendToken("A");
    session.onAck();
    session.failFromServer(
      "stream_event",
      new Error("No active stream for this message"),
    );
    session.sendToken("AB");
    session.finish();

    expect(calls).toEqual([
      { kind: "start", messageId: "msg_2" },
      { kind: "token", messageId: "msg_2", text: "A" },
    ]);
  });

  test("auto-starts stream when finish is called with needsReply on unstarted session", () => {
    const calls: OutboundCall[] = [];
    const session = new StreamSession(createOutboundRecorder(calls), "msg_3");

    // No tokens sent — stream not started
    session.finish({ needsReply: true, question: "What do you prefer?" });

    // Should have auto-started
    expect(calls).toEqual([{ kind: "start", messageId: "msg_3" }]);

    // Ack the start — finish should flush
    session.onAck();

    expect(calls).toEqual([
      { kind: "start", messageId: "msg_3" },
      {
        kind: "finish",
        messageId: "msg_3",
        needsReply: true,
        question: "What do you prefer?",
      },
    ]);
  });

  test("does not auto-start stream when finish is called without needsReply", () => {
    const calls: OutboundCall[] = [];
    const session = new StreamSession(createOutboundRecorder(calls), "msg_4");

    // No tokens sent, no needsReply — finish should no-op
    session.finish();

    expect(calls).toEqual([]);
  });
});
