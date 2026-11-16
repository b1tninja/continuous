import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  IPV4_SPECIAL_PURPOSE,
  IPV6_SPECIAL_PURPOSE,
  type SpecialPurposeBlock,
} from "./specialPurpose.generated";

/**
 * Whether an IP address is not on the public internet. An address is
 * non-public when the most specific block of the IANA Special-Purpose Address
 * Registries (RFC 6890, as updated by RFC 8190) that contains it is not
 * "Globally Reachable": loopback, private use, link-local (which includes the
 * cloud metadata address 169.254.169.254), shared address space,
 * documentation, benchmarking, the IETF protocol assignments, reserved, and
 * the IPv6 equivalents. Multicast (224.0.0.0/4, ff00::/8, which have their own
 * registries) and the deprecated site-local fec0::/10 are non-public too.
 * Addresses that embed an IPv4 address (IPv4-mapped, IPv4-compatible, NAT64
 * 64:ff9b::/96, 6to4) are judged by that IPv4 address.
 */
export function isNonPublicAddress(address: string): boolean {
  return nonPublicReason(address) !== undefined;
}

/**
 * Why an address is non-public, as a short phrase for a refusal ("Link Local,
 * RFC 3927"), or undefined when it is public.
 */
export function nonPublicReason(address: string): string | undefined {
  const ip = normalizeHost(address);
  const kind = isIP(ip);
  if (kind === 4) return ipv4Reason(ipv4ToNum(ip));
  if (kind === 6) {
    const parsed = parseIPv6(ip);
    // An address Node accepts but we cannot parse is treated as non-public.
    if (parsed === null) return "unparsed IPv6 address";
    return ipv6Reason(parsed);
  }
  return undefined;
}

interface V4Block {
  base: number;
  bits: number;
  block: SpecialPurposeBlock;
}
interface V6Block {
  base: bigint;
  bits: number;
  block: SpecialPurposeBlock;
}

function mask4(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

const V4_BLOCKS: V4Block[] = IPV4_SPECIAL_PURPOSE.map((block) => {
  const [addr, len] = block.prefix.split("/");
  const bits = Number(len);
  return { base: (ipv4ToNum(addr) & mask4(bits)) >>> 0, bits, block };
}).sort((a, b) => b.bits - a.bits);

const V6_BLOCKS: V6Block[] = IPV6_SPECIAL_PURPOSE.map((block) => {
  const [addr, len] = block.prefix.split("/");
  const bits = Number(len);
  const value = parseIPv6(addr);
  if (value === null) throw new Error(`Bad registry prefix ${block.prefix}`);
  return { base: value >> BigInt(128 - bits), bits, block };
}).sort((a, b) => b.bits - a.bits);

/** The most specific special-purpose block that holds the address, if any. */
export function specialPurposeBlockOf(
  address: string,
): SpecialPurposeBlock | undefined {
  const ip = normalizeHost(address);
  const kind = isIP(ip);
  if (kind === 4) return v4Block(ipv4ToNum(ip));
  if (kind === 6) {
    const parsed = parseIPv6(ip);
    return parsed === null ? undefined : v6Block(parsed);
  }
  return undefined;
}

function v4Block(n: number): SpecialPurposeBlock | undefined {
  // Sorted longest prefix first, so the first hit is the most specific
  return V4_BLOCKS.find((b) => (n & mask4(b.bits)) >>> 0 === b.base)?.block;
}

function v6Block(value: bigint): SpecialPurposeBlock | undefined {
  return V6_BLOCKS.find((b) => value >> BigInt(128 - b.bits) === b.base)?.block;
}

function blockReason(block: SpecialPurposeBlock | undefined) {
  if (!block || block.globallyReachable === true) return undefined;
  const rfc = block.rfc.replace(/^\[|\]$/g, "").split("]")[0];
  return `${block.name}, ${rfc}`;
}

function ipv4Reason(n: number): string | undefined {
  // 224.0.0.0/4 is in the IPv4 Multicast Address Space registry instead
  if (n >>> 28 === 0xe) return "Multicast, RFC 5771";
  return blockReason(v4Block(n));
}

function ipv4ToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

/** Expand an IPv6 address, including a dotted or hex IPv4 tail, to 128 bits. */
function parseIPv6(ip: string): bigint | null {
  let text = ip;
  const lastColon = text.lastIndexOf(":");
  const tail = lastColon === -1 ? text : text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const v4 = ipv4ToNum(tail);
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = text.slice(0, lastColon + 1) + hi + ":" + lo;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): string[] | null => {
    if (side === "") return [];
    const groups = side.split(":");
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups;
  };
  const head = parseSide(halves[0]);
  if (!head) return null;
  const tailGroups = halves.length === 2 ? parseSide(halves[1]) : [];
  if (!tailGroups) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tailGroups.length > 7) return null;
  const zeros = halves.length === 2 ? 8 - head.length - tailGroups.length : 0;
  const groups = [...head, ...Array(zeros).fill("0"), ...tailGroups];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

function embeddedReason(kind: string, v4: number): string | undefined {
  const reason = ipv4Reason(v4);
  return reason ? `${kind} ${reason}` : undefined;
}

