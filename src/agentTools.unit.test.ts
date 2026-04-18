import { afterEach, describe, expect, mock, test } from "bun:test";
import { clearAccountState, getAccountState } from "./accountState.js";
import { agentTools } from "./agentTools.js";
import { runWithInboundRoutingContext } from "./inboundRoutingState.js";

const ACCOUNT_ID = "acct_test";
const originalFetch = globalThis.fetch;

function installConnectedAccount(): void {
  const state = getAccountState(ACCOUNT_ID);
  state.connectionState = "connected";
  state.context = {
    token: "ta_test_token",
    wsUrl: "wss://type.example.com/api/agents/ws",
    agentId: "agent_123",
  };
  state.outbound = {} as never;
}

function getTool(name: string) {
  const tool = agentTools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Missing tool ${name}`);
  }
  return tool;
}

afterEach(() => {
  clearAccountState(ACCOUNT_ID);
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("agentTools channel routing", () => {
  test("binds service and database discovery requests to the current inbound channel context", async () => {
    installConnectedAccount();

    const requestedUrls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ url: String(input) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const [findToolsResult, listDatabasesResult] =
      await runWithInboundRoutingContext(
        {
          channelId: "ch_alpha",
          replyTargetParentMessageId: null,
          requiresExplicitReplyTarget: false,
        },
        async () =>
          Promise.all([
            getTool("find_tools").execute("tool_alpha", {}),
            getTool("list_databases").execute("tool_beta", {}),
          ]),
      );

    expect(findToolsResult.content[0]?.text).toContain("channelId=ch_alpha");
    expect(listDatabasesResult.content[0]?.text).toContain(
      "channelId=ch_alpha",
    );
    expect(requestedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/services?channelId=ch_alpha"),
        expect.stringContaining("/postgres?channelId=ch_alpha"),
      ]),
    );
  });

  test("keeps concurrent tool calls isolated by async context", async () => {
    installConnectedAccount();

    const requestedUrls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await Promise.all([
      runWithInboundRoutingContext(
        {
          channelId: "ch_one",
          replyTargetParentMessageId: null,
          requiresExplicitReplyTarget: false,
        },
        () =>
          getTool("call_tool").execute("tool_one", {
            service: "linear",
            name: "list_issues",
          }),
      ),
      runWithInboundRoutingContext(
        {
          channelId: "ch_two",
          replyTargetParentMessageId: null,
          requiresExplicitReplyTarget: false,
        },
        () =>
          getTool("postgresql_query").execute("tool_two", {
            integrationId: "db_1",
            query: "select 1",
          }),
      ),
    ]);

    expect(requestedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("channelId=ch_one"),
        expect.stringContaining("channelId=ch_two"),
      ]),
    );
  });
});
