import * as nodePath from "node:path";
import { BuiltInToolNames } from "../../builtIn";
import { commandCandidateSet } from "../candidates";
import { effectsOfCommand } from "../commandSpecs";
import { programName } from "../destinations";
import { isSecretPath } from "../protectedPaths";
import {
  credentialCommandLabel,
  jqEnvironmentLabel,
  secretWordLabel,
} from "../secretCommands";
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
 * Programs that put a file's content on their output (or decode, search or
 * page it): naming a secret file as their operand reads it. PowerShell
 * aliases are folded by `programName` (`cat`, `gc` and `type` are
 * `get-content` there), so both spellings are listed.
 */
const CONTENT_READERS = new Set([
  "cat",
  "tac",
  "nl",
  "type",
  "get-content",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "findstr",
  "select-string",
  "awk",
  "gawk",
  "sed",
  "cut",
  "sort",
  "uniq",
  "diff",
  "base64",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "jq",
  "yq",
  "openssl",
  "gpg",
  "source",
  ".",
  "certutil",
  "import-csv",
]);

/** Programs that take a key to log in with (`-i key`): the key is used, not sent. */
const IDENTITY_FLAG_PROGRAMS = new Set(["ssh", "scp", "sftp"]);

/** Programs that reach the network whatever commandSpecs.ts knows of them. */
const NETWORK_PROGRAMS = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "invoke-webrequest",
  "invoke-restmethod",
]);

const flagsOff = (w: string) => !w.startsWith("-");

/** The path a network argument carries: `@.env`, `file=@.env`, `--data-binary=@.env`, `.env`. */
function sentPath(word: string): string {
  const at = word.lastIndexOf("@");
  if (at >= 0 && at < word.length - 1) return word.slice(at + 1);
  const eq = word.indexOf("=");
  return eq > 0 && eq < word.length - 1 ? word.slice(eq + 1) : word;
}

/**
 * A URL or a remote path (`host:path`, `user@host:path`): somewhere else's
 * file, not one on this machine being sent. A drive letter (`C:/x`) is local.
 */
function isRemote(word: string): boolean {
  if (word.includes("://")) return true;
  return /^[^/\\]+:/.test(word) && !/^[a-zA-Z]:[\\/]/.test(word);
}

/** What read a secret, and the path when a file was read. */
interface SecretSource {
  text: string;
  path?: string;
}

/** One command (a candidate's words): does it read a secret file's content? */
function wordsReadSecret(words: string[]): SecretSource | undefined {
  const clean = (w: string) => slashes(unquote(w));
  const program = programName(words[0]);
  const rest = words.slice(1);
  // Input redirected from the file: `wc -l < .env`, `curl -d @- x <.env`
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d?<(?![<(&])/.test(w)) {
      const target = clean(w.replace(/^\d?</, "") || (words[i + 1] ?? ""));
      if (target && isSecretPath(target)) {
        return { text: `a command that reads ${target}`, path: target };
      }
    }
  }
  if (CONTENT_READERS.has(program)) {
    const read = rest.filter(flagsOff).map(clean).find(isSecretPath);
    if (read) return { text: `a command that reads ${read}`, path: read };
  }
  if (
    NETWORK_PROGRAMS.has(program) ||
    effectsOfCommand(words.join(" ")).has("network")
  ) {
    for (let i = 0; i < rest.length; i++) {
      if (IDENTITY_FLAG_PROGRAMS.has(program) && rest[i - 1] === "-i") continue;
      const sent = clean(sentPath(rest[i]));
      if (sent && !isRemote(sent) && isSecretPath(sent)) {
        return { text: `a command that sends ${sent}`, path: sent };
      }
    }
  }
  return undefined;
}

/**
 * Whether a command prints a credential (the words the `credential-read`
 * sink names: an environment dump, a secret-looking variable) or reads a
 * secret file's content: a program that prints, searches or decodes it, an
 * input redirect from it, or a network command that sends it (`curl -d
 * @.env`, `scp .env host:`). A command that only names the file (`echo .env`,
 * `ls .env`, `test -f .env`, `git add .env`) reads nothing and marks nothing.
 * Read from the command candidates (candidates.ts), so a pipeline, a list,
 * `bash -c` and PowerShell aliases are seen as the shell sees them.
 */
function commandSecretSource(
  command: string,
  shell?: ShellKind,
): SecretSource | undefined {
  for (const c of commandCandidateSet(command, shell).list) {
    const words = c.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const printed =
      words
        .map((w, i) =>
          secretWordLabel(w, i === 0, words.length > 1, words[i - 1]),
        )
        .find(Boolean) ??
      jqEnvironmentLabel(words) ??
      credentialCommandLabel(words);
    if (printed) return { text: `a command that prints ${printed}` };
    const read = wordsReadSecret(words);
    if (read) return read;
  }
  return undefined;
}

function secretSourceParts(call: SourceCall): SecretSource | undefined {
  const { toolName, parsedArgs } = call;
  if (CONTENT_READS.has(toolName)) {
    const raw = str(parsedArgs[FILE_READS[toolName]])?.trim();
    return raw && isSecretPath(slashes(raw))
      ? { text: `${toolName} ${raw}`, path: raw }
      : undefined;
  }
  if (toolName === BuiltInToolNames.RunTerminalCommand) {
    const command = str(parsedArgs.command);
    return command ? commandSecretSource(command, call.shell) : undefined;
  }
  return undefined;
}

/**
 * What brought a secret into the conversation, if this call did: a file
 * tool's read of a protected secret path (`isSecretPath`), or a command that
 * prints a credential or reads a secret file's content. The tool and the
 * path or the word, never the content. A confidentiality label: it says
 * private data entered, not that the content is untrusted.
 */
export function secretSourceOfCall(call: SourceCall): string | undefined {
  return secretSourceParts(call)?.text;
}

/**
 * The same, for the audit trail: the path cut to the file's name
 * (`read_file .npmrc`, `a command that reads credentials`).
 */
export function secretSourceForAudit(call: SourceCall): string | undefined {
  const parts = secretSourceParts(call);
  if (!parts?.path) return parts?.text;
  const name = slashes(parts.path).split("/").filter(Boolean).pop() ?? "";
  return parts.text.replace(parts.path, name);
}

function readsSecret(call: SourceCall): boolean {
  return secretSourceOfCall(call) !== undefined;
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
