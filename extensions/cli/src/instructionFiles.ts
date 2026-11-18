import * as fs from "fs";
import * as path from "path";

import {
  guardInstructionFile,
  type InstructionFileNotice,
} from "core/config/markdown/instructionFiles.js";

import { env } from "./env.js";

/**
 * The instruction files the system message is built from: the first agent
 * file found in the working directory and every markdown rule under the
 * rules directories. Listed here so the system message can be cached per
 * session and rebuilt only when one of them changes.
 */
export const AGENT_FILES = ["AGENTS.md", "AGENT.md", "CLAUDE.md", "CODEX.md"];

export function rulesDirs(cwd: string = process.cwd()): string[] {
  return [
    path.join(cwd, ".continuous", "rules"),
    path.join(cwd, ".continue", "rules"),
    path.join(env.continueHome, "rules"),
  ];
}

function stamp(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    return `${filePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

/**
 * One string that changes when an instruction file is added, removed, edited
 * or replaced: path, mtime and size of each agent file and rule file. A few
 * stat calls per request; no file is read.
 */
export function instructionFilesFingerprint(
  cwd: string = process.cwd(),
): string {
  const stamps: string[] = [];
  for (const fileName of AGENT_FILES) {
    const s = stamp(path.join(cwd, fileName));
    if (s) stamps.push(s);
  }
  for (const dir of rulesDirs(cwd)) {
    let files: string[];
    try {
      files = fs.readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const file of files) {
      if (!String(file).endsWith(".md")) continue;
      const s = stamp(path.join(dir, String(file)));
      if (s) stamps.push(s);
    }
  }
  return stamps.sort().join("\n");
}

const warned = new Set<string>();

/** Print each notice once per process: the message is rebuilt on every file change. */
export function warnOnce(notice: InstructionFileNotice): void {
  const key = JSON.stringify([notice.file, notice.message]);
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`Warning: ${notice.message}`);
}

/**
 * Read an agent or rule file as it goes into the system message: hidden
 * characters removed, a secret warned about, cut at 32 KiB (the same guard
 * as the IDE, `core/config/markdown/instructionFiles.ts`). The CLI has no
 * Restricted Mode, so the file is always read. Throws as `readFileSync` does.
 */
export function readInstructionFile(
  filePath: string,
  warn: (notice: InstructionFileNotice) => void = warnOnce,
): string {
  const guarded = guardInstructionFile(
    filePath,
    fs.readFileSync(filePath, "utf-8"),
  );
  for (const notice of guarded.notices) warn(notice);
  return guarded.content;
}
