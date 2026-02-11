/**
 * Plugin Config Schema and Account Resolution
 *
 * Defines the configuration shape for the Type channel plugin
 * and how to resolve account credentials from the OpenClaw config.
 */

import { z } from "zod";

const typeChannelConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  token: z.string().optional().default(""),
  wsUrl: z.string().optional().default("wss://api.type.com/api/agents/ws"),
  agentId: z.string().optional().default(""),
});

const cfgSchema = z.object({
  channels: z
    .object({
      type: typeChannelConfigSchema.optional(),
    })
    .optional(),
});

export interface TypeAccountConfig {
  accountId: string;
  token: string;
  wsUrl: string;
  agentId: string;
  enabled: boolean;
}

function parseTypeConfig(cfg: Record<string, unknown>) {
  const parsed = cfgSchema.safeParse(cfg);
  return parsed.success ? parsed.data.channels?.type : undefined;
}

/**
 * List available account IDs from the config.
 * Type uses a single account per plugin config.
 */
export function listAccountIds(cfg: Record<string, unknown>): string[] {
  const typeConfig = parseTypeConfig(cfg);
  if (typeConfig?.token) return ["default"];
  return [];
}

/**
 * Resolve account configuration from the OpenClaw global config.
 */
export function resolveAccount(
  cfg: Record<string, unknown>,
  accountId?: string,
): TypeAccountConfig {
  const typeConfig = parseTypeConfig(cfg);
  return {
    accountId: accountId ?? "default",
    token: typeConfig?.token ?? "",
    wsUrl: typeConfig?.wsUrl ?? "wss://api.type.com/api/agents/ws",
    agentId: typeConfig?.agentId ?? "",
    enabled: typeConfig?.enabled ?? false,
  };
}
