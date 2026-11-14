/**
 * Write cost per response on a synthetic agent session (STOR6/STOR7): the
 * whole-file JSON save against the session log, the log fed whole sessions
 * (the CLI's and core's own saves) and fed deltas (the webview's saves).
 *
 * In CI it runs 100 requests and checks the cost per save stays flat. With
 * STOR_MEASURE=1 it runs 500 and prints the table quoted in the PR (to the
 * file named by STOR_MEASURE_OUT, if set).
 */
import * as fs from "node:fs";

import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";

import type { ChatHistoryItem, Session, SessionDelta } from "../index.js";

import { forkSession } from "./forkSession.js";
import { findLastIndex } from "./findLast.js";
import { HistoryManager } from "./history.js";
import {
  getSessionBlobFolderPath,
  getSessionFilePath,
  getSessionLogFilePath,
} from "./paths.js";

const FULL = process.env.STOR_MEASURE === "1";
const REQUESTS = FULL ? 500 : 100;

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function text(seed: number, chars: number): string {
  const r = rng(seed);
  const words = [
    "const",
    "return",
    "if",
    "value",
    "items",
    "map",
    "=>",
    "{",
    "}",
  ];
  let s = "";
  while (s.length < chars) {
    s += words[Math.floor(r() * words.length)];
    s += r() < 0.1 ? "\n" : " ";
  }
  return s.slice(0, chars);
}

function call(id: string) {
  return {
    id,
    type: "function" as const,
    function: { name: "read_file", arguments: `{"filepath":"src/${id}.ts"}` },
  };
}

/**
 * One request of an agent turn, as the GUI's store holds it after the save
 * that follows the stream: the previous call's state now has its output,
 * its tool message is added, and the new answer (another call) is added.
 */
class SyntheticAgentSession {
  history: ChatHistoryItem[] = [];
  private r = rng(42);
  private outputs: string[] = [];
  private pending?: { index: number; id: string };

  request(k: number): void {
    if (k === 1 || k % 25 === 0) {
      this.history.push({
        message: { role: "user", content: `Request ${k}: carry on.` },
        contextItems: [],
        editorState: { type: "doc", content: [{ type: "paragraph" }] },
      });
    }
    if (k === 100 || k === 250 || k === 400) this.addImage(k);
    if (k === 200 || k === 400) this.compact(k);
    if (k === 300) this.interrupt(k);

    if (this.pending) {
      const output = this.outputFor(k);
      const { index, id } = this.pending;
      const prev = this.history[index];
      this.history[index] = {
        ...prev,
        toolCallStates: prev.toolCallStates!.map((s) => ({
          ...s,
          status: "done" as const,
          output: [{ name: id, description: "file", content: output }],
        })),
      };
      this.history.push({
        message: { role: "tool", content: output, toolCallId: id },
        contextItems: [],
      });
    }
    const id = `call_${k}`;
    this.history.push({
      message: {
        role: "assistant",
        content: text(k, 200 + Math.floor(this.r() * 600)),
        toolCalls: [call(id)],
      },
      contextItems: [],
      toolCallStates: [
        {
          toolCallId: id,
          toolCall: call(id),
          status: "generated",
          parsedArgs: { filepath: `src/${id}.ts` },
        },
      ],
    });
    this.pending = { index: this.history.length - 1, id };
  }

  /** 2-20 KB; every 10th re-reads an earlier file; every 50th is 80 KB. */
  private outputFor(k: number): string {
    let out: string;
    if (k % 10 === 0 && this.outputs.length) {
      out = this.outputs[Math.floor(this.r() * this.outputs.length)];
    } else if (k % 50 === 0) {
      out = text(10_000 + k, 80_000);
    } else {
      out = text(10_000 + k, 2_000 + Math.floor(this.r() * 18_000));
    }
    this.outputs.push(out);
    return out;
  }

  private addImage(k: number): void {
    const url = `data:image/png;base64,${text(20_000 + k, 150_000).replace(/[^A-Za-z]/g, "A")}`;
    this.history.push({
      message: {
        role: "user",
        content: [
          { type: "text", text: "Here is a screenshot" },
          { type: "imageUrl", imageUrl: { url } },
        ],
      },
      contextItems: [],
      editorState: {
        type: "doc",
        content: [{ type: "image", attrs: { src: url } }],
      },
    });
  }

  private compact(k: number): void {
    const i = findLastIndex(this.history, (h) => h.message.role === "user");
    this.history[i] = {
      ...this.history[i],
      conversationSummary: text(30_000 + k, 4_000),
    };
  }

  private interrupt(k: number): void {
    this.history.push({
      message: { role: "assistant", content: text(40_000 + k, 300) },
      contextItems: [],
      interrupted: "stopped",
    });
  }

  session(id: string): Session {
    return {
      sessionId: id,
      title: "Synthetic agent session",
      workspaceDirectory: "/ws",
      history: [...this.history],
      mode: "agent",
    };
  }
}

interface Row {
  bytes: number;
  ms: number;
  posted: number;
}

function summarize(rows: Row[]) {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const tail = rows.slice(-50);
  return {
    totalBytes: sum(rows.map((r) => r.bytes)),
    lastBytes: rows.at(-1)!.bytes,
    meanBytesLast50: sum(tail.map((r) => r.bytes)) / tail.length,
    totalMs: sum(rows.map((r) => r.ms)),
    meanMsLast50: sum(tail.map((r) => r.ms)) / tail.length,
    maxMs: Math.max(...rows.map((r) => r.ms)),
    meanPostedLast50: sum(tail.map((r) => r.posted)) / tail.length,
  };
}

