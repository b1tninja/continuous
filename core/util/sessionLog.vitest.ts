import * as fs from "node:fs";
import * as path from "node:path";

import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatHistoryItem, Session } from "../index.js";

import { forkSession } from "./forkSession.js";
import { HistoryManager } from "./history.js";
import { toMarkDown } from "./historyUtils.js";
import {
  getSessionBlobFolderPath,
  getSessionFilePath,
  getSessionLogFilePath,
  getSessionsListPath,
} from "./paths.js";
import { BLOB_THRESHOLD_CHARS } from "./sessionBlobs.js";
import {
  COMPACT_MIN_BYTES,
  replaySessionLog,
  SessionLogWriter,
} from "./sessionLog.js";

function user(text: string): ChatHistoryItem {
  return { message: { role: "user", content: text }, contextItems: [] };
}

function assistant(text: string): ChatHistoryItem {
  return { message: { role: "assistant", content: text }, contextItems: [] };
}

/** An agent round: the assistant's tool call with its output, and the tool message. */
function toolRound(id: string, outputs: string[]): ChatHistoryItem[] {
  const toolCall = {
    id,
    type: "function" as const,
    function: { name: "read_file", arguments: '{"filepath":"a.ts"}' },
  };
  return [
    {
      message: { role: "assistant", content: "", toolCalls: [toolCall] },
      contextItems: [],
      toolCallStates: [
        {
          toolCallId: id,
          toolCall,
          status: "done",
          parsedArgs: { filepath: "a.ts" },
          output: outputs.map((content, i) => ({
            name: "a.ts",
            description: "file",
            content,
          })),
        },
      ],
    } as ChatHistoryItem,
    {
      message: { role: "tool", content: outputs.join("\n\n"), toolCallId: id },
      contextItems: [],
    },
  ];
}

function big(seed: string, chars = BLOB_THRESHOLD_CHARS + 1000): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `${seed} line ${i}\n`;
  return s;
}

function session(history: ChatHistoryItem[], extra: Partial<Session> = {}) {
  const s: Session = {
    sessionId: uuidv4(),
    title: "A title",
    workspaceDirectory: "/ws",
    history,
    ...extra,
  };
  return s;
}

function logManager(): HistoryManager {
  const m = new HistoryManager();
  m.setSessionLog(true);
  return m;
}

/** What the session looks like once saved and read back as JSON would be. */
function asSaved(s: Session): unknown {
  return JSON.parse(JSON.stringify(s));
}

function blobFiles(id: string): string[] {
  try {
    return fs
      .readdirSync(getSessionBlobFolderPath(id))
      .filter((f) => !f.endsWith(".tmp"));
  } catch {
    return [];
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session log: append", () => {
  it("writes a snapshot first, then appends only what changed", async () => {
    const m = logManager();
    const s = session([user("hi"), assistant("hello")]);
    expect(m.save(s).rev).toEqual(expect.any(String));
    await m.flush(s.sessionId);
    const file = getSessionLogFilePath(s.sessionId);
    const first = fs.readFileSync(file, "utf8");
    expect(first.split("\n")[0]).toContain('"t":"header"');
    expect(fs.existsSync(getSessionFilePath(s.sessionId))).toBe(false);

    const next = { ...s, history: [...s.history, user("more")] };
    m.save(next);
    await m.flush(s.sessionId);
    const second = fs.readFileSync(file, "utf8");
    expect(second.startsWith(first)).toBe(true);
    const appended = second.slice(first.length).trim().split("\n");
    expect(appended).toHaveLength(1);
    expect(JSON.parse(appended[0])).toMatchObject({ t: "item", i: 2 });

    expect(asSaved(new HistoryManager().load(s.sessionId))).toEqual(
      asSaved(next),
    );
  });

  it("records cut history and removed fields", async () => {
    const m = logManager();
    const s = session([user("a"), assistant("b"), user("c")], {
      planFile: "file:///plan.md",
    });
    m.save(s);
    const cut = { ...s, history: s.history.slice(0, 1) };
    delete cut.planFile;
    m.save(cut);
    await m.flush(s.sessionId);
    const back = new HistoryManager().load(s.sessionId);
    expect(back.history).toHaveLength(1);
    expect(back.planFile).toBeUndefined();
  });

  it("coalesces saves made before the write runs", async () => {
    const m = logManager();
    const s = session([user("a")]);
    m.save(s);
    await m.flush(s.sessionId);
    const before = m.sessionLogStats.appends;
    let cur = s;
    for (let i = 0; i < 5; i++) {
      cur = {
        ...cur,
        history: [...cur.history.slice(0, 1), assistant(`v${i}`)],
      };
      m.save(cur);
    }
    await m.flush(s.sessionId);
    expect(m.sessionLogStats.appends - before).toBe(1);
    expect(
      new HistoryManager().load(s.sessionId).history[1].message.content,
    ).toBe("v4");
  });

  it("a load in the same process sees saves still queued", () => {
    const m = logManager();
    const s = session([user("queued")]);
    m.save(s);
    // Nothing has been written yet: the write runs on a later turn
    expect(fs.existsSync(getSessionLogFilePath(s.sessionId))).toBe(false);
    expect(asSaved(m.load(s.sessionId))).toEqual(asSaved(s));
  });
});

