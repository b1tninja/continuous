import {
  knownValueMatcher,
  scanText,
  secretValuesFromEnv,
  shannonEntropy,
} from "./secretScan";
import { classifyHost } from "./networkAddress";
import { isPublicTld } from "./publicTlds";
import {
  hostInNetSet,
  normalizeHost as canonicalHost,
} from "../tools/permissions/destinations";

/**
 * Checks on a URL before a fetch tool connects to it (plans/research/
 * web-search-and-fetch.md, gaps G3, G4, G10). A URL the model builds is bytes
 * it chooses and a server it names receives, so a secret in the path or query
 * is an exfiltration channel. Nothing here prints a matched value.
 */

export function assertFetchableScheme(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Refused: only http and https URLs can be fetched (this one is ${url.protocol})`,
    );
  }
}

export function assertNoUserinfo(url: URL): void {
  if (url.username || url.password) {
    throw new Error(
      "Refused: the URL has a user name or password in it. Credentials are never sent in a URL",
    );
  }
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Rule kinds of secret-shaped values in the part of the URL a server receives. */
export function secretKindsInUrl(
  url: URL,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const sent = `${url.pathname}${url.search}`;
  // Scan both spellings: a percent-encoded key is still the key
  const text = `${sent}\n${decoded(sent)}`;
  const known = knownValueMatcher(secretValuesFromEnv(env));
  const kinds = scanText(text, "outbound", { known }).map((f) => f.kind);
  return [...new Set(kinds)];
}

/** Throws, without quoting the value, when the URL carries a secret. */
export function assertNoSecretInUrl(url: URL): void {
  const kinds = secretKindsInUrl(url);
  if (kinds.length) {
    throw new Error(
      `Refused: the URL contains what looks like a credential (${kinds.join(", ")}). It was not fetched. Do not put secrets in a URL`,
    );
  }
}

const LONG_TOKEN = /[A-Za-z0-9+/_=%-]{64,}/g;

/**
 * Why a URL should be shown to the person even when fetching is otherwise
 * allowed: it carries a long high-entropy token (base64 or an encoded
 * payload), the shape of data being moved out. Ask-only: it never loosens.
 * Provenance (the URL appeared in a message or a tool result) is not used,
 * because the conversation is not reachable from the policy hook.
 */
export function urlReviewReason(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return "credentials in the URL";
  if (secretKindsInUrl(url).length) return "a credential-shaped value";
  for (const token of `${url.pathname}${url.search}`.match(LONG_TOKEN) ?? []) {
    // Mixed case and digits: a slug or a hex digest is not a payload
    if (
      /[a-z]/.test(token) &&
      /[A-Z]/.test(token) &&
      /\d/.test(token) &&
      shannonEntropy(token) >= 4.2
    ) {
      return "a long encoded value";
    }
  }
  return undefined;
}

/**
 * A name that resolves to nothing here and is a single label (`wiki`,
 * `intranet`) or ends in a label that is not a delegated top-level domain
 * (`host.corp`, `nas.lan`).
 * Behind an HTTP proxy the proxy resolves names, so such a name may be an
 * internal host that this machine cannot see. Names under a real TLD that do
 * not resolve are not flagged: with DNS only available through the proxy,
 * that is every public name.
 */
export function isUnresolvedInternalName(
  hostname: string,
  addresses: readonly string[],
): boolean {
  if (addresses.length) return false;
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host || host.includes(":") || /^[\d.]+$/.test(host)) return false;
  const labels = host.split(".");
  // A single label is an internal name even when it is also a delegated
  // top-level domain (`wiki`, `app`, `dev`): a bare TLD names no web host in
  // practice (ICANN does not allow dotless domains, SSAC SAC053), so `wiki`
  // that does not resolve here is the intranet's `wiki` behind a proxy.
  if (labels.length === 1) return true;
  return !isPublicTld(labels[labels.length - 1]);
}

/** `classifyHost` plus the unresolved-internal-name rule (ask, never allow). */
export async function classifyFetchTarget(
  hostname: string,
): Promise<{ addresses: string[]; nonPublic: boolean }> {
  const { addresses, nonPublic } = await classifyHost(hostname);
  return {
    addresses,
    nonPublic: nonPublic || isUnresolvedInternalName(hostname, addresses),
  };
}

/** IPv4 carried in the low 32 bits of an IPv6 address (NAT64 64:ff9b::/96, IPv4-compatible ::/96). */
function embeddedIPv4(host: string): string | undefined {
  const m =
    /^(?:64:ff9b:(?:0:0:0:0:|:)|::|0:0:0:0:0:0:)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(
      host,
    );
  if (!m) return undefined;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

function isMetadataHost(raw: string): boolean {
  const host = canonicalHost(raw);
  if (hostInNetSet(host, "metadata")) return true;
  const v4 = embeddedIPv4(host);
  return v4 !== undefined && hostInNetSet(v4, "metadata");
}

/**
 * Why a fetch target is a cloud metadata service (`169.254.169.254`,
 * `fd00:ec2::254`, `100.100.100.200`, `metadata.google.internal`,
 * `metadata.goog`), by its name, an address it resolved to, or an IPv6 form
 * that carries the address. Undefined when it is not one.
 *
 * Refused at every level, IDGAF included, at the start URL and at every
 * redirect hop (plans/research/web-fetch-large-pages-and-policy.md, 8.6): no
 * person reads documentation from the metadata service, and it is the one
 * SSRF target that hands out credentials.
 */
export function cloudMetadataReason(
  hostname: string,
  addresses: readonly string[] = [],
): string | undefined {
  if (isMetadataHost(hostname)) return canonicalHost(hostname);
  const hit = addresses.find(isMetadataHost);
  return hit ? `${canonicalHost(hostname)} resolves to ${hit}` : undefined;
}

/** The refusal text for a cloud metadata target. Do not retry it: no setting allows it. */
export function cloudMetadataRefusal(where: string): string {
  return `Refused: ${where} is a cloud metadata service, which hands out credentials. It is never fetched, at any level. Do not retry it.`;
}
