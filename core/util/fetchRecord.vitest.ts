import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAuditTrailForTests } from "../tools/permissions/audit/global";
import { AuditTrail } from "../tools/permissions/audit/trail";
import { FetchDeadlineError } from "./boundedBody";
import {
  getFetchLog,
  provenanceLine,
  resetFetchLogForTests,
  sha256Hex,
  type FetchRecord,
} from "./fetchRecord";
import { guardedWebRequest } from "./guardedFetch";
import { setHostResolver } from "./networkAddress";
import { secretCases } from "./secretScan/fixtures";

/** WB24: the record, the provenance line, the fetch log and the audit line. */

const redirect = (location: string) => ({
  status: 301,
  headers: { get: (k: string) => (k === "location" ? location : null) },
});

function page(body: string | Uint8Array, type = "text/html; charset=utf-8") {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    status: 200,
    statusText: "OK",
    headers: { get: (k: string) => (k === "content-type" ? type : null) },
    body: {
      async *[Symbol.asyncIterator]() {
        // in two chunks, as a network would
        yield bytes.subarray(0, Math.floor(bytes.length / 2));
        yield bytes.subarray(Math.floor(bytes.length / 2));
      },
    },
    text: vi.fn(async () => new TextDecoder().decode(bytes)),
  };
}

const base = {
  purpose: "tool" as const,
  origin: "model" as const,
  maxBytes: 1024 * 1024,
  deadlineMs: 5000,
};

let dir: string;
let trail: AuditTrail;

function auditLines(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        for (const line of fs.readFileSync(full, "utf8").split("\n")) {
          if (line.trim()) out.push(JSON.parse(line));
        }
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  setHostResolver(async () => ["93.184.215.14"]);
  resetFetchLogForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-audit-"));
  trail = new AuditTrail({ dir, enabled: true });
  setAuditTrailForTests(trail);
});

afterEach(() => {
  setHostResolver(undefined);
  setAuditTrailForTests(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the fetch record", () => {
  it("has every field for a fetch through two redirects (three hops)", async () => {
    const html = "<html><body>hello</body></html>";
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://b.example/two"))
      .mockResolvedValueOnce(redirect("http://c.example/three?x=1"))
      .mockResolvedValueOnce(page(html));
    const resp = await guardedWebRequest(new URL("https://a.example/one"), {
      ...base,
      fetchFn,
      callId: "call-1",
    });
    const r = resp.record;
    expect(r).toMatchObject({
      purpose: "tool",
      origin: "model",
      startUrl: "https://a.example/one",
      finalUrl: "http://c.example/three?x=1",
      hops: [
        { url: "https://a.example/one", status: 301 },
        { url: "https://b.example/two", status: 301 },
        { url: "http://c.example/three?x=1", status: 200 },
      ],
      redirects: 2,
      status: 200,
      contentType: "text/html; charset=utf-8",
      bytes: html.length,
      truncated: false,
      sha256: sha256Hex(new TextEncoder().encode(html)),
      robots: "not-checked",
      rule: "builtin:public",
      unencrypted: true,
      outcome: "fetched",
      callId: "call-1",
    });
    expect(Date.parse(r.fetchedAt)).not.toBeNaN();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(resp.finalUrl.toString()).toBe("http://c.example/three?x=1");
  });

  it("names the rule for a non-public start the person chose", async () => {
    setHostResolver(async () => ["10.0.0.9"]);
    const resp = await guardedWebRequest(
      new URL("https://wiki.corp.example/"),
      {
        ...base,
        origin: "person",
        purpose: "url",
        fetchFn: vi.fn().mockResolvedValue(page("x", "text/plain")),
      },
    );
    expect(resp.record.rule).toBe("builtin:non-public-start(person)");
  });

  it("records a refusal with its reason and no status", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect("http://169.254.169.254/"));
    await expect(
      guardedWebRequest(new URL("https://a.example/"), { ...base, fetchFn }),
    ).rejects.toThrow(/non-public/);
    const [r] = getFetchLog().list();
    expect(r.outcome).toBe("refused");
    expect(r.error).toMatch(/169\.254\.169\.254/);
    expect(r.sha256).toBeUndefined();
  });

  it("records an HTTP error without reading its body", async () => {
    const text = vi.fn(async () => "secret error page");
    const fetchFn = vi.fn().mockResolvedValue({
      status: 503,
      statusText: "Service Unavailable",
      headers: { get: () => "text/html" },
      text,
    });
    const resp = await guardedWebRequest(new URL("https://a.example/"), {
      ...base,
      fetchFn,
    });
    expect(resp.ok).toBe(false);
    expect(resp.data.length).toBe(0);
    expect(text).not.toHaveBeenCalled();
    expect(resp.record.outcome).toBe("http-error");
    expect(resp.record.status).toBe(503);
  });
});

