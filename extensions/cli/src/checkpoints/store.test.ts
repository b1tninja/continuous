import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isSafeSessionId,
  promptHash,
  promptLabel,
  sha256,
  type TurnRef,
} from "./model.js";
import { pruneOrphanedCheckpoints } from "./prune.js";
import { CheckpointStore } from "./store.js";

let tmp: string;
let work: string;
let root: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ckpt-store-"));
  work = path.join(tmp, "work");
  root = path.join(tmp, "global", "checkpoints");
  fs.mkdirSync(work, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function turn(text: string, userIndex: number): TurnRef {
  return { label: promptLabel(text), promptHash: promptHash(text), userIndex };
}

/** What a file tool does: snapshot, write, record. */
function agentWrite(
  store: CheckpointStore,
  ref: TurnRef,
  file: string,
  content: string,
) {
  store.snapshotBefore(file, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  store.recordWrite(file, content);
}

describe("CheckpointStore: capture", () => {
  it("keeps the first snapshot of a file per turn and stores contents once", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "one\n");
    const t1 = turn("fix a", 1);

    agentWrite(store, t1, a, "two\n");
    agentWrite(store, t1, a, "three\n");

    const turns = store.turns();
    expect(turns).toHaveLength(1);
    expect(turns[0].label).toBe("fix a");
    expect(turns[0].files).toEqual([
      { uri: a, existed: true, blob: sha256("one\n"), bytes: 4 },
    ]);
    expect(fs.readdirSync(path.join(root, "s1", "blobs"))).toEqual([
      sha256("one\n"),
    ]);
  });

  it("records a file the agent created as not existing", () => {
    const store = new CheckpointStore(root, "s1");
    const b = path.join(work, "new", "b.txt");
    agentWrite(store, turn("make b", 1), b, "b\n");
    expect(store.turns()[0].files[0]).toEqual({ uri: b, existed: false });
  });

  it("starts a new turn for a new prompt, and for the same text sent later", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "0");
    agentWrite(store, turn("go", 1), a, "1");
    agentWrite(store, turn("go", 1), a, "2");
    agentWrite(store, turn("other", 3), a, "3");
    agentWrite(store, turn("go", 5), a, "4");
    // compaction lowered the index mid-turn: still the same turn
    agentWrite(store, turn("go", 2), a, "5");
    expect(store.turns().map((t) => t.label)).toEqual(["go", "other", "go"]);
  });

  it("skips files over the size cap and secret files without copying them", () => {
    const store = new CheckpointStore(root, "s1", {
      maxFileBytes: 10,
      maxSessionBytes: 1000,
      maxTurns: 10,
    });
    const big = path.join(work, "big.txt");
    const env = path.join(work, ".env");
    fs.writeFileSync(big, "x".repeat(20));
    fs.writeFileSync(env, "KEY=secret");
    const t = turn("t", 1);
    store.snapshotBefore(big, t);
    store.snapshotBefore(env, t);
    const files = store.turns()[0].files;
    expect(files[0]).toMatchObject({
      uri: big,
      skipped: "too_large",
      bytes: 20,
    });
    expect(files[1]).toMatchObject({ uri: env, skipped: "secret" });
    expect(files[1].blob).toBeUndefined();
    expect(fs.existsSync(path.join(root, "s1", "blobs"))).toBe(false);
  });

  it("drops the oldest turns past the turn cap and deletes their blobs", () => {
    const store = new CheckpointStore(root, "s1", {
      maxFileBytes: 1000,
      maxSessionBytes: 100_000,
      maxTurns: 2,
    });
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "v0");
    agentWrite(store, turn("p1", 1), a, "v1");
    agentWrite(store, turn("p2", 3), a, "v2");
    agentWrite(store, turn("p3", 5), a, "v3");
    expect(store.turns().map((t) => t.label)).toEqual(["p2", "p3"]);
    expect(fs.readdirSync(path.join(root, "s1", "blobs")).sort()).toEqual(
      [sha256("v1"), sha256("v2")].sort(),
    );
  });

  it("drops the oldest turns past the byte cap, never the current one", () => {
    const store = new CheckpointStore(root, "s1", {
      maxFileBytes: 1000,
      maxSessionBytes: 25,
      maxTurns: 100,
    });
    const a = path.join(work, "a.txt");
    const b = path.join(work, "b.txt");
    fs.writeFileSync(a, "a".repeat(20));
    fs.writeFileSync(b, "b".repeat(20));
    agentWrite(store, turn("p1", 1), a, "short");
    agentWrite(store, turn("p2", 3), b, "short");
    expect(store.turns().map((t) => t.label)).toEqual(["p2"]);
    expect(store.storedBytes()).toBe(20);

    // One turn alone over the budget: the new snapshot is marked, not stored
    const c = path.join(work, "c.txt");
    fs.writeFileSync(c, "c".repeat(20));
    store.snapshotBefore(c, turn("p2", 3));
    expect(store.turns()[0].files[1]).toMatchObject({
      uri: c,
      skipped: "session_cap",
    });
    expect(store.storedBytes()).toBe(20);
  });

  it("sets a damaged index aside instead of failing", () => {
    const store = new CheckpointStore(root, "s1");
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(path.join(store.dir, "index.json"), "{not json");
    expect(store.turns()).toEqual([]);
    expect(
      fs
        .readdirSync(store.dir)
        .some((n) => n.startsWith("index.json.damaged-")),
    ).toBe(true);
  });

  it("refuses a session id that would leave the checkpoints folder", () => {
    expect(isSafeSessionId("0f1e2d3c-aaaa-bbbb-cccc-1234567890ab")).toBe(true);
    for (const bad of ["..", ".", "../x", "a/b", "a\\b", ""]) {
      expect(isSafeSessionId(bad)).toBe(false);
    }
    expect(() => new CheckpointStore(root, "../escape")).toThrow();
  });
});