describe("session log: compaction", () => {
  it("rewrites the log when it passes the ratio, and reads the same", async () => {
    const m = logManager();
    const s = session([user("q"), assistant("")]);
    m.save(s);
    await m.flush(s.sessionId);
    let cur = s;
    // One item rewritten many times: the log grows, the live size does not
    const text = "x".repeat(8 * 1024);
    for (let i = 0; i < 80; i++) {
      cur = {
        ...cur,
        history: [cur.history[0], assistant(`${i} ${text}`)],
      };
      m.save(cur);
      await m.flush(s.sessionId);
    }
    expect(m.sessionLogStats.compactions).toBeGreaterThan(0);
    const size = fs.statSync(getSessionLogFilePath(s.sessionId)).size;
    expect(size).toBeLessThan(COMPACT_MIN_BYTES + 3 * 9 * 1024);
    expect(asSaved(new HistoryManager().load(s.sessionId))).toEqual(
      asSaved(cur),
    );
  });
});

describe("session log: crash safety", () => {
  it("ignores a cut-off last line, and the next save appends cleanly", async () => {
    const m = logManager();
    const s = session([user("turn 1"), assistant("answer 1")]);
    m.save(s);
    await m.flush(s.sessionId);
    const file = getSessionLogFilePath(s.sessionId);
    fs.appendFileSync(file, '{"t":"item","i":2,"v":{"message":{"ro');

    const reader = logManager();
    const back = reader.load(s.sessionId);
    expect(asSaved(back)).toEqual(asSaved(s));
    // cut off the file, so an append starts on a line of its own
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);

    const next = { ...back, history: [...back.history, user("turn 2")] };
    reader.save(next);
    await reader.flush(s.sessionId);
    expect(asSaved(new HistoryManager().load(s.sessionId))).toEqual(
      asSaved(next),
    );
  });

  it("skips a damaged line in the middle and keeps the rest", () => {
    const text =
      '{"t":"header","format":"continuous-session","v":1,"sessionId":"x"}\n' +
      '{"t":"item","i":0,"v":{"message":{"role":"user","content":"a"},"contextItems":[]}}\n' +
      "garbage\n" +
      '{"t":"item","i":1,"v":{"message":{"role":"assistant","content":"b"},"contextItems":[]}}\n';
    const r = replaySessionLog(text);
    expect("reason" in r).toBe(false);
    if ("reason" in r) return;
    expect(r.badLines).toBe(1);
    expect(r.items).toHaveLength(2);
  });

  it("Resume sees the last completed turn and its saved partial", async () => {
    const m = logManager();
    const partial: ChatHistoryItem = {
      ...assistant("half an ans"),
      interrupted: { reason: "stopped", at: 1 } as any,
    };
    const s = session([user("q1"), assistant("a1"), user("q2"), partial]);
    m.save(s);
    await m.flush(s.sessionId);
    // A crash in the middle of the next write
    fs.appendFileSync(
      getSessionLogFilePath(s.sessionId),
      '{"t":"item","i":4,"v":{"mes',
    );
    const back = new HistoryManager().load(s.sessionId);
    expect(back.history).toHaveLength(4);
    expect(back.history[3].interrupted).toEqual(partial.interrupted);
    expect(back.history[3].message.content).toBe("half an ans");
  });

  it("a header that does not parse is set aside as damaged", () => {
    const id = uuidv4();
    fs.writeFileSync(getSessionLogFilePath(id), "not a log\n");
    const result = new HistoryManager().loadWithStatus(id);
    expect(result.damaged?.keptAt).toMatch(/\.corrupt-\d+\.jsonl$/);
    expect(result.session.history).toEqual([]);
  });
});

