/**
 * Message-text search over the most recently written sessions (NI10): the
 * History page searches titles itself, at once, and asks core for this to
 * find a word that only a message holds.
 *
 * Bounded so that it cannot hold up core: at most `maxSessions` sessions
 * (newest written first), files over `maxFileBytes` are left out, the scan
 * stops after `timeBudgetMs`, and it yields to the event loop between
 * sessions. Only user and assistant text is searched, not tool output,
 * context items or prompts. The answer says how far it got, so the page can
 * say "searched the newest 200 sessions". V8 (search over cold history)
 * replaces it later.
 */
import fs from "node:fs";
import path from "node:path";

import type { BaseSessionMetadata, ChatHistoryItem } from "../index.js";

import { getGlobalDirPath } from "./paths.js";
import { stripPromptsFromSessionBytes } from "./promptLogsFile.js";
import { replaySessionLog, sessionFromReplay } from "./sessionLog.js";

export const SEARCH_MAX_SESSIONS = 200;
export const SEARCH_MAX_RESULTS = 50;
export const SEARCH_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const SEARCH_TIME_BUDGET_MS = 3_000;
/** A message text blob larger than this is not read for a search. */
const SEARCH_MAX_BLOB_BYTES = 512 * 1024;
const SNIPPET_CHARS = 140;

export interface SessionSearchOptions {
  query: string;
  /** The global folder; default the real one. */
  root?: string;
  maxSessions?: number;
  maxResults?: number;
  maxFileBytes?: number;
  timeBudgetMs?: number;
  /** Titles by id, from the session list (a hit on the title scores too). */
  titles?: Map<string, string>;
  signal?: AbortSignal;
  /** For tests: the clock. */
  clock?: () => number;
}

export interface SessionSearchHit {
  sessionId: string;
  title: string;
  score: number;
  /** Messages that hold every term. */
  matches: number;
  /** About 140 characters around the best match, whitespace collapsed. */
  snippet: string;
  /** Who wrote the message the snippet is from. */
  role: "user" | "assistant";
}

export interface SessionSearchResult {
  query: string;
  hits: SessionSearchHit[];
  /** Sessions read. */
  scanned: number;
  /** Sessions on disk. */
  total: number;
  /** Left out because their file is larger than `maxFileBytes`. */
  skippedLarge: number;
  /** Why it did not read every session, when it did not. */
  stoppedBy?: "maxSessions" | "time";
}

/** Lower-case words of a query, longest first, without repeats. */
export function searchTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

function countOf(haystack: string, needle: string, cap = 10): number {
  if (!needle) return 0;
  let n = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1 && n < cap;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    n++;
  }
  return n;
}

/** The text of a user or assistant message, or undefined for any other. */
export function messageText(
  item: ChatHistoryItem,
): { role: "user" | "assistant"; text: string } | undefined {
  const message = item?.message;
  if (!message || (message.role !== "user" && message.role !== "assistant")) {
    return undefined;
  }
  const content = message.content as unknown;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) =>
        part && typeof part === "object" && typeof part.text === "string"
          ? part.text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return text ? { role: message.role, text } : undefined;
}

function snippetAround(text: string, at: number, length: number): string {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const half = Math.max(0, Math.floor((SNIPPET_CHARS - length) / 2));
  const start = Math.max(0, at - half);
  const end = Math.min(text.length, at + length + half);
  return `${start > 0 ? "…" : ""}${flat(text.slice(start, end)).trim()}${
    end < text.length ? "…" : ""
  }`;
}

/**
 * Scores one session's messages against the query; undefined when not every
 * term is in the session. A phrase match counts five times a word, a word
 * in a message the person wrote half again as much as one in a reply, and a
 * word in the title three times.
 */
export function scoreSession(
  history: ChatHistoryItem[],
  query: string,
  title = "",
): Omit<SessionSearchHit, "sessionId" | "title"> | undefined {
  const terms = searchTerms(query);
  if (terms.length === 0) return undefined;
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  const seen = new Set<string>();
  const lowerTitle = title.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (lowerTitle.includes(t)) {
      seen.add(t);
      score += 3;
    }
  }
  let matches = 0;
  let best:
    | {
        score: number;
        role: "user" | "assistant";
        text: string;
        at: number;
        len: number;
      }
    | undefined;
  for (const item of history) {
    const m = messageText(item);
    if (!m) continue;
    const lower = m.text.toLowerCase();
    const weight = m.role === "user" ? 1.5 : 1;
    let s = 0;
    let all = true;
    for (const t of terms) {
      const c = countOf(lower, t);
      if (c > 0) seen.add(t);
      else all = false;
      s += c;
    }
    const phraseCount = terms.length > 1 ? countOf(lower, phrase) : 0;
    s += phraseCount * 5;
    if (s === 0) continue;
    if (all) matches++;
    s *= weight;
    score += s;
    if (!best || s > best.score) {
      const atPhrase = phraseCount > 0 ? lower.indexOf(phrase) : -1;
      const term = terms.find((t) => lower.includes(t)) ?? terms[0];
      const at = atPhrase === -1 ? lower.indexOf(term) : atPhrase;
      best = {
        score: s,
        role: m.role,
        text: m.text,
        at,
        len: atPhrase === -1 ? term.length : phrase.length,
      };
    }
  }
  if (!best || terms.some((t) => !seen.has(t))) return undefined;
  return {
    score: Math.round(score * 100) / 100,
    matches,
    snippet: snippetAround(best.text, best.at, best.len),
    role: best.role,
  };
}

