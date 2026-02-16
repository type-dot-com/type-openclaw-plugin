import { describe, expect, test } from "bun:test";
import { type StreamOutbound, StreamSession } from "./streamSession.js";

type OutboundCall =
  | { kind: "start"; messageId: string }
  | { kind: "token"; messageId: string; text: string }
  | { kind: "finish"; messageId: string };

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
    finishStream(messageId: string): boolean {
      calls.push({ kind: "finish", messageId });
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
});
