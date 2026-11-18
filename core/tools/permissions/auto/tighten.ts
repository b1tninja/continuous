import * as path from "node:path";
import { commandName, dequote, splitRawWords } from "../shellWords";
import { uriToPath } from "../names";
import type { ModelCategory } from "./categories";
import type { ReviewResult } from "./parse";

/**
 * Deterministic rules applied to the reviewer's `allow` (ROADMAP B84). They
 * exist because a weak reviewer model can score the task as the action and
 * allow `sudo`, a `truncate` on a database, an edit of `~/.bashrc` or a
 * lockfile pointed at an `http` mirror (research/b54-nova-false-allows.md).
 *
 * The contract is one-way: `tightenAllow` returns its input unchanged unless
 * the input is an `allow`, and then returns either the same `allow` or an
 * `ask`. It never produces an `allow` and never touches an `ask` or `deny`.
 * A rule that is too broad therefore costs a click, never a wrong allow.
 */

export interface TightenCall {
  toolName: string;
  args: unknown;
  /** Workspace folders as the IDE gives them: file URIs or plain paths. */
  workspaceDirs?: readonly string[];
}

export interface Tightened {
  category: ModelCategory;
  reason: string;
}

const EDIT_TOOLS = new Set([
  "edit_existing_file",
  "create_new_file",
  "single_find_and_replace",
  "multi_edit",
]);

const ESCALATION = new Set(["sudo", "su", "doas", "pkexec"]);

/** Words that carry a command but are not the command: `env`, `nohup`, `time`. */
const WRAPPERS = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "nice",
  "ionice",
  "setsid",
  "stdbuf",
  "xargs",
  "timeout",
  "watch",
  "then",
  "do",
  "else",
  "!",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** A path under a scratch or cache directory, where emptying a file is routine. */
const SCRATCH =
  /(^|[\\/])(\.?cache|\.?caches|tmp|temp|\.tmp|\.turbo|\.next|\.parcel-cache|__pycache__|node_modules[\\/]\.cache)([\\/]|$)|\.(cache|tmp|temp|log|pyc)$|^\/dev\/(null|zero)$/i;

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "composer.lock",
  "gemfile.lock",
  "uv.lock",
]);

const STARTUP_FILES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".cshrc",
  ".tcshrc",
  ".kshrc",
  "config.fish",
]);

const USER_DIRS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker"]);

const isWindowsPath = (p: string) =>
  /^[a-z]:[\\/]/i.test(p) || p.includes("\\");

function flavor(p: string) {
  return isWindowsPath(p) ? path.win32 : path.posix;
}

function workspacePaths(dirs: readonly string[] | undefined): string[] {
  return (dirs ?? [])
    .map((d) => (d.startsWith("file:") ? uriToPath(d) : d))
    .filter((d): d is string => !!d)
    .map((d) => (/^\/[a-z]:\//i.test(d) ? d.slice(1) : d));
}

function inside(file: string, dir: string): boolean {
  const f = flavor(dir);
  const rel = f.relative(f.normalize(dir), f.normalize(file));
  return rel === "" || (!rel.startsWith("..") && !f.isAbsolute(rel));
}

/** Where a path points, for a judgement about the workspace: `~` and `$HOME` are the home folder. */
function isHomeRelative(p: string): boolean {
  return /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)([\\/]|$)/i.test(p);
}

function outsideWorkspace(file: string, dirs: string[]): boolean | undefined {
  if (isHomeRelative(file)) return true;
  const absolute = path.posix.isAbsolute(file) || path.win32.isAbsolute(file);
  if (!absolute) {
    // Relative to the workspace unless it climbs out of it
    return /(^|[\\/])\.\.([\\/]|$)/.test(file) ? true : false;
  }
  if (dirs.length === 0) return undefined;
  return !dirs.some((d) => inside(file, d));
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function segments(p: string): string[] {
  return p.split(/[\\/]/).map((s) => s.toLowerCase());
}

/** A file the person's shell, SSH or cloud tooling reads: edited anywhere, it is user-wide configuration. */
function isUserWideConfig(file: string): boolean {
  const name = baseName(file);
  if (STARTUP_FILES.has(name)) return true;
  const segs = segments(file);
  return segs.some((s) => USER_DIRS.has(s));
}

const SCRATCH_OK = (file: string) => SCRATCH.test(file);

function filepathOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const k of ["filepath", "filePath", "path", "file_path"]) {
    if (typeof a[k] === "string" && a[k]) return a[k] as string;
  }
  return undefined;
}

function editHit(call: TightenCall): Tightened | undefined {
  const file = filepathOf(call.args);
  if (!file) return undefined;
  const dirs = workspacePaths(call.workspaceDirs);
  if (isUserWideConfig(file) || segments(file).includes(".config")) {
    // `.config` inside a project is project configuration; only outside it is user-wide
    if (isUserWideConfig(file) || outsideWorkspace(file, dirs) !== false) {
      return {
        category: "outside-workspace",
        reason: `This edits ${file}, user-wide configuration outside the project.`,
      };
    }
  }
  if (outsideWorkspace(file, dirs) === true && !SCRATCH_OK(file)) {
    return {
      category: "outside-workspace",
      reason: `This writes ${file}, which is outside the workspace.`,
    };
  }
  if (LOCKFILES.has(baseName(file))) {
    const rest = Object.fromEntries(
      Object.entries((call.args ?? {}) as Record<string, unknown>).filter(
        ([k]) => !["filepath", "filePath", "path", "file_path"].includes(k),
      ),
    );
    if (/(^|[^a-z0-9+.-])(?:git\+)?http:\/\//i.test(JSON.stringify(rest))) {
      return {
        category: "security-weakening",
        reason: `This puts a non-https URL into ${baseName(file)}, a package source that is not encrypted.`,
      };
    }
  }
  return undefined;
}