describe("CheckpointStore: rewind", () => {
  it("restores edited files, recreates deleted ones and deletes created ones", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    const b = path.join(work, "b.txt");
    const c = path.join(work, "sub", "c.txt");
    fs.writeFileSync(a, "a0\n");
    fs.writeFileSync(b, "b0\n");
    const t1 = turn("first", 1);
    agentWrite(store, t1, a, "a1\n");
    agentWrite(store, t1, b, "b1\n");
    agentWrite(store, t1, c, "c1\n");
    fs.rmSync(b); // removed by the agent's shell, say: recreate it

    const target = store.turns()[0].turnId;
    const plan = store.planRewind(target);
    expect(plan.map((i) => [path.basename(i.uri), i.action])).toEqual([
      ["a.txt", "restore"],
      ["b.txt", "recreate"],
      ["c.txt", "delete"],
    ]);
    // b was not removed by the agent's own tools: flagged
    expect(plan.find((i) => i.uri === b)?.changedOutside).toBe(true);
    expect(plan.find((i) => i.uri === a)).toMatchObject({
      changedOutside: false,
      added: 1,
      removed: 1,
    });

    const result = store.rewind(target, { confirmChanged: true });
    expect(result.failed).toEqual([]);
    expect(result.restored.sort()).toEqual([a, b].sort());
    expect(result.deleted).toEqual([c]);
    expect(fs.readFileSync(a, "utf-8")).toBe("a0\n");
    expect(fs.readFileSync(b, "utf-8")).toBe("b0\n");
    expect(fs.existsSync(c)).toBe(false);
    expect(store.turns()).toEqual([]);
  });

  it("restores to before the target turn across later turns", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "v0");
    agentWrite(store, turn("p1", 1), a, "v1");
    agentWrite(store, turn("p2", 3), a, "v2");
    agentWrite(store, turn("p3", 5), a, "v3");
    const [, second] = store.turns();

    store.rewind(second.turnId);
    expect(fs.readFileSync(a, "utf-8")).toBe("v1");
    expect(store.turns().map((t) => t.label)).toEqual(["p1"]);

    // Rewinding twice: the earlier turn still restores exactly
    store.rewind(store.turns()[0].turnId);
    expect(fs.readFileSync(a, "utf-8")).toBe("v0");
  });

  it("refuses a file changed outside the agent unless confirmed", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    const b = path.join(work, "b.txt");
    fs.writeFileSync(a, "a0\n");
    fs.writeFileSync(b, "b0\n");
    const t1 = turn("p", 1);
    agentWrite(store, t1, a, "a1\n");
    agentWrite(store, t1, b, "b1\n");
    fs.writeFileSync(a, "a1\nmine\n"); // the person's own edit

    const target = store.turns()[0].turnId;
    const plan = store.planRewind(target);
    expect(plan.find((i) => i.uri === a)).toMatchObject({
      changedOutside: true,
      added: 1,
      removed: 2,
    });

    const refused = store.rewind(target);
    expect(refused.refused).toEqual([a]);
    expect(refused.restored).toEqual([b]);
    expect(fs.readFileSync(a, "utf-8")).toBe("a1\nmine\n");
    // The refused file keeps its snapshot so it can be restored after all
    expect(store.turns()[0].files.map((f) => f.uri)).toEqual([a]);
  });

  it("treats a snapshot with no finished write as changed outside", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "a0");
    store.snapshotBefore(a, turn("p", 1)); // the tool then failed
    fs.writeFileSync(a, "someone else");
    const [item] = store.planRewind(store.turns()[0].turnId);
    expect(item.changedOutside).toBe(true);
  });

  it("reports skipped files as unrestorable and leaves them alone", () => {
    const store = new CheckpointStore(root, "s1", {
      maxFileBytes: 5,
      maxSessionBytes: 1000,
      maxTurns: 10,
    });
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "123456789");
    agentWrite(store, turn("p", 1), a, "x");
    const result = store.rewind(store.turns()[0].turnId);
    expect(result.unrestorable).toEqual([{ uri: a, reason: "too_large" }]);
    expect(fs.readFileSync(a, "utf-8")).toBe("x");
  });

  it("leaves files that already match out of the plan", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "same");
    agentWrite(store, turn("p", 1), a, "same");
    expect(store.planRewind(store.turns()[0].turnId)).toEqual([]);
  });

  it("restores bytes exactly: line endings, BOM and non-UTF-8", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.bin");
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff]);
    fs.writeFileSync(a, original);
    agentWrite(store, turn("p", 1), a, "replaced\n");
    store.rewind(store.turns()[0].turnId);
    expect(fs.readFileSync(a).equals(original)).toBe(true);
  });

  it("collects a write failure instead of stopping", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    const b = path.join(work, "b.txt");
    fs.writeFileSync(a, "a0");
    fs.writeFileSync(b, "b0");
    const t = turn("p", 1);
    agentWrite(store, t, a, "a1");
    agentWrite(store, t, b, "b1");
    const blob = sha256("a0");
    fs.writeFileSync(path.join(store.dir, "blobs", blob), "tampered");
    const result = store.rewind(store.turns()[0].turnId);
    expect(result.failed.map((f) => f.uri)).toEqual([a]);
    expect(result.failed[0].error).toMatch(/damaged/);
    expect(result.restored).toEqual([b]);
  });
});

