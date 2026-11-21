/**
 * Bounded capture of a command's output (plans/research/runaway-command-output.md).
 *
 * Memory stays constant whatever a command prints: the first `headChars`
 * and the most recent `tailChars` are kept, the rest is only counted (the
 * full output goes to a file, commandOutputStore.ts). From that state come
 * what the model sees (head and tail, with a note), the window the chat view
 * shows, and whether the output looks like a runaway: a flood (too much, too
 * fast) or a loop (the same line or block over and over).
 *
 * Pure: no I/O, no clock. The caller passes the time.
 */

import { stripAnsi } from "./ansi";

/** What to do when a command's output looks like a runaway. */
export enum RunawayAction {
  /** End the command and its children, and tell the model why. */
  Stop = "stop",
  /** Let it run, writing to its file only, until the file cap. */
  KeepRunning = "keep-running",
}

/** Why the output looks like a runaway. */
export enum RunawayReason {
  Flood = "flood",
  Repetition = "repetition",
  /** The full output's file is full: always a stop. */
  FileCap = "file-cap",
}

export interface OutputLimits {
  /** The start of the output, kept whole. */
  headChars: number;
  /** The most recent output, kept. */
  tailChars: number;
  /** What the model sees of a command that succeeded. */
  modelChars: number;
  /** What the model sees of a command that failed: the end matters most. */
  modelFailureChars: number;
  /** A flood: at least this many bytes a second... */
  floodBytesPerSecond: number;
  /** ...for this many seconds in a row... */
  floodSeconds: number;
  /** ...or this many bytes in all. */
  floodTotalBytes: number;
  /** A loop: the same line this many times in a row. */
  repeatedLine: number;
  /** A loop: a block of 2 to this many lines... */
  repeatedBlockMaxLines: number;
  /** ...repeating this many times. */
  repeatedBlockTimes: number;
  /** The full output's file stops here, and the command with it. */
  fileCapBytes: number;
  /** The chat view shows at most this many of the last lines... */
  viewLines: number;
  /** ...and at most this many characters. */
  viewChars: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  headChars: 64 * 1024,
  tailChars: 1024 * 1024,
  modelChars: 30_000,
  modelFailureChars: 10_000,
  floodBytesPerSecond: 1_000_000,
  floodSeconds: 10,
  floodTotalBytes: 100_000_000,
  repeatedLine: 1_000,
  repeatedBlockMaxLines: 20,
  repeatedBlockTimes: 200,
  fileCapBytes: 512 * 1024 * 1024,
  viewLines: 400,
  viewChars: 256 * 1024,
};

/** Only this much of a line is hashed to compare it with others. */
const LINE_KEY_CHARS = 512;

export interface CaptureState {
  /** The first `headChars` characters. */
  head: string;
  /** The most recent characters after the head, at most about `tailChars`. */
  tail: string;
  totalChars: number;
  totalBytes: number;
  /** Line breaks seen. */
  lines: number;
  /** The second (time / 1000) the current rate bucket counts. */
  second: number;
  secondBytes: number;
  /** Completed seconds in a row at or above the flood rate. */
  floodRun: number;
  /** Bytes in the last completed second, for the meter. */
  bytesPerSecond: number;
  /** The start of a line that has not ended yet (at most LINE_KEY_CHARS). */
  partialLine: string;
  /** Keys of the most recent complete lines, newest last. */
  recent: number[];
  /** How many lines in a row equal the one before. */
  sameLineRun: number;
  /** Per block length p (index p), lines matching the line p back. */
  blockRuns: number[];
  /** Set once, the first time the output looks like a runaway. */
  runaway?: RunawayReason;
}

export function newCapture(now: number): CaptureState {
  return {
    head: "",
    tail: "",
    totalChars: 0,
    totalBytes: 0,
    lines: 0,
    second: Math.floor(now / 1000),
    secondBytes: 0,
    floodRun: 0,
    bytesPerSecond: 0,
    partialLine: "",
    recent: [],
    sameLineRun: 0,
    blockRuns: [],
  };
}

/** Characters of the output that are counted but not kept. */
export function omittedChars(state: CaptureState): number {
  return state.totalChars - state.head.length - state.tail.length;
}

/** The whole output, or undefined once some of it is no longer kept. */
export function fullText(state: CaptureState): string | undefined {
  return omittedChars(state) === 0 ? state.head + state.tail : undefined;
}

/** FNV-1a over the first characters of a line, mixed with its length. */
function lineKey(line: string, length: number): number {
  let h = 0x811c9dc5;
  const n = Math.min(line.length, LINE_KEY_CHARS);
  for (let i = 0; i < n; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= length;
  return Math.imul(h, 0x01000193) >>> 0;
}

/** What a line shows once carriage returns are applied: the last non-empty part. */
function afterCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line;
  const parts = line.split("\r");
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== "") return parts[i];
  }
  return "";
}

/** A line with backspaces applied. */
function applyBackspaces(line: string): string {
  if (!line.includes("\b")) return line;
  const out: string[] = [];
  for (const ch of line) {
    if (ch === "\b") out.pop();
    else out.push(ch);
  }
  return out.join("");
}

