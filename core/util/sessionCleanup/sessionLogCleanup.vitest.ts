/**
 * Clean up old sessions (#868) on sessions saved as an append-only log with
 * blobs (#869): a `.jsonl` has no prompts to drop, but may keep blobs no item
 * refers to any more. Only those are moved out; a blob the session refers
 * to, a session open elsewhere and a blob written in the last minutes are
 * left alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatHistoryItem, Session } from "../../index.js";
import { readSessionFile } from "../history";
import { TOOL_OUTPUT_BLOB_CHARS } from "../sessionBlobs";
import { markSessionOpen, resetOwnLease } from "../sessionLeases";
import { replaySessionLog, SessionLogWriter } from "../sessionLog";
import { blobRefs } from "../sessionBlobs";
import {
  applyCleanup,
  describeResult,
  describeScan,
  quickCleanupEstimate,
  scanForCleanup,
} from "./index";
import { scanSessionLogRefs } from "./sessionLogFile";

const HOUR = 3_600_000;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-log-cleanup-"));
  fs.mkdirSync(path.join(root, "sessions"));
  resetOwnLease();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetOwnLease();
});

const sessionsDir = () => path.join(root, "sessions");
const logFile = (id: string) => path.join(sessionsDir(), `${id}.jsonl`);
const blobDir = (id: string) => path.join(sessionsDir(), id, "blobs");

function writer(): SessionLogWriter {
  return new SessionLogWriter({
    logFile,
    jsonFile: (id) => path.join(sessionsDir(), `${id}.json`),
    blobDir,
  });
}

function output(seed: string): string {
  let s = "";
  for (let i = 0; s.length < TOOL_OUTPUT_BLOB_CHARS * 2; i++) {
    s += `${seed} line ${i}\n`;
  }
  return s;
}

function toolRound(id: string, out: string): ChatHistoryItem[] {
  const toolCall = {
    id,
    type: "function" as const,
    function: { name: "read_file", arguments: "{}" },
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
          parsedArgs: {},
          output: [{ name: "a.ts", description: "file", content: out }],
        },
      ],
    } as ChatHistoryItem,
    {
      message: { role: "tool", content: out, toolCallId: id },
      contextItems: [],
    },
  ];
}

function user(text: string): ChatHistoryItem {
  return { message: { role: "user", content: text }, contextItems: [] };
}

function age(file: string, ms: number) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

function ageSession(id: string, ms = 2 * HOUR) {
  age(logFile(id), ms);
  for (const name of fs.readdirSync(blobDir(id))) {
    age(path.join(blobDir(id), name), ms);
  }
}

function blobs(id: string): string[] {
  return fs.readdirSync(blobDir(id)).sort();
}

/**
 * A log session whose second tool output was replaced: the first version's
 * blob is still in the folder, nothing refers to it.
 */
async function sessionWithStaleBlob(id: string): Promise<{
  session: Session;
  stale: string;
  referenced: string[];
}> {
  const w = writer();
  const first: Session = {
    sessionId: id,
    title: "t",
    workspaceDirectory: "/ws",
    history: [user("q"), ...toolRound("c1", output("kept"))],
  };
  w.saveFull(first);
  await w.flush(id);
  const before = new Set(blobs(id));
  const second: Session = {
    ...first,
    history: [
      user("q"),
      ...toolRound("c1", output("kept")),
      ...toolRound("c2", output("old version")),
    ],
  };
  w.saveFull(second);
  await w.flush(id);
  const withOld = blobs(id);
  const stale = withOld.find((b) => !before.has(b))!;
  const final: Session = {
    ...second,
    history: [
      user("q"),
      ...toolRound("c1", output("kept")),
      ...toolRound("c2", output("new version")),
    ],
  };
  w.saveFull(final);
  await w.flush(id);
  ageSession(id);
  const replay = replaySessionLog(fs.readFileSync(logFile(id), "utf8"));
  if ("reason" in replay) throw new Error(replay.reason);
  const referenced = [...blobRefs(replay.items)].sort();
  expect(referenced).not.toContain(stale);
  return { session: final, stale, referenced };
}

function loads(id: string): Session {
  const read = readSessionFile(logFile(id));
  if (!read || !("session" in read)) throw new Error("not readable");
  expect(read.log?.missingBlobs).toBe(0);
  return read.session;
}

