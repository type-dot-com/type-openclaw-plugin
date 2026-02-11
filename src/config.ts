/**
 * Plugin Config Schema and Account Resolution
 *
 * Defines the configuration shape for the Type channel plugin
 * and how to resolve account credentials from the OpenClaw config.
 */

export interface TypeChannelConfig {
  enabled: boolean;
  token: string;
  wsUrl: string;
  agentId: string;
}

export interface TypeAccountConfig {
  accountId: string;
  token: string;
  wsUrl: string;
  agentId: string;
  enabled: boolean;
}

/**
 * List available account IDs from the config.
 * Type uses a single account per plugin config.
 */
export function listAccountIds(cfg: Record<string, unknown>): string[] {
  const typeConfig = (cfg as { channels?: { type?: TypeChannelConfig } })
    .channels?.type;
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
  const typeConfig = (
    cfg as { channels?: { type?: Partial<TypeChannelConfig> } }
  ).channels?.type;
  return {
    accountId: accountId ?? "default",
    token: typeConfig?.token ?? "",
    wsUrl: typeConfig?.wsUrl ?? "wss://api.type.com/api/agents/ws",
    agentId: typeConfig?.agentId ?? "",
    enabled: typeConfig?.enabled ?? false,
  };
}