interface RepetitionState {
  recent: number[];
  sameLineRun: number;
  blockRuns: number[];
  found: boolean;
}

/** Feeds one complete line to the loop detector. */
function seeLine(
  rep: RepetitionState,
  key: number,
  limits: OutputLimits,
): void {
  const { recent, blockRuns } = rep;
  const prev = recent[recent.length - 1];
  rep.sameLineRun = prev === key ? rep.sameLineRun + 1 : 1;
  if (rep.sameLineRun >= limits.repeatedLine) rep.found = true;
  // Blocks of 2 lines or more. A line equal to the one before neither counts
  // nor breaks a block, so one line repeated is left to the check above.
  for (let p = 2; p <= limits.repeatedBlockMaxLines; p++) {
    const back = recent[recent.length - p];
    if (back === undefined || back !== key) {
      blockRuns[p] = 0;
    } else if (prev !== key) {
      blockRuns[p] = (blockRuns[p] ?? 0) + 1;
      if (blockRuns[p] >= p * limits.repeatedBlockTimes) rep.found = true;
    }
  }
  recent.push(key);
  if (recent.length > limits.repeatedBlockMaxLines) recent.shift();
}

/**
 * The state after a chunk of output. `bytes` is the chunk's size before
 * decoding (what a flood and the file cap are measured in).
 */
export function appendChunk(
  state: CaptureState,
  text: string,
  bytes: number,
  now: number,
  limits: OutputLimits = DEFAULT_OUTPUT_LIMITS,
): CaptureState {
  // Head first, then the tail, trimmed in steps so trimming is not per chunk
  let head = state.head;
  let rest = text;
  if (head.length < limits.headChars) {
    const take = Math.min(limits.headChars - head.length, rest.length);
    head += rest.slice(0, take);
    rest = rest.slice(take);
  }
  let tail = state.tail + rest;
  if (tail.length > limits.tailChars * 1.25) {
    tail = tail.slice(-limits.tailChars);
  }

  // Rate, by whole seconds
  const second = Math.floor(now / 1000);
  let { secondBytes, floodRun, bytesPerSecond } = state;
  if (second !== state.second) {
    const consecutive = second - state.second === 1;
    floodRun =
      consecutive && secondBytes >= limits.floodBytesPerSecond
        ? floodRun + 1
        : 0;
    bytesPerSecond = consecutive ? secondBytes : 0;
    secondBytes = bytes;
  } else {
    secondBytes += bytes;
  }
  const totalBytes = state.totalBytes + bytes;

  // Lines, for the count and the loop detector
  const rep: RepetitionState = {
    recent: [...state.recent],
    sameLineRun: state.sameLineRun,
    blockRuns: [...state.blockRuns],
    found: false,
  };
  const parts = text.split("\n");
  let partialLine = state.partialLine;
  let partialLength = state.partialLine.length;
  for (let i = 0; i < parts.length - 1; i++) {
    const line = afterCarriageReturns(
      (partialLine + parts[i]).slice(0, LINE_KEY_CHARS * 2),
    );
    seeLine(rep, lineKey(line, partialLength + parts[i].length), limits);
    partialLine = "";
    partialLength = 0;
  }
  const last = parts[parts.length - 1];
  partialLine = (partialLine + last).slice(0, LINE_KEY_CHARS * 2);
  partialLength += last.length;

  let runaway = state.runaway;
  if (!runaway) {
    if (
      floodRun >= limits.floodSeconds ||
      totalBytes >= limits.floodTotalBytes
    ) {
      runaway = RunawayReason.Flood;
    } else if (rep.found) {
      runaway = RunawayReason.Repetition;
    }
  }

  return {
    head,
    tail,
    totalChars: state.totalChars + text.length,
    totalBytes,
    lines: state.lines + parts.length - 1,
    second,
    secondBytes,
    floodRun,
    bytesPerSecond,
    partialLine,
    recent: rep.recent,
    sameLineRun: rep.sameLineRun,
    blockRuns: rep.blockRuns,
    runaway,
  };
}

/** The state with a runaway reason set, unless one already is. */
export function withRunaway(
  state: CaptureState,
  reason: RunawayReason,
): CaptureState {
  return state.runaway ? state : { ...state, runaway: reason };
}

/**
 * Output as a reader sees it: a progress bar keeps only its last state
 * (carriage returns and backspaces applied), and a line repeated runs of 3 or
 * more is kept once with a count.
 */
