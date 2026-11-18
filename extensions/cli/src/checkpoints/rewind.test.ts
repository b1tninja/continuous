import fs from "fs";
import os from "os";
import path from "path";

import type { ChatHistoryItem } from "core/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { promptHash, promptLabel } from "./model.js";
import {
  applyRedo,
  applyRewind,
  availableModes,
  buildRewindEntries,
  describeItems,
  previewFiles,
} from "./rewind.js";
import { CheckpointStore } from "./store.js";

let tmp: string;
let work: string;
let store: CheckpointStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cn-rewind-"));
  work = path.join(tmp, "work");
  fs.mkdirSync(work);
  store = new CheckpointStore(path.join(tmp, "checkpoints"), "s1");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const assistant = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});

/** The agent, answering the prompt at `userIndex`, writes `file`. */
function write(prompt: string, userIndex: number, file: string, text: string) {
  store.snapshotBefore(file, {
    label: promptLabel(prompt),
    promptHash: promptHash(prompt),
    userIndex,
  });
  fs.writeFileSync(file, text);
  store.recordWrite(file, text);
}

describe("buildRewindEntries", () => {
  it("lists every prompt and joins the turns that wrote files", () => {
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "0");
    const history = [
      user("first"),
      assistant("ok"),
      user("second"),
      assistant("ok"),
      user("third"),
    ];
    write("first", 0, a, "1");
    write("third", 4, a, "3");

    const entries = buildRewindEntries(history, store.turns());
    expect(
      entries.map((e) => [e.number, e.label, e.historyIndex, e.files.length]),
    ).toEqual([
      [1, "first", 0, 1],
      [2, "second", 2, 0],
      [3, "third", 4, 1],
    ]);
    // "second" wrote nothing: restoring files targets the next turn that did
    const [t1, t3] = store.turns();
    expect(entries.map((e) => e.filesTurnId)).toEqual([
      t1.turnId,
      t3.turnId,
      t3.turnId,
    ]);
  });

  it("keeps turns whose prompt was compacted away, for files only", () => {
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "0");
    write("old prompt", 0, a, "1");
    const history = [user("summary of the earlier conversation"), user("now")];
    write("now", 1, a, "2");

    const entries = buildRewindEntries(history, store.turns());
    expect(entries.map((e) => [e.label, e.historyIndex])).toEqual([
      ["old prompt", undefined],
      ["summary of the earlier conversation", 0],
      ["now", 1],
    ]);
    expect(availableModes(entries[0], previewFiles(store, entries[0]))).toEqual(
      ["files"],
    );
  });

  it("matches the same prompt text sent twice to the right turns", () => {
    const a = path.join(work, "a.txt");
    fs.writeFileSync(a, "0");
    const history = [user("go"), assistant("1"), user("go")];
    write("go", 0, a, "1");
    write("go", 2, a, "2");
    const entries = buildRewindEntries(history, store.turns());
    const [t1, t2] = store.turns();
    expect(entries.map((e) => e.turn?.turnId)).toEqual([t1.turnId, t2.turnId]);
  });
});

describe("applyRewind and applyRedo", () => {
  function setup() {
    const a = path.join(work, "a.txt");
    const b = path.join(work, "b.txt");
    fs.writeFileSync(a, "a0\n");
    const history = [user("p1"), assistant("r1"), user("p2"), assistant("r2")];
    write("p1", 0, a, "a1\n");
    write("p2", 2, a, "a2\n");
    write("p2", 2, b, "b2\n");
    return { a, b, history };
  }

  it("both: restores the files and cuts the conversation before the prompt", () => {
    const { a, b, history } = setup();
    const entries = buildRewindEntries(history, store.turns());
    const out = applyRewind(store, history, entries[1], "both", { cwd: work });
    expect(fs.readFileSync(a, "utf-8")).toBe("a1\n");
    expect(fs.existsSync(b)).toBe(false);
    expect(out.history).toEqual(history.slice(0, 2));
    expect(out.lines.join("\n")).toMatch(/Restored 1 file\(s\), removed 1/);
    expect(out.lines.join("\n")).toMatch(/Conversation rewound/);
  });

  it("files: keeps the conversation", () => {
    const { a, history } = setup();
    const entries = buildRewindEntries(history, store.turns());
    const out = applyRewind(store, history, entries[0], "files");
    expect(out.history).toBeUndefined();
    expect(fs.readFileSync(a, "utf-8")).toBe("a0\n");
  });

  it("conversation: keeps the files", () => {
    const { a, history } = setup();
    const entries = buildRewindEntries(history, store.turns());
    const out = applyRewind(store, history, entries[1], "conversation");
    expect(out.history).toEqual(history.slice(0, 2));
    expect(fs.readFileSync(a, "utf-8")).toBe("a2\n");
    expect(store.turns()).toHaveLength(2);
  });

  it("redo puts back files and conversation when nothing was added since", () => {
    const { a, b, history } = setup();
    const entries = buildRewindEntries(history, store.turns());
    const out = applyRewind(store, history, entries[1], "both");
    const redone = applyRedo(store, out.history!);
    expect(redone?.history).toEqual(history);
    expect(fs.readFileSync(a, "utf-8")).toBe("a2\n");
    expect(fs.readFileSync(b, "utf-8")).toBe("b2\n");
    expect(applyRedo(store, history)).toBeUndefined();
  });

  it("redo leaves the conversation alone when messages were added since", () => {
    const { a, history } = setup();
    const entries = buildRewindEntries(history, store.turns());
    const out = applyRewind(store, history, entries[1], "both");
    const later = [...out.history!, user("something else")];
    const redone = applyRedo(store, later);
    expect(redone?.history).toBeUndefined();
    expect(redone?.lines.join("\n")).toMatch(/not restored/);
    expect(fs.readFileSync(a, "utf-8")).toBe("a2\n");
  });

  it("an outside change is refused unless confirmed, and described", () => {
    const { a, history } = setup();
    fs.writeFileSync(a, "a2\nmine\n");
    const entries = buildRewindEntries(history, store.turns());
    const items = previewFiles(store, entries[1]);
    expect(describeItems(items, work)).toContain(
      "restore  a.txt  +1 -2  changed outside the agent since its last write",
    );
    const refused = applyRewind(store, history, entries[1], "files", {
      cwd: work,
    });
    expect(refused.lines).toContain(
      "Left alone (changed outside the agent): a.txt",
    );
    expect(fs.readFileSync(a, "utf-8")).toBe("a2\nmine\n");
    applyRewind(store, history, entries[1], "files", { confirmChanged: true });
    expect(fs.readFileSync(a, "utf-8")).toBe("a1\n");
  });
});
