import type { TypeConnection } from "./connection.js";
import type { PluginRuntime } from "./messageHandler.js";
import type { TypeOutboundHandler } from "./outbound.js";

export interface AccountState {
  connection: TypeConnection | null;
  outbound: TypeOutboundHandler | null;
  context: { token: string; wsUrl: string; agentId: string } | null;
  connectionState: "disconnected" | "connecting" | "connected";
}

const accountStates = new Map<string, AccountState>();

let pluginRuntime: PluginRuntime | null = null;

export function getPluginRuntime(): PluginRuntime | null {
  return pluginRuntime;
}

export function setPluginRuntime(runtime: PluginRuntime): void {
  pluginRuntime = runtime;
}

export function getAccountState(accountId: string): AccountState {
  let state = accountStates.get(accountId);
  if (!state) {
    state = {
      connection: null,
      outbound: null,
      context: null,
      connectionState: "disconnected",
    };
    accountStates.set(accountId, state);
  }
  return state;
}

export function clearAccountState(accountId: string): void {
  accountStates.delete(accountId);
}

/**
 * Select a single fallback account ID when no explicit accountId is provided.
 * Both getOutboundForAccount and getAccountContextForAccount use this to
 * guarantee they pick the same fallback account.
 */
function selectFallbackAccountId(): string | undefined {
  for (const [id, state] of accountStates.entries()) {
    if (state.outbound) return id;
  }
  return undefined;
}

export function getOutboundForAccount(
  accountId: string | null | undefined,
): TypeOutboundHandler | null {
  const resolvedId = accountId ?? selectFallbackAccountId();
  if (!resolvedId) return null;
  return accountStates.get(resolvedId)?.outbound ?? null;
}

export function getAccountContextForAccount(
  accountId: string | null | undefined,
): { token: string; wsUrl: string; agentId: string } | null {
  const resolvedId = accountId ?? selectFallbackAccountId();
  if (!resolvedId) return null;
  return accountStates.get(resolvedId)?.context ?? null;
}