describe("caps and deadlines", () => {
  it("cuts the body at the byte cap and hashes what was read", async () => {
    const big = new Uint8Array(10_000).fill(97);
    const resp = await guardedWebRequest(new URL("https://a.example/"), {
      ...base,
      maxBytes: 1000,
      fetchFn: vi.fn().mockResolvedValue(page(big, "text/plain")),
    });
    expect(resp.data.length).toBe(1000);
    expect(resp.truncated).toBe(true);
    expect(resp.record.truncated).toBe(true);
    expect(resp.record.sha256).toBe(sha256Hex(big.subarray(0, 1000)));
    expect(provenanceLine(resp.record)).toContain("(cut at the cap)");
  });

  it("gives up when the server never answers, and records the failure", async () => {
    const started = Date.now();
    const err = await guardedWebRequest(new URL("https://slow.example/"), {
      ...base,
      deadlineMs: 150,
      fetchFn: vi.fn(() => new Promise(() => undefined)),
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(FetchDeadlineError);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(getFetchLog().list()[0].outcome).toBe("failed");
  });

  it("gives up on a body that never ends within the deadline", async () => {
    const drip = {
      status: 200,
      headers: { get: () => "text/plain" },
      body: {
        async *[Symbol.asyncIterator]() {
          yield new Uint8Array([97]);
          await new Promise(() => undefined);
        },
      },
      text: async () => "",
    };
    await expect(
      guardedWebRequest(new URL("https://drip.example/"), {
        ...base,
        deadlineMs: 150,
        fetchFn: vi.fn().mockResolvedValue(drip),
      }),
    ).rejects.toThrow(/did not finish within/);
  });

  it("does not read a body the caller refuses by type", async () => {
    const response = page("PNG", "image/png");
    await expect(
      guardedWebRequest(new URL("https://a.example/i.png"), {
        ...base,
        fetchFn: vi.fn().mockResolvedValue(response),
        accept: () => {
          throw new Error("Refused: not text");
        },
      }),
    ).rejects.toThrow(/not text/);
    expect(response.text).not.toHaveBeenCalled();
    expect(getFetchLog().list()[0].outcome).toBe("refused");
  });
});

describe("the provenance line", () => {
  const record: FetchRecord = {
    id: "x",
    purpose: "tool",
    origin: "model",
    startUrl: "https://docs.example.com/guide",
    finalUrl: "https://docs.example.com/guide/intro",
    hops: [],
    redirects: 1,
    status: 200,
    contentType: "text/html; charset=utf-8",
    bytes: 49_152,
    truncated: false,
    sha256: "3f2a9c1b0d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4",
    fetchedAt: "2026-11-15T10:04:12.345Z",
    durationMs: 12,
    robots: "not-checked",
    rule: "builtin:public",
    unencrypted: false,
    outcome: "fetched",
  };

  it("carries final URL, status, type, size, time, hash, robots, rule and hops", () => {
    expect(provenanceLine(record)).toBe(
      "[fetched https://docs.example.com/guide/intro · 200 text/html · 48 KiB · 2026-11-15T10:04:12Z · sha256:3f2a9c1b0d4e · robots: not checked · rule: builtin:public · via 1 redirect]",
    );
  });

  it("stays under 60 tokens, even with a long URL", () => {
    // About four characters a token for prose; the line has digits and hex,
    // which tokenize worse, so the length is capped as well
    const line = provenanceLine(record);
    expect(Math.ceil(line.length / 4)).toBeLessThan(60);
    expect(line.length).toBeLessThan(200);
    const long = {
      ...record,
      finalUrl: `https://docs.example.com/${"segment/".repeat(40)}`,
      unencrypted: true,
    };
    expect(Math.ceil(provenanceLine(long).length / 4)).toBeLessThan(60);
  });

  it("does not repeat a credential-shaped value from the URL", () => {
    const value = secretCases().find((c) => c.ruleId === "github-pat")!.value;
    const line = provenanceLine({
      ...record,
      finalUrl: `https://example.com/?key=${value}`,
    });
    expect(line).not.toContain(value);
  });

  it("labels plain http and success statuses other than 200", () => {
    const line = provenanceLine({ ...record, status: 203, unencrypted: true });
    expect(line).toContain("· 203 text/html ·");
    expect(line).toMatch(/· unencrypted\]$/);
  });
});

describe("the fetch log and the audit line", () => {
  it("keeps every fetch, newest first, under the call's session", async () => {
    trail.decision({
      session: "sess-9",
      callId: "call-7",
      tool: "fetch_url_content",
      args: "{}",
      policy: "allow",
      by: "rules",
    });
    for (const p of ["/a", "/b"]) {
      await guardedWebRequest(new URL(`https://a.example${p}`), {
        ...base,
        callId: "call-7",
        fetchFn: vi.fn().mockResolvedValue(page("x", "text/plain")),
      });
    }
    await guardedWebRequest(new URL("https://c.example/"), {
      ...base,
      purpose: "url",
      origin: "person",
      fetchFn: vi.fn().mockResolvedValue(page("y", "text/plain")),
    });
    const all = getFetchLog().list();
    expect(all.map((r) => r.finalUrl)).toEqual([
      "https://c.example/",
      "https://a.example/b",
      "https://a.example/a",
    ]);
    expect(
      getFetchLog()
        .list("sess-9")
        .map((r) => r.finalUrl),
    ).toEqual(["https://a.example/b", "https://a.example/a"]);
    // bodies are not kept
    expect(JSON.stringify(all)).not.toMatch(/"(text|data|body)"/);
  });

  it("writes one masked audit line per fetch, query values hidden", async () => {
    await guardedWebRequest(
      new URL("https://a.example/search?q=private+words&page=2#frag"),
      {
        ...base,
        fetchFn: vi.fn().mockResolvedValue(page("hello", "text/plain")),
      },
    );
    const lines = auditLines().filter((l) => l.ev === "fetch");
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatchObject({
      v: 1,
      ev: "fetch",
      session: "web-fetches",
      purpose: "tool",
      origin: "model",
      url: "https://a.example/search?q=*&page=*",
      finalUrl: "https://a.example/search?q=*&page=*",
      redirects: 0,
      outcome: "fetched",
      rule: "builtin:public",
      robots: "not-checked",
      status: 200,
      bytes: 5,
      sha256: sha256Hex(new TextEncoder().encode("hello")),
    });
    expect(JSON.stringify(line)).not.toContain("private");
    expect(JSON.stringify(line)).not.toContain("frag");
  });

  it("writes the audit line under the session of the tool call", async () => {
    trail.decision({
      session: "sess-1",
      callId: "call-1",
      tool: "fetch_url_content",
      args: "{}",
      policy: "allow",
      by: "rules",
    });
    await guardedWebRequest(new URL("https://a.example/"), {
      ...base,
      callId: "call-1",
      fetchFn: vi.fn().mockResolvedValue(page("x", "text/plain")),
    });
    const line = auditLines().find((l) => l.ev === "fetch")!;
    expect(line.session).toBe("sess-1");
    expect(line.callId).toBe("call-1");
  });

  it("never fails the fetch when the audit trail cannot write", async () => {
    setAuditTrailForTests(
      new AuditTrail({
        dir: path.join(dir, "missing", "\0bad"),
        enabled: true,
        onError: () => undefined,
      }),
    );
    await expect(
      guardedWebRequest(new URL("https://a.example/"), {
        ...base,
        fetchFn: vi.fn().mockResolvedValue(page("x", "text/plain")),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(getFetchLog().list()).toHaveLength(1);
  });
});
