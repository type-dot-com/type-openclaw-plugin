import { describe, expect, test } from "bun:test";
import {
  cleanupScope,
  runInScope,
  setPendingAskUserQuestion,
} from "./askUserState.js";
import { ReplyTextProcessor } from "./replyTextProcessor.js";
import type { StreamSession } from "./streamSession.js";

/** Minimal mock that tracks calls and exposes controllable state. */
function createMockSession(overrides?: {
  isFailed?: boolean;
  isStarted?: boolean;
}): StreamSession & {
  tokens: string[];
  toolEvents: unknown[];
  textResets: number;
} {
  const mock = {
    isFailed: overrides?.isFailed ?? false,
    isStarted: overrides?.isStarted ?? false,
    tokens: [] as string[],
    toolEvents: [] as unknown[],
    textResets: 0,
    sendToken(text: string) {
      mock.tokens.push(text);
      mock.isStarted = true;
    },
    sendToolEvent(event: unknown) {
      mock.toolEvents.push(event);
    },
    resetTextAccumulator() {
      mock.textResets++;
    },
    // Unused methods from StreamSession — typed loosely for the mock
    finish() {},
  } as unknown as StreamSession & {
    tokens: string[];
    toolEvents: unknown[];
    textResets: number;
  };
  return mock;
}

