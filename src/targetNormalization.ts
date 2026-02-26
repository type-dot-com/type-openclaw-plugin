const KNOWN_DIRECT_TARGET_PREFIXES = ["ch_", "agsess_", "dm_", "msg_"] as const;

/**
 * Normalize user/tool provided Type target strings into raw channel/session ids.
 */
export function normalizeTypeTarget(raw: string): string {
  let value = raw.trim();
  if (!value) {
    return "";
  }
  value = value.replace(/^type:/i, "");
  value = value.replace(/^(channel|group):/i, "");
  return value.trim();
}

/**
 * Identify values that should bypass directory resolution and be treated as direct ids.
 */
export function isLikelyTypeTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  if (/^(channel|group|user):/i.test(trimmed)) {
    return true;
  }

  const normalized = normalizeTypeTarget(trimmed);
  if (!normalized) {
    return false;
  }

  return KNOWN_DIRECT_TARGET_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}
