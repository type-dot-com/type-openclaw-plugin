/**
 * Resolve the HTTP API origin from a configured WebSocket URL.
 */
export function resolveApiOriginFromWsUrl(wsUrl: string): string | null {
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    } else if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}
