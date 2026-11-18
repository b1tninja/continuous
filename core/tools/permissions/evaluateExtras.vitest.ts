import { describe, expect, it } from "vitest";
import { plainHttpsHost } from "./evaluateExtras";
import type { PolicyLevel } from "./policy";
import { testToolCall } from "./testToolCall";

const fetchAt = (
  url: string,
  level: PolicyLevel,
  trusted: string[] = ["docs.example.com"],
  extra: Record<string, unknown> = {},
  user: Record<string, unknown> = {},
) =>
  testToolCall({
    tool: "fetch_url_content",
    args: { url, ...extra },
    levels: {
      context: level,
      tools: level,
      edits: level,
      plan: level,
      questions: level,
    },
    sources: {
      user: { ...user, auto: { environment: { trustedDomains: trusted } } },
    },
    cwd: "/home/dev/shop",
    shell: "bash",
  } as never);

describe("trusted-host GET allow (B56)", () => {
  it("settles a plain GET of a trusted host at Automatic without the reviewer", () => {
    const r = fetchAt("https://docs.example.com/guide/start", "automatic");
    expect(r.decision).toBe("allow");
    expect(r.source).toBe("trusted-host");
    expect(r.wouldAskReviewer).toBe(false);
    expect(
      fetchAt("https://api.docs.example.com/x", "automatic").decision,
    ).toBe("allow");
  });

  it("is an allow at Permissive too", () => {
    expect(fetchAt("https://docs.example.com/a", "permissive").decision).toBe(
      "allow",
    );
  });

  it("leaves an untrusted host to ask-unknown-host", () => {
    const r = fetchAt("https://evil.test/a", "automatic");
    expect(r.decision).toBe("ask");
    expect(r.source).toBe("protected-path");
  });

  it("does not apply when the person trusts nothing", () => {
    const r = fetchAt("https://docs.example.com/a", "automatic", []);
    expect(r.source).not.toBe("trusted-host");
  });

  it("does not apply below Automatic", () => {
    // Cautious already runs a trusted domain through the web area (step 11).
    // B56's trusted-host allow is only Automatic and Permissive.
    const cautious = fetchAt("https://docs.example.com/a", "cautious");
    expect(cautious.decision).toBe("allow");
    expect(cautious.source).not.toBe("trusted-host");
    const manual = fetchAt("https://docs.example.com/a", "manual");
    expect(manual.decision).toBe("ask");
    expect(manual.source).not.toBe("trusted-host");
  });

  it("does not apply to a query, credentials, a port, http or an extra argument", () => {
    for (const url of [
      "https://docs.example.com/a?token=abc",
      "https://user:pw@docs.example.com/a",
      "https://docs.example.com:8443/a",
      "http://docs.example.com/a",
      "https://docs.example.com/a#frag",
      "https://docs.example.com.evil.test/a",
      "https://docs.example.com@evil.test/a",
    ]) {
      const r = fetchAt(url, "automatic");
      expect(r.source, url).not.toBe("trusted-host");
    }
    const withBody = fetchAt(
      "https://docs.example.com/a",
      "automatic",
      ["docs.example.com"],
      { method: "POST", body: "x" },
    );
    expect(withBody.source).not.toBe("trusted-host");
  });

  it("does not apply to a private address or when a rule asks or refuses", () => {
    expect(
      fetchAt("https://127.0.0.1/a", "automatic", ["127.0.0.1"]).source,
    ).not.toBe("trusted-host");
    const ask = fetchAt(
      "https://docs.example.com/a",
      "automatic",
      undefined,
      {},
      {
        ask: ["fetchUrl(https://docs.example.com/*)"],
      },
    );
    expect(ask.decision).toBe("ask");
    expect(ask.source).not.toBe("trusted-host");
    const deny = fetchAt(
      "https://docs.example.com/a",
      "automatic",
      undefined,
      {},
      {
        deny: ["fetchUrl(https://docs.example.com/*)"],
      },
    );
    expect(deny.decision).toBe("deny");
  });

  it("reads only plain https hosts", () => {
    expect(plainHttpsHost("https://a.test/x")).toBe("a.test");
    expect(plainHttpsHost("https://a.test/x?q=1")).toBeUndefined();
    expect(plainHttpsHost("nope")).toBeUndefined();
    expect(plainHttpsHost(5)).toBeUndefined();
  });
});
