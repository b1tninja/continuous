import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { testConnectionCommand } from "./testConnection.js";

const KEY = "sk-ant-api03-SECRET-VALUE";

function capture() {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  return out;
}

const seen: { url: string; headers: Record<string, string> }[] = [];
const fetchFn = (async (url: string, init: { headers: any }) => {
  seen.push({ url, headers: init.headers });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [
        {
          id: "claude-sonnet-4-5-20250929",
          lifecycle: "deprecated",
          deprecated_at: "2026-09-30T00:00:00Z",
          retires_at: "2026-11-30T00:00:00Z",
        },
      ],
    }),
    text: async () => "",
  };
}) as never;

afterEach(() => {
  vi.restoreAllMocks();
  seen.length = 0;
});

describe("test-connection --provider anthropic", () => {
  it("warns with the retirement date and replacement, and never prints the key", async () => {
    const out = capture();
    const dir = mkdtempSync(join(tmpdir(), "cli-anthropic-"));
    const code = await testConnectionCommand({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      env: { ANTHROPIC_API_KEY: KEY },
      fetchFn,
      noticeFile: join(dir, "n.json"),
      now: "2026-11-11",
    });
    const text = out.join("");
    expect(code).toBe(0);
    expect(text).toContain("Connected. 1 model listed");
    expect(text).toContain("Warning:");
    expect(text).toContain("2026-11-30");
    expect(text).toContain("claude-sonnet-5-5");
    expect(text).toContain("(from your key)");
    expect(text).not.toContain(KEY);
    expect(seen[0].headers["x-api-key"]).toBe(KEY);
  });

  it("names the variable when the key is missing", async () => {
    const out = capture();
    const code = await testConnectionCommand({
      provider: "anthropic",
      env: {},
    });
    expect(code).toBe(2);
    expect(out.join("")).toContain("ANTHROPIC_API_KEY is not set");
  });

  it("json output carries the notice and no key", async () => {
    const out = capture();
    const dir = mkdtempSync(join(tmpdir(), "cli-anthropic-"));
    await testConnectionCommand({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      apiKeyEnv: "MY_KEY",
      env: { MY_KEY: KEY },
      json: true,
      fetchFn,
      noticeFile: join(dir, "n.json"),
      now: "2026-11-11",
    });
    const parsed = JSON.parse(out.join(""));
    expect(parsed.retirement[0].retiresAt).toBe("2026-11-30");
    expect(out.join("")).not.toContain(KEY);
  });

  it("names an id the key cannot reach, with close matches", async () => {
    const out = capture();
    const dir = mkdtempSync(join(tmpdir(), "cli-anthropic-"));
    const routed = (async (url: string) =>
      url.includes("/models/")
        ? {
            ok: false,
            status: 404,
            json: async () => ({}),
            text: async () => "{}",
          }
        : {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "claude-sonnet-5-5" }] }),
            text: async () => "",
          }) as never;
    const code = await testConnectionCommand({
      provider: "anthropic",
      model: "claude-sonet-5-5",
      env: { ANTHROPIC_API_KEY: KEY },
      fetchFn: routed,
      record: false,
      noticeFile: join(dir, "n.json"),
      now: "2026-11-11",
    });
    const text = out.join("");
    expect(code).toBe(0);
    expect(text).toContain(
      'Warning: Anthropic does not know a model "claude-sonet-5-5"',
    );
    expect(text).toContain("Did you mean claude-sonnet-5-5?");
    expect(text).not.toContain(KEY);
  });
});
