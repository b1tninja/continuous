/**
 * MCP revision 2026-07-28 (stateless): constants, per-request `_meta`, header
 * encoding and a strict check of a `server/discover` result.
 *
 * Primary text: https://modelcontextprotocol.io/specification/2026-07-28/changelog
 * (fetched 2026-11-11), `basic/versioning`, `basic/transports/streamable-http`
 * and `server/discover`.
 */

export const MODERN_PROTOCOL_VERSION = "2026-07-28";

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES =
  "io.modelcontextprotocol/clientCapabilities";

/** JSON-RPC code of `UnsupportedProtocolVersionError` (renumbered from -32004). */
export const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;
/** `HeaderMismatchError`. */
export const HEADER_MISMATCH_CODE = -32020;

export interface ClientIdentity {
  name: string;
  version: string;
}

export interface DiscoverResult {
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  instructions?: string;
  serverInfo?: { name?: string; version?: string };
}

/** The `_meta` object every modern request carries. */
export function buildRequestMeta(
  clientInfo: ClientIdentity,
  capabilities: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
    [META_CLIENT_INFO]: clientInfo,
    [META_CLIENT_CAPABILITIES]: capabilities,
  };
}

const SAFE_HEADER_VALUE = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;
const SENTINEL = /^=\?base64\?.*\?=$/;

/**
 * Header value for `Mcp-Name`: plain when it is visible ASCII without edge
 * whitespace and does not look like the Base64 sentinel, else
 * `=?base64?<utf-8 in base64>?=`.
 */
export function encodeHeaderValue(value: string): string {
  if (SAFE_HEADER_VALUE.test(value) && !SENTINEL.test(value)) {
    return value;
  }
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a `result` as a DiscoverResult. Returns undefined for anything that
 * is not one: the caller then treats the server as legacy, so a malformed
 * answer can never make a working server unusable.
 */
export function parseDiscoverResult(
  result: unknown,
): DiscoverResult | undefined {
  if (!isRecord(result)) return undefined;
  const { supportedVersions, capabilities } = result;
  if (
    !Array.isArray(supportedVersions) ||
    supportedVersions.length === 0 ||
    supportedVersions.length > 64 ||
    !supportedVersions.every((v) => typeof v === "string" && v.length < 64)
  ) {
    return undefined;
  }
  if (!isRecord(capabilities)) return undefined;
  const meta = result._meta;
  const info = isRecord(meta)
    ? meta["io.modelcontextprotocol/serverInfo"]
    : undefined;
  return {
    supportedVersions: supportedVersions as string[],
    capabilities,
    instructions:
      typeof result.instructions === "string" ? result.instructions : undefined,
    serverInfo: isRecord(info)
      ? (info as DiscoverResult["serverInfo"])
      : undefined,
  };
}
