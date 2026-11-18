import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isNonPublicAddress,
  isNonPublicHostname,
  nonPublicReason,
  specialPurposeBlockOf,
} from "./networkAddress";
import {
  IPV4_SPECIAL_PURPOSE,
  IPV6_SPECIAL_PURPOSE,
  type SpecialPurposeBlock,
} from "./specialPurpose.generated";

// @ts-ignore: a plain .mjs script with no type declarations
import * as generator from "../scripts/generate-special-purpose.mjs";

const csv = (name: string) =>
  fs.readFileSync(path.join(__dirname, "iana", name), "utf8");

describe("the generated table is the IANA registry", () => {
  it("matches the committed IPv4 CSV entry for entry", () => {
    expect(IPV4_SPECIAL_PURPOSE).toEqual(
      generator.parseRegistry(csv(generator.V4_CSV)),
    );
  });

  it("matches the committed IPv6 CSV entry for entry", () => {
    expect(IPV6_SPECIAL_PURPOSE).toEqual(
      generator.parseRegistry(csv(generator.V6_CSV)),
    );
  });

  it("pins the registry contents (a refresh shows up here)", () => {
    expect(IPV4_SPECIAL_PURPOSE.map((b) => b.prefix)).toEqual([
      "0.0.0.0/8",
      "0.0.0.0/32",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.0.0.0/29",
      "192.0.0.8/32",
      "192.0.0.9/32",
      "192.0.0.10/32",
      "192.0.0.170/32",
      "192.0.0.171/32",
      "192.0.2.0/24",
      "192.31.196.0/24",
      "192.52.193.0/24",
      "192.88.99.0/24",
      "192.88.99.2/32",
      "192.168.0.0/16",
      "192.175.48.0/24",
      "198.18.0.0/15",
      "198.51.100.0/24",
      "203.0.113.0/24",
      "240.0.0.0/4",
      "255.255.255.255/32",
    ]);
    expect(IPV6_SPECIAL_PURPOSE.map((b) => b.prefix)).toEqual([
      "::1/128",
      "::/128",
      "::ffff:0:0/96",
      "64:ff9b::/96",
      "64:ff9b:1::/48",
      "100::/64",
      "100:0:0:1::/64",
      "2001::/23",
      "2001::/32",
      "2001:1::1/128",
      "2001:1::2/128",
      "2001:1::3/128",
      "2001:2::/48",
      "2001:3::/32",
      "2001:4:112::/48",
      "2001:10::/28",
      "2001:20::/28",
      "2001:30::/28",
      "2001:db8::/32",
      "2002::/16",
      "2620:4f:8000::/48",
      "3fff::/20",
      "5f00::/16",
      "fc00::/7",
      "fe80::/10",
    ]);
  });
});

/** The first address of a CIDR block. */
const base = (block: SpecialPurposeBlock) => block.prefix.split("/")[0];

// Blocks whose address is judged by the IPv4 address inside it, not by the
// registry row: an IPv4-mapped or NAT64 form of a public address is public
const EMBEDS_IPV4 = new Set(["::ffff:0:0/96", "64:ff9b::/96", "2002::/16"]);

describe("every special-purpose block is classified by its registry row", () => {
  const rows = [...IPV4_SPECIAL_PURPOSE, ...IPV6_SPECIAL_PURPOSE].filter(
    (b) => !EMBEDS_IPV4.has(b.prefix),
  );

  it.each(rows.map((b) => [b.prefix, b] as const))("%s", (_prefix, block) => {
    // The base address may fall in a more specific row (192.0.0.0/24 holds
    // 192.0.0.0/29); the most specific row decides
    const decides = specialPurposeBlockOf(base(block))!;
    expect(decides).toBeDefined();
    expect(isNonPublicAddress(base(block))).toBe(
      decides.globallyReachable !== true,
    );
  });

  it("refuses every block that is not globally reachable, at both ends", () => {
    const lastV4 = (prefix: string) => {
      const [addr, len] = prefix.split("/");
      const n =
        addr.split(".").reduce((acc, part) => acc * 256 + Number(part), 0) +
        2 ** (32 - Number(len)) -
        1;
      return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
    };
    const notReachable = IPV4_SPECIAL_PURPOSE.filter(
      (b) => b.globallyReachable !== true,
    );
    for (const block of notReachable) {
      const last = lastV4(block.prefix);
      const decides = specialPurposeBlockOf(last)!;
      expect(isNonPublicAddress(last), `${block.prefix} ends at ${last}`).toBe(
        decides.globallyReachable !== true,
      );
    }
  });
});

