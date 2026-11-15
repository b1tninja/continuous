import * as nodePath from "node:path";
import { BuiltInToolNames } from "../../builtIn";
import { commandCandidateSet } from "../candidates";
import { programName } from "../destinations";
import { isSecretPath } from "../protectedPaths";
import { jqEnvironmentLabel, secretWordLabel } from "../secretCommands";
import type { ShellKind } from "../../../util/shell";
import { mcpLabel, type TaintKind, type TaintLabel } from "./taintState";

/**
 * What counts as untrusted content entering the conversation, judged from the
 * call that fetched it (never from the content). plans/design/tainted-session.md.
 */
export interface SourceCall {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  /** An MCP tool: its output is the server's, whoever runs the server */
  mcp?: boolean;
  /** The MCP server's name, when the host knows it: the label is `mcp:<server>` */
  mcpServer?: string;
  /** Workspace folders as paths; the first is the folder commands and relative paths start in */
  workspaceDirs?: readonly string[];
  /**
   * Whether the person has trusted this workspace folder (a project-trust
   * record for any scope, `folderHasTrustRecord`). A read of a file in a
   * folder it says no for is labelled `untrusted-workspace`. A host that
   * cannot tell leaves it out, and no such label is added.
   */
  folderTrusted?: (dir: string) => boolean;
  shell?: ShellKind;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const WIN_PATH = /^[a-zA-Z]:[\\/]|^\\\\/;

function flavorOf(p: string): typeof nodePath.posix {
  return WIN_PATH.test(p) ? nodePath.win32 : nodePath.posix;
}

/**
 * Whether a path, as written, lies outside every workspace folder. Links are
 * not followed here: the policy-time check does that, this one only has to be
 * cheap and to err toward "outside" (a spurious taint costs a few asks).
 */
export function isOutsideWorkspace(
  raw: string,
  dirs: readonly string[] | undefined,
): boolean {
  if (!dirs?.length) return false;
  return workspaceDirOf(raw, dirs) === undefined;
}

/**
 * The workspace folder a path, as written, lies in (as the host gave it), or
 * undefined when it lies in none. Same reading as `isOutsideWorkspace`.
 */
export function workspaceDirOf(
  raw: string,
  dirs: readonly string[] | undefined,
): string | undefined {
  if (!dirs?.length) return undefined;
  const text = raw.trim();
  if (text.startsWith("~")) return undefined;
  const flavor = flavorOf(text);
  const fold = (p: string) => (flavor === nodePath.win32 ? p.toLowerCase() : p);
  const base = dirs[0];
  // A file URI's path on Windows is `/c:/dir`; the drive form is what a path is written as
  const plain = (d: string) => d.replace(/^\/([a-zA-Z]:)/, "$1");
  const abs = flavor.isAbsolute(text)
    ? flavor.normalize(text)
    : flavor.resolve(plain(base), text);
  return dirs.find((d) => {
    const dir = flavor.normalize(plain(d));
    const rel = flavor.relative(fold(dir), fold(abs));
    return rel === "" || (!rel.startsWith("..") && !flavor.isAbsolute(rel));
  });
}

const FILE_READS: Record<string, string> = {
  [BuiltInToolNames.ReadFile]: "filepath",
  [BuiltInToolNames.ReadFileRange]: "filepath",
  [BuiltInToolNames.CodeNavigation]: "filepath",
  [BuiltInToolNames.LSTool]: "dirPath",
  [BuiltInToolNames.ViewSubdirectory]: "directory_path",
};

/** A tool that reads a file or a folder, which taints when its target is outside the workspace. */
export function isFileReadTool(toolName: string): boolean {
  return toolName in FILE_READS;
}

/** Programs whose output is text somebody else wrote: a web page or an issue. */
const WEB_PROGRAMS = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "invoke-webrequest",
  "invoke-restmethod",
]);
const ISSUE_VERBS = new Set(["view", "list", "diff", "checks", "status"]);
const ISSUE_NOUNS = new Set(["issue", "pr", "release", "gist", "run"]);

