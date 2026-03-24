/**
 * Plugin Config Schema and Account Resolution
 *
 * Defines the configuration shape for the Type channel plugin
 * and how to resolve account credentials from the OpenClaw config.
 *
 * Supports two config formats:
 *
 * Legacy (single account):
 *   channels.type.token / wsUrl / agentId
 *
 * Multi-account (follows Discord/Telegram pattern):
 *   channels.type.accounts.<name>.token / wsUrl / agentId
 */

import { z } from "zod";

export const DEFAULT_TYPE_WS_URL = "wss://api.type.com/api/agents/ws";

const typeAccountConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  token: z.string().optional().default(""),
  wsUrl: z.string().optional().default(DEFAULT_TYPE_WS_URL),
  agentId: z.string().optional().default(""),
  mediaLocalRoots: z.array(z.string()).optional().default([]),
  ownerAllowFrom: z.array(z.string()).optional().default([]),
});

/**
 * Config schema supporting both legacy flat format and multi-account format.
 *
 * Legacy:    channels.type.{ token, wsUrl, agentId, ... }
 * Multi:     channels.type.accounts.{ <name>: { token, wsUrl, agentId, ... } }
 */
const cfgSchema = z.object({
  channels: z
    .object({
      type: z
        .object({
          // Legacy flat fields (all optional so they coexist with accounts)
          enabled: z.boolean().optional(),
          token: z.string().optional(),
          wsUrl: z.string().optional(),
          agentId: z.string().optional(),
          mediaLocalRoots: z.array(z.string()).optional(),
          ownerAllowFrom: z.array(z.string()).optional(),
          // Multi-account: named accounts object
          accounts: z.record(z.string(), typeAccountConfigSchema).optional(),
        })
        .optional(),
    })
    .optional(),
});

export interface TypeAccountConfig {
  accountId: string;
  token: string;
  wsUrl: string;
  agentId: string;
  mediaLocalRoots: readonly string[];
  ownerAllowFrom: readonly string[];
  enabled: boolean;
}

interface ParsedTypeConfig {
  legacy: {
    enabled?: boolean;
    token?: string;
    wsUrl?: string;
    agentId?: string;
    mediaLocalRoots?: string[];
    ownerAllowFrom?: string[];
  } | null;
  accounts: Record<string, z.infer<typeof typeAccountConfigSchema>> | null;
}

function parseTypeConfig(cfg: Record<string, unknown>): ParsedTypeConfig {
  const parsed = cfgSchema.safeParse(cfg);
  if (!parsed.success || !parsed.data.channels?.type) {
    return { legacy: null, accounts: null };
  }

  const typeBlock = parsed.data.channels.type;
  const accounts =
    typeBlock.accounts && Object.keys(typeBlock.accounts).length > 0
      ? typeBlock.accounts
      : null;

  // Legacy fields present if token is set (without accounts)
  const hasLegacyToken = Boolean(typeBlock.token);
  const legacy = hasLegacyToken
    ? {
        enabled: typeBlock.enabled,
        token: typeBlock.token,
        wsUrl: typeBlock.wsUrl,
        agentId: typeBlock.agentId,
        mediaLocalRoots: typeBlock.mediaLocalRoots,
        ownerAllowFrom: typeBlock.ownerAllowFrom,
      }
    : null;

  return { legacy, accounts };
}

/**
 * List available account IDs from the config.
 *
 * Multi-account: returns keys from channels.type.accounts
 * Legacy: returns ["default"] if token is configured
 */
export function listAccountIds(cfg: Record<string, unknown>): string[] {
  const { legacy, accounts } = parseTypeConfig(cfg);
  if (accounts) return Object.keys(accounts);
  if (legacy?.token) return ["default"];
  return [];
}

/**
 * Non-destructive account inspection for setup flows.
 *
 * Returns config status without materializing secrets — safe to call
 * during onboarding wizards where the full runtime isn't loaded.
 */
export function inspectAccount(
  cfg: Record<string, unknown>,
  accountId?: string,
): {
  enabled: boolean;
  configured: boolean;
  hasToken: boolean;
  hasAgentId: boolean;
} {
  const account = resolveAccount(cfg, accountId);
  return {
    enabled: account.enabled,
    configured: Boolean(account.token) && Boolean(account.agentId),
    hasToken: Boolean(account.token),
    hasAgentId: Boolean(account.agentId),
  };
}

/**
 * Resolve account configuration from the OpenClaw global config.
 *
 * Multi-account: looks up by accountId in channels.type.accounts
 * Legacy: returns the flat config as the "default" account
 */
export function resolveAccount(
  cfg: Record<string, unknown>,
  accountId?: string,
): TypeAccountConfig {
  const { legacy, accounts } = parseTypeConfig(cfg);
  const resolvedAccountId = accountId ?? "default";

  // Multi-account: look up by accountId
  if (accounts) {
    const account = accounts[resolvedAccountId];
    if (account) {
      return {
        accountId: resolvedAccountId,
        token: account.token,
        wsUrl: account.wsUrl,
        agentId: account.agentId,
        mediaLocalRoots: account.mediaLocalRoots,
        ownerAllowFrom: account.ownerAllowFrom,
        enabled: account.enabled,
      };
    }
    // accountId not found in accounts — return empty config
    return {
      accountId: resolvedAccountId,
      token: "",
      wsUrl: DEFAULT_TYPE_WS_URL,
      agentId: "",
      mediaLocalRoots: [],
      ownerAllowFrom: [],
      enabled: false,
    };
  }

  // Legacy flat config
  return {
    accountId: resolvedAccountId,
    token: legacy?.token ?? "",
    wsUrl: legacy?.wsUrl ?? DEFAULT_TYPE_WS_URL,
    agentId: legacy?.agentId ?? "",
    mediaLocalRoots: legacy?.mediaLocalRoots ?? [],
    ownerAllowFrom: legacy?.ownerAllowFrom ?? [],
    enabled: legacy?.enabled ?? false,
  };
}