describe("session log: migration from .json", () => {
  it("converts a session on its next save and round-trips", async () => {
    const legacy = new HistoryManager(); // log off: writes .json
    const [a, t] = toolRound("call_1", [big("out")]);
    const s = session([user("q"), a, t], {
      mode: "agent",
      chatModelTitle: null,
      usage: { totalCost: 1, promptTokens: 2, completionTokens: 3 } as any,
      queuedMessages: [{ id: "q1", content: "later" } as any],
    });
    legacy.save(s);
    const jsonFile = getSessionFilePath(s.sessionId);
    expect(fs.existsSync(jsonFile)).toBe(true);

    const m = logManager();
    const loaded = m.load(s.sessionId);
    expect(asSaved(loaded)).toEqual(asSaved(s));
    m.save(loaded);
    // The old file stays until the new one reads back the same
    expect(fs.existsSync(jsonFile)).toBe(true);
    await m.flush(s.sessionId);
    expect(fs.existsSync(jsonFile)).toBe(false);
    expect(fs.existsSync(getSessionLogFilePath(s.sessionId))).toBe(true);
    expect(asSaved(new HistoryManager().load(s.sessionId))).toEqual(asSaved(s));
  });

  it("keeps the .json when the new file does not read back the same", async () => {
    vi.spyOn(SessionLogWriter.prototype as any, "readsBackAs").mockReturnValue(
      false,
    );
    const onError = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = session([user("keep me")]);
    new HistoryManager().save(s);
    const m = logManager();
    const edited = { ...m.load(s.sessionId), title: "Edited" };
    m.save(edited);
    // queued behind the migration
    m.save({ ...edited, history: [...edited.history, user("queued")] });
    await m.flush(s.sessionId);
    expect(fs.existsSync(getSessionFilePath(s.sessionId))).toBe(true);
    expect(fs.existsSync(getSessionLogFilePath(s.sessionId))).toBe(false);
    expect(onError).toHaveBeenCalled();
    // The save that tried the migration is in the .json
    const json = () =>
      JSON.parse(fs.readFileSync(getSessionFilePath(s.sessionId), "utf8"));
    expect(json().title).toBe("Edited");
    // later saves in this process go to the .json, whole
    const next = { ...edited, history: [...s.history, assistant("ok")] };
    expect(m.save(next).rev).toBeNull();
    expect(json().history).toHaveLength(2);
    expect(
      m.saveDelta({
        sessionId: s.sessionId,
        baseRev: "any",
        length: 2,
        items: [],
        meta: {},
      }).needFull,
    ).toBe(true);
  });

  it("turning the log off writes .json and removes the log", async () => {
    const m = logManager();
    const s = session([user("q"), ...toolRound("c", [big("o")])]);
    m.save(s);
    await m.flush(s.sessionId);
    const off = new HistoryManager();
    off.save(off.load(s.sessionId));
    expect(fs.existsSync(getSessionLogFilePath(s.sessionId))).toBe(false);
    expect(blobFiles(s.sessionId)).toEqual([]);
    expect(asSaved(off.load(s.sessionId))).toEqual(asSaved(s));
  });
});

