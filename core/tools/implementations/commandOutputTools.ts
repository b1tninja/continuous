import fs from "node:fs";
import readline from "node:readline";

import { ToolImpl } from ".";
import {
  DEFAULT_OUTPUT_LIMITS,
  formatBytes,
  fullText,
  omittedChars,
} from "../../util/commandOutputBuffer";
import {
  CommandRecord,
  findCommand,
  listCommands,
  waitForEnd,
} from "../../util/commandOutputStore";
import { stripAnsi } from "../../util/ansi";
import { killProcessTree } from "../../util/killProcessTree";
import { getOptionalStringArg } from "../parseArgs";

/** Lines read_command_output returns at most. */
export const MAX_READ_LINES = 1_000;
const DEFAULT_TAIL_LINES = 100;
const MAX_GREP_MATCHES = 200;
/** How far back from the end of a file the tail is looked for. */
const TAIL_READ_BYTES = 2 * 1024 * 1024;

function item(content: string, status: string) {
  return [
    {
      name: "Command output",
      description: "Command output",
      content,
      status,
    },
  ];
}

function stateLine(record: CommandRecord): string {
  const ran = `${record.id}: \`${record.command}\``;
  const size = `${formatBytes(record.capture.totalBytes)}, ${record.capture.lines.toLocaleString("en-US")} lines`;
  if (record.endedAt === undefined) return `${ran} is running (${size}).`;
  const how =
    record.stoppedFor === "stopped"
      ? "was stopped"
      : record.stoppedFor
        ? "was stopped as a runaway"
        : record.exitCode === 0
          ? "finished"
          : `exited with code ${record.exitCode ?? "unknown"}`;
  return `${ran} ${how} (${size}).`;
}

/** The record the model means: by id or tool call, else the newest. */
function recordFor(id: string | undefined): CommandRecord | undefined {
  if (id) return findCommand(id);
  return listCommands().sort((a, b) => b.startedAt - a.startedAt)[0];
}

function notFound(id: string | undefined) {
  const known = listCommands()
    .map((r) => r.id)
    .join(", ");
  return item(
    `No command ${id ? `with id ${id}` : "has run"} in this window.${known ? ` Known: ${known}.` : ""}`,
    "Not found",
  );
}

function clampLines(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_READ_LINES);
}

/** The last `count` lines of a file, read from its end only. */
async function tailOfFile(file: string, count: number): Promise<string[]> {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_READ_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift(); // a partial first line
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-count);
  } finally {
    await handle.close();
  }
}

/** Lines matching `pattern`, with their numbers, read a line at a time. */
async function grepFile(
  file: string,
  pattern: RegExp,
  limit: number,
): Promise<{ matches: string[]; more: boolean }> {
  const matches: string[] = [];
  const reader = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let n = 0;
  let more = false;
  for await (const line of reader) {
    n++;
    if (pattern.test(line)) {
      if (matches.length >= limit) {
        more = true;
        break;
      }
      matches.push(`${n}: ${line.slice(0, 2_000)}`);
    }
  }
  reader.close();
  return { matches, more };
}

/** A line as the model reads it: without terminal escape sequences. */
function plain(line: string): string {
  return stripAnsi(line);
}

/** Keeps a reply within what one tool result may carry. */
function capped(text: string): string {
  const max = DEFAULT_OUTPUT_LIMITS.modelChars;
  return text.length <= max
    ? text
    : `[cut to the last ${max.toLocaleString("en-US")} characters]\n${text.slice(-max)}`;
}

/**
 * The longest a read_command_output call waits for a command to end. It is
 * below the foreground command limit so a wait never outlasts the call it
 * replaces, and short enough that stopping the turn is not held up for long
 * (a tool call carries no abort signal).
 */
export const MAX_WAIT_SECONDS = 60;

