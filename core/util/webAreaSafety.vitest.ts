import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getUrlContextItems } from "../context/providers/URLContextProvider";
import { cloudMetadataReason } from "./fetchUrlSafety";
import { fetchWithGuardedRedirects } from "./guardedFetch";
import {
  assertWebEnabled,
  getWebConfig,
  resetWebConfigForTests,
  resolveWebConfig,
} from "./webConfig";

/**
 * WB45: the cloud metadata refusal inside the fetch, and `web.enabled`
 * (plans/research/web-fetch-large-pages-and-policy.md, 8.4 and 8.6).
 */

afterEach(() => resetWebConfigForTests());

describe("cloudMetadataReason", () => {
  it("names the metadata services in every spelling", () => {
    for (const host of [
      "169.254.169.254",
      "[::ffff:a9fe:a9fe]",
      "[64:ff9b::a9fe:a9fe]",
      "[64:ff9b:0:0:0:0:169.254.169.254]",
      "[fd00:ec2::254]",
      "metadata.google.internal",
      "Metadata.Google.Internal.",
      "metadata.goog",
      "100.100.100.200",
      "0xa9.0xfe.0xa9.0xfe",
    ]) {
      expect(cloudMetadataReason(host), host).toBeDefined();
    }
  });

  it("finds a name that resolves to the metadata address", () => {
    expect(
      cloudMetadataReason("innocent.example", [
        "93.184.215.14",
        "169.254.169.254",
      ]),
    ).toBe("innocent.example resolves to 169.254.169.254");
  });

  it("leaves other link-local, private and public hosts alone", () => {
    for (const host of [
      "169.254.1.1",
      "10.0.0.1",
      "example.com",
      "metadata.example.com",
      "[::1]",
    ]) {
      expect(cloudMetadataReason(host), host).toBeUndefined();
    }
  });
});

describe("the fetch refuses cloud metadata at the start and at every hop", () => {
  const ok = () =>
    new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  const redirect = (to: string) =>
    new Response(null, { status: 302, headers: { location: to } });

  it("a metadata start URL is refused before any request", async () => {
    const fetchFn = vi.fn(async () => ok());
    await expect(
      fetchWithGuardedRedirects(
        new URL("http://169.254.169.254/latest/meta-data/"),
        fetchFn as never,
        {
          classify: async () => ({
            addresses: ["169.254.169.254"],
            nonPublic: true,
          }),
        },
      ),
    ).rejects.toThrow(/cloud metadata/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a name that resolves to the metadata address is refused", async () => {
    const fetchFn = vi.fn(async () => ok());
    await expect(
      fetchWithGuardedRedirects(
        new URL("http://rebind.example/"),
        fetchFn as never,
        {
          classify: async () => ({
            addresses: ["169.254.169.254"],
            nonPublic: true,
          }),
        },
      ),
    ).rejects.toThrow(/resolves to 169\.254\.169\.254/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a metadata hop on the same non-public host is refused too", async () => {
    // A local start may redirect within the local network; never to metadata
    const fetchFn = vi.fn(async (u: URL) =>
      u.pathname === "/" ? redirect("http://metadata.google.internal/x") : ok(),
    );
    await expect(
      fetchWithGuardedRedirects(new URL("http://intranet/"), fetchFn as never, {
        classify: async (host: string) => ({
          addresses: host === "intranet" ? ["10.0.0.5"] : [],
          nonPublic: true,
        }),
      }),
    ).rejects.toThrow(/cloud metadata/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("web.enabled", () => {
  it("a workspace or assistant config may turn it off, never on", () => {
    const off = resolveWebConfig({ other: { enabled: false } });
    expect(off.config.enabled).toBe(false);
    expect(off.config.sources.enabled).toBe("assistant-config");
    const on = resolveWebConfig({
      user: { enabled: false },
      other: { enabled: true },
    });
    expect(on.config.enabled).toBe(false);
    expect(on.notices.join(" ")).toContain("web.enabled");
  });

  it("a workspace cannot set the Web level through web.policy", () => {
    const r = resolveWebConfig({ other: { policy: "permissive" } });
    expect(r.config.policy).toBeUndefined();
    expect(r.notices.join(" ")).toContain("web.policy");
  });

  it("assertWebEnabled names the setting and what was not done", () => {
    expect(() =>
      assertWebEnabled("no web page is fetched", { enabled: false }),
    ).toThrow(/web\.enabled: false\), so no web page is fetched/);
    expect(() => assertWebEnabled("x", { enabled: true })).not.toThrow();
  });

  it("off in the person's own config.yaml turns off @url", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-off-"));
    try {
      const file = path.join(dir, "config.yaml");
      fs.writeFileSync(file, "web:\n  enabled: false\n");
      resetWebConfigForTests(file);
      expect(getWebConfig().enabled).toBe(false);
      const fetchFn = vi.fn();
      await expect(
        getUrlContextItems("https://example.com/", fetchFn as never),
      ).rejects.toThrow(/web\.enabled: false/);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("host: rules", () => {
  it("match whole labels; a bad rule allows nothing", async () => {
    const {
      hostRuleMatches,
      hostAllowRules,
      hostAllowRuleFor,
      readUserHostAllow,
    } = await import("../tools/permissions/webHostRules");
    expect(hostRuleMatches("host:example.com", "example.com")).toBe(true);
    expect(hostRuleMatches("host:example.com", "a.example.com")).toBe(false);
    expect(hostRuleMatches("host:*.example.com", "a.example.com")).toBe(true);
    expect(hostRuleMatches("host:*.example.com", "example.com")).toBe(false);
    expect(hostRuleMatches("host:*.example.com", "aexample.com")).toBe(false);
    expect(hostRuleMatches("host:*", "example.com")).toBe(false);
    expect(hostRuleMatches("host:ex*.com", "example.com")).toBe(false);
    expect(hostRuleMatches("host:", "example.com")).toBe(false);
    expect(hostAllowRules(["Read", "host:a.test", "Fetch(x)", 3])).toEqual([
      "host:a.test",
    ]);
    expect(hostAllowRuleFor("https://Docs.Example.com:8443/x")).toBe(
      "host:docs.example.com",
    );
    expect(hostAllowRuleFor("ftp://x.test/")).toBeUndefined();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-rules-"));
    try {
      const file = path.join(dir, "permissions.yaml");
      fs.writeFileSync(
        file,
        "allow:\n  - Read\n  - host:docs.example.com\nlevels:\n  web: listed\n",
      );
      expect(readUserHostAllow(file)).toEqual(["host:docs.example.com"]);
      expect(readUserHostAllow(path.join(dir, "missing.yaml"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