describe("session log: deltas", () => {
  it("applies a delta against the revision it was given", async () => {
    const m = logManager();
    const s = session([user("q")]);
    const { rev } = m.save(s);
    const delta = {
      sessionId: s.sessionId,
      baseRev: rev!,
      length: 2,
      items: [{ index: 1, item: assistant("a") }],
      meta: { title: "Renamed", workspaceDirectory: "/ws" },
    };
    const result = m.saveDelta(delta);
    expect(result.needFull).toBeFalsy();
    expect(result.rev).not.toBe(rev);
    await m.flush(s.sessionId);
    const back = new HistoryManager().load(s.sessionId);
    expect(back.title).toBe("Renamed");
    expect(back.history.map((h) => h.message.content)).toEqual(["q", "a"]);
    const listed = new HistoryManager()
      .list({})
      .find((x) => x.sessionId === s.sessionId);
    expect(listed).toMatchObject({ title: "Renamed", messageCount: 1 });
  });

  it("asks for the whole session when it cannot apply a delta", () => {
    const m = logManager();
    const s = session([user("q")]);
    const { rev } = m.save(s);
    const base = {
      sessionId: s.sessionId,
      length: 2,
      items: [{ index: 1, item: assistant("a") }],
      meta: {},
    };
    expect(m.saveDelta({ ...base, baseRev: "stale" }).needFull).toBe(true);
    // a gap: item 2 is new and not sent
    expect(m.saveDelta({ ...base, baseRev: rev!, length: 3 }).needFull).toBe(
      true,
    );
    // another process (or a restart) has no state for it
    expect(logManager().saveDelta({ ...base, baseRev: rev! }).needFull).toBe(
      true,
    );
    // the log off
    expect(new HistoryManager().saveDelta({ ...base, baseRev: rev! })).toEqual({
      rev: null,
      needFull: true,
    });
  });

  it("asks for the whole session when another window wrote the file", async () => {
    const m = logManager();
    const s = session([user("q")]);
    const { rev } = m.save(s);
    await m.flush(s.sessionId);
    fs.appendFileSync(
      getSessionLogFilePath(s.sessionId),
      `${JSON.stringify({ t: "item", i: 1, v: assistant("other window") })}\n`,
    );
    const result = m.saveDelta({
      sessionId: s.sessionId,
      baseRev: rev!,
      length: 2,
      items: [{ index: 1, item: assistant("mine") }],
      meta: {},
    });
    expect(result.needFull).toBe(true);
  });
});

describe("session log: blobs", () => {
  it("stores a tool output once for the call state and the tool message", async () => {
    const m = logManager();
    const output = big("file contents");
    const s = session([user("read it"), ...toolRound("call_9", [output])]);
    m.save(s);
    await m.flush(s.sessionId);
    expect(blobFiles(s.sessionId)).toHaveLength(1);
    const log = fs.readFileSync(getSessionLogFilePath(s.sessionId), "utf8");
    expect(log.length).toBeLessThan(output.length / 4);
    expect(log).toContain('"$join"');
    expect(asSaved(new HistoryManager().load(s.sessionId))).toEqual(asSaved(s));
  });

  it("joins a multi-part output from the same blobs", async () => {
    const m = logManager();
    const parts = [big("one"), "small part", big("two")];
    const s = session([user("q"), ...toolRound("call_m", parts)]);
    m.save(s);
    await m.flush(s.sessionId);
    expect(blobFiles(s.sessionId)).toHaveLength(2);
    const back = new HistoryManager().load(s.sessionId);
    expect(back.history[2].message.content).toBe(parts.join("\n\n"));
  });

  it("stores an image once for the message and the editor document", async () => {
    const m = logManager();
    const dataUrl = `data:image/png;base64,${"A".repeat(40_000)}`;
    const item: ChatHistoryItem = {
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "imageUrl", imageUrl: { url: dataUrl } },
        ],
      },
      contextItems: [],
      editorState: {
        type: "doc",
        content: [{ type: "image", attrs: { src: dataUrl } }],
      },
    };
    const s = session([item, assistant("I see")]);
    m.save(s);
    await m.flush(s.sessionId);
    expect(blobFiles(s.sessionId)).toHaveLength(1);
    expect(asSaved(new HistoryManager().load(s.sessionId))).toEqual(asSaved(s));
  });

  it("the same output in a later turn is not written again", async () => {
    const m = logManager();
    const output = big("same file");
    const s = session([user("q"), ...toolRound("c1", [output])]);
    m.save(s);
    await m.flush(s.sessionId);
    const blobsBefore = m.sessionLogStats.blobsWritten;
    const next = {
      ...s,
      history: [...s.history, ...toolRound("c2", [output])],
    };
    m.save(next);
    await m.flush(s.sessionId);
    expect(m.sessionLogStats.blobsWritten).toBe(blobsBefore);
    expect(blobFiles(s.sessionId)).toHaveLength(1);
  });

  it("keeps an object of the session's own that looks like a reference", async () => {
    const m = logManager();
    const odd = {
      ...user("odd"),
      editorState: { $blob: "not a hash", $join: [1], n: 3 },
    };
    const s = session([odd]);
    m.save(s);
    await m.flush(s.sessionId);
    expect(asSaved(new HistoryManager().load(s.sessionId))).toEqual(asSaved(s));
  });

  it("a missing blob becomes a marker; the rest of the session loads", async () => {
    const m = logManager();
    const s = session([user("q"), ...toolRound("c", [big("gone")])]);
    m.save(s);
    await m.flush(s.sessionId);
    for (const f of blobFiles(s.sessionId)) {
      fs.rmSync(path.join(getSessionBlobFolderPath(s.sessionId), f));
    }
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const back = new HistoryManager().load(s.sessionId);
    expect(back.history).toHaveLength(3);
    expect(back.history[2].message.content).toMatch(/is missing/);
  });

  it("delete removes the log and the blob folder", async () => {
    const m = logManager();
    const s = session([user("q"), ...toolRound("c", [big("x")])]);
    m.save(s);
    await m.flush(s.sessionId);
    m.delete(s.sessionId);
    expect(fs.existsSync(getSessionLogFilePath(s.sessionId))).toBe(false);
    expect(fs.existsSync(getSessionBlobFolderPath(s.sessionId))).toBe(false);
  });
});

