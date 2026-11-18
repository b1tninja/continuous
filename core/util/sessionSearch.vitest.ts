/**
 * Message-text search over recent sessions (NI10): finds a word only a
 * message holds, ranks phrase matches, the person's own words and the title
 * higher, and stops at its session, size and time bounds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatHistoryItem } from "../index.js";
import { HistoryManager } from "./history.js";
import { BLOB_THRESHOLD_CHARS } from "./sessionBlobs.js";
import { scoreSession, searchSessions, searchTerms } from "./sessionSearch.js";

const user = (text: string): ChatHistoryItem => ({
  message: { role: "user", content: text },
  contextItems: [],
});
const assistant = (text: string): ChatHistoryItem => ({
  message: { role: "assistant", content: text },
  contextItems: [],
});
const tool = (text: string): ChatHistoryItem => ({
  message: { role: "tool", content: text, toolCallId: "t" },
  contextItems: [],
});

let root: string;
let age = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
  fs.mkdirSync(path.join(root, "sessions"));
  age = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Writes a .json session; each later call is older on disk. */
function put(id: string, history: ChatHistoryItem[], title = id): void {
  const file = path.join(root, "sessions", `${id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ sessionId: id, title, workspaceDirectory: "", history }),
  );
  const t = new Date(Date.now() - ++age * 60_000);
  fs.utimesSync(file, t, t);
}

describe("searchSessions", () => {
  it("finds a word that only a message body holds, with a snippet", async () => {
    put("a", [user("how do I parse the TOML config?"), assistant("Use toml.")]);
    put("b", [user("something else"), assistant("nothing")]);
    const r = await searchSessions({ query: "toml", root });
    expect(r.hits.map((h) => h.sessionId)).toEqual(["a"]);
    expect(r.hits[0].snippet.toLowerCase()).toContain("toml");
    expect(r.hits[0].role).toBe("user");
    expect(r).toMatchObject({ scanned: 2, total: 2, skippedLarge: 0 });
    expect(r.stoppedBy).toBeUndefined();
  });

  it("needs every word somewhere in the session, not only in tool output", async () => {
    put("both", [user("the parser"), assistant("a crash in it")]);
    put("one", [user("the parser works")]);
    put("tool", [user("run it"), tool("parser crash")]);
    const r = await searchSessions({ query: "parser crash", root });
    expect(r.hits.map((h) => h.sessionId)).toEqual(["both"]);
  });

  it("ranks a phrase above scattered words, and the person's words above replies", async () => {
    put("scattered", [user("crash on startup; the parser is fine")]);
    put("phrase", [user("a parser crash again")]);
    put("reply", [assistant("parser crash")]);
    const r = await searchSessions({ query: "parser crash", root });
    expect(r.hits.map((h) => h.sessionId)).toEqual([
      "phrase",
      "reply",
      "scattered",
    ]);
  });

  it("counts a title match and breaks ties by recency", async () => {
    put("newer", [user("deploy notes")]);
    put("older", [user("deploy notes")]);
    put("titled", [user("deploy notes")], "Deploy");
    const r = await searchSessions({ query: "deploy", root });
    expect(r.hits.map((h) => h.sessionId)).toEqual([
      "titled",
      "newer",
      "older",
    ]);
  });

  it("reads only the newest maxSessions sessions", async () => {
    for (let i = 0; i < 5; i++) put(`s${i}`, [user("needle")]);
    const r = await searchSessions({ query: "needle", root, maxSessions: 3 });
    expect(r.hits.map((h) => h.sessionId)).toEqual(["s0", "s1", "s2"]);
    expect(r).toMatchObject({ scanned: 3, total: 5, stoppedBy: "maxSessions" });
  });

  it("stops at its time budget", async () => {
    for (let i = 0; i < 5; i++) put(`s${i}`, [user("needle")]);
    let t = 0;
    const r = await searchSessions({
      query: "needle",
      root,
      timeBudgetMs: 25,
      // each reading of the clock is 10 ms later
      clock: () => (t += 10),
    });
    expect(r.stoppedBy).toBe("time");
    expect(r.scanned).toBeLessThan(5);
  });

  it("leaves out files over the size bound and caps the hits", async () => {
    put("big", [user(`needle ${"x".repeat(2000)}`)]);
    for (let i = 0; i < 4; i++) put(`s${i}`, [user("needle")]);
    const r = await searchSessions({
      query: "needle",
      root,
      maxFileBytes: 1000,
      maxResults: 2,
    });
    expect(r.skippedLarge).toBe(1);
    expect(r.hits).toHaveLength(2);
  });

  it("answers nothing for an empty query", async () => {
    put("a", [user("x")]);
    expect((await searchSessions({ query: "   ", root })).hits).toEqual([]);
  });
});

describe("searchSessions on a log session", () => {
  it("finds a word in a message stored as a blob", async () => {
    // The real sessions folder of the test run (CONTINUE_GLOBAL_DIR)
    const m = new HistoryManager();
    m.setSessionLog(true);
    const long = `${"filler ".repeat(BLOB_THRESHOLD_CHARS / 6)} zebracorn`;
    const id = `search-${Date.now()}`;
    m.save({
      sessionId: id,
      title: "Long",
      workspaceDirectory: "",
      history: [user("tell me"), assistant(long)],
    });
    await m.flush(id);
    try {
      const r = await searchSessions({ query: "zebracorn" });
      expect(r.hits.map((h) => h.sessionId)).toContain(id);
    } finally {
      m.delete(id);
    }
  });
});

describe("scoreSession and searchTerms", () => {
  it("splits, lowers and dedupes words", () => {
    expect(searchTerms("  Foo bar FOO ")).toEqual(["foo", "bar"]);
  });

  it("reads text parts of a message", () => {
    const hit = scoreSession(
      [
        {
          message: {
            role: "user",
            content: [{ type: "text", text: "an image of a kiwi" }],
          },
          contextItems: [],
        } as ChatHistoryItem,
      ],
      "kiwi",
    );
    expect(hit?.snippet).toContain("kiwi");
  });
});