describe("ReplyTextProcessor", () => {
  describe("processText", () => {
    test("forwards normal text to session", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("Hello world", true);

      expect(session.tokens).toEqual(["Hello world"]);
      expect(processor.result.needsReply).toBe(false);
    });

    test("ignores empty text", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("   ", true);

      expect(session.tokens).toHaveLength(0);
    });

    test("ignores text when session is failed", () => {
      const session = createMockSession({ isFailed: true });
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("Hello", true);

      expect(session.tokens).toHaveLength(0);
    });

    test("calls onSessionStarted when token is sent and session is started", () => {
      const session = createMockSession();
      let called = false;
      const processor = new ReplyTextProcessor(session, () => {
        called = true;
      });
      processor.processText("Hello", true);

      // Session becomes started after sendToken
      expect(called).toBe(true);
    });
  });

  describe("NO_REPLY sentinel", () => {
    test("suppresses NO_REPLY sentinel", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("NO_REPLY", true);

      expect(session.tokens).toHaveLength(0);
      expect(processor.result.needsReply).toBe(false);
    });

    test("suppresses NO_REPLY case-insensitively", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("no_reply", true);

      expect(session.tokens).toHaveLength(0);
    });

    test("suppresses all subsequent text after NO_REPLY", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("NO_REPLY", true);
      processor.processText("This should not appear", true);

      expect(session.tokens).toHaveLength(0);
    });

    test("accepts NO (short sentinel) only after tool event", async () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});

      // Before any tool event, "NO" is forwarded as normal text
      processor.processText("NO", true);
      expect(session.tokens).toEqual(["NO"]);

      // After a tool event, "NO" becomes a sentinel
      const session2 = createMockSession();
      const processor2 = new ReplyTextProcessor(session2, () => {});
      await processor2.handleToolDelivery("search: results here");
      processor2.processText("NO", true);
      expect(session2.tokens).toHaveLength(0);
    });
  });

  describe("NEEDS_REPLY sentinel", () => {
    test("detects NEEDS_REPLY: with question", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("NEEDS_REPLY: What is your name?", true);

      expect(session.tokens).toHaveLength(0);
      expect(processor.result.needsReply).toBe(true);
      expect(processor.result.needsReplyQuestion).toBe("What is your name?");
    });

    test("buffers NEEDS_REPLY: when not final attempt", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("NEEDS_REPLY: What?", false);

      // Not yet resolved — buffered
      expect(processor.result.needsReply).toBe(false);
      expect(session.tokens).toHaveLength(0);

      // Flush resolves it
      processor.flush();
      expect(processor.result.needsReply).toBe(true);
      expect(processor.result.needsReplyQuestion).toBe("What?");
    });

    test("handles NEEDS_REPLY: with empty question", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("NEEDS_REPLY: ", true);

      expect(processor.result.needsReply).toBe(true);
      expect(processor.result.needsReplyQuestion).toBeUndefined();
    });

    test("is case-insensitive", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});
      processor.processText("needs_reply: Hello?", true);

      expect(processor.result.needsReply).toBe(true);
      expect(processor.result.needsReplyQuestion).toBe("Hello?");
    });
  });

  describe("sentinel prefix buffering", () => {
    test("buffers partial sentinel prefix and flushes as text", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});

      // "N" could be start of "NO_REPLY" or "NEEDS_REPLY"
      processor.processText("N", false);
      expect(session.tokens).toHaveLength(0);

      // "Normal text" — not a sentinel prefix, flush buffered + send
      processor.processText("Normal text", true);
      expect(session.tokens.length).toBeGreaterThan(0);
    });

    test("buffers then resolves full NO_REPLY sentinel", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});

      processor.processText("NO", false);
      expect(session.tokens).toHaveLength(0);

      processor.processText("NO_REPLY", true);
      expect(session.tokens).toHaveLength(0); // suppressed
    });

    test("preserves original text when buffered prefix is not a sentinel", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});

      processor.processText(" n", false);
      processor.processText("ext", true);

      expect(session.tokens).toEqual([" next"]);
    });
  });

  describe("handleToolDelivery", () => {
    test("detects ask_user tool and sets needsReply", async () => {
      const scope = "msg-test-keyed";
      await runInScope(scope, async () => {
        try {
          const session = createMockSession();
          const processor = new ReplyTextProcessor(session, () => {}, scope);

          // Store a pending question via the ask_user state bridge
          setPendingAskUserQuestion("test-key", "What do you think?");

          const intercepted = await processor.handleToolDelivery(
            "ask_user: some output",
            {
              toolCallId: "test-key",
            },
          );
          expect(intercepted).toBe(true);
          expect(processor.result.needsReply).toBe(true);
          expect(processor.result.needsReplyQuestion).toBe(
            "What do you think?",
          );
        } finally {
          cleanupScope(scope);
        }
      });
    });

    test("falls back to scoped FIFO pending question without matching toolCallId", async () => {
      const scope = "msg-test-fifo";
      await runInScope(scope, async () => {
        try {
          const session = createMockSession();
          const processor = new ReplyTextProcessor(session, () => {}, scope);

          setPendingAskUserQuestion("pending-key", "What do you think?");

          const intercepted = await processor.handleToolDelivery(
            "ask_user: fallback?",
          );
          expect(intercepted).toBe(true);
          expect(processor.result.needsReply).toBe(true);
          expect(processor.result.needsReplyQuestion).toBe(
            "What do you think?",
          );
        } finally {
          cleanupScope(scope);
        }
      });
    });

    test("waits for execute to populate question when deliver fires first", async () => {
      const scope = "msg-test-timing";
      await runInScope(scope, async () => {
        try {
          const session = createMockSession();
          const processor = new ReplyTextProcessor(session, () => {}, scope);

          // Simulate OpenClaw's ordering: deliver fires first, execute follows ~3ms later
          const deliveryPromise = processor.handleToolDelivery("Ask User");
          setTimeout(() => {
            setPendingAskUserQuestion("delayed-key", "Delayed question?");
          }, 5);

          const intercepted = await deliveryPromise;
          expect(intercepted).toBe(true);
          expect(processor.result.needsReply).toBe(true);
          expect(processor.result.needsReplyQuestion).toBe("Delayed question?");
        } finally {
          cleanupScope(scope);
        }
      });
    });

    test("FIFO fallback does not consume questions from a different scope", async () => {
      // Simulate agent A storing a question in scope A
      runInScope("msg-agent-a", () => {
        setPendingAskUserQuestion("tool-a", "Agent A question");
      });

      try {
        // Simulate agent B trying to consume without toolCallId in scope B
        // Use "Ask User" (no colon/question) to match OpenClaw's stripped format
        const scopeB = "msg-agent-b";
        await runInScope(scopeB, async () => {
          try {
            const session = createMockSession();
            const processor = new ReplyTextProcessor(session, () => {}, scopeB);

            const intercepted = await processor.handleToolDelivery("Ask User");

            expect(intercepted).toBe(true);
            expect(processor.result.needsReply).toBe(true);
            // Should NOT have consumed agent A's question
            expect(processor.result.needsReplyQuestion).toBeUndefined();
          } finally {
            cleanupScope(scopeB);
          }
        });
      } finally {
        cleanupScope("msg-agent-a");
      }
    });

    test("returns false for non-ask_user tools", async () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});

      const intercepted = await processor.handleToolDelivery(
        "search: query results",
      );
      expect(intercepted).toBe(false);
      expect(processor.result.needsReply).toBe(false);
      expect(session.toolEvents.length).toBeGreaterThan(0);
    });

    test("returns false when session is failed", async () => {
      const session = createMockSession({ isFailed: true });
      const processor = new ReplyTextProcessor(session, () => {});

      const intercepted =
        await processor.handleToolDelivery("ask_user: question");
      expect(intercepted).toBe(false);
    });
  });

  describe("flush", () => {
    test("flushes buffered candidate as final text", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});

      // Buffer a partial prefix
      processor.processText("Hello", false);
      processor.flush();

      expect(session.tokens).toEqual(["Hello"]);
    });

    test("no-ops when suppressed", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});

      processor.processText("NO_REPLY", true);
      processor.flush(); // should not throw or send anything

      expect(session.tokens).toHaveLength(0);
    });

    test("no-ops when no pending candidate", () => {
      const session = createMockSession();
      const processor = new ReplyTextProcessor(session, () => {});

      processor.flush(); // nothing buffered
      expect(session.tokens).toHaveLength(0);
    });
  });
});
