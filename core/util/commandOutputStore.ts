import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  appendChunk,
  CaptureState,
  DEFAULT_OUTPUT_LIMITS,
  fullText,
  newCapture,
  OutputLimits,
  RunawayAction,
  RunawayReason,
  withRunaway,
} from "./commandOutputBuffer";
import { getContinueGlobalPath } from "./paths";

/**
 * The commands the agent started in this window, with their bounded output
 * (commandOutputBuffer.ts) and the file their full output goes to once it is
 * more than the model sees. read_command_output and stop_command find them
 * here; finished ones are kept for a while so their output can still be read.
 */

/** Files older than this are deleted when the folder is first used. */
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Finished commands kept for read_command_output. */
const MAX_FINISHED = 50;
/** Writes queued past this are dropped (and counted), so a slow disk cannot fill memory. */
const MAX_QUEUED_WRITE_BYTES = 16 * 1024 * 1024;

export interface CommandRecord {
  /** Short id the model passes to read_command_output and stop_command. */
  id: string;
  toolCallId: string;
  command: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  process?: ChildProcess;
  capture: CaptureState;
  limits: OutputLimits;
  runawayAction: RunawayAction;
  /** Why it was stopped by us, when it was. */
  stoppedFor?: RunawayReason | "stopped";
  outputPath?: string;
  fileBytes: number;
  droppedBytes: number;
  /** Running on after its call returned (waitForCompletion false, moved). */
  background: boolean;
}

const records = new Map<string, CommandRecord>();
const streams = new Map<string, fs.WriteStream>();
let folderReady: string | undefined;
let nextId = 1;

/** Where full outputs go; overridable for tests. */
let outputFolder = (): string =>
  path.join(getContinueGlobalPath(), "command-output");

export function setCommandOutputFolderForTests(folder: string): void {
  outputFolder = () => folder;
  folderReady = undefined;
}

function prepareFolder(): string {
  const folder = outputFolder();
  if (folderReady === folder) return folder;
  fs.mkdirSync(folder, { recursive: true });
  const cutoff = Date.now() - FILE_MAX_AGE_MS;
  for (const name of fs.readdirSync(folder)) {
    const file = path.join(folder, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // Gone already, or in use; the next start tries again
    }
  }
  folderReady = folder;
  return folder;
}

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "command";
}

export function registerCommand(input: {
  toolCallId: string;
  command: string;
  process?: ChildProcess;
  runawayAction?: RunawayAction;
  background?: boolean;
  limits?: OutputLimits;
  now?: number;
}): CommandRecord {
  const now = input.now ?? Date.now();
  const record: CommandRecord = {
    id: `cmd-${nextId++}`,
    toolCallId: input.toolCallId,
    command: input.command,
    startedAt: now,
    process: input.process,
    capture: newCapture(now),
    limits: input.limits ?? DEFAULT_OUTPUT_LIMITS,
    runawayAction: input.runawayAction ?? RunawayAction.Stop,
    fileBytes: 0,
    droppedBytes: 0,
    background: input.background ?? false,
  };
  records.set(record.id, record);
  pruneFinished();
  return record;
}

function pruneFinished(): void {
  const finished = [...records.values()].filter((r) => r.endedAt !== undefined);
  for (const r of finished.slice(
    0,
    Math.max(0, finished.length - MAX_FINISHED),
  )) {
    records.delete(r.id);
  }
}

/** By its id (cmd-3) or the tool call that started it. */
export function findCommand(idOrToolCallId: string): CommandRecord | undefined {
  return (
    records.get(idOrToolCallId) ??
    [...records.values()].find((r) => r.toolCallId === idOrToolCallId)
  );
}

export function listCommands(): CommandRecord[] {
  return [...records.values()];
}

function writeToFile(record: CommandRecord, text: string): void {
  let stream = streams.get(record.id);
  if (!stream) {
    try {
      const folder = prepareFolder();
      record.outputPath = path.join(
        folder,
        `${new Date(record.startedAt).toISOString().replace(/[:.]/g, "-")}-${safeName(record.toolCallId || record.id)}.log`,
      );
      stream = fs.createWriteStream(record.outputPath, { flags: "a" });
      stream.on("error", () => {
        // A disk error ends the file, not the command
        streams.delete(record.id);
      });
      streams.set(record.id, stream);
    } catch {
      return;
    }
  }
  const bytes = Buffer.byteLength(text);
  if (record.fileBytes + bytes > record.limits.fileCapBytes) {
    record.capture = withRunaway(record.capture, RunawayReason.FileCap);
    closeFile(record);
    return;
  }
  if (stream.writableLength > MAX_QUEUED_WRITE_BYTES) {
    record.droppedBytes += bytes;
    return;
  }
  stream.write(text);
  record.fileBytes += bytes;
}

function closeFile(record: CommandRecord): void {
  streams.get(record.id)?.end();
  streams.delete(record.id);
}

/**
 * Adds a chunk of output. Once the output is more than the model sees, it
 * also goes to the command's file: everything so far, then each chunk.
 */
export function recordOutput(
  record: CommandRecord,
  text: string,
  bytes: number,
  now: number = Date.now(),
): CommandRecord {
  const before = record.capture;
  record.capture = appendChunk(before, text, bytes, now, record.limits);
  if (streams.has(record.id)) {
    writeToFile(record, text);
  } else if (
    !record.outputPath &&
    record.capture.totalChars > record.limits.modelFailureChars
  ) {
    // Everything so far: still whole, since the tail keeps far more than this
    writeToFile(record, fullText(before) ?? "");
    writeToFile(record, text);
  }
  return record;
}

export function finishCommand(
  record: CommandRecord,
  exitCode: number | null,
  now: number = Date.now(),
): void {
  record.endedAt ??= now;
  record.exitCode = exitCode;
  record.process = undefined;
  closeFile(record);
  pruneFinished();
}

export function clearCommandsForTests(): void {
  for (const r of records.values()) closeFile(r);
  records.clear();
  nextId = 1;
}
