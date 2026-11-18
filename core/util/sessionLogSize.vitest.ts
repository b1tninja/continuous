/**
 * The session size guard (STOR8, #867) on sessions saved as an append-only
 * log (STOR6/STOR7, #869): the size a save reports, the one in the session
 * list and the budget warning count the `.jsonl` log plus the blobs it
 * refers to, not a `.json` file that no longer exists.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatHistoryItem, Session } from "../index.js";

import { HistoryManager } from "./history.js";
import {
  getSessionBlobFolderPath,
  getSessionLogFilePath,
  getSessionsListPath,
} from "./paths.js";
import { TOOL_OUTPUT_BLOB_CHARS } from "./sessionBlobs.js";

function user(text: string): ChatHistoryItem {
  return { message: { role: "user", content: text }, contextItems: [] };
}

function toolRound(id: string, output: string): ChatHistoryItem[] {
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
          output: [{ name: "a.ts", description: "file", content: output }],
        },
      ],
    } as ChatHistoryItem,
    {
      message: { role: "tool", content: output, toolCallId: id },
      contextItems: [],
    },
  ];
}

function output(seed: string, chars = TOOL_OUTPUT_BLOB_CHARS * 4): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `${seed} line ${i}\n`;
  return s;
}

function session(history: ChatHistoryItem[]): Session {
  return {
    sessionId: uuidv4(),
    title: "A title",
    workspaceDirectory: "/ws",
    history,
  };
}

/** What the session takes on disk: its log plus every file in its blob folder. */
function onDisk(id: string): { log: number; blobs: number } {
  const log = fs.statSync(getSessionLogFilePath(id)).size;
  let blobs = 0;
  const dir = getSessionBlobFolderPath(id);
  for (const name of fs.readdirSync(dir)) {
    blobs += fs.statSync(path.join(dir, name)).size;
  }
  return { log, blobs };
}

function listed(id: string) {
  const list = JSON.parse(fs.readFileSync(getSessionsListPath(), "utf8"));
  return list.find((x: { sessionId: string }) => x.sessionId === id);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session size on a log session", () => {
  it("a whole-session save reports the log plus its blobs", async () => {
    const m = new HistoryManager();
    m.setSessionLog(true);
    const s = session([user("q"), ...toolRound("c1", output("one"))]);
    const { fileBytes } = m.save(s);
    await m.flush(s.sessionId);
    const disk = onDisk(s.sessionId);
    expect(disk.blobs).toBeGreaterThan(0);
    expect(fileBytes).toBe(disk.log + disk.blobs);
    expect(listed(s.sessionId)).toMatchObject({
      fileBytes: disk.log + disk.blobs,
      storage: "log",
    });
  });

  it("a delta save (the webview's mid-turn path) reports the new size", async () => {
    const m = new HistoryManager();
    m.setSessionLog(true);
    const s = session([user("q")]);
    const { rev } = m.save(s);
    const round = toolRound("c2", output("two"));
    const result = m.saveDelta({
      sessionId: s.sessionId,
      baseRev: rev!,
      length: 3,
      items: round.map((item, i) => ({ index: i + 1, item })),
      meta: { title: s.title, workspaceDirectory: s.workspaceDirectory },
    });
    expect(result.needFull).toBeFalsy();
    await m.flush(s.sessionId);
    const disk = onDisk(s.sessionId);
    expect(result.fileBytes).toBe(disk.log + disk.blobs);
    // The size grew by far more than a tenth: the list shows the new one
    expect(listed(s.sessionId).fileBytes).toBe(disk.log + disk.blobs);
  });

  it("counts a blob once, however many items refer to it", async () => {
    const m = new HistoryManager();
    m.setSessionLog(true);
    const same = output("same");
    const s = session([
      user("q"),
      ...toolRound("c3", same),
      ...toolRound("c4", same),
    ]);
    const { fileBytes } = m.save(s);
    await m.flush(s.sessionId);
    const disk = onDisk(s.sessionId);
    expect(fs.readdirSync(getSessionBlobFolderPath(s.sessionId))).toHaveLength(
      1,
    );
    expect(fileBytes).toBe(disk.log + disk.blobs);
  });

  it("a session opened from disk counts the blobs already stored", async () => {
    const first = new HistoryManager();
    first.setSessionLog(true);
    const s = session([user("q"), ...toolRound("c5", output("five"))]);
    first.save(s);
    await first.flush(s.sessionId);

    const second = new HistoryManager();
    second.setSessionLog(true);
    const loaded = second.load(s.sessionId);
    const { fileBytes } = second.save({
      ...loaded,
      history: [...loaded.history, user("again")],
    });
    await second.flush(s.sessionId);
    const disk = onDisk(s.sessionId);
    expect(fileBytes).toBe(disk.log + disk.blobs);
  });

  it("warns once past the budget, naming the log and stored outputs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new HistoryManager(1024);
    m.setSessionLog(true);
    const s = session([user("q"), ...toolRound("c6", output("six"))]);
    m.save(s);
    m.save({ ...s, history: [...s.history, user("more")] });
    await m.flush(s.sessionId);
    const lines = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("session budget"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("its log and stored outputs");
    expect(lines[0]).not.toContain("rewrites it whole");
  });

  it("fills in a listed log session's size from the log and its blob folder", async () => {
    const m = new HistoryManager();
    m.setSessionLog(true);
    const s = session([user("q"), ...toolRound("c7", output("seven"))]);
    m.save(s);
    await m.flush(s.sessionId);
    const disk = onDisk(s.sessionId);
    const [filled] = m.withFileSizes([
      {
        sessionId: s.sessionId,
        title: s.title,
        dateCreated: "0",
        workspaceDirectory: s.workspaceDirectory,
      },
    ]);
    expect(filled).toMatchObject({
      fileBytes: disk.log + disk.blobs,
      storage: "log",
    });
  });

  it("a session saved as .json is listed as json, with its file's size", () => {
    const m = new HistoryManager();
    const s = session([user("q")]);
    const { fileBytes } = m.save(s);
    expect(listed(s.sessionId)).toMatchObject({ fileBytes, storage: "json" });
  });
});
