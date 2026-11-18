import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { DAY_MS, parseAge, planClean, runClean } from "./cleanStores";

const roots: string[] = [];
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-"));
  roots.push(root);
  for (const d of ["sessions", "dev_data/0.2.0", "logs"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  return root;
}
const aged = (f: string, days: number) => {
  const t = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(f, t, t);
};
afterEach(() => {
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

describe("clean: session logs and their blobs", () => {
  it("ages a .jsonl session and takes its blob folder with it", () => {
    const root = tree();
    const sessions = path.join(root, "sessions");
    const oldLog = path.join(sessions, "old.jsonl");
    const liveLog = path.join(sessions, "live.jsonl");
    fs.writeFileSync(oldLog, "{}\n");
    fs.writeFileSync(liveLog, "{}\n");
    for (const id of ["old", "live"]) {
      fs.mkdirSync(path.join(sessions, id, "blobs"), { recursive: true });
      const blob = path.join(sessions, id, "blobs", "a".repeat(64));
      fs.writeFileSync(blob, "x".repeat(100));
      // Blobs are written once and never touched again
      aged(blob, 400);
    }
    aged(oldLog, 40);

    const plan = planClean(root);
    expect(plan.entries.map((e) => path.basename(e.file))).toEqual([
      "old.jsonl",
    ]);
    // the blob folder is counted with its session
    expect(plan.entries[0].bytes).toBe(3 + 100);

    runClean(plan);
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(path.join(sessions, "old"))).toBe(false);
    // An active session keeps its old blobs
    expect(fs.existsSync(path.join(sessions, "live", "blobs"))).toBe(true);
  });
});

describe("clean", () => {
  it("parses ages", () => {
    expect(parseAge("30d")).toBe(30 * DAY_MS);
    expect(parseAge("2w")).toBe(14 * DAY_MS);
    expect(parseAge("x")).toBeUndefined();
    expect(parseAge("0")).toBeUndefined();
  });

  it("plans without touching anything, then deletes only old own files", () => {
    const root = tree();
    const oldS = path.join(root, "sessions", "a.json");
    const newS = path.join(root, "sessions", "b.json");
    const list = path.join(root, "sessions", "sessions.json");
    const log = path.join(root, "logs", "core.log");
    const other = path.join(root, "config.yaml");
    const jl = path.join(root, "dev_data", "0.2.0", "toolUsage.jsonl");
    fs.writeFileSync(oldS, "{}");
    fs.writeFileSync(newS, "{}");
    fs.writeFileSync(
      list,
      JSON.stringify([{ sessionId: "a" }, { sessionId: "b" }]),
    );
    fs.writeFileSync(log, "x");
    fs.writeFileSync(other, "keep");
    const old = new Date(Date.now() - 60 * DAY_MS).toISOString();
    const recent = new Date().toISOString();
    fs.writeFileSync(
      jl,
      `${JSON.stringify({ timestamp: old })}\n${JSON.stringify({ timestamp: recent })}\nnot json\n`,
    );
    aged(oldS, 40);
    aged(log, 40);
    aged(other, 400);

    const plan = planClean(root, 30 * DAY_MS);
    expect(plan.entries.map((e) => path.basename(e.file)).sort()).toEqual([
      "a.json",
      "core.log",
      "toolUsage.jsonl",
    ]);
    expect(fs.existsSync(oldS)).toBe(true);

    const res = runClean(plan);
    expect(res.failed).toEqual([]);
    expect(fs.existsSync(oldS)).toBe(false);
    expect(fs.existsSync(newS)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(
      fs.readFileSync(jl, "utf8").split("\n").filter(Boolean),
    ).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(list, "utf8"))).toEqual([
      { sessionId: "b" },
    ]);
  });

  it("uses per-store defaults: sessions 30d, logs 14d, dev_data 90d", () => {
    const root = tree();
    const s20 = path.join(root, "sessions", "s20.json");
    const l20 = path.join(root, "logs", "l20.log");
    const s40 = path.join(root, "sessions", "s40.json");
    const l10 = path.join(root, "logs", "l10.log");
    for (const f of [s20, l20, s40, l10]) fs.writeFileSync(f, "x");
    aged(s20, 20);
    aged(l20, 20);
    aged(s40, 40);
    aged(l10, 10);
    const jl = path.join(root, "dev_data", "0.2.0", "e.jsonl");
    const at = (d: number) =>
      JSON.stringify({ timestamp: new Date(Date.now() - d * DAY_MS) });
    fs.writeFileSync(
      jl,
      `${at(60)}
${at(100)}
${at(1)}
`,
    );
    const plan = planClean(root);
    const names = plan.entries.map((e) => path.basename(e.file)).sort();
    expect(names).toEqual(["e.jsonl", "l20.log", "s40.json"]);
    expect(plan.entries.find((e) => e.store === "dev_data")?.lines).toBe(1);
    // an explicit age overrides every store
    expect(planClean(root, 5 * DAY_MS).entries.length).toBe(5);
  });

  it("refuses a path outside the root", () => {
    const root = tree();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    roots.push(outside);
    const victim = path.join(outside, "v.json");
    fs.writeFileSync(victim, "{}");
    const r = runClean({
      root,
      cutoff: new Date(),
      cutoffs: { sessions: 0, dev_data: 0, logs: 0 },
      bytes: 0,
      skipped: [],
      entries: [{ store: "sessions", file: victim, bytes: 2, action: "file" }],
    });
    expect(r.failed).toEqual([victim]);
    expect(fs.existsSync(victim)).toBe(true);
  });
});
