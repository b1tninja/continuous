import { FetchLike, postRpc } from "./mcpHttpRpc";
import {
  ClientIdentity,
  DiscoverResult,
  MODERN_PROTOCOL_VERSION,
  buildRequestMeta,
  parseDiscoverResult,
} from "./mcpRevision";

export type EraProbe =
  | { era: "modern"; discover: DiscoverResult }
  | { era: "legacy"; reason: string };

export interface ProbeOptions {
  url: string;
  clientInfo: ClientIdentity;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Ask an HTTP server whether it speaks revision 2026-07-28 by sending
 * `server/discover`. Never throws: every failure (network, auth, 4xx/5xx
 * without a modern error, malformed result) answers "legacy" with a reason, so
 * the caller falls back to the classic `initialize` handshake and the existing
 * error handling, including OAuth on 401, runs unchanged.
 */
export async function probeServerEra(opts: ProbeOptions): Promise<EraProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const { status, response } = await postRpc({
      url: opts.url,
      method: "server/discover",
      id: "discover-1",
      params: { _meta: buildRequestMeta(opts.clientInfo) },
      headers: opts.headers,
      fetch: opts.fetch,
      signal: controller.signal,
    });
    if (status !== 200 || !response) {
      return {
        era: "legacy",
        reason: `HTTP ${status} without a JSON-RPC answer`,
      };
    }
    if (response.error) {
      // A recognized modern error means a modern server that does not offer
      // our version; the classic path may still work (dual-era), so fall back.
      return { era: "legacy", reason: `error ${response.error.code}` };
    }
    const discover = parseDiscoverResult(response.result);
    if (!discover) {
      return { era: "legacy", reason: "malformed server/discover result" };
    }
    if (!discover.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) {
      return { era: "legacy", reason: "no common protocol version" };
    }
    return { era: "modern", discover };
  } catch (e) {
    return {
      era: "legacy",
      reason: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
