/**
 * Lightweight setup entry point for OpenClaw onboarding.
 *
 * Only imports config resolution — avoids pulling in WebSocket,
 * streaming, or other heavy runtime dependencies.
 */

import {
  inspectAccount,
  listAccountIds,
  resolveAccount,
} from "./src/config.js";

const setupPlugin = {
  id: "type",
  meta: {
    id: "type",
    label: "Type",
    selectionLabel: "Type (Team Chat)",
    docsPath: "/channels/type",
    blurb: "Connect OpenClaw to Type team chat via WebSocket.",
  },

  config: {
    listAccountIds: (cfg: Record<string, unknown>) => listAccountIds(cfg),
    resolveAccount: (cfg: Record<string, unknown>, accountId?: string) =>
      resolveAccount(cfg, accountId),
    inspectAccount: (cfg: Record<string, unknown>, accountId?: string) =>
      inspectAccount(cfg, accountId),
    isConfigured: (
      account: { token?: string; agentId?: string },
      _cfg: Record<string, unknown>,
    ): boolean => Boolean(account.token) && Boolean(account.agentId),
  },
};

export default setupPlugin;