function ipv6Reason(value: bigint): string | undefined {
  const high96 = value >> 32n;
  const v4 = Number(value & 0xffffffffn);
  // :: and ::1 are registry entries; the rest of ::/96 is IPv4-compatible
  if (value > 1n && high96 === 0n) {
    return embeddedReason("IPv4-compatible", v4);
  }
  // IPv4-mapped (::ffff:0:0/96), including the hex form URL parsers produce.
  if (high96 === 0xffffn) return embeddedReason("IPv4-mapped", v4);
  // Well-known NAT64 prefix 64:ff9b::/96, judged by the embedded IPv4 address.
  if (high96 === 0x64ff9bn << 64n) return embeddedReason("NAT64", v4);
  // 6to4 (2002::/16) carries an IPv4 address in the next 32 bits.
  if (value >> 112n === 0x2002n) {
    return embeddedReason("6to4", Number((value >> 80n) & 0xffffffffn));
  }
  const top = Number(value >> 112n);
  if ((top & 0xff00) === 0xff00) return "Multicast, RFC 4291";
  if ((top & 0xffc0) === 0xfec0) return "Site-Local (deprecated), RFC 3879";
  return blockReason(v6Block(value));
}

/** Names that never point at a public host. */
const NON_PUBLIC_NAME = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

/** Compare hosts without brackets, a zone id, or a trailing dot. */
export function normalizeHost(hostname: string): string {
  const stripped = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const zone = stripped.indexOf("%");
  return zone === -1 ? stripped : stripped.slice(0, zone);
}

/** Judged from the hostname alone (no DNS): literal addresses and local names. */
export function isNonPublicHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (isIP(host)) return isNonPublicAddress(host);
  return NON_PUBLIC_NAME.test(host);
}

export type Resolver = (hostname: string) => Promise<string[]>;

const resolveAll: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((record) => record.address);

/** How long a checked resolution is reused, so the later connection cannot see a different address. */
const PIN_MS = 10 * 60 * 1000;

let hostResolver: Resolver = resolveAll;
const pinCache = new Map<string, { addresses: string[]; at: number }>();

/** Replace name resolution. Used by tests; pass undefined to restore DNS. */
export function setHostResolver(resolver?: Resolver): void {
  hostResolver = resolver ?? resolveAll;
  pinCache.clear();
}

export function clearPinnedHosts(): void {
  pinCache.clear();
}

/**
 * Addresses for a host. A repeated call within the pin window returns the
 * addresses already checked, not a fresh lookup.
 */
export async function resolveHostAddresses(
  hostname: string,
): Promise<string[]> {
  const host = normalizeHost(hostname);
  if (!host) return [];
  if (isIP(host)) return [host];
  const cached = pinCache.get(host);
  if (cached && Date.now() - cached.at < PIN_MS) return cached.addresses;
  try {
    const addresses = (await hostResolver(host)).map(normalizeHost);
    pinCache.set(host, { addresses, at: Date.now() });
    return addresses;
  } catch {
    return [];
  }
}

/** Addresses already checked for this host, if the pin window is still open. */
export function peekHostAddresses(hostname: string): string[] | undefined {
  const host = normalizeHost(hostname);
  if (isIP(host)) return [host];
  const cached = pinCache.get(host);
  if (!cached || Date.now() - cached.at >= PIN_MS) return undefined;
  return cached.addresses;
}

export async function classifyHost(
  hostname: string,
): Promise<{ addresses: string[]; nonPublic: boolean }> {
  const host = normalizeHost(hostname);
  const literal = isNonPublicHostname(host);
  const addresses = await resolveHostAddresses(host);
  return {
    addresses,
    nonPublic: literal || addresses.some(isNonPublicAddress),
  };
}

/**
 * A fetch target that must ask: a literal private address, a local name, a
 * name already resolved to a private address, or a preprocess result that says so.
 */
export function isPrivateFetchTarget(
  rawUrl: unknown,
  processed?: Record<string, unknown>,
): boolean {
  if (processed?.nonPublic === true) return true;
  if (typeof rawUrl !== "string" || !rawUrl) return false;
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  if (isNonPublicHostname(host)) return true;
  return !!peekHostAddresses(host)?.some(isNonPublicAddress);
}

export type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A `lookup` that returns only the addresses already checked, so the
 * connection cannot follow a different answer from DNS.
 */
export function pinnedLookup(addresses: string[]) {
  const records = addresses.map((address) => {
    const ip = normalizeHost(address);
    return { address: ip, family: isIP(ip) === 6 ? 6 : 4 };
  });
  return (
    hostname: string,
    options: unknown,
    callback?: LookupCallback,
  ): void => {
    const cb: LookupCallback | undefined =
      typeof options === "function" ? (options as LookupCallback) : callback;
    if (!records.length) {
      const error = new Error(
        `No pinned address for ${hostname}`,
      ) as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      cb?.(error, "", 0);
      return;
    }
    const all =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      Boolean((options as { all?: boolean }).all);
    if (all) cb?.(null, records);
    else cb?.(null, records[0].address, records[0].family);
  };
}

/**
 * Whether a hostname is, or resolves to, a non-public address. A name that
 * cannot be resolved is not treated as non-public (the fetch will fail).
 * A resolver passed in is used once and not pinned; the default resolver is.
 */
export async function resolvesToNonPublic(
  hostname: string,
  resolve?: Resolver,
): Promise<boolean> {
  if (!resolve) return (await classifyHost(hostname)).nonPublic;
  if (isNonPublicHostname(hostname)) return true;
  try {
    return (await resolve(normalizeHost(hostname))).some(isNonPublicAddress);
  } catch {
    return false;
  }
}
