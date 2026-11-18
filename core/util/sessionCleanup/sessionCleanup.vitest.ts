import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stripPromptsFromSessionBytes } from "../promptLogsFile";
import { leaseDir, markSessionOpen, resetOwnLease } from "../sessionLeases";
import {
  applyCleanup,
  CLEANUP_BACKUP_DIR,
  describeResult,
  describeScan,
  DROPPED_PROMPT_MARKER,
  pruneCleanupBackups,
  quickCleanupEstimate,
  scanForCleanup,
} from "./index";
import { scanSessionFile } from "./sessionFile";

const DAY = 86_400_000;
const HOUR = 3_600_000;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-cleanup-"));
  fs.mkdirSync(path.join(root, "sessions"));
  resetOwnLease();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetOwnLease();
});

function hashOf(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function age(file: string, ms: number) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

/**
 * A session the way releases before the fix saved it: every request's
 * prompt holds everything before it. Written in pieces, so a large one
 * never exists as one string.
 */
function writeSession(
  id: string,
  options: { requests?: number; promptBytes?: number; agedMs?: number } = {},
): string {
  const requests = options.requests ?? 4;
  const unit = options.promptBytes ?? 1000;
  const file = path.join(root, "sessions", `${id}.json`);
  const fd = fs.openSync(file, "w");
  const w = (s: string) => fs.writeSync(fd, s);
  w(
    `{\n  "sessionId": ${JSON.stringify(id)},\n  "title": "t",\n  "workspaceDirectory": "",\n  "history": [`,
  );
  // Text with escapes, quotes and non-ASCII, as real prompts have
  const piece = JSON.stringify(
    `line "quoted" \\ é 😀\n`.repeat(Math.ceil(unit / 30)).slice(0, unit),
  ).slice(1, -1);
  for (let k = 0; k < requests; k++) {
    if (k) w(",");
    w(
      `\n    {"message": {"id": "u${k}", "role": "user", "content": "q${k}"}, "contextItems": []},`,
    );
    w(
      `\n    {"message": {"id": "a${k}", "role": "assistant", "content": "answer ${k}"}, "contextItems": [], "promptLogs": [`,
    );
    w(`{"modelTitle": "m", "modelProvider": "p", "prompt": "`);
    for (let j = 0; j <= k; j++) w(piece);
    w(`", "completion": "answer ${k}"}]}`);
  }
  w(`\n  ]\n}\n`);
  fs.closeSync(fd);
  age(file, options.agedMs ?? DAY);
  return file;
}

describe("scanForCleanup", () => {
  it("reports sessions with old prompt logs and changes nothing", async () => {
    const a = writeSession("a", { requests: 5 });
    const b = writeSession("b", { requests: 2 });
    const before = [hashOf(a), hashOf(b)];
    const scan = await scanForCleanup({ root });
    expect(scan.sessions.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
    expect(scan.sessions.find((s) => s.sessionId === "a")!.promptLogs).toBe(5);
    // Every stored prompt goes: 1 + 2 + 3 + 4 + 5 pieces in "a", 1 + 2 in "b"
    expect(scan.totals.sessionsBytes).toBeGreaterThan(15 * 1000);
    expect(scan.largestSession?.file).toBe(a);
    expect([hashOf(a), hashOf(b)]).toEqual(before);
    const report = describeScan(scan).join("\n");
    expect(report).toContain("2 session(s) with old prompt logs");
    expect(report).toContain("largest session file");
    expect(report).not.toContain('line "quoted"');
  });

  it("leaves sessions open elsewhere and recently written alone", async () => {
    writeSession("open");
    writeSession("recent", { agedMs: 60_000 });
    writeSession("idle");
    markSessionOpen("open", { root }); // this process, which is alive
    const scan = await scanForCleanup({ root });
    expect(scan.sessions.map((s) => s.sessionId)).toEqual(["idle"]);
    expect(
      Object.fromEntries(
        scan.skipped.map((s) => [path.basename(s.file), s.reason]),
      ),
    ).toEqual({
      "open.json": "open elsewhere",
      "recent.json": "written in the last 10 minutes",
    });
  });

  it("ignores the record of a process that has exited, and removes it", async () => {
    writeSession("s");
    fs.mkdirSync(leaseDir(root), { recursive: true });
    const stale = path.join(leaseDir(root), `${os.hostname()}-999999.json`);
    fs.writeFileSync(
      stale,
      JSON.stringify({
        pid: 2 ** 30,
        host: os.hostname(),
        sessions: { s: Date.now() },
      }),
    );
    const scan = await scanForCleanup({ root });
    expect(scan.sessions.map((s) => s.sessionId)).toEqual(["s"]);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("skips a file that is not JSON, and one already clean", async () => {
    const bad = path.join(root, "sessions", "bad.json");
    fs.writeFileSync(bad, '{"history": [');
    age(bad, DAY);
    // Already what the product writes now: the marker in place of the prompt
    const clean = path.join(root, "sessions", "clean.json");
    fs.writeFileSync(
      clean,
      JSON.stringify({
        sessionId: "clean",
        history: [
          {
            message: { id: "a", role: "assistant", content: "" },
            promptLogs: [{ prompt: DROPPED_PROMPT_MARKER, completion: "x" }],
          },
        ],
      }),
    );
    age(clean, DAY);
    const scan = await scanForCleanup({ root });
    expect(scan.sessions).toEqual([]);
    expect(scan.skipped).toEqual([
      expect.objectContaining({ file: bad, reason: "not a readable session" }),
    ]);
    expect(scan.sessionFilesScanned).toBe(1);
  });
});

describe("applyCleanup", () => {
  it("rewrites each session without old prompts, checks it, and keeps the original", async () => {
    const file = writeSession("s", { requests: 6, promptBytes: 5000 });
    const original = hashOf(file);
    const originalSize = fs.statSync(file).size;
    const before = JSON.parse(fs.readFileSync(file, "utf8"));
    const scan = await scanForCleanup({ root });
    const result = await applyCleanup(scan);

    expect(result.sessions.cleaned).toBe(1);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.history.map((i: any) => i.message.id)).toEqual(
      before.history.map((i: any) => i.message.id),
    );
    const prompts = after.history.flatMap((i: any) =>
      (i.promptLogs ?? []).map((l: any) => l.prompt),
    );
    expect(prompts).toHaveLength(6);
    expect(prompts.every((p: string) => p === DROPPED_PROMPT_MARKER)).toBe(
      true,
    );
    // completions and models stay
    expect(after.history.at(1).promptLogs[0].completion).toBe("answer 0");
    expect(fs.statSync(file).size).toBe(originalSize - result.sessions.bytes);

    const backup = path.join(result.backupDir, "sessions", "s.json");
    expect(hashOf(backup)).toBe(original);
    // The same session the product reads from the original when it loads it
    expect(after).toEqual(
      JSON.parse(
        stripPromptsFromSessionBytes(fs.readFileSync(backup)).toString("utf8"),
      ),
    );
    expect(fs.readdirSync(path.join(root, "sessions"))).toEqual(["s.json"]);
    expect(describeResult(result).join("\n")).toContain(result.backupDir);
  });

  it("rolls back when the rewritten copy does not check out", async () => {
    const file = writeSession("s");
    const original = hashOf(file);
    const scan = await scanForCleanup({ root });
    const result = await applyCleanup(scan, {
      verifySession: async () => {
        throw new Error("the cleaned copy differs: message ids");
      },
    });
    expect(result.sessions.cleaned).toBe(0);
    expect(result.failed).toEqual([
      { file, reason: "the cleaned copy differs: message ids" },
    ]);
    expect(hashOf(file)).toBe(original);
    expect(fs.readdirSync(path.join(root, "sessions"))).toEqual(["s.json"]);
    expect(
      fs.existsSync(path.join(result.backupDir, "sessions", "s.json")),
    ).toBe(false);
  });

  it("does not replace a session that changed while it was rewritten", async () => {
    const file = writeSession("s");
    const scan = await scanForCleanup({ root });
    const result = await applyCleanup(scan, {
      verifySession: async () => {
        fs.appendFileSync(file, " ");
        return undefined as never;
      },
    });
    expect(result.skipped).toEqual([
      expect.objectContaining({ file, reason: "changed during cleanup" }),
    ]);
    expect(fs.readFileSync(file, "utf8").endsWith("}\n ")).toBe(true);
    expect(fs.readdirSync(path.join(root, "sessions"))).toEqual(["s.json"]);
  });

  it("re-checks which sessions are open when it applies", async () => {
    writeSession("s");
    const scan = await scanForCleanup({ root });
    markSessionOpen("s", { root }); // opened between the dry run and the apply
    const result = await applyCleanup(scan);
    expect(result.sessions.cleaned).toBe(0);
    expect(result.skipped[0].reason).toBe("open elsewhere");
  });

  it("drops old dev data lines and keeps chatInteraction as sizes and a hash", async () => {
    const dir = path.join(root, "dev_data", "0.2.0");
    fs.mkdirSync(dir, { recursive: true });
    const chat = path.join(dir, "chatInteraction.jsonl");
    const old = new Date(Date.now() - 200 * DAY).toISOString();
    const recent = new Date(Date.now() - HOUR).toISOString();
    const prompt = "the whole conversation ".repeat(500);
    fs.writeFileSync(
      chat,
      [
        {
          timestamp: old,
          eventName: "chatInteraction",
          prompt,
          completion: "x",
        },
        {
          timestamp: recent,
          eventName: "chatInteraction",
          prompt,
          completion: "done",
          sessionId: "s",
        },
        {
          timestamp: recent,
          eventName: "chatInteraction",
          promptBytes: 3,
          sessionId: "t",
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\nnot json\n",
    );
    const other = path.join(dir, "tokensGenerated.jsonl");
    fs.writeFileSync(
      other,
      `${JSON.stringify({ timestamp: recent, generatedTokens: 3 })}\n`,
    );
    const otherHash = hashOf(other);

    const scan = await scanForCleanup({ root });
    expect(scan.devData).toHaveLength(1);
    expect(scan.devData[0]).toMatchObject({ oldLines: 1, promptLines: 1 });
    const result = await applyCleanup(scan);
    expect(result.devData.cleaned).toBe(1);

    const lines = fs.readFileSync(chat, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const kept = JSON.parse(lines[0]);
    expect(kept).toEqual({
      timestamp: recent,
      eventName: "chatInteraction",
      sessionId: "s",
      promptBytes: Buffer.byteLength(prompt),
      completionBytes: 4,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
    });
    expect(JSON.parse(lines[1])).toEqual({
      timestamp: recent,
      eventName: "chatInteraction",
      promptBytes: 3,
      sessionId: "t",
    });
    expect(lines[2]).toBe("not json");
    expect(hashOf(other)).toBe(otherHash);
    expect(
      fs.existsSync(
        path.join(
          result.backupDir,
          "dev_data",
          "0.2.0",
          "chatInteraction.jsonl",
        ),
      ),
    ).toBe(true);
  });

  it("moves logs older than the retention into the backup folder", async () => {
    fs.mkdirSync(path.join(root, "logs"));
    const oldLog = path.join(root, "logs", "core.log");
    const newLog = path.join(root, "logs", "cn.log");
    fs.writeFileSync(oldLog, "old");
    fs.writeFileSync(newLog, "new");
    age(oldLog, 20 * DAY);
    const scan = await scanForCleanup({ root });
    expect(scan.logs.map((l) => l.file)).toEqual([oldLog]);
    const result = await applyCleanup(scan);
    expect(result.logs.moved).toBe(1);
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(newLog)).toBe(true);
    expect(
      fs.readFileSync(path.join(result.backupDir, "logs", "core.log"), "utf8"),
    ).toBe("old");
  });
});

describe("backups and estimates", () => {
  it("deletes only dated backup folders older than the age given", () => {
    const base = path.join(root, CLEANUP_BACKUP_DIR);
    for (const d of ["2026-01-01", "2026-11-13", "not-a-date"]) {
      fs.mkdirSync(path.join(base, d), { recursive: true });
      fs.writeFileSync(path.join(base, d, "f"), "1234");
    }
    const now = Date.parse("2026-11-14T12:00:00Z");
    const pruned = pruneCleanupBackups(root, 30 * DAY, now);
    expect(pruned.removed.map((p) => path.basename(p))).toEqual(["2026-01-01"]);
    expect(pruned.bytes).toBe(4);
    expect(fs.readdirSync(base).sort()).toEqual(["2026-11-13", "not-a-date"]);
  });

  it("estimates an upper bound from file sizes alone", async () => {
    const file = writeSession("s");
    const scan = await scanForCleanup({ root });
    const estimate = await quickCleanupEstimate({ root });
    expect(estimate).toBe(fs.statSync(file).size);
    expect(estimate).toBeGreaterThanOrEqual(scan.totals.reclaimableBytes);
  });
});

/**
 * A real file past V8's string limit. Writes about 640 MB to the temp
 * folder, so it runs only when asked: CONTINUOUS_LARGE_FILE_TESTS=1.
 */
describe.runIf(process.env.CONTINUOUS_LARGE_FILE_TESTS === "1")(
  "a session past the string limit",
  () => {
    it("is scanned, cleaned and checked without being read into one string", async () => {
      const file = writeSession("huge", { requests: 170, promptBytes: 50_000 });
      const size = fs.statSync(file).size;
      expect(size).toBeGreaterThan(600 * 1024 * 1024);
      expect(size).toBeGreaterThan(2 ** 29);
      const scan = await scanForCleanup({ root, stores: ["sessions"] });
      expect(scan.sessions).toHaveLength(1);
      const result = await applyCleanup(scan);
      expect(result.failed).toEqual([]);
      expect(result.sessions.cleaned).toBe(1);
      const after = fs.statSync(file).size;
      expect(after).toBeLessThan(1024 * 1024);
      const check = await scanSessionFile(file);
      expect(check.items).toBe(340);
      expect(check.fullPrompts).toBe(0);
      // The backup is the original (a hard link, or a copy)
      expect(
        fs.statSync(path.join(result.backupDir, "sessions", "huge.json")).size,
      ).toBe(size);
    }, 600_000);
  },
);