export const readCommandOutputImpl: ToolImpl = async (args) => {
  const id = getOptionalStringArg(args, "id");
  const record = recordFor(id);
  if (!record) return notFound(id);
  const grep = getOptionalStringArg(args, "grep");
  // Wait for the end first, so the output read below is the whole of it
  const waited = clampWaitSeconds(args?.waitSeconds);
  let waitNote = "";
  if (waited > 0 && record.endedAt === undefined) {
    const startedWaiting = Date.now();
    const ended = await waitForEnd(record, waited * 1000);
    const took = Math.max(0, Math.round((Date.now() - startedWaiting) / 1000));
    waitNote = ended
      ? `[waited ${took} s: the command ended]\n`
      : `[waited ${waited} s: the command is still running]\n`;
  }
  const status = record.endedAt === undefined ? "Running" : "Finished";

  let pattern: RegExp | undefined;
  if (grep) {
    try {
      pattern = new RegExp(grep, "i");
    } catch (e) {
      return item(
        `"${grep}" is not a valid regular expression: ${(e as Error).message}`,
        "Invalid pattern",
      );
    }
  }

  const file = record.outputPath;
  const fileReadable = file && fs.existsSync(file);
  const kept = fullText(record.capture);
  let lines: string[];
  let note = "";

  if (pattern) {
    const limit = clampLines(args?.lines, MAX_GREP_MATCHES);
    if (fileReadable) {
      const { matches, more } = await grepFile(file, pattern, limit);
      lines = matches.map(plain);
      if (more) note = `\n[more than ${limit} matches; narrow the pattern]`;
    } else {
      const source = kept ?? record.capture.tail;
      lines = source
        .split("\n")
        .map((line, i) => ({ line: plain(line), i }))
        .filter(({ line }) => pattern!.test(line))
        .slice(0, limit)
        .map(({ line, i }) => `${i + 1}: ${line}`);
    }
    if (!lines.length) note = "\n[no line matches]";
  } else {
    const count = clampLines(args?.lines, DEFAULT_TAIL_LINES);
    if (fileReadable) {
      lines = (await tailOfFile(file, count)).map(plain);
    } else {
      const all = (kept ?? record.capture.tail).split("\n");
      // Output that ends in a newline has no empty last line
      if (all[all.length - 1] === "") all.pop();
      lines = all.slice(-count).map(plain);
    }
  }

  const where = file
    ? `Full output: ${file}${record.droppedBytes ? ` (${formatBytes(record.droppedBytes)} could not be written)` : ""}.`
    : omittedChars(record.capture) > 0
      ? "Only the start and the end of this output were kept."
      : "";
  return item(
    capped(
      `${waitNote}${stateLine(record)} ${where}\n${lines.join("\n")}${note}`,
    ),
    status,
  );
};

/** `waitSeconds` as a whole number from 0 to MAX_WAIT_SECONDS; anything else is 0. */
export function clampWaitSeconds(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_WAIT_SECONDS, Math.floor(n));
}

/** How long stop_command waits for the command to end before it answers. */
export const STOP_WAIT_MS = 3_000;

export const stopCommandImpl: ToolImpl = async (args) => {
  const id = getOptionalStringArg(args, "id");
  const record = recordFor(id);
  if (!record) return notFound(id);
  const child = record.process;
  if (record.endedAt !== undefined || !child) {
    return item(stateLine(record), "Not running");
  }
  record.stoppedFor ??= "stopped";
  const ended = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("exit", () => resolve());
  });
  killProcessTree(child, "SIGTERM");
  const timer = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), STOP_WAIT_MS),
  );
  if ((await Promise.race([ended, timer])) === "timeout") {
    killProcessTree(child, "SIGKILL");
  }
  const tail = (fullText(record.capture) ?? record.capture.tail)
    .split("\n")
    .slice(-20)
    .map(plain)
    .join("\n");
  return item(capped(`Stopped. ${stateLine(record)}\n${tail}`), "Stopped");
};
