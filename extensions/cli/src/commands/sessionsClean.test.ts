import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  describeScan,
  scanForCleanup,
} from "core/util/sessionCleanup/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionsCleanCommand } from "./sessionsClean.js";

let root: string;
let out: string[];
let err: string[];
const io = () => ({
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-sessions-clean-"));
  fs.mkdirSync(path.join(root, "sessions"));
  out = [];
  err = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A small session with three requests' full prompts, written a day ago. */
function oldSession(id: string): string {
  const prompt = (k: number) =>
    `secret-free conversation text ${k} `.repeat(200 * k);
  const session = {
    sessionId: id,
    title: "t",
    workspaceDirectory: "",
    history: [1, 2, 3].flatMap((k) => [
      {
        message: { id: `u${k}`, role: "user", content: "q" },
        contextItems: [],
      },
      {
        message: { id: `a${k}`, role: "assistant", content: "a" },
        contextItems: [],
        promptLogs: [
          {
            modelTitle: "m",
            modelProvider: "p",
            prompt: prompt(k),
            completion: "a",
          },
        ],
      },
    ]),
  };
  const file = path.join(root, "sessions", `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(session, undefined, 2));
  const t = new Date(Date.now() - 86_400_000);
  fs.utimesSync(file, t, t);
  return file;
}

describe("continuous sessions clean", () => {
  it("is a dry run by default, prints the same report as VS Code, and never prints contents", async () => {
    const file = oldSession("s");
    const before = fs.readFileSync(file, "utf8");
    expect(await sessionsCleanCommand({ root }, io())).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const text = out.join("\n");
    // The lines VS Code shows come from the same function
    const shared = describeScan(await scanForCleanup({ root }));
    for (const line of shared) expect(out).toContain(line);
    expect(text).toContain("1 session(s) with old prompt logs");
    expect(text).toContain("Dry run: nothing changed");
    expect(text).not.toContain("conversation text");
  });

  it("cleans with --yes and keeps the original in cleanup-backups", async () => {
    const file = oldSession("s");
    const size = fs.statSync(file).size;
    expect(await sessionsCleanCommand({ root, yes: true }, io())).toBe(0);
    expect(fs.statSync(file).size).toBeLessThan(size);
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(session.history).toHaveLength(6);
    const backups = path.join(root, "cleanup-backups");
    const [day] = fs.readdirSync(backups);
    expect(
      fs.statSync(path.join(backups, day, "sessions", "s.json")).size,
    ).toBe(size);
    expect(out.join("\n")).toContain("Originals are kept in");
  });

  it("does nothing with --yes --dry-run", async () => {
    const file = oldSession("s");
    const before = fs.readFileSync(file, "utf8");
    await sessionsCleanCommand({ root, yes: true, dryRun: true }, io());
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("answers in JSON, without contents", async () => {
    oldSession("s");
    await sessionsCleanCommand({ root, json: true }, io());
    const report = JSON.parse(out.join(""));
    expect(report.applied).toBe(false);
    expect(report.scan.sessions).toHaveLength(1);
    expect(report.scan.totals.sessionsBytes).toBeGreaterThan(0);
    expect(out.join("")).not.toContain("conversation text");
  });

  it("reports and moves the stale blobs of a log session", async () => {
    // A .jsonl session that refers to one blob; a second blob is left over
    const id = "log";
    const used = "a".repeat(64);
    const stale = "b".repeat(64);
    const log = path.join(root, "sessions", `${id}.jsonl`);
    fs.writeFileSync(
      log,
      [
        { t: "header", format: "continuous-session", v: 1, sessionId: id },
        { t: "meta", k: "title", v: "t" },
        {
          t: "item",
          i: 0,
          v: {
            message: { role: "tool", content: { $blob: used, n: 5 } },
            contextItems: [],
          },
        },
      ]
        .map(
          (l) => `${JSON.stringify(l)}
`,
        )
        .join(""),
    );
    const blobs = path.join(root, "sessions", id, "blobs");
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, used), "kept!");
    fs.writeFileSync(path.join(blobs, stale), "stale output");
    const t = new Date(Date.now() - 86_400_000);
    for (const f of [log, path.join(blobs, used), path.join(blobs, stale)]) {
      fs.utimesSync(f, t, t);
    }

    await sessionsCleanCommand({ root, json: true }, io());
    const report = JSON.parse(out.join(""));
    expect(report.scan.blobs).toEqual([
      { dir: blobs, staleBlobs: 1, reclaimableBytes: 12 },
    ]);
    out = [];
    await sessionsCleanCommand({ root, yes: true }, io());
    expect(fs.readdirSync(blobs)).toEqual([used]);
  });

  it("leaves dev data and logs alone when asked", async () => {
    fs.mkdirSync(path.join(root, "logs"));
    const log = path.join(root, "logs", "core.log");
    fs.writeFileSync(log, "x");
    const t = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(log, t, t);
    await sessionsCleanCommand(
      { root, yes: true, logs: false, devData: false },
      io(),
    );
    expect(fs.existsSync(log)).toBe(true);
    expect(out.join("\n")).not.toContain("Logs:");
    out = [];
    await sessionsCleanCommand({ root, yes: true }, io());
    expect(fs.existsSync(log)).toBe(false);
  });

  it("rejects a bad age", async () => {
    expect(await sessionsCleanCommand({ root, logsDays: "soon" }, io())).toBe(
      2,
    );
    expect(err.join("\n")).toContain("--logs-days");
  });
});
