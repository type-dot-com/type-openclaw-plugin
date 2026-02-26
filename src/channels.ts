import { z } from "zod";
import type { TypeAccountConfig } from "./config.js";
import {
  isLikelyTypeTargetId,
  normalizeTypeTarget,
} from "./targetNormalization.js";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const channelEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

export type ChannelEntry = z.infer<typeof channelEntrySchema>;

const fetchChannelsResponseSchema = z.object({
  channels: z.array(channelEntrySchema).optional(),
});

function deriveBaseUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

export async function fetchChannels(
  account: TypeAccountConfig,
): Promise<{ ok: true; channels: ChannelEntry[] } | { ok: false }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const baseUrl = deriveBaseUrl(account.wsUrl);
    const res = await fetch(
      `${baseUrl}/api/agents/${account.agentId}/channels`,
      {
        headers: { Authorization: `Bearer ${account.token}` },
        signal: controller.signal,
      },
    );
    if (!res.ok) return { ok: false };
    const parsed = fetchChannelsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false };
    return { ok: true, channels: parsed.data.channels ?? [] };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

const channelCacheMap = new Map<
  string,
  { data: ChannelEntry[]; expiresAt: number }
>();

export async function fetchChannelsCached(
  account: TypeAccountConfig,
): Promise<ChannelEntry[]> {
  const cacheKey = `${account.accountId}:${account.agentId}`;
  const cached = channelCacheMap.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  const result = await fetchChannels(account);
  if (!result.ok) return [];
  channelCacheMap.set(cacheKey, {
    data: result.channels,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return result.channels;
}

export async function resolveChannelId(
  to: string,
  account: TypeAccountConfig,
): Promise<string> {
  const normalizedTarget = normalizeTypeTarget(to);
  if (!account.token || isLikelyTypeTargetId(normalizedTarget)) {
    return normalizedTarget;
  }
  const channels = await fetchChannelsCached(account);
  const normalized = normalizedTarget.startsWith("#")
    ? normalizedTarget.slice(1)
    : normalizedTarget;
  const match =
    channels.find((ch) => ch.id === normalizedTarget) ??
    channels.find((ch) => ch.name.toLowerCase() === normalized.toLowerCase());
  return match ? match.id : normalizedTarget;
}