describe("clean up a log session's blobs", () => {
  it("reports blobs the session no longer refers to, and changes nothing", async () => {
    const { stale } = await sessionWithStaleBlob("s");
    const listing = blobs("s");
    const bytes = fs.statSync(path.join(blobDir("s"), stale)).size;

    const scan = await scanForCleanup({ root, open: new Map() });
    expect(scan.sessions).toEqual([]);
    expect(scan.blobs).toEqual([
      expect.objectContaining({
        sessionId: "s",
        staleBlobs: 1,
        reclaimableBytes: bytes,
        logFile: logFile("s"),
      }),
    ]);
    expect(scan.totals.blobsBytes).toBe(bytes);
    expect(scan.totals.reclaimableBytes).toBe(bytes);
    expect(describeScan(scan).join("\n")).toContain(
      "Stored outputs: 1 no session refers to any more, in 1 session folder(s)",
    );
    expect(blobs("s")).toEqual(listing);
  });

  it("counts the log and its blobs as the session's size", async () => {
    await sessionWithStaleBlob("s");
    let total = fs.statSync(logFile("s")).size;
    for (const b of blobs("s")) {
      total += fs.statSync(path.join(blobDir("s"), b)).size;
    }
    const scan = await scanForCleanup({ root, open: new Map() });
    expect(scan.largestSession).toEqual({ file: logFile("s"), bytes: total });
  });

  it("moves only the stale blob to the backup folder; the session reads the same", async () => {
    const { session, stale, referenced } = await sessionWithStaleBlob("s");
    const before = loads("s");
    expect(JSON.parse(JSON.stringify(before))).toEqual(
      JSON.parse(JSON.stringify(session)),
    );

    const scan = await scanForCleanup({ root, open: new Map() });
    const result = await applyCleanup(scan, { open: new Map() });
    expect(result.failed).toEqual([]);
    expect(result.blobs.moved).toBe(1);
    expect(blobs("s")).toEqual(referenced);
    expect(
      fs.existsSync(
        path.join(result.backupDir, "sessions", "s", "blobs", stale),
      ),
    ).toBe(true);
    expect(loads("s")).toEqual(before);
    expect(describeResult(result)[0]).toContain("moved 1 stored output(s)");
  });

  it("leaves a session open elsewhere alone", async () => {
    await sessionWithStaleBlob("s");
    markSessionOpen("s", { root }); // this process, which is alive
    const listing = blobs("s");
    const scan = await scanForCleanup({ root });
    expect(scan.blobs).toEqual([]);
    expect(scan.skipped).toEqual([
      expect.objectContaining({ file: logFile("s"), reason: "open elsewhere" }),
    ]);
    await applyCleanup(scan);
    expect(blobs("s")).toEqual(listing);
  });

  it("re-checks at apply time: a session opened after the scan is skipped", async () => {
    await sessionWithStaleBlob("s");
    const listing = blobs("s");
    const scan = await scanForCleanup({ root, open: new Map() });
    expect(scan.blobs).toHaveLength(1);
    markSessionOpen("s", { root });
    const result = await applyCleanup(scan);
    expect(result.blobs.moved).toBe(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: "open elsewhere" }),
    ]);
    expect(blobs("s")).toEqual(listing);
  });

  it("skips a session whose log changed since the scan", async () => {
    await sessionWithStaleBlob("s");
    const listing = blobs("s");
    const scan = await scanForCleanup({ root, open: new Map() });
    fs.appendFileSync(logFile("s"), "\n");
    age(logFile("s"), 2 * HOUR);
    const result = await applyCleanup(scan, { open: new Map() });
    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: "changed during cleanup" }),
    ]);
    expect(blobs("s")).toEqual(listing);
  });

  it("never takes a blob written in the last minutes, even unreferenced", async () => {
    const { stale } = await sessionWithStaleBlob("s");
    // A blob is written before the line that refers to it
    fs.utimesSync(path.join(blobDir("s"), stale), new Date(), new Date());
    const scan = await scanForCleanup({ root, open: new Map() });
    expect(scan.blobs).toEqual([]);
  });

  it("leaves the blobs of a log with a damaged line alone", async () => {
    await sessionWithStaleBlob("s");
    const text = fs.readFileSync(logFile("s"), "utf8").split("\n");
    text.splice(2, 0, "{not json");
    fs.writeFileSync(logFile("s"), text.join("\n"));
    ageSession("s");
    const scan = await scanForCleanup({ root, open: new Map() });
    expect(scan.blobs).toEqual([]);
  });

  it("reports a blob folder whose session is gone, and moves it out", async () => {
    await sessionWithStaleBlob("gone");
    const count = blobs("gone").length;
    fs.rmSync(logFile("gone"));
    const scan = await scanForCleanup({ root, open: new Map() });
    expect(scan.blobs).toEqual([
      expect.objectContaining({ sessionId: "gone", staleBlobs: count }),
    ]);
    expect(scan.blobs[0].logFile).toBeUndefined();
    const result = await applyCleanup(scan, { open: new Map() });
    expect(result.blobs.moved).toBe(count);
    expect(blobs("gone")).toEqual([]);
  });

  it("the size-only estimate is an upper bound with log sessions", async () => {
    await sessionWithStaleBlob("s");
    const scan = await scanForCleanup({ root, open: new Map() });
    const estimate = await quickCleanupEstimate({ root });
    expect(estimate).toBeGreaterThanOrEqual(scan.totals.reclaimableBytes);
    // The log itself is not counted: it holds no prompts
    let blobBytes = 0;
    for (const b of blobs("s")) {
      blobBytes += fs.statSync(path.join(blobDir("s"), b)).size;
    }
    expect(estimate).toBe(blobBytes);
  });
});

describe("scanSessionLogRefs", () => {
  it("reads a log larger than its 1 MiB pieces the way a load does", async () => {
    const w = writer();
    const history: ChatHistoryItem[] = [];
    // Items under the blob threshold stay in the log: about 2 MB of lines
    const inline = "é".repeat(1500);
    for (let i = 0; i < 700; i++) history.push(user(`${i} ${inline}`));
    history.push(...toolRound("c", output("big")));
    w.saveFull({
      sessionId: "long",
      title: "t",
      workspaceDirectory: "",
      history,
    });
    await w.flush("long");
    expect(fs.statSync(logFile("long")).size).toBeGreaterThan(2 * (1 << 20));
    const whole = replaySessionLog(fs.readFileSync(logFile("long"), "utf8"));
    if ("reason" in whole) throw new Error(whole.reason);
    const refs = await scanSessionLogRefs(logFile("long"));
    expect(refs.sessionId).toBe("long");
    expect([...refs.referenced].sort()).toEqual(
      [...blobRefs(whole.items)].sort(),
    );
    expect(refs.referenced.size).toBe(1);
  });

  it("ignores a cut-off last line", async () => {
    await sessionWithStaleBlob("s");
    fs.appendFileSync(logFile("s"), '{"t":"item","i":0,"v":{"$blob":"ab');
    const refs = await scanSessionLogRefs(logFile("s"));
    expect(refs.badLines).toBe(0);
    expect(refs.referenced.has("ab")).toBe(false);
  });
});