/** Split a command line into simple commands, each a list of words with quotes kept. */
function simpleCommands(line: string): string[][] {
  const out: string[][] = [];
  const parts = line.split(/\r?\n|&&|\|\||[;|&(){}`]|\$\(/);
  for (const part of parts) {
    const words = splitRawWords(part);
    if (words.length) out.push(words);
  }
  return out;
}

const isAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/** The command word and its arguments, past assignments, wrappers and their options. */
function headOf(words: string[]): { name: string; args: string[] } | undefined {
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (isAssignment(w)) continue;
    const name = commandName(dequote(w));
    if (WRAPPERS.has(name) || (i > 0 && /^-/.test(dequote(w)))) continue;
    // `timeout 5 cmd`, `nice -n 5 cmd`: skip a bare number operand
    if (/^\d+(\.\d+)?[smhd]?$/.test(name)) continue;
    return { name, args: words.slice(i + 1).map(dequote) };
  }
  return undefined;
}

function operands(args: string[], withValue: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (!a.includes("=") && withValue.has(a)) i++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (withValue.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function hit(category: Tightened["category"], reason: string): Tightened {
  return { category, reason };
}

function commandHit(
  command: string,
  dirs: string[],
  depth: number,
): Tightened | undefined {
  for (const words of simpleCommands(command)) {
    const head = headOf(words);
    if (!head) continue;
    const { name, args } = head;
    if (ESCALATION.has(name)) {
      return hit(
        "permission-change",
        `This runs with elevated privileges (${name}), which changes the system outside the workspace.`,
      );
    }
    if (SHELLS.has(name) && depth < 3) {
      const c = args.indexOf("-c");
      const inner = c >= 0 ? args[c + 1] : undefined;
      const found = inner && commandHit(inner, dirs, depth + 1);
      if (found) return found;
    }
    if (name === "truncate") {
      const targets = operands(
        args,
        new Set(["-s", "--size", "-r", "--reference"]),
      );
      const bad = targets.find((t) => !SCRATCH_OK(t));
      if (bad) {
        return hit(
          "destructive-irreversible",
          `This empties ${bad}, which is not a cache or scratch file.`,
        );
      }
    }
    if (name === "shred") {
      const bad = operands(
        args,
        new Set(["-n", "--iterations", "-s", "--size", "--random-source"]),
      ).find((t) => !SCRATCH_OK(t));
      if (bad) {
        return hit(
          "destructive-irreversible",
          `This overwrites ${bad} so it cannot be recovered, and it is not a cache or scratch file.`,
        );
      }
    }
    if (name === "dd") {
      const of = args.find((a) => a.startsWith("of="))?.slice(3);
      if (of && !SCRATCH_OK(of)) {
        return hit(
          "destructive-irreversible",
          `This writes over ${of} with dd, and it is not a cache or scratch file.`,
        );
      }
    }
  }
  // Redirects and `tee` into user-wide configuration
  for (const m of command.matchAll(/>>?\s*("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    const target = dequote(m[1]);
    if (isUserWideConfig(target) || isHomeRelative(target)) {
      return hit(
        "outside-workspace",
        `This writes ${target}, user-wide configuration outside the project.`,
      );
    }
  }
  for (const words of simpleCommands(command)) {
    const head = headOf(words);
    if (head?.name === "tee") {
      const bad = operands(head.args, new Set()).find(
        (t) => isUserWideConfig(t) || isHomeRelative(t),
      );
      if (bad) {
        return hit(
          "outside-workspace",
          `This writes ${bad}, user-wide configuration outside the project.`,
        );
      }
    }
  }
  return undefined;
}

/** The rule that applies to this call, if any. Pure; exported for the tests. */
export function tightenHit(call: TightenCall): Tightened | undefined {
  if (EDIT_TOOLS.has(call.toolName)) return editHit(call);
  if (call.toolName === "run_terminal_command") {
    const a = call.args as { command?: unknown } | null | undefined;
    if (typeof a?.command !== "string") return undefined;
    return commandHit(a.command, workspacePaths(call.workspaceDirs), 0);
  }
  return undefined;
}

/**
 * Raise-only: an `allow` that matches a rule becomes an `ask` with the rule's
 * category; everything else comes back as it was (the same object).
 */
export function tightenAllow(
  result: ReviewResult,
  call: TightenCall,
): ReviewResult {
  if (result.decision !== "allow") return result;
  let found: Tightened | undefined;
  try {
    found = tightenHit(call);
  } catch {
    // A rule that cannot read the call cannot vouch for an allow
    found = hit(
      "uncertain",
      "The call could not be checked, so you are asked.",
    );
  }
  if (!found) return result;
  return {
    decision: "ask",
    category: found.category,
    reason: `${found.reason} The reviewer allowed it; a fixed rule asks instead.`,
  };
}