describe("classification examples", () => {
  it.each([
    // the classic set
    ["127.0.0.1", "Loopback"],
    ["10.1.2.3", "Private-Use"],
    ["172.31.255.255", "Private-Use"],
    ["192.168.1.1", "Private-Use"],
    ["169.254.169.254", "Link Local"],
    ["100.64.0.1", "Shared Address Space"],
    ["0.0.0.0", "This host on this network"],
    // added by the registry table (WB22)
    ["192.0.0.1", "IPv4 Service Continuity Prefix"],
    ["192.0.0.200", "IETF Protocol Assignments"],
    ["192.0.2.10", "Documentation (TEST-NET-1)"],
    ["198.51.100.7", "Documentation (TEST-NET-2)"],
    ["203.0.113.9", "Documentation (TEST-NET-3)"],
    ["198.18.0.1", "Benchmarking"],
    ["198.19.255.255", "Benchmarking"],
    ["192.88.99.1", "Deprecated (6to4 Relay Anycast)"],
    ["240.0.0.1", "Reserved"],
    ["255.255.255.255", "Limited Broadcast"],
    ["224.0.0.251", "Multicast"],
    ["239.255.255.250", "Multicast"],
    ["::1", "Loopback Address"],
    ["::", "Unspecified Address"],
    ["fd00::1", "Unique-Local"],
    ["fe80::1", "Link-Local Unicast"],
    ["fec0::1", "Site-Local"],
    ["ff02::1", "Multicast"],
    ["100::1", "Discard-Only Address Block"],
    ["100:0:0:1::1", "Dummy IPv6 Prefix"],
    ["2001:db8::1", "Documentation"],
    ["3fff::1", "Documentation"],
    ["2001:2::1", "Benchmarking"],
    ["2001::1", "TEREDO"],
    ["2001:100::1", "IETF Protocol Assignments"],
    ["5f00::1", "Segment Routing (SRv6) SIDs"],
    ["64:ff9b:1::1", "IPv4-IPv6 Translat."],
  ])("%s is non-public (%s)", (address, name) => {
    expect(isNonPublicAddress(address)).toBe(true);
    expect(nonPublicReason(address)).toContain(name);
  });

  it.each([
    // IPv4-mapped, dotted and hex, as URL parsers write them
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::ffff:192.0.2.1",
    "::ffff:198.18.0.1",
    // IPv4-compatible, NAT64 and 6to4 forms of private addresses
    "::10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::10.0.0.1",
    "2002:a9fe:a9fe::1",
    "2002:c000:0201::1",
  ])("%s embeds a non-public IPv4 address", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
    expect(isNonPublicHostname(`[${address}]`)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "93.184.215.14",
    "1.1.1.1",
    "192.0.0.9", // PCP anycast: globally reachable
    "192.0.0.10", // TURN anycast
    "192.31.196.1", // AS112-v4
    "192.52.193.1", // AMT
    "192.175.48.1", // AS112 direct delegation
    "2606:4700:4700::1111",
    "2001:1::1", // PCP anycast, inside the 2001::/23 block
    "2001:1::3",
    "2001:3::1", // AMT
    "2001:4:112::1", // AS112-v6
    "2001:20::1", // ORCHIDv2
    "2001:30::1", // DETs
    "2620:4f:8000::1",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("%s is public", (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
    expect(nonPublicReason(address)).toBeUndefined();
  });

  it("says which block, with its RFC, for a refusal", () => {
    expect(nonPublicReason("169.254.169.254")).toBe("Link Local, RFC 3927");
    expect(nonPublicReason("::ffff:169.254.169.254")).toBe(
      "IPv4-mapped Link Local, RFC 3927",
    );
    expect(nonPublicReason("192.0.0.170")).toBe(
      "NAT64/DNS64 Discovery, RFC 8880",
    );
  });
});
