/**
 * Which shell runs a terminal command, in one place. The runners, the command
 * classifiers and the permission engine all need the same answer: a command
 * means what its shell makes of it, and `date 1-1-20`, `find`, `sort` and a
 * backtick are not the same thing in bash, PowerShell and cmd
 * (plans/command-analysis.md).
 */
import { containerArgs } from "./containerArgs";
import { sourceEncodedArgs } from "./sourceEncoded";

export { sourceEncodedArgs };
export type ShellKind =
  /** bash, and any shell that starts as one */
  | "bash"
  | "zsh"
  /** sh, dash, ash: the POSIX subset */
  | "sh"
  /** Windows PowerShell 5.1 and PowerShell 7+ */
  | "powershell"
  | "cmd"
  /** fish, nushell, ksh, tcsh, or anything not recognised: never vouched */
  | "unknown";

/** Shells whose grammar is POSIX's (bash and zsh add to it). */
export const POSIX_SHELLS: readonly ShellKind[] = ["bash", "zsh", "sh"];

export function isPosixShell(kind: ShellKind | undefined): boolean {
  return !!kind && POSIX_SHELLS.includes(kind);
}

/** The kind of shell an executable is, from its name alone. */
export function shellKindOf(executable: string | undefined): ShellKind {
  const name = (executable ?? "")
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  switch (name) {
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "sh":
    case "dash":
    case "ash":
      return "sh";
    case "powershell":
    case "pwsh":
      return "powershell";
    case "cmd":
      return "cmd";
    default:
      return "unknown";
  }
}

/**
 * `command` followed by a PowerShell tail that exits with the code the
 * command's last native program chose. `powershell -Command` reports 1 for
 * any failing native command, so a check that exits 3 would come back as 1.
 * `$LASTEXITCODE` is cleared first so a stale code from an earlier statement
 * is not reported, and `$?` decides success so `node -e "process.exit(3)";
 * echo hi` is still 0, as it is without the tail. A failing cmdlet leaves
 * `$LASTEXITCODE` null and exits 1. Other shells report the real code
 * already and get `command` back unchanged.
 *
 * `resetFirst: false` leaves out the line that clears `$LASTEXITCODE`, so the
 * command stays on line 1 and PowerShell's own error text ("At line:1
 * char:5") is what it would be without the tail: the terminal tools use it,
 * because the model reads that text. The price is small: when the last
 * statement is a failing cmdlet, no native program ran in the command, and
 * the person's profile left a non-zero `$LASTEXITCODE`, that stale number is
 * reported in place of 1 (a failure either way).
 */
export function withRealExitCode(
  command: string,
  kind: ShellKind,
  opts: { resetFirst?: boolean } = {},
): string {
  if (kind !== "powershell") return command;
  // Newlines, not `;`: a trailing `# comment` must not swallow the tail
  return [
    ...(opts.resetFirst === false ? [] : ["$global:LASTEXITCODE = $null"]),
    command,
    "$__ok = $?",
    "if ($__ok) { exit 0 }",
    "if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "exit 1",
  ].join("\n");
}

export interface ResolvedShell {
  kind: ShellKind;
  executable: string;
  /** The arguments that make the shell run `command` and exit */
  args: (command: string) => string[];
  /** Start-up files run before the command, so the person's own code does */
  runsProfile: boolean;
}

export interface ShellEnvironment {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Overrides the process-wide preference and `CONTINUOUS_TERMINAL_SHELL` */
  terminalShell?: TerminalShellPreference | "default";
}

/** The host user, for a container that writes files as them (not on Windows). */
export function hostUser(): { uid: number; gid: number } | undefined {
  return typeof process.getuid === "function" &&
    typeof process.getgid === "function"
    ? { uid: process.getuid(), gid: process.getgid() }
    : undefined;
}

/**
 * Where the person asked terminal commands to run instead of the host's own
 * shell: in a WSL distribution on Windows (plans/isolation.md, W1), or in a
 * container (W2), `docker run` or `podman run` once per command.
 */
export type TerminalShellPreference =
  | {
      kind: "wsl";
      /** The distribution (`wsl -l`); the default distribution when absent */
      distro?: string;
    }
  | {
      kind: "container";
      /** docker or podman; docker if present, else podman, when absent */
      runtime?: "docker" | "podman";
      /** The image; `ubuntu:24.04` when absent */
      image?: string;
    };

