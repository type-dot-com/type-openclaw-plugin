import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TYPE_WS_URL,
  listAccountIds,
  resolveAccount,
} from "./config.js";

describe("type plugin config resolution", () => {
  // -----------------------------------------------------------------------
  // Legacy single-account config
  // -----------------------------------------------------------------------

  describe("legacy flat config", () => {
    test("resolves configured fields", () => {
      const cfg: Record<string, unknown> = {
        channels: {
          type: {
            token: "ta_test",
            wsUrl: "wss://example.com/api/agents/ws",
            agentId: "agent_123",
            mediaLocalRoots: ["/workspace", "/tmp/uploads"],
            ownerAllowFrom: ["user_123"],
          },
        },
      };

      const account = resolveAccount(cfg);
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("ta_test");
      expect(account.wsUrl).toBe("wss://example.com/api/agents/ws");
      expect(account.agentId).toBe("agent_123");
      expect(account.mediaLocalRoots).toEqual(["/workspace", "/tmp/uploads"]);
      expect(account.ownerAllowFrom).toEqual(["user_123"]);
    });

    test("defaults mediaLocalRoots to empty array", () => {
      const account = resolveAccount({});
      expect(account.wsUrl).toBe(DEFAULT_TYPE_WS_URL);
      expect(account.mediaLocalRoots).toEqual([]);
      expect(account.ownerAllowFrom).toEqual([]);
    });

    test("listAccountIds returns [default] when token is set", () => {
      const cfg: Record<string, unknown> = {
        channels: {
          type: {
            token: "ta_test",
            mediaLocalRoots: ["/workspace"],
          },
        },
      };

      expect(listAccountIds(cfg)).toEqual(["default"]);
    });

    test("listAccountIds returns [] when no config", () => {
      expect(listAccountIds({})).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-account config (Discord/Telegram pattern)
  // -----------------------------------------------------------------------

  describe("multi-account config", () => {
    const multiAccountCfg: Record<string, unknown> = {
      channels: {
        type: {
          accounts: {
            support: {
              enabled: true,
              token: "ta_support",
              wsUrl: "wss://api.type.com/api/agents/ws",
              agentId: "agent_support",
              mediaLocalRoots: ["/workspace/support"],
              ownerAllowFrom: ["user_support"],
            },
            engineering: {
              enabled: true,
              token: "ta_eng",
              wsUrl: "wss://api.type.com/api/agents/ws",
              agentId: "agent_eng",
            },
          },
        },
      },
    };

    test("listAccountIds returns all account keys", () => {
      const ids = listAccountIds(multiAccountCfg);
      expect(ids).toEqual(["support", "engineering"]);
    });

    test("resolveAccount returns correct account by ID", () => {
      const support = resolveAccount(multiAccountCfg, "support");
      expect(support.accountId).toBe("support");
      expect(support.token).toBe("ta_support");
      expect(support.agentId).toBe("agent_support");
      expect(support.mediaLocalRoots).toEqual(["/workspace/support"]);
      expect(support.ownerAllowFrom).toEqual(["user_support"]);

      const eng = resolveAccount(multiAccountCfg, "engineering");
      expect(eng.accountId).toBe("engineering");
      expect(eng.token).toBe("ta_eng");
      expect(eng.agentId).toBe("agent_eng");
      expect(eng.mediaLocalRoots).toEqual([]);
      expect(eng.ownerAllowFrom).toEqual([]);
    });

    test("resolveAccount returns empty config for unknown accountId", () => {
      const unknown = resolveAccount(multiAccountCfg, "unknown");
      expect(unknown.accountId).toBe("unknown");
      expect(unknown.token).toBe("");
      expect(unknown.agentId).toBe("");
      expect(unknown.enabled).toBe(false);
    });

    test("resolveAccount without accountId returns empty when accounts exist", () => {
      // "default" doesn't exist in accounts, so should return empty
      const result = resolveAccount(multiAccountCfg);
      expect(result.accountId).toBe("default");
      expect(result.token).toBe("");
    });

    test("resolveAccount with default account works", () => {
      const cfgWithDefault: Record<string, unknown> = {
        channels: {
          type: {
            accounts: {
              default: {
                token: "ta_default",
                agentId: "agent_default",
              },
              other: {
                token: "ta_other",
                agentId: "agent_other",
              },
            },
          },
        },
      };

      const result = resolveAccount(cfgWithDefault);
      expect(result.accountId).toBe("default");
      expect(result.token).toBe("ta_default");
      expect(result.agentId).toBe("agent_default");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    test("empty accounts object falls back to legacy", () => {
      const cfg: Record<string, unknown> = {
        channels: {
          type: {
            token: "ta_legacy",
            agentId: "agent_legacy",
            accounts: {},
          },
        },
      };

      expect(listAccountIds(cfg)).toEqual(["default"]);
      const account = resolveAccount(cfg);
      expect(account.token).toBe("ta_legacy");
      expect(account.agentId).toBe("agent_legacy");
    });

    test("invalid config returns empty", () => {
      const account = resolveAccount({ channels: "invalid" });
      expect(account.token).toBe("");
      expect(account.agentId).toBe("");
    });
  });
});