export function compressProgress(text: string): string {
  if (!text) return text;
  const lines = text
    .split("\n")
    .map((l) => applyBackspaces(afterCarriageReturns(l)));
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    // The last element is what follows the final newline: keep it as it is
    if (run >= 3 && j < lines.length) {
      out.push(lines[i], `[the line above repeated ${run - 1} more times]`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out.join("\n");
}

/** "1.2 MB", "340 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}

/**
 * The kept output, with a marker where the middle was not kept. Terminal
 * escape sequences are removed from the head and the tail one at a time: the
 * cut can fall inside a sequence, and the half of it that is left must not
 * stay behind as text. `keepAnsi` leaves them in, for the screen.
 */
function keptText(state: CaptureState, keepAnsi: boolean): string {
  const clean = keepAnsi ? (s: string) => s : stripAnsi;
  const omitted = omittedChars(state);
  if (omitted === 0) return clean(state.head + state.tail);
  // Start the tail at a line, so a half line does not look like output
  const nl = state.tail.indexOf("\n");
  const tail = nl >= 0 && nl < 1000 ? state.tail.slice(nl + 1) : state.tail;
  return `${clean(state.head)}\n[... ${omitted.toLocaleString("en-US")} characters not kept ...]\n${clean(tail)}`;
}

export interface ModelTextOptions {
  failed: boolean;
  /**
   * Keep terminal escape sequences (colours). The model's text has them removed;
   * this is for the copy the screen shows, which draws the colours.
   */
  keepAnsi?: boolean;
  /** Where the full output is, when it was written to a file. */
  outputPath?: string;
  /** The command's id for read_command_output. */
  commandId?: string;
  limits?: OutputLimits;
}

/**
 * What the model gets: the whole output when it fits, else the first 20% and
 * the last 80% of the limit with a note saying how much there was and where
 * the rest is. Terminal escape sequences are removed (ansi.ts): they cost
 * tokens and make two identical lines look different.
 */
export function modelText(
  state: CaptureState,
  options: ModelTextOptions,
): string {
  const limits = options.limits ?? DEFAULT_OUTPUT_LIMITS;
  const limit = options.failed ? limits.modelFailureChars : limits.modelChars;
  const text = compressProgress(keptText(state, options.keepAnsi === true));
  if (omittedChars(state) === 0 && text.length <= limit) return text;

  let headPart = text.slice(0, Math.floor(limit * 0.2));
  const headNl = headPart.lastIndexOf("\n");
  if (headNl > headPart.length / 2) headPart = headPart.slice(0, headNl);
  let tailPart = text.slice(-(limit - headPart.length));
  const tailNl = tailPart.indexOf("\n");
  if (tailNl >= 0 && tailNl < tailPart.length / 2) {
    tailPart = tailPart.slice(tailNl + 1);
  }
  const where = options.outputPath
    ? ` The full output is in ${options.outputPath}${
        options.commandId
          ? `; read parts of it with read_command_output (id ${options.commandId})`
          : ""
      }.`
    : "";
  const note = `[Output cut: ${formatBytes(state.totalBytes)}, ${state.lines.toLocaleString("en-US")} lines; showing the first ${headPart.length.toLocaleString("en-US")} and the last ${tailPart.length.toLocaleString("en-US")} characters.${where}]`;
  return `${note}\n${headPart}\n[...]\n${tailPart}`;
}

/**
 * The end of the output, for the chat view. The escape sequences stay: the
 * screen draws the colours. (The model's copy is modelText, which removes them.)
 */
export function viewText(
  state: CaptureState,
  limits: OutputLimits = DEFAULT_OUTPUT_LIMITS,
): string {
  const kept = omittedChars(state) === 0 ? state.head + state.tail : state.tail;
  let text = compressProgress(kept.slice(-limits.viewChars));
  const lines = text.split("\n");
  const cut = lines.length > limits.viewLines || kept.length < state.totalChars;
  if (lines.length > limits.viewLines) {
    text = lines.slice(-limits.viewLines).join("\n");
  }
  return cut ? `[earlier output not shown here]\n${text}` : text;
}

/** The counters the chat view shows beside the output. */
export interface OutputStats {
  bytes: number;
  lines: number;
  bytesPerSecond: number;
  runaway?: RunawayReason;
}

export function outputStats(state: CaptureState): OutputStats {
  return {
    bytes: state.totalBytes,
    lines: state.lines,
    bytesPerSecond: state.bytesPerSecond,
    ...(state.runaway ? { runaway: state.runaway } : {}),
  };
}

/** Why a command was stopped, in the words the model and the person see. */
export function runawayMessage(
  reason: RunawayReason,
  state: CaptureState,
  limits: OutputLimits = DEFAULT_OUTPUT_LIMITS,
): string {
  switch (reason) {
    case RunawayReason.Flood:
      return state.totalBytes >= limits.floodTotalBytes
        ? `the command printed ${formatBytes(state.totalBytes)}, more than the ${formatBytes(limits.floodTotalBytes)} a command may print`
        : `the command printed more than ${formatBytes(limits.floodBytesPerSecond)} a second for ${limits.floodSeconds} seconds (${formatBytes(state.totalBytes)} in all)`;
    case RunawayReason.Repetition:
      return `the command printed the same ${
        state.sameLineRun >= limits.repeatedLine ? "line" : "block of lines"
      } over and over (${state.lines.toLocaleString("en-US")} lines), which looks like a loop`;
    case RunawayReason.FileCap:
      return `the output reached the ${formatBytes(limits.fileCapBytes)} limit of its file`;
  }
}