function deltaFrom(
  prev: ChatHistoryItem[],
  next: Session,
  rev: string,
): SessionDelta {
  return {
    sessionId: next.sessionId,
    baseRev: rev,
    length: next.history.length,
    items: next.history
      .map((item, index) => ({ index, item }))
      .filter(({ item, index }) => prev[index] !== item),
    meta: {
      title: next.title,
      workspaceDirectory: next.workspaceDirectory,
    },
  };
}

async function run(mode: "json" | "log-full" | "log-delta") {
  const m = new HistoryManager();
  m.setSessionLog(mode !== "json");
  const id = uuidv4();
  const gen = new SyntheticAgentSession();
  const rows: Row[] = [];
  let rev: string | null = null;
  let prev: ChatHistoryItem[] = [];
  let flushMs = 0;
  for (let k = 1; k <= REQUESTS; k++) {
    gen.request(k);
    const s = gen.session(id);
    const before =
      m.sessionLogStats.bytesWritten + m.sessionLogStats.blobBytesWritten;
    let posted: number;
    const t0 = performance.now();
    if (mode === "log-delta" && rev) {
      const delta = deltaFrom(prev, s, rev);
      posted = JSON.stringify(delta).length;
      rev = m.saveDelta(delta).rev;
    } else {
      posted = JSON.stringify(s).length;
      rev = m.save(s).rev;
    }
    const ms = performance.now() - t0;
    const t1 = performance.now();
    await m.flush(id);
    flushMs += performance.now() - t1;
    const bytes =
      mode === "json"
        ? fs.statSync(getSessionFilePath(id)).size
        : m.sessionLogStats.bytesWritten +
          m.sessionLogStats.blobBytesWritten -
          before;
    rows.push({ bytes, ms, posted });
    prev = s.history;
    if (k === 350) {
      // One fork, saved as its own session (not counted)
      const fork = forkSession(m.load(id), { sessionId: uuidv4(), upTo: 100 });
      m.save(fork);
      await m.flush(fork.sessionId);
    }
  }
  const file =
    mode === "json" ? getSessionFilePath(id) : getSessionLogFilePath(id);
  let blobBytes = 0;
  let blobs = 0;
  try {
    for (const f of fs.readdirSync(getSessionBlobFolderPath(id))) {
      blobs++;
      blobBytes += fs.statSync(`${getSessionBlobFolderPath(id)}/${f}`).size;
    }
  } catch {
    // no blobs (json)
  }
  const loaded = new HistoryManager().load(id);
  return {
    mode,
    ...summarize(rows),
    flushMs,
    fileBytes: fs.statSync(file).size,
    blobs,
    blobBytes,
    stats: { ...m.sessionLogStats },
    roundTrips:
      JSON.stringify(loaded.history) ===
      JSON.stringify(JSON.parse(JSON.stringify(gen.history))),
    rows,
  };
}

describe(`write cost per response, ${REQUESTS}-request agent session`, () => {
  it("the session log writes a bounded amount per save; JSON rewrites it all", async () => {
    const json = await run("json");
    const full = await run("log-full");
    const delta = await run("log-delta");
    for (const r of [json, full, delta]) expect(r.roundTrips).toBe(true);

    // JSON: each save writes the whole session, so it grows with the session
    expect(json.rows.at(-1)!.bytes).toBeGreaterThan(
      4 * json.rows[REQUESTS / 10].bytes,
    );
    // Log: the late saves cost about what the early ones did
    for (const r of [full, delta]) {
      const early = r.rows.slice(5, 25).reduce((a, x) => a + x.bytes, 0);
      const late = r.rows.slice(-20).reduce((a, x) => a + x.bytes, 0);
      expect(late).toBeLessThan(3 * early);
      expect(r.totalBytes).toBeLessThan(json.totalBytes / 5);
    }
    // Deltas post a bounded amount; the whole session grows
    expect(delta.meanPostedLast50).toBeLessThan(full.meanPostedLast50 / 10);

    if (FULL) {
      const fmt = (r: typeof json) => ({
        mode: r.mode,
        "bytes written, all saves": r.totalBytes,
        "bytes written, last save": r.lastBytes,
        "bytes/save, last 50": Math.round(r.meanBytesLast50),
        "ms on caller/save, last 50": +r.meanMsLast50.toFixed(2),
        "ms on caller, max save": +r.maxMs.toFixed(1),
        "ms on caller, all saves": Math.round(r.totalMs),
        "ms async write, all saves": Math.round(r.flushMs),
        "chars posted/save, last 50": Math.round(r.meanPostedLast50),
        "session file bytes": r.fileBytes,
        "blob files": r.blobs,
        "blob bytes": r.blobBytes,
        compactions: r.stats.compactions,
      });
      const table = JSON.stringify(
        [fmt(json), fmt(full), fmt(delta)],
        undefined,
        2,
      );
      // This suite's console is quiet: STOR_MEASURE_OUT names a file outside the repo
      if (process.env.STOR_MEASURE_OUT) {
        fs.writeFileSync(process.env.STOR_MEASURE_OUT, table);
      } else {
        console.log(table);
      }
    }
  }, 600_000);
});
