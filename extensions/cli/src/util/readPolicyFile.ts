/**
 * One reader for the files that hold a person's safety policy: hook settings
 * and permissions.yaml. It tells "absent" from "present but broken" so a
 * loader cannot mistake a damaged file for "no policy" and run with fewer
 * guards than the person wrote.
 *
 * Errors name the file and the position of the problem, never the file's
 * contents: a parser's own message quotes the text around the error, and these
 * files can sit next to secrets.
 */

import * as fs from "fs";

import YAML from "yaml";

import { safeStderr } from "../init.js";

import { logger } from "./logger.js";

export type PolicyFileResult<T> =
  | { status: "absent" }
  | { status: "ok"; value: T }
  | { status: "broken"; path: string; error: string };

export interface BrokenConfigFile {
  path: string;
  error: string;
}

export type PolicyFormat = "json" | "yaml";

function lineAndColumn(text: string, offset: number): string {
  const before = text.slice(0, Math.max(0, offset));
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1) + 1;
  return `line ${line}, column ${column}`;
}

/** The parse error as a position only. Exported for tests. */
export function describeParseError(
  format: PolicyFormat,
  text: string,
  error: unknown,
): string {
  if (format === "yaml") {
    const e = error as {
      code?: string;
      linePos?: { line: number; col: number }[];
    };
    const pos = e.linePos?.[0];
    const where = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
    return `not valid YAML${e.code ? ` (${e.code})` : ""}${where}`;
  }
  const message = error instanceof Error ? error.message : "";
  const at = /position (\d+)/.exec(message);
  if (at) return `not valid JSON at ${lineAndColumn(text, Number(at[1]))}`;
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return `not valid JSON at line ${lc[1]}, column ${lc[2]}`;
  return text.trim() === ""
    ? "not valid JSON (the file is empty)"
    : "not valid JSON (unexpected end of input or unexpected character)";
}

/**
 * Read and parse a policy file.
 *
 * - `absent`: the file does not exist.
 * - `ok`: parsed, and `validate` (if given) returned undefined.
 * - `broken`: unreadable, unparseable, or `validate` returned a reason.
 *
 * `validate` returns a short reason that must not quote the file's contents.
 */
export function readPolicyFile<T>(
  filePath: string,
  format: PolicyFormat,
  validate?: (parsed: unknown) => string | undefined,
): PolicyFileResult<T> {
  if (!fs.existsSync(filePath)) return { status: "absent" };

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: "broken",
      path: filePath,
      error: `could not be read${code ? ` (${code})` : ""}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = format === "yaml" ? YAML.parse(text) : JSON.parse(text);
  } catch (error) {
    return {
      status: "broken",
      path: filePath,
      error: describeParseError(format, text, error),
    };
  }

  const reason = validate?.(parsed);
  if (reason) return { status: "broken", path: filePath, error: reason };
  return { status: "ok", value: parsed as T };
}

/** Message for a headless refusal: names each file and the error, nothing else. */
export function formatBrokenConfigRefusal(files: BrokenConfigFile[]): string {
  const lines = files.map((f) => `  ${f.path}: ${f.error}`);
  return [
    `Cannot start: ${files.length === 1 ? "a policy file is" : "policy files are"} present but unreadable, so its guards would silently not apply.`,
    ...lines,
    "Fix the file, or pass --ignore-broken-config to continue with it ignored.",
  ].join("\n");
}

let ignoreBroken = false;

/** --ignore-broken-config: continue with broken policy files ignored. */
export function setIgnoreBrokenConfigForRun(value: boolean): void {
  ignoreBroken = value;
}

export function ignoreBrokenConfigForRun(): boolean {
  return ignoreBroken;
}

/** Reads after a file name: "is not valid YAML", "could not be read", "has the wrong structure". */
export function asPredicate(reason: string): string {
  return /^(has|could) /.test(reason) ? reason : `is ${reason}`;
}

const noticed = new Set<string>();

/**
 * Tell the person, once per file per process, that a policy file is being
 * ignored. A visible block on stderr, not a log line. `ignored` is true when
 * they asked for it with --ignore-broken-config.
 */
export function noticeBrokenConfig(
  file: BrokenConfigFile,
  ignored = false,
): void {
  const key = `${file.path}\n${file.error}`;
  if (noticed.has(key)) return;
  noticed.add(key);
  logger.warn(`Policy file ${file.path} is broken: ${file.error}`);
  safeStderr(
    `\nWARNING: ${file.path} ${asPredicate(file.error)}.\n` +
      `It is being ignored${ignored ? " (--ignore-broken-config)" : ""}, so the hooks or permission rules in it do NOT apply. Fix the file.\n\n`,
  );
}

/** For tests. */
export function resetBrokenConfigNotices(): void {
  noticed.clear();
}

const warnedOnce = new Set<string>();

/** One warning per key per process, for things that are not a whole file. */
export function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  logger.warn(message);
  safeStderr(`WARNING: ${message}\n`);
}

/** For tests. */
export function resetWarnOnce(): void {
  warnedOnce.clear();
}
