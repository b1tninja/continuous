/**
 * The sentences that tell a model which shell reads its terminal commands
 * and what that shell does differently
 * (plans/research/env-disclosure-master-plan.md, sections 3.8 and 4, row
 * ENV5). One builder for every surface, so the IDE and the CLI cannot
 * describe the same executor in two ways.
 *
 * The input is facts from the executor: the shell this process starts (or
 * the fact that it starts none and types into a terminal), the container and
 * WSL options in force, and the machine facts with their confidence. No
 * argument is text a model or a repository wrote, the label of the shell is
 * never parsed, and a set of facts that contradicts itself gets the "not
 * known" sentence, because a wrong claim costs more than saying nothing.
 *
 * Pure: nothing here reads the process, a file or a setting. Nothing here is
 * wired into a prompt yet.
 */
import type { EnvFieldId } from "./environmentContract";
import { sanitiseEnvValue } from "./envDisclosure";
import type { ShellKind } from "./shell";

export type Confidence = "known" | "likely" | "unknown";

/** A fact with how sure it is; the shape of `Fact` in the environment fact detectors. */
export interface EnvFact<T extends string> {
  value: T;
  confidence: Confidence;
  /** What the answer came from, in words a person can read. */
  source: string;
}

/**
 * The shell that will really read a command. The same three fields as the
 * `ExecutionShell` of the shell-context work, so the value `executionShell()`
 * returns can be passed as it is. `terminal-reported` is the later case of a
 * remote terminal whose shell the editor names.
 */
export interface ExecutionShellFact {
  /** The grammar; "unknown" when it cannot be told. */
  kind: ShellKind;
  source: "spawned" | "terminal" | "terminal-reported";
  /** Words for a person. Shown on the approval card; never read here. */
  label: string;
}

export type OsFamily = "windows" | "macos" | "linux" | "other" | "unknown";
export type Userland = "gnu" | "bsd" | "busybox" | "unknown";
export type YesNoUnknown = "yes" | "no" | "unknown";

export interface ContainerExecutorFacts {
  runtime?: string;
  /** The image reference as configured. */
  image: string;
  /** The `--network` value in force. */
  network: "none" | "bridge";
  /** False only if the executor stops passing `--read-only`. */
  readOnly?: boolean;
}

export interface WslExecutorFacts {
  distro?: string;
  /** Whether Windows programs start from inside the distribution. */
  interop: boolean | "unknown";
}

export interface RemoteWindowFacts {
  /** The editor's remote name: "ssh-remote", "wsl", "dev-container". */
  name: string;
  /** True when the name is a guess (JetBrains reading SSH variables). */
  guessed?: boolean;
}

export interface ShellFacts {
  shell: ExecutionShellFact;
  /** The program the executor starts (`resolveShell().executable`); only its name is used. */
  executable?: string;
  os: EnvFact<OsFamily>;
  remote?: RemoteWindowFacts;
  /** Set when commands run in a WSL distribution from a Windows host. */
  wsl?: WslExecutorFacts;
  /** Set when commands run in a container this product starts. */
  container?: ContainerExecutorFacts;
  userland?: EnvFact<Userland>;
  /** Markers that this machine is itself a container. */
  containerHint?: {
    inContainer: EnvFact<YesNoUnknown>;
    markers: readonly string[];
  };
  /** Whether this Linux is WSL (the CLI started inside a distribution). */
  hostWsl?: EnvFact<YesNoUnknown>;
}

export interface DescribeShellOptions {
  /** Leave the container marker out (`environment.detail: minimal`). */
  containerHint?: boolean;
  /** Name the whole image reference, not its last segment (`environment.detail: full`). */
  fullImage?: boolean;
  /**
   * How a value from a setting or a marker (a distribution, an image, a
   * marker path, a shell name) is made safe; the renderer passes its own so
   * masking and the never-send list apply. Defaults to the shared sanitiser.
   */
  value?: (text: string, cap: number) => string;
}

export type ShellVariant =
  | "powershell-5.1"
  | "powershell-7"
  | "powershell"
  | "cmd"
  | "wsl"
  | "git-bash"
  | "container"
  | "remote"
  | "remote-reported"
  | "posix"
  | "other-shell"
  | "unknown";

export interface ShellDescription {
  text: string;
  variant: ShellVariant;
  /** The contract fields whose values are in the text. */
  fields: EnvFieldId[];
}

const START =
  "a new process for each command, starting in the workspace folder";
const NO_PROMPTS = "Commands cannot answer prompts.";
const NOT_BASH =
  "No heredocs, export or VAR=x cmd: use $env:VAR='x'; cmd. Use 2>$null, not 2>/dev/null.";