describe("session log: readers on a blob-backed session", () => {
  async function blobBacked(): Promise<Session> {
    const m = logManager();
    const s = session(
      [
        user("first"),
        ...toolRound("r1", [big("read one")]),
        assistant("done"),
        { ...user("second"), conversationSummary: "a summary" },
        ...toolRound("r2", [big("read two"), "tail"]),
      ],
      { title: "Blob-backed", forkedFrom: undefined },
    );
    m.save(s);
    await m.flush(s.sessionId);
    expect(blobFiles(s.sessionId).length).toBeGreaterThan(0);
    return s;
  }

  it("session list and titles, without reading blobs", async () => {
    const s = await blobBacked();
    // Rebuild the list from the files, as after a damaged sessions.json
    fs.writeFileSync(getSessionsListPath(), "not json");
    fs.rmSync(getSessionBlobFolderPath(s.sessionId), {
      recursive: true,
      force: true,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new HistoryManager();
    // list() reads sessions.json; a save rebuilds it
    m.save(session([user("other")]));
    const entry = m.list({}).find((x) => x.sessionId === s.sessionId);
    expect(entry).toMatchObject({ title: "Blob-backed", messageCount: 3 });
  });

  it("export (copy as markdown) reads the full outputs", async () => {
    const s = await blobBacked();
    const back = new HistoryManager().load(s.sessionId);
    const when = new Date(0);
    expect(
      toMarkDown(
        back.history.map((h) => h.message),
        when,
      ),
    ).toBe(
      toMarkDown(
        s.history.map((h) => h.message),
        when,
      ),
    );
  });

  it("fork from a blob-backed session, saved and read in the new format", async () => {
    const s = await blobBacked();
    const m = logManager();
    const parent = m.load(s.sessionId);
    const fork = forkSession(parent, { sessionId: uuidv4(), upTo: 2 });
    m.save(fork);
    await m.flush(fork.sessionId);
    expect(fs.existsSync(getSessionLogFilePath(fork.sessionId))).toBe(true);
    const back = new HistoryManager().load(fork.sessionId);
    expect(asSaved(back)).toEqual(asSaved(fork));
    expect(back.history[2].message.content).toBe(s.history[2].message.content);
    // The fork's blob is the parent's, linked or copied: same bytes
    const [h] = blobFiles(fork.sessionId);
    expect(
      fs.readFileSync(path.join(getSessionBlobFolderPath(fork.sessionId), h)),
    ).toEqual(
      fs.readFileSync(path.join(getSessionBlobFolderPath(s.sessionId), h)),
    );
  });

  it("Resume continues a loaded session by appending", async () => {
    const s = await blobBacked();
    const m = logManager();
    const loaded = m.load(s.sessionId);
    const resumed = {
      ...loaded,
      history: [...loaded.history, assistant("resumed")],
    };
    const before = m.sessionLogStats.snapshots;
    m.save(resumed);
    await m.flush(s.sessionId);
    // Appended to the file it read, not rewritten
    expect(m.sessionLogStats.snapshots).toBe(before);
    expect(asSaved(new HistoryManager().load(s.sessionId))).toEqual(
      asSaved(resumed),
    );
  });
});