/** A blob reader that leaves out large blobs (tool output, mostly). */
function smallBlobReader(dir: string): (hash: string) => string | undefined {
  return (hash) => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const file = path.join(dir, hash);
    try {
      if (fs.statSync(file).size > SEARCH_MAX_BLOB_BYTES) return "";
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
}

async function readHistory(
  file: string,
): Promise<{ history: ChatHistoryItem[]; title: string } | undefined> {
  try {
    if (file.endsWith(".jsonl")) {
      const replay = replaySessionLog(await fs.promises.readFile(file, "utf8"));
      if ("reason" in replay) return undefined;
      const blobs = path.join(
        path.dirname(file),
        path.basename(file, ".jsonl"),
        "blobs",
      );
      const session = sessionFromReplay(replay, smallBlobReader(blobs));
      return { history: session.history ?? [], title: session.title ?? "" };
    }
    const bytes = stripPromptsFromSessionBytes(
      await fs.promises.readFile(file),
    );
    const session = JSON.parse(bytes.toString("utf8"));
    if (!session || !Array.isArray(session.history)) return undefined;
    return { history: session.history, title: session.title ?? "" };
  } catch {
    return undefined;
  }
}

/** Session files in `sessions/`, newest written first (a `.jsonl` wins over its `.json`). */
async function recentSessionFiles(
  root: string,
): Promise<{ id: string; file: string; bytes: number; mtimeMs: number }[]> {
  const dir = path.join(root, "sessions");
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const byId = new Map<
    string,
    { id: string; file: string; bytes: number; mtimeMs: number }
  >();
  for (const name of names) {
    if (
      !(name.endsWith(".json") || name.endsWith(".jsonl")) ||
      name === "sessions.json" ||
      name.includes(".tmp") ||
      name.includes(".corrupt-")
    ) {
      continue;
    }
    const id = name.replace(/\.jsonl?$/, "");
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      continue;
    }
    const known = byId.get(id);
    if (known && known.file.endsWith(".jsonl")) continue;
    byId.set(id, { id, file, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** Searches message text; see the module comment for its bounds. */
export async function searchSessions(
  options: SessionSearchOptions,
): Promise<SessionSearchResult> {
  const query = options.query.trim();
  const maxSessions = options.maxSessions ?? SEARCH_MAX_SESSIONS;
  const maxResults = options.maxResults ?? SEARCH_MAX_RESULTS;
  const maxFileBytes = options.maxFileBytes ?? SEARCH_MAX_FILE_BYTES;
  const budget = options.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS;
  const clock = options.clock ?? Date.now;
  const result: SessionSearchResult = {
    query,
    hits: [],
    scanned: 0,
    total: 0,
    skippedLarge: 0,
  };
  if (searchTerms(query).length === 0) return result;
  const files = await recentSessionFiles(options.root ?? getGlobalDirPath());
  result.total = files.length;
  const started = clock();
  const hits: (SessionSearchHit & { order: number })[] = [];
  for (const [order, f] of files.entries()) {
    options.signal?.throwIfAborted();
    if (result.scanned >= maxSessions) {
      result.stoppedBy = "maxSessions";
      break;
    }
    if (clock() - started > budget) {
      result.stoppedBy = "time";
      break;
    }
    if (f.bytes > maxFileBytes) {
      result.skippedLarge++;
      continue;
    }
    const read = await readHistory(f.file);
    result.scanned++;
    if (read) {
      const title = options.titles?.get(f.id) ?? read.title;
      const scored = scoreSession(read.history, query, title);
      if (scored) hits.push({ sessionId: f.id, title, ...scored, order });
    }
    await yieldToLoop();
  }
  // Best first; between equals the one written more recently
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  result.hits = hits.slice(0, maxResults).map(({ order, ...hit }) => hit);
  return result;
}

/** Titles by id, for `SessionSearchOptions.titles`. */
export function titlesOf(list: BaseSessionMetadata[]): Map<string, string> {
  return new Map(list.map((s) => [s.sessionId, s.title]));
}
