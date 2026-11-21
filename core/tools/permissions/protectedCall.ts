import * as os from "node:os";
import type { ShellKind } from "../../util/shell";
import { commandCandidateSet } from "./candidates";
import { fetchAndRunHit } from "./fetchAndRun";
import { ProtectedHit, ProtectedKind, protectedPathHit } from "./protected";
import {
  credentialCommandLabel,
  isNetworkPath,
  jqEnvironmentLabel,
  secretWordLabel,
} from "./secretCommands";

const strip = (s: string) =>
  s.replace(/^[<>&|]+/, "").replace(/^['"]+|['"]+$/g, "");

/** Words of a command, per candidate, so a command name knows whether it has arguments. */
export function wordsOf(candidates: string[]): string[][] {
  return candidates.map((c) => c.split(/\s+/).map(strip).filter(Boolean));
}

/** The words of a command worth testing as paths: quotes, redirects and `--opt=` stripped. */
export function pathWords(candidates: string[]): string[] {
  const words = new Set<string>();
  for (const list of wordsOf(candidates)) {
    for (const w of list) {
      words.add(w);
      const eq = w.indexOf("=");
      if (eq > 0 && eq < w.length - 1) words.add(strip(w.slice(eq + 1)));
    }
  }
  return [...words];
}

/**
 * Does a command mention a protected path anywhere in its words? Over-matches
 * on purpose, like deny rules: `echo .env` asks. A command can use a path in
 * ways this cannot see (a variable, a glob, `cd` then a bare name), so this
 * is a guard against accidents, not a sandbox.
 *
 * It also catches commands that print credentials without naming a file
 * (`printenv`, `echo $AWS_SECRET_ACCESS_KEY`, `dir env:`) and network paths
 * (`\\host\share`), which contact another computer.
 */
export function protectedCommandHit(
  command: string,
  home: string = os.homedir(),
  /** Kinds the person switched off (built-in rules by id) */
  skip: readonly ProtectedKind[] = [],
  /** Directory the command runs in, so a relative path can be recognised. */
  cwd?: string,
  /** The shell that runs it; unknown reads the command under every grammar */
  shell?: ShellKind,
): ProtectedHit | undefined {
  // First, so Automatic can refuse it whatever else the command touches
  if (!skip.includes("fetch-and-run") && fetchAndRunHit(command)) {
    return { kind: "fetch-and-run", path: "a download that is then run" };
  }
  const { list, truncated } = commandCandidateSet(command, shell);
  // The cap dropped part of the command. A secret in the missing part would
  // otherwise look safe, so the command asks.
  if (truncated && !skip.includes("secret")) {
    return {
      kind: "secret",
      path: "a command too long to check in full",
    };
  }
  const pathKinds = (["secret", "config"] as ProtectedKind[]).filter(
    (k) => !skip.includes(k),
  );
  for (const word of pathWords(list)) {
    const hit = pathKinds.length
      ? protectedPathHit(word, pathKinds, home, cwd)
      : undefined;
    if (hit) return hit;
  }
  for (const word of skip.includes("network") ? [] : command.split(/\s+/)) {
    if (isNetworkPath(word)) {
      return { kind: "network", path: strip(word) };
    }
  }
  for (const words of skip.includes("secret") ? [] : wordsOf(list)) {
    const jq = jqEnvironmentLabel(words) ?? credentialCommandLabel(words);
    if (jq) return { kind: "secret", path: jq };
    for (let i = 0; i < words.length; i++) {
      const label = secretWordLabel(
        words[i],
        i === 0,
        words.length > 1,
        i > 0 ? words[i - 1] : undefined,
      );
      if (label) return { kind: "secret", path: label };
    }
  }
  return undefined;
}

const READ_TOOLS = new Set([
  "read_file",
  "read_file_range",
  "read_currently_open_file",
]);
const LIST_TOOLS = new Set(["ls", "view_subdirectory"]);
const WRITE_TOOLS = new Set([
  "create_new_file",
  "edit_existing_file",
  "single_find_and_replace",
  "multi_edit",
]);

/** The path a built-in file tool names, and whether it only reads. */
export function fileToolTarget(
  toolName: string,
  parsedArgs: Record<string, unknown>,
): { path: string | undefined; reads: boolean } | undefined {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (READ_TOOLS.has(toolName)) {
    return { path: str(parsedArgs.filepath), reads: true };
  }
  if (LIST_TOOLS.has(toolName)) {
    const dir = str(parsedArgs.dirPath) ?? str(parsedArgs.directory_path);
    return { path: dir, reads: true };
  }
  if (WRITE_TOOLS.has(toolName)) {
    return { path: str(parsedArgs.filepath), reads: false };
  }
  return undefined;
}

/** Does this tool call touch a protected path? Checks the written path and the resolved one. */
export function findProtected(args: {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  resolvedPath?: string;
  home?: string;
  /** Directory the call runs in. Relative paths are resolved against it. */
  cwd?: string;
  /** Kinds the person switched off (built-in rules by id) */
  skip?: readonly ProtectedKind[];
  /** The shell that runs a terminal command */
  shell?: ShellKind;
}): ProtectedHit | undefined {
  const { toolName, parsedArgs, resolvedPath } = args;
  const home = args.home ?? os.homedir();
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  if (toolName === "run_terminal_command") {
    const command = str(parsedArgs.command);
    return command
      ? protectedCommandHit(command, home, args.skip, args.cwd, args.shell)
      : undefined;
  }

  let kinds: ProtectedKind[];
  let written: string | undefined;
  if (READ_TOOLS.has(toolName)) {
    kinds = ["secret"];
    written = str(parsedArgs.filepath);
  } else if (LIST_TOOLS.has(toolName)) {
    kinds = ["secret"];
    written = str(parsedArgs.dirPath) ?? str(parsedArgs.directory_path);
  } else if (WRITE_TOOLS.has(toolName)) {
    kinds = ["secret", "config"];
    written = str(parsedArgs.filepath);
  } else {
    return undefined;
  }
  kinds = kinds.filter((k) => !args.skip?.includes(k));
  if (kinds.length === 0) return undefined;
  return (
    protectedPathHit(written, kinds, home, args.cwd) ??
    protectedPathHit(resolvedPath, kinds, home, args.cwd)
  );
}
