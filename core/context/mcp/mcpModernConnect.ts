import { ModernMcpClient } from "./ModernMcpClient";
import { probeServerEra } from "./mcpDiscover";
import { FetchLike } from "./mcpHttpRpc";

export interface ModernConnectArgs {
  url: string;
  clientInfo: { name: string; version: string };
  headers?: Record<string, string>;
  /** Token of a saved sign-in, sent as a bearer when no Authorization header is set. */
  accessToken?: () => Promise<string | undefined>;
  fetch?: FetchLike;
}

/**
 * Negotiate with an HTTP server: `server/discover` first. A server that
 * answers it with revision 2026-07-28 gets the stateless client; anything else
 * (old server, 401, malformed answer, network error) returns undefined and the
 * caller runs the classic `initialize` handshake exactly as before.
 */
export async function connectModernIfSupported(
  args: ModernConnectArgs,
): Promise<ModernMcpClient | undefined> {
  const headers = { ...args.headers };
  const hasAuth = Object.keys(headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
  if (!hasAuth && args.accessToken) {
    try {
      const token = await args.accessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch {
      // no usable sign-in: probe without it
    }
  }
  const probe = await probeServerEra({
    url: args.url,
    clientInfo: args.clientInfo,
    headers,
    fetch: args.fetch,
  });
  if (probe.era !== "modern") return undefined;
  return new ModernMcpClient({
    url: args.url,
    clientInfo: args.clientInfo,
    discover: probe.discover,
    headers,
    fetch: args.fetch,
  });
}