/**
 * `wsl` or `wsl:<distribution>` (also `wsl/<distribution>`), as written in
 * the `CONTINUOUS_TERMINAL_SHELL` environment variable. Anything else,
 * including `default`, is no preference.
 */
export function parseTerminalShell(
  value: string | undefined,
): TerminalShellPreference | undefined {
  const text = (value ?? "").trim();
  const m = /^wsl(?:[:/](.+))?$/i.exec(text);
  if (m) {
    const distro = m[1]?.trim();
    return distro ? { kind: "wsl", distro } : { kind: "wsl" };
  }
  // container, container:docker, container:podman:<image>, container:<image>;
  // an image may hold a colon (a tag), so only a leading runtime name is split off
  const c = /^container(?::(.*))?$/i.exec(text);
  if (!c) return undefined;
  let rest = (c[1] ?? "").trim();
  let runtime: "docker" | "podman" | undefined;
  const r = /^(docker|podman)(?::(.*))?$/i.exec(rest);
  if (r) {
    runtime = r[1].toLowerCase() as "docker" | "podman";
    rest = (r[2] ?? "").trim();
  }
  return {
    kind: "container",
    ...(runtime ? { runtime } : {}),
    ...(rest ? { image: rest } : {}),
  };
}

let configuredShell: TerminalShellPreference | undefined;

/** Set by the editor from its settings; `undefined` goes back to the default. */
export function setTerminalShellPreference(
  preference: TerminalShellPreference | undefined,
): void {
  configuredShell = preference;
}

let sessionShell: TerminalShellPreference | "default" | undefined;

/**
 * Freezes the shell for the editor's current session at the one its
 * environment snapshot names, so the prompt (which says which shell runs a
 * command) and the executor cannot disagree when the setting changes during
 * the session (plans/research/env-disclosure-master-plan.md 3.7, ENV13).
 * `"default"` is the host's own shell; `undefined` follows the setting again.
 */
export function setSessionTerminalShell(
  preference: TerminalShellPreference | "default" | undefined,
): void {
  sessionShell = preference;
}

export function getTerminalShellPreference(
  env: Record<string, string | undefined> = process.env,
): TerminalShellPreference | undefined {
  if (sessionShell !== undefined) {
    return sessionShell === "default" ? undefined : sessionShell;
  }
  return configuredShell ?? parseTerminalShell(env.CONTINUOUS_TERMINAL_SHELL);
}

/** The setting as configured, ignoring a session's frozen shell: what a new session starts with. */
export function configuredTerminalShellPreference(
  env: Record<string, string | undefined> = process.env,
): TerminalShellPreference | undefined {
  return configuredShell ?? parseTerminalShell(env.CONTINUOUS_TERMINAL_SHELL);
}

/**
 * The arguments that make `wsl.exe` run `command` in bash exactly as written.
 * The command is sent as base64 and sourced from a process substitution:
 * `wsl.exe` re-parses its command line, which was seen to drop the quotes
 * from `<<'EOF'` (so `$HOME` expanded inside a quoted heredoc), while base64
 * has no characters to mangle. Sourcing keeps the command in the login shell
 * itself, so `exit N`, `cd` and standard input behave as they do for
 * `bash -c`. A Windows command line holds about 32,000 characters, so a very
 * long command (over about 24,000 before encoding) fails to start.
 */
export function wslArgs(command: string, distro?: string): string[] {
  return [
    ...(distro ? ["-d", distro] : []),
    "--",
    ...sourceEncodedArgs(command),
  ];
}

/**
 * The shell terminal commands run in: Windows PowerShell on Windows, the
 * person's login shell elsewhere. When `$SHELL` is not set (an editor started
 * from the Dock on some setups), that is zsh on macOS, every new account's
 * shell since 10.15, and bash elsewhere. WSL is a
 * Linux, so it takes the second branch. On Windows a preference for WSL
 * (`terminalShell`, the editor's setting, or `CONTINUOUS_TERMINAL_SHELL`) runs
 * commands in bash inside that distribution instead.
 */