describe("CheckpointStore: redo", () => {
  it("puts back the files and the conversation of the last rewind", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    const c = path.join(work, "c.txt");
    fs.writeFileSync(a, "v0");
    agentWrite(store, turn("p1", 1), a, "v1");
    agentWrite(store, turn("p2", 3), a, "v2");
    agentWrite(store, turn("p2", 3), c, "new");
    const target = store.turns()[1].turnId;

    store.rewind(target, {
      conversation: { atIndex: 3, items: [{ m: "p2" }, { m: "reply" }] },
    });
    expect(fs.readFileSync(a, "utf-8")).toBe("v1");
    expect(fs.existsSync(c)).toBe(false);
    expect(store.redoRecord()).toBeDefined();

    const redone = store.redo();
    expect(redone?.failed).toEqual([]);
    expect(fs.readFileSync(a, "utf-8")).toBe("v2");
    expect(fs.readFileSync(c, "utf-8")).toBe("new");
    expect(redone?.conversation).toEqual({
      atIndex: 3,
      items: [{ m: "p2" }, { m: "reply" }],
    });
    expect(store.turns().map((t) => t.label)).toEqual(["p1", "p2"]);
    expect(store.redoRecord()).toBeUndefined();

    // And it can be rewound again, with no false "changed outside"
    const again = store.planRewind(target);
    expect(again.every((i) => !i.changedOutside)).toBe(true);
  });

  it("is gone once the agent writes again", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "v0");
    agentWrite(store, turn("p1", 1), a, "v1");
    store.rewind(store.turns()[0].turnId);
    agentWrite(store, turn("p1b", 1), a, "w1");
    expect(store.redoRecord()).toBeUndefined();
    expect(store.redo()).toBeUndefined();
  });

  it("refuses to redo over a file changed since the rewind unless confirmed", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "v0");
    agentWrite(store, turn("p1", 1), a, "v1");
    store.rewind(store.turns()[0].turnId);
    fs.writeFileSync(a, "edited after rewind");

    expect(store.planRedo()[0].changedOutside).toBe(true);
    const refused = store.redo();
    expect(refused?.refused).toEqual([a]);
    expect(fs.readFileSync(a, "utf-8")).toBe("edited after rewind");
  });

  it("redo with confirmation overwrites", () => {
    const store = new CheckpointStore(root, "s1");
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "v0");
    agentWrite(store, turn("p1", 1), a, "v1");
    store.rewind(store.turns()[0].turnId);
    fs.writeFileSync(a, "edited after rewind");
    store.redo({ confirmChanged: true });
    expect(fs.readFileSync(a, "utf-8")).toBe("v1");
  });
});

describe("pruneOrphanedCheckpoints", () => {
  it("removes old folders of sessions that are gone and keeps the rest", () => {
    const now = Date.now();
    const live = new CheckpointStore(root, "live");
    const gone = new CheckpointStore(root, "gone");
    const fresh = new CheckpointStore(root, "fresh");
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "x");
    for (const s of [live, gone, fresh]) agentWrite(s, turn("p", 1), a, "y");
    const old = new Date(now - 3 * 24 * 60 * 60 * 1000);
    for (const s of [live, gone]) {
      fs.utimesSync(path.join(s.dir, "index.json"), old, old);
      fs.utimesSync(s.dir, old, old);
    }
    fs.writeFileSync(path.join(root, "stray.txt"), "not a folder");

    const removed = pruneOrphanedCheckpoints(root, (id) => id === "live", {
      now,
    });
    expect(removed).toEqual(["gone"]);
    expect(fs.existsSync(live.dir)).toBe(true);
    expect(fs.existsSync(fresh.dir)).toBe(true);
    expect(fs.existsSync(gone.dir)).toBe(false);
  });

  it("is a no-op when there is no checkpoints folder", () => {
    expect(
      pruneOrphanedCheckpoints(path.join(tmp, "nope"), () => false),
    ).toEqual([]);
  });
});

describe("prompt labels", () => {
  it("uses the first non-empty line, shortened", () => {
    expect(promptLabel("\n\n  hello world  \nmore")).toBe("hello world");
    expect(promptLabel("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
