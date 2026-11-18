import { logger } from "./logger.js";

/**
 * A line the person has to see, for conditions that used to reach the log
 * only (a damaged session file, a session that is not being saved).
 *
 * - Shown once per key in a process, so a save that fails on every message
 *   says so one time.
 * - Headless runs and anything before the terminal UI: one line on stderr,
 *   never stdout, so `-p` output stays clean.
 * - With the terminal UI up, the line goes to the chat through the sink the
 *   UI registers; notices raised while the UI is starting are held for it.
 */
type Sink = (text: string) => void;

let sink: Sink | undefined;
let held = false;
const waiting: string[] = [];
const shown = new Set<string>();

export function userNotice(text: string, key: string = text): void {
  if (shown.has(key)) return;
  shown.add(key);
  logger.warn(text);
  if (sink) {
    sink(text);
  } else if (held) {
    waiting.push(text);
  } else {
    process.stderr.write(`${text}\n`);
  }
}

/** The terminal UI is about to draw: keep notices for its sink. */
export function holdUserNotices(): void {
  held = true;
}

/**
 * Where notices go while the terminal UI is up; `undefined` when it is gone,
 * which sends anything still waiting to stderr.
 */
export function setUserNoticeSink(next: Sink | undefined): void {
  sink = next;
  if (!next) held = false;
  for (const text of waiting.splice(0)) {
    if (next) next(text);
    else process.stderr.write(`${text}\n`);
  }
}

/** For tests. */
export function resetUserNotices(): void {
  sink = undefined;
  held = false;
  waiting.length = 0;
  shown.clear();
}