const PASS_FORCE =
  "Commands cannot answer prompts: pass -Force or -Confirm:$false.";

/** Section 4.1 of the master plan, byte for byte. */
const POWERSHELL_51 = [
  `Runs in Windows PowerShell 5.1 (powershell.exe), ${START}.`,
  "Write PowerShell, not bash.",
  "&& and || are syntax errors here: use a; if ($?) { b }.",
  NOT_BASH,
  "curl, ls, rm and where are PowerShell aliases with other flags: call curl.exe and where.exe, and use Remove-Item -Recurse -Force.",
  "grep, sed and head may not be installed: check with Get-Command.",
  'Run a quoted program path as & "C:\\path\\app.exe".',
  PASS_FORCE,
  "Write files with the edit tools, not > (it writes UTF-16 here).",
].join(" ");

/** Drafted, not measured: no pwsh was on the review machine, and the executor does not start it yet. */
const POWERSHELL_7 = [
  `Runs in PowerShell 7 or later (pwsh), ${START}.`,
  "Write PowerShell, not bash.",
  "&& and || work.",
  NOT_BASH,
  PASS_FORCE,
].join(" ");

const POWERSHELL_ANY = [
  `Runs in PowerShell (Windows PowerShell 5.1 or PowerShell 7: not known here), ${START}.`,
  "Write PowerShell, not bash.",
  "&& and || are syntax errors in 5.1: use a; if ($?) { b }, which both accept.",
  NOT_BASH,
  PASS_FORCE,
].join(" ");

/** Drafted: the executor never starts cmd for the terminal tool today. */
const CMD = [
  `Runs in cmd.exe, ${START}.`,
  "Chain with && or &: ; is not a separator.",
  "Variables are %NAME%, the escape character is ^, and only double quotes quote.",
  "Unix tools such as grep and ls are not there.",
  NO_PROMPTS,
].join(" ");

/** Drafted only: this product never starts Git Bash. */
const GIT_BASH = [
  `Runs in bash from Git for Windows (Git Bash), ${START}.`,
  "Use bash syntax; paths are /c/Users/... or C:/..., and an argument that looks like a path is converted for Windows programs (write //b for a /b switch, or set MSYS_NO_PATHCONV=1).",
  "Text files may have CRLF line endings.",
  NO_PROMPTS,
].join(" ");

const UNKNOWN = [
  "Commands run in a shell that is not known here.",
  "Send one simple command per call, and avoid syntax that only one shell accepts.",
  NO_PROMPTS,
].join(" ");

/**
 * One dialect sentence for a login shell `ShellKind` calls unknown. Every
 * claim is from documentation, not from a run, so each is short and plain.
 */
const OTHER_SHELLS: Record<string, { name: string; dialect: string }> = {
  fish: {
    name: "fish",
    dialect:
      "fish is not a POSIX shell: set variables with set -x NAME value, and there are no heredocs.",
  },
  nu: {
    name: "nushell",
    dialect:
      "nushell is not a POSIX shell: pipelines carry tables, variables are $env.NAME, and ^name runs an external program.",
  },
  nushell: {
    name: "nushell",
    dialect:
      "nushell is not a POSIX shell: pipelines carry tables, variables are $env.NAME, and ^name runs an external program.",
  },
  ksh: {
    name: "ksh",
    dialect: "ksh is close to POSIX sh: avoid bash-only syntax.",
  },
  ksh93: {
    name: "ksh",
    dialect: "ksh is close to POSIX sh: avoid bash-only syntax.",
  },
  mksh: {
    name: "ksh",
    dialect: "ksh is close to POSIX sh: avoid bash-only syntax.",
  },
  csh: {
    name: "csh",
    dialect:
      "csh is not a POSIX shell: set variables with setenv NAME value, and redirect errors with >&.",
  },
  tcsh: {
    name: "csh",
    dialect:
      "csh is not a POSIX shell: set variables with setenv NAME value, and redirect errors with >&.",
  },
  xonsh: {
    name: "xonsh",
    dialect:
      "xonsh reads both Python and shell syntax: keep to plain commands.",
  },
};

const NOT_CHECKED =
  "Commands here are not checked against this shell's syntax: keep them simple.";

/** A short value from a setting or a file name, safe inside the sentence. */
function defaultWord(value: string, cap: number): string {
  return sanitiseEnvValue(value.trim(), { maxChars: cap, singleLine: true })
    .text;
}

let word = defaultWord;

