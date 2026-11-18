import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summarizeChatInteraction } from "../data/chatInteractionSummary";
import {
  appendDebugPrompt,
  DEBUG_PROMPT_LOG_ENV,
  debugPromptLogEnabled,
} from "./debugPromptLog";

const DAY = 86_400_000;
/** Built at run time so no secret-shaped literal sits in the source. */
const KEY = ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("-");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-prompts-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const total = () =>
  fs
    .readdirSync(dir)
    .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);

describe("debug prompt log", () => {
  it("is off unless the setting or the environment variable turns it on", () => {
    expect(debugPromptLogEnabled(undefined, {})).toBe(false);
    expect(debugPromptLogEnabled(false, { [DEBUG_PROMPT_LOG_ENV]: "0" })).toBe(
      false,
    );
    expect(debugPromptLogEnabled(true, {})).toBe(true);
    expect(
      debugPromptLogEnabled(undefined, { [DEBUG_PROMPT_LOG_ENV]: "1" }),
    ).toBe(true);
  });

  it("masks secrets and writes owner-only JSON lines", () => {
    const file = appendDebugPrompt(
      {
        sessionId: "s",
        model: "m",
        prompt: `use ${KEY} please`,
        completion: "ok",
      },
      { dir },
    )!;
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(entry).toMatchObject({
      sessionId: "s",
      model: "m",
      completion: "ok",
    });
    expect(entry.prompt).not.toContain(KEY);
    expect(entry.prompt).toContain("please");
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o077).toBe(0);
    }
  });

  it("stays under its size cap, dropping the oldest file first", () => {
    const cap = 50_000;
    let now = Date.UTC(2026, 10, 14);
    for (let i = 0; i < 200; i++) {
      appendDebugPrompt(
        { prompt: `request ${i} `.padEnd(1000, "x") },
        { dir, capBytes: cap, now: now++ },
      );
    }
    expect(total()).toBeLessThanOrEqual(cap + 1200);
    const all = fs
      .readdirSync(dir)
      .sort()
      .flatMap((f) =>
        fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"),
      )
      .map((l) => JSON.parse(l).prompt as string);
    expect(all.at(-1)).toMatch(/^request 199 /);
    expect(all.some((p) => p.startsWith("request 0 "))).toBe(false);
  });

  it("cuts one request that is larger than a file's share, and says so", () => {
    const file = appendDebugPrompt(
      { prompt: "y".repeat(100_000) },
      { dir, capBytes: 50_000 },
    )!;
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(entry.prompt.length).toBeLessThan(10_000);
    expect(entry.truncated).toContain("cut to fit");
    expect(fs.statSync(file).size).toBeLessThanOrEqual(10_000);
  });

  it("deletes files not written to within the age limit", () => {
    const now = Date.now();
    const first = appendDebugPrompt(
      { prompt: "a".repeat(3000) },
      { dir, capBytes: 10_000, now: now - 30 * DAY },
    )!;
    const old = new Date(now - 30 * DAY);
    fs.utimesSync(first, old, old);
    // a full file forces a new one; the old one is past 14 days
    appendDebugPrompt(
      { prompt: "b".repeat(3000) },
      { dir, capBytes: 10_000, now },
    );
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });
});

describe("summarizeChatInteraction", () => {
  it("keeps sizes and a hash in place of the texts", () => {
    const out = summarizeChatInteraction({
      prompt: "héllo",
      completion: "ok",
      promptTokens: 3,
      sessionId: "s",
    });
    expect(out).toEqual({
      promptTokens: 3,
      sessionId: "s",
      promptBytes: 6,
      completionBytes: 2,
      promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const plain = { sessionId: "s", promptBytes: 1 };
    expect(summarizeChatInteraction(plain)).toBe(plain);
  });
});
