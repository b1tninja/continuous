/**
 * The opt-in debug prompt log (ROADMAP STOR4): the full prompt of each model
 * request, for someone debugging what a model was sent. Off by default; on
 * with the `continuous.debugPromptLog` setting in VS Code, or
 * `--debug-prompt-log` / `CONTINUOUS_DEBUG_PROMPT_LOG=1` for the terminal
 * agent.
 *
 * Written to `<global folder>/logs/prompts/prompts-<start>.jsonl`, one JSON
 * line per request, owner-only, with secrets the scanner recognises masked
 * (`scrubDeep`). Bounded twice: the files together stay under
 * `DEBUG_PROMPT_LOG_CAP_BYTES` (the oldest file goes first), and a file not
 * written to for `DEBUG_PROMPT_LOG_MAX_AGE_DAYS` is deleted. One request
 * larger than a file's share is cut, and says so.
 */
import fs from "node:fs";
import path from "node:path";

import { getGlobalDirPath } from "./paths.js";
import { appendPrivate } from "./privateFiles.js";
import { scrubDeep } from "./secretScan/scrubForDisk.js";

export const DEBUG_PROMPT_LOG_ENV = "CONTINUOUS_DEBUG_PROMPT_LOG";
export const DEBUG_PROMPT_LOG_CAP_BYTES = 50 * 1024 * 1024;
export const DEBUG_PROMPT_LOG_MAX_AGE_DAYS = 14;
/** The cap is split over this many files, so dropping the oldest frees a fifth. */
const SEGMENTS = 5;
const DAY_MS = 86_400_000;
const FILE_RE = /^prompts-(\d+)\.jsonl$/;

/** On when the setting is on, or the environment variable is 1/true/yes/on. */
export function debugPromptLogEnabled(
  setting?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (setting) return true;
  const v = env[DEBUG_PROMPT_LOG_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function debugPromptLogDir(root: string = getGlobalDirPath()): string {
  return path.join(root, "logs", "prompts");
}

export interface DebugPromptEntry {
  sessionId?: string;
  model?: string;
  provider?: string;
  prompt: string;
  completion?: string;
}

export interface DebugPromptLogOptions {
  dir?: string;
  capBytes?: number;
  maxAgeMs?: number;
  now?: number;
}

function segments(dir: string): { file: string; start: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const m = FILE_RE.exec(name);
      return m ? [{ file: path.join(dir, name), start: Number(m[1]) }] : [];
    })
    .sort((a, b) => a.start - b.start);
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Cut the prompt so that the line fits in `limit` bytes, and say how much was cut. */
function fitLine(entry: Record<string, unknown>, limit: number): string {
  let line = `${JSON.stringify(entry)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes <= limit) return line;
  const prompt = String(entry.prompt ?? "");
  const over = bytes - limit + 128;
  const keep = Math.max(0, prompt.length - over);
  line = `${JSON.stringify({
    ...entry,
    prompt: prompt.slice(0, keep),
    truncated: `the prompt was cut to fit the log: ${bytes} bytes before`,
  })}\n`;
  return line;
}

/**
 * Appends one request. Never throws: a log that cannot be written is not a
 * reason to fail the request. Returns the file written, or undefined.
 */
export function appendDebugPrompt(
  entry: DebugPromptEntry,
  options: DebugPromptLogOptions = {},
): string | undefined {
  try {
    const dir = options.dir ?? debugPromptLogDir();
    const cap = options.capBytes ?? DEBUG_PROMPT_LOG_CAP_BYTES;
    const maxAge = options.maxAgeMs ?? DEBUG_PROMPT_LOG_MAX_AGE_DAYS * DAY_MS;
    const now = options.now ?? Date.now();
    const segmentBytes = Math.max(1024, Math.floor(cap / SEGMENTS));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const line = fitLine(
      scrubDeep({ timestamp: new Date(now).toISOString(), ...entry }),
      segmentBytes,
    );
    const lineBytes = Buffer.byteLength(line);

    let files = segments(dir);
    let current = files[files.length - 1];
    if (!current || sizeOf(current.file) + lineBytes > segmentBytes) {
      let start = now;
      while (files.some((f) => f.start === start)) start++;
      current = { file: path.join(dir, `prompts-${start}.jsonl`), start };
      files = [...files, current];
    }
    appendPrivate(current.file, line);

    // Age: a file not written to for maxAge goes. Size: oldest first.
    let total = files.reduce((n, f) => n + sizeOf(f.file), 0);
    for (const f of files) {
      if (f === current) break;
      let mtime = now;
      try {
        mtime = fs.statSync(f.file).mtimeMs;
      } catch {
        continue;
      }
      if (total > cap || now - mtime > maxAge) {
        const size = sizeOf(f.file);
        fs.rmSync(f.file, { force: true });
        total -= size;
      }
    }
    return current.file;
  } catch {
    return undefined;
  }
}
