import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TYPE_WS_URL,
  listAccountIds,
  resolveAccount,
} from "./config.js";

describe("type plugin config resolution", () => {
  test("resolves configured mediaLocalRoots", () => {
    const cfg: Record<string, unknown> = {
      channels: {
        type: {
          token: "ta_test",
          wsUrl: "wss://example.com/api/agents/ws",
          agentId: "agent_123",
          mediaLocalRoots: ["/workspace", "/tmp/uploads"],
        },
      },
    };

    const account = resolveAccount(cfg);
    expect(account.token).toBe("ta_test");
    expect(account.wsUrl).toBe("wss://example.com/api/agents/ws");
    expect(account.agentId).toBe("agent_123");
    expect(account.mediaLocalRoots).toEqual(["/workspace", "/tmp/uploads"]);
  });

  test("defaults mediaLocalRoots to empty array", () => {
    const account = resolveAccount({});
    expect(account.wsUrl).toBe(DEFAULT_TYPE_WS_URL);
    expect(account.mediaLocalRoots).toEqual([]);
  });

  test("listAccountIds remains keyed by token presence", () => {
    const cfgWithToken: Record<string, unknown> = {
      channels: {
        type: {
          token: "ta_test",
          mediaLocalRoots: ["/workspace"],
        },
      },
    };

    expect(listAccountIds(cfgWithToken)).toEqual(["default"]);
    expect(listAccountIds({})).toEqual([]);
  });
});