/** The name of a program from its path, without `.exe`, lower case. */
export function programName(executable: string | undefined): string {
  const base = (executable ?? "").trim().split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** The kind of a remote window from the editor's remote name: `ssh-remote+host` gives `ssh-remote`. */
export function remoteKindOf(name: string | undefined): string {
  const kind = (name ?? "")
    .trim()
    .toLowerCase()
    .split("+")[0]
    .replace(/[^a-z0-9._-]/g, "");
  return kind.slice(0, 24);
}

/**
 * The image as the sentence names it: its last path segment and tag, so a
 * private registry and its path are not sent. `full` keeps the whole
 * reference, without any `user:password@` part and without a digest.
 */
export function imageName(
  image: string,
  full = false,
  clean: (text: string, cap: number) => string = defaultWord,
): string {
  const noDigest = image.trim().split("@sha256:")[0];
  const noCredentials = noDigest.replace(/^[^/@]*@/, "");
  const shown = full
    ? noCredentials
    : (noCredentials.split("/").pop() ?? noCredentials);
  return clean(shown, 160);
}

function isRemote(facts: ShellFacts): boolean {
  return facts.remote !== undefined || facts.shell.source !== "spawned";
}

function remoteSentence(facts: ShellFacts): ShellDescription {
  const kind = remoteKindOf(facts.remote?.name);
  const fields: EnvFieldId[] = ["executionShell", "remoteKind"];
  if (facts.shell.source === "terminal-reported") {
    const reported = reportedShell(facts.shell.kind);
    if (reported) {
      return {
        text: `Commands run in the editor's terminal on the remote machine, which reports ${reported.name}: ${reported.advice}`,
        variant: "remote-reported",
        fields,
      };
    }
  }
  const where = facts.remote?.guessed
    ? "Commands are typed into the editor's terminal, which appears to be on a remote machine (a guess from SSH variables)."
    : `Commands are typed into the editor's terminal on the remote machine${kind ? ` (${kind})` : ""}.`;
  return {
    text: [
      where,
      "Its shell is not known here, the output is not captured, and each command asks the person first.",
      "Send one simple command per call; ; separates commands in bash and PowerShell, while && works only in bash and PowerShell 7.",
      "Ask the person to paste the output when you need it.",
    ].join(" "),
    variant: "remote",
    fields,
  };
}

function reportedShell(
  kind: ShellKind,
): { name: string; advice: string } | undefined {
  switch (kind) {
    case "bash":
    case "zsh":
      return { name: kind, advice: `use ${kind} syntax.` };
    case "sh":
      return { name: "sh", advice: "use POSIX sh syntax, not bash's." };
    case "powershell":
      return {
        name: "PowerShell (5.1 or 7: not known)",
        advice:
          "use PowerShell syntax, and a; if ($?) { b } instead of &&, which 5.1 rejects.",
      };
    case "cmd":
      return { name: "cmd.exe", advice: "chain with && or &, not ;." };
    default:
      return undefined;
  }
}

function wslSentence(wsl: WslExecutorFacts): ShellDescription {
  const distro = wsl.distro ? word(wsl.distro, 40) : "";
  const tools =
    wsl.interop === true
      ? "The distribution has its own python3, node and git, not Windows'; Windows programs need .exe (cmd.exe /c, node.exe)."
      : wsl.interop === false
        ? "The distribution has its own python3, node and git. Windows programs cannot be started from here."
        : "The distribution has its own python3, node and git, not Windows'.";
  return {
    text: [
      `Runs in bash (login shell) inside WSL${distro ? ` (${distro})` : ""}, ${START} under /mnt/<drive>/.`,
      "Use bash syntax and Linux paths: C:\\a\\b is /mnt/c/a/b here (wslpath converts); the file tools take Windows paths.",
      tools,
      "Windows environment variables are not passed in.",
      "Scripts with CRLF line endings fail in bash.",
      "Walking large trees under /mnt/c is slow.",
      NO_PROMPTS,
    ].join(" "),
    variant: "wsl",
    fields: ["executionShell", "wsl"],
  };
}

function containerSentence(
  container: ContainerExecutorFacts,
  options: DescribeShellOptions,
): ShellDescription {
  return {
    text: [
      `Runs in bash inside a container (image ${imageName(container.image, options.fullImage, word)}), started fresh for each command in the workspace folder, the only folder mounted.`,
      container.network === "none"
        ? "There is no network: package installs and downloads fail."
        : "The network is on.",
      container.readOnly === false
        ? "HOME is /tmp."
        : "Only the workspace and /tmp are writable, and HOME is /tmp.",
      "git, node and python may not be in the image.",
      NO_PROMPTS,
    ].join(" "),
    variant: "container",
    fields: ["executionShell", "container"],
  };
}

function posixSentence(
  facts: ShellFacts,
  options: DescribeShellOptions,
): ShellDescription {
  const program = programName(facts.executable);
  const kind = facts.shell.kind;
  const other = kind === "unknown" ? OTHER_SHELLS[program] : undefined;
  const name = other?.name ?? (word(program, 40) || kind);
  const os = facts.os.value;
  const where =
    facts.os.confidence === "unknown"
      ? ""
      : os === "macos"
        ? " on macOS"
        : os === "linux"
          ? " on Linux"
          : "";
  const fields: EnvFieldId[] = ["executionShell"];
  const parts = [`Runs in ${name} (login shell)${where}, ${START}.`];
  if (kind === "sh") {
    parts.push(
      "This is a POSIX sh, not bash: no [[ ]], arrays or other bash-only syntax.",
    );
  }
  if (kind === "unknown") {
    parts.push(
      other?.dialect ??
        "This shell is not one this product recognises: write commands most shells accept.",
      NOT_CHECKED,
    );
  }
  const userland = facts.userland;
  if (userland && userland.confidence !== "unknown") {
    if (userland.value === "bsd") {
      fields.push("userland");
      parts.push(
        `${os === "macos" ? "macOS tools" : "The tools here"} are BSD, not GNU: GNU-only options (for example sed -i without a suffix, grep -P) may fail; prefer POSIX options.`,
      );
    } else if (userland.value === "busybox") {
      fields.push("userland");
      parts.push(
        "The tools here appear to be BusyBox's, not GNU: GNU-only options may fail; prefer POSIX options.",
      );
    }
  }
  const wsl = facts.hostWsl;
  if (wsl?.value === "yes" && wsl.confidence !== "unknown") {
    fields.push("hostWsl");
    parts.push(
      wsl.confidence === "known"
        ? "Windows drives are under /mnt/."
        : "This machine appears to be WSL: Windows drives are under /mnt/.",
    );
  }
  const hint = facts.containerHint;
  if (
    options.containerHint !== false &&
    hint?.inContainer.value === "yes" &&
    hint.inContainer.confidence !== "unknown"
  ) {
    fields.push("containerHint");
    const marker = hint.markers[0] ? ` (${word(hint.markers[0], 80)})` : "";
    parts.push(
      `This machine appears to be a container${marker}: systemd may be missing.`,
    );
  }
  parts.push(NO_PROMPTS);
  return {
    text: parts.join(" "),
    variant: kind === "unknown" ? "other-shell" : "posix",
    fields,
  };
}

/**
 * The sentence and what it was built from. The variant is chosen from the
 * structured facts alone:
 *
 * 1. a remote window, or a shell this process does not start: the remote
 *    wording, which claims no shell;
 * 2. the container executor, then the WSL executor (both are bash by
 *    construction; anything else is a contradiction and gets "not known");
 * 3. PowerShell by the program started (`powershell.exe` is 5.1, `pwsh` is 7
 *    or later), cmd, bash on Windows (Git Bash);
 * 4. a login shell on macOS, Linux or another Unix, with the facts that are
 *    `known` or `likely` and none that are `unknown`.
 */
export function describeExecutionShellParts(
  facts: ShellFacts,
  options: DescribeShellOptions = {},
): ShellDescription {
  const clean = options.value;
  word = clean ? (v, cap) => clean(v.trim(), cap) : defaultWord;
  try {
    return describe(facts, options);
  } finally {
    word = defaultWord;
  }
}

function describe(
  facts: ShellFacts,
  options: DescribeShellOptions,
): ShellDescription {
  if (isRemote(facts)) return remoteSentence(facts);
  const unknown: ShellDescription = {
    text: UNKNOWN,
    variant: "unknown",
    fields: ["executionShell"],
  };
  const kind = facts.shell.kind;
  const windows =
    facts.os.value === "windows" && facts.os.confidence !== "unknown";
  if (facts.container) {
    return kind === "bash"
      ? containerSentence(facts.container, options)
      : unknown;
  }
  if (facts.wsl) {
    return kind === "bash" && windows ? wslSentence(facts.wsl) : unknown;
  }
  const program = programName(facts.executable);
  if (kind === "powershell") {
    const fields: EnvFieldId[] = ["executionShell"];
    if (program === "powershell") {
      return { text: POWERSHELL_51, variant: "powershell-5.1", fields };
    }
    if (program === "pwsh") {
      return { text: POWERSHELL_7, variant: "powershell-7", fields };
    }
    return { text: POWERSHELL_ANY, variant: "powershell", fields };
  }
  if (kind === "cmd") {
    return { text: CMD, variant: "cmd", fields: ["executionShell"] };
  }
  if (windows) {
    return kind === "bash"
      ? { text: GIT_BASH, variant: "git-bash", fields: ["executionShell"] }
      : unknown;
  }
  if (kind === "unknown" && !program) return unknown;
  return posixSentence(facts, options);
}

/** The terminal tool's shell sentence for these facts. */
export function describeExecutionShell(
  facts: ShellFacts,
  options: DescribeShellOptions = {},
): string {
  return describeExecutionShellParts(facts, options).text;
}

/**
 * Where hook commands run, for the hooks help text. Hooks do not use the
 * terminal executor: they go to `cmd.exe /d /s /c` on Windows and to
 * `/bin/sh -c` elsewhere, whatever the terminal shell setting is.
 */
export function describeHookShell(os: OsFamily): string {
  return os === "windows"
    ? "Hook commands run in cmd.exe: chain with && or & (; is not a separator), use %VAR% for variables and double quotes only (single quotes do not quote); there are no Unix tools."
    : "Hook commands run in /bin/sh -c: write POSIX sh, not bash (on some systems sh is dash).";
}

/** The preference shapes of `TerminalShellPreference` in ./shell, as far as the sentence needs them. */
export type ShellPreferenceFact =
  | { kind: "wsl"; distro?: string }
  | { kind: "container"; runtime?: string; image?: string };

/**
 * What the gatherer has in hand, in the shapes the other modules return, so
 * that wiring is one call:
 *
 * - `executionShell`: `executionShell(remoteName, opts)` from ./shell (#758),
 *   passed as it is (`{kind, source, label}`).
 * - `executable`: `resolveShell(opts).executable`.
 * - `preference`: `getTerminalShellPreference()` from ./shell.
 * - `facts`: `environmentFactsOf(...)` from ./environmentFacts (#763); its
 *   `os`, `userland` and `container` fields have the shapes used here. When
 *   it is absent the OS family is read from `platform` alone.
 * - `containerNetwork`: the `network` option the container executor passes
 *   (`containerArgs`, default `none`).
 * - `wslInterop`: from the WSL probe (ENV22); `unknown` until it exists.
 */
export interface ShellFactsSources {
  executionShell: ExecutionShellFact;
  executable?: string;
  platform: string;
  remoteName?: string;
  remoteGuessed?: boolean;
  preference?: ShellPreferenceFact;
  containerNetwork?: "none" | "bridge";
  defaultImage?: string;
  wslInterop?: boolean | "unknown";
  facts?: {
    os?: EnvFact<OsFamily>;
    userland?: EnvFact<Userland>;
    container?: {
      inContainer: EnvFact<YesNoUnknown>;
      markers: readonly string[];
    };
  };
  hostWsl?: EnvFact<YesNoUnknown>;
}

const LOCAL_REMOTE_NAMES = ["", "local", "na"];

function osOfPlatform(platform: string): EnvFact<OsFamily> {
  const value: OsFamily =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "macos"
        : platform === "linux"
          ? "linux"
          : platform
            ? "other"
            : "unknown";
  return {
    value,
    confidence: value === "unknown" ? "unknown" : "known",
    source: `platform ${platform || "not given"}`,
  };
}

/** The adapter from the executor's own values to `ShellFacts`. */
export function shellFactsOf(src: ShellFactsSources): ShellFacts {
  const remoteName = (src.remoteName ?? "").trim();
  const remote = LOCAL_REMOTE_NAMES.includes(remoteName.toLowerCase())
    ? undefined
    : { name: remoteName, guessed: src.remoteGuessed };
  const pref = src.preference;
  return {
    shell: src.executionShell,
    executable: src.executable,
    os: src.facts?.os ?? osOfPlatform(src.platform),
    remote,
    wsl:
      pref?.kind === "wsl" && src.platform === "win32"
        ? { distro: pref.distro, interop: src.wslInterop ?? "unknown" }
        : undefined,
    container:
      pref?.kind === "container"
        ? {
            runtime: pref.runtime,
            image: pref.image ?? src.defaultImage ?? "ubuntu:24.04",
            network: src.containerNetwork ?? "none",
          }
        : undefined,
    userland: src.facts?.userland,
    containerHint: src.facts?.container,
    hostWsl: src.hostWsl,
  };
}