export function resolveShell(opts: ShellEnvironment = {}): ResolvedShell {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const preference =
    opts.terminalShell === "default"
      ? undefined
      : (opts.terminalShell ?? getTerminalShellPreference(env));
  if (preference?.kind === "container") {
    // The command is bash's inside the container, whatever the host is. The
    // executor picks the runtime and the mounted folder; this is the shape
    // other readers of the shell (the policy's classifiers) need.
    const runtime = preference.runtime ?? "docker";
    return {
      kind: "bash",
      executable: runtime,
      args: (command) =>
        containerArgs(command, {
          runtime,
          image: preference.image,
          cwd: process.cwd(),
          platform,
          user: hostUser(),
        }),
      runsProfile: false,
    };
  }
  if (platform === "win32" && preference?.kind === "wsl") {
    // The command is bash's, whatever the host is: the classifiers, the
    // lint and the policy engine read it with bash's grammar
    return {
      kind: "bash",
      executable: "wsl.exe",
      args: (command) => wslArgs(command, preference.distro),
      runsProfile: true,
    };
  }
  if (platform === "win32") {
    return {
      kind: "powershell",
      executable: "powershell.exe",
      // -NonInteractive: a prompt (Read-Host, a confirmation, a cmdlet asking
      // for a missing mandatory parameter such as the `curl` alias's -Uri)
      // fails at once with PowerShell's own error instead of waiting for an
      // answer nobody can type
      args: (command) => [
        "-NoLogo",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
      // No -NoProfile: the person's profile runs first
      runsProfile: true,
    };
  }
  const executable =
    env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return {
    kind: shellKindOf(executable),
    executable,
    args: (command) => ["-l", "-c", command],
    runsProfile: true,
  };
}

/**
 * The editor's remote names for which the terminal tool starts the shell
 * itself, on this machine. For any other (SSH, a WSL window, a dev container,
 * Codespaces) the command is typed into the editor's integrated terminal on
 * the other machine.
 */
export const LOCAL_REMOTE_NAMES: readonly string[] = ["", "local"];

export interface ExecutionShell {
  /** The grammar to read the command with; "unknown" when it cannot be told */
  kind: ShellKind;
  /**
   * "spawned": this process starts the shell, so the kind is a fact.
   * "terminal": the command is sent to a terminal whose shell this process
   * cannot see (its profile on the other machine, or whatever is running in
   * it), so the kind is unknown and never this machine's own shell.
   */
  source: "spawned" | "terminal";
  /** Words for a person: "Windows PowerShell 5.1", "bash in WSL", "the remote terminal's shell". */
  label: string;
}

/** The words for a shell this process starts itself. */
export function shellLabel(shell: ResolvedShell): string {
  const program = (shell.executable.split(/[\/]/).pop() ?? "").toLowerCase();
  if (program === "wsl.exe") return "bash in WSL";
  if (program === "docker" || program === "podman")
    return "bash in a container";
  // powershell.exe is Windows PowerShell, whose last version is 5.1; pwsh is 7 or later
  if (program === "powershell.exe" || program === "powershell") {
    return "Windows PowerShell 5.1";
  }
  if (program === "pwsh" || program === "pwsh.exe")
    return "PowerShell 7 or later";
  return shell.kind === "unknown"
    ? `${program || "a shell"} (not a shell this product parses)`
    : program || shell.kind;
}

/**
 * The shell a terminal command will really be read by, and how that is known.
 * The permission engine, the lint and the audit record must use this, not
 * `resolveShell()` alone: in a remote window `resolveShell()` describes the
 * machine the editor runs on (PowerShell on a Windows laptop) while the
 * command is read by the terminal on the other side (bash on a Linux host).
 * With no remote name (the CLI, a test) the shell is the one started here.
 */
export function executionShell(
  remoteName?: string,
  opts: ShellEnvironment = {},
): ExecutionShell {
  if (remoteName !== undefined && !LOCAL_REMOTE_NAMES.includes(remoteName)) {
    return {
      kind: "unknown",
      source: "terminal",
      label: `the shell of the editor's terminal (${remoteName})`,
    };
  }
  const shell = resolveShell(opts);
  return { kind: shell.kind, source: "spawned", label: shellLabel(shell) };
}