function commandSource(command: string, shell?: ShellKind) {
  for (const c of commandCandidateSet(command, shell).list) {
    const words = c.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const program = programName(words[0]);
    if (WEB_PROGRAMS.has(program)) return "web-fetch" as const;
    if (program === "gh") {
      const rest = words.slice(1).filter((w) => !w.startsWith("-"));
      if (rest[0] === "api") return "issue-text" as const;
      if (ISSUE_NOUNS.has(rest[0]) && ISSUE_VERBS.has(rest[1])) {
        return "issue-text" as const;
      }
    }
  }
  return undefined;
}

/** Tools that read a file's content (a folder listing is not a read of a secret). */
const CONTENT_READS = new Set<string>([
  BuiltInToolNames.ReadFile,
  BuiltInToolNames.ReadFileRange,
  BuiltInToolNames.CodeNavigation,
]);

const unquote = (w: string) => w.replace(/^['"]+|['"]+$/g, "");
const slashes = (p: string) => p.replace(/\\/g, "/");

/**
 * Whether a command prints a credential (the words the `credential-read` sink
 * names: an environment dump, a secret-looking variable) or names a secret
 * file (`cat .env`, `type ~/.aws/credentials`). It errs toward yes: a command
 * that only mentions a secret file is labelled too.
 */
function commandReadsSecret(command: string, shell?: ShellKind): boolean {
  for (const c of commandCandidateSet(command, shell).list) {
    const words = c.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const printed = words.some((w, i) =>
      secretWordLabel(w, i === 0, words.length > 1, words[i - 1]),
    );
    if (printed || jqEnvironmentLabel(words)) return true;
    if (words.slice(1).some((w) => isSecretPath(slashes(unquote(w))))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether this call brought a secret into the conversation: a file tool's
 * read of a protected secret path (`isSecretPath`), or a command that prints
 * a credential or names a secret file. A confidentiality label: it says
 * private data entered, not that the content is untrusted.
 */
function readsSecret(call: SourceCall): boolean {
  const { toolName, parsedArgs } = call;
  if (CONTENT_READS.has(toolName)) {
    const raw = str(parsedArgs[FILE_READS[toolName]]);
    return !!raw && isSecretPath(slashes(raw.trim()));
  }
  if (toolName === BuiltInToolNames.RunTerminalCommand) {
    const command = str(parsedArgs.command);
    return !!command && commandReadsSecret(command, call.shell);
  }
  return false;
}

/** The labels of the content this call brought into the conversation, if any. */
export function taintLabelsOfCall(call: SourceCall): TaintLabel[] {
  if (call.mcp) return [mcpLabel(call.mcpServer)];
  const labels: TaintLabel[] = [];
  const kind = fixedKindOfCall(call);
  if (kind) labels.push(kind);
  if (readsSecret(call)) labels.push("secret");
  return labels;
}
/** The first label of this call's content (see `taintLabelsOfCall`). */
export function taintKindOfCall(call: SourceCall): TaintLabel | undefined {
  return taintLabelsOfCall(call)[0];
}

function fixedKindOfCall(call: SourceCall): TaintKind | undefined {
  const { toolName, parsedArgs } = call;
  if (
    toolName === BuiltInToolNames.FetchUrlContent ||
    toolName === BuiltInToolNames.SearchWeb
  ) {
    return "web-fetch";
  }
  const pathArg = FILE_READS[toolName];
  if (pathArg) {
    const raw = str(parsedArgs[pathArg]) ?? (pathArg === "dirPath" ? "." : "");
    if (!raw || !call.workspaceDirs?.length) return undefined;
    const dir = workspaceDirOf(raw, call.workspaceDirs);
    if (dir === undefined) return "outside-read";
    // A file's content from a folder the person has not trusted: a cloned
    // repository's README, AGENTS.md or test fixture is somebody else's text
    if (CONTENT_READS.has(toolName) && call.folderTrusted?.(dir) === false) {
      return "untrusted-workspace";
    }
    return undefined;
  }
  if (toolName === BuiltInToolNames.RunTerminalCommand) {
    const command = str(parsedArgs.command);
    return command ? commandSource(command, call.shell) : undefined;
  }
  return undefined;
}
