import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Session } from "core/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { promptHash, promptLabel } from "../checkpoints/model.js";
import { CheckpointStore } from "../checkpoints/store.js";

import { rewindCommand, type RewindDeps } from "./rewind.js";

let tmp: string;
let work: string;
let store: CheckpointStore;
let saved: Session[];
let session: Session;
let out: string[];
let err: string[];
const io = () => ({
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
});

function write(prompt: string, userIndex: number, file: string, text: string) {
  store.snapshotBefore(file, {
    label: promptLabel(prompt),
    promptHash: promptHash(prompt),
    userIndex,
  });
  fs.writeFileSync(file, text);
  store.recordWrite(file, text);
}

const deps = (): RewindDeps => ({
  loadSession: (id) => (id === session.sessionId ? session : null),
  saveSession: (s) => {
    saved.push(s);
    session = s;
  },
  storeFor: () => store,
});

let a: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-rewind-"));
  work = path.join(tmp, "work");
  fs.mkdirSync(work);
  store = new CheckpointStore(path.join(tmp, "checkpoints"), "s1");
  saved = [];
  out = [];
  err = [];
  session = {
    sessionId: "s1",
    title: "t",
    workspaceDirectory: work,
    history: [
      { message: { role: "user", content: "p1" }, contextItems: [] },
      { message: { role: "assistant", content: "r1" }, contextItems: [] },
      { message: { role: "user", content: "p2" }, contextItems: [] },
      { message: { role: "assistant", content: "r2" }, contextItems: [] },
    ],
  };
  a = path.join(work, "a.txt");
  fs.writeFileSync(a, "a0\n");
  write("p1", 0, a, "a1\n");
  write("p2", 2, a, "a2\n");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("continuous rewind", () => {
  it("lists the prompts and what is not covered when --to is absent", () => {
    expect(rewindCommand("s1", {}, deps(), io())).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("  1. p1  (1 file(s))");
    expect(text).toContain("  2. p2  (1 file(s))");
    expect(text).toContain("shell commands");
    expect(fs.readFileSync(a, "utf-8")).toBe("a2\n");
  });

  it("--to restores files only by default and keeps the conversation", () => {
    expect(rewindCommand("s1", { to: "2" }, deps(), io())).toBe(0);
    expect(fs.readFileSync(a, "utf-8")).toBe("a1\n");
    expect(saved).toEqual([]);
    expect(out.join("\n")).toContain("Restored 1 file(s)");
  });

  it("--mode both also cuts the saved conversation, and --redo puts it back", () => {
    const original = session.history;
    expect(rewindCommand("s1", { to: "2", mode: "both" }, deps(), io())).toBe(
      0,
    );
    expect(session.history).toEqual(original.slice(0, 2));
    expect(rewindCommand("s1", { redo: true }, deps(), io())).toBe(0);
    expect(session.history).toEqual(original);
    expect(fs.readFileSync(a, "utf-8")).toBe("a2\n");
    expect(rewindCommand("s1", { redo: true }, deps(), io())).toBe(1);
  });

  it("stops with nothing changed when a file changed outside the agent", () => {
    fs.writeFileSync(a, "a2\nmine\n");
    expect(rewindCommand("s1", { to: "1" }, deps(), io())).toBe(1);
    expect(out.join("\n")).toContain(
      "1 file(s) changed outside the agent since its last write; nothing was changed",
    );
    expect(out.join("\n")).toContain("a.txt  +1 -2");
    expect(fs.readFileSync(a, "utf-8")).toBe("a2\nmine\n");

    expect(rewindCommand("s1", { to: "1", yes: true }, deps(), io())).toBe(0);
    expect(fs.readFileSync(a, "utf-8")).toBe("a0\n");
  });

  it("--skip-changed leaves the changed file and restores the rest", () => {
    const b = path.join(work, "b.txt");
    write("p2", 2, b, "created");
    fs.writeFileSync(a, "outside");
    expect(
      rewindCommand("s1", { to: "2", skipChanged: true }, deps(), io()),
    ).toBe(0);
    expect(fs.readFileSync(a, "utf-8")).toBe("outside");
    expect(fs.existsSync(b)).toBe(false);
  });

  it("--dry-run changes nothing", () => {
    expect(rewindCommand("s1", { to: "1", dryRun: true }, deps(), io())).toBe(
      0,
    );
    expect(out.join("\n")).toContain("restore  a.txt");
    expect(fs.readFileSync(a, "utf-8")).toBe("a2\n");
  });

  it("--json lists entries", () => {
    rewindCommand("s1", { json: true }, deps(), io());
    const data = JSON.parse(out[0]);
    expect(data.entries.map((e: any) => e.number)).toEqual([1, 2]);
    expect(data.entries[0].files).toEqual([a]);
  });

  it("refuses unknown sessions, prompts and modes", () => {
    expect(rewindCommand("nope", {}, deps(), io())).toBe(2);
    expect(rewindCommand("s1", { to: "9" }, deps(), io())).toBe(2);
    expect(rewindCommand("s1", { to: "1", mode: "all" }, deps(), io())).toBe(2);
    expect(err).toHaveLength(3);
  });
});
