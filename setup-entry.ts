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

  // The OpenClaw loader's setup-phase path expects a `register` (or `activate`)
  // export when the SDK's defineSetupPluginEntry marker isn't used. Full
  // channel registration happens in src/index.ts at runtime; this no-op keeps
  // install/setup-phase loads from logging "missing register/activate export".
  register: () => {},
};

export default setupPlugin;
