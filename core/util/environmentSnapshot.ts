/**
 * The gatherer (plans/research/env-disclosure-master-plan.md, sections 3.2
 * and 3.4, row ENV6): the only impure part of the environment disclosure. It
 * reads the machine once per session and returns the frozen
 * `EnvironmentSnapshot` that ./environmentPrompt renders. The snapshot is
 * saved with the session and reused on resume, so a resumed session keeps the
 * bytes it started with.
 *
 * Every read is guarded: a reader that fails gives an absent or `unknown`
 * fact, never a throw. Each git call is asynchronous and stops after 2
 * seconds, so a slow repository cannot hold up the first request.
 *
 * #758 (`executionShell`) and #763 (`environmentFactsOf`) are not on `main`
 * yet, so `executionShellOf` here is the local adapter with the same
 * `{kind, source, label}` shape; once they land it becomes one import.
 */
import { execFile } from "node:child_process";
import os from "node:os";

import type { Detail } from "./environmentContract";
import type { EnvironmentSnapshot } from "./environmentPrompt";
import { localDayOf } from "./environmentUpdate";
import {
  configuredTerminalShellPreference,
  getTerminalShellPreference,
  resolveShell,
  type ShellEnvironment,
  type TerminalShellPreference,
} from "./shell";
import {
  programName,
  shellFactsOf,
  type EnvFact,
  type ExecutionShellFact,
  type ShellFacts,
  type YesNoUnknown,
} from "./shellDescription";

export { localDayOf };

export const GIT_TIMEOUT_MS = 2000;
export const DETAIL_LEVELS: readonly Detail[] = ["minimal", "standard", "full"];
export const DEFAULT_DETAIL: Detail = "standard";

const LOCAL_REMOTE_NAMES = ["", "local", "na"];

function isRemoteName(remoteName: string | undefined): boolean {
  return !LOCAL_REMOTE_NAMES.includes((remoteName ?? "").trim().toLowerCase());
}

/** `minimal`, `standard` or `full`, in any case; anything else is `undefined`. */
export function parseEnvDetail(value: unknown): Detail | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return (DETAIL_LEVELS as readonly string[]).includes(v)
    ? (v as Detail)
    : undefined;
}

// The fields of ShellEnvironment, written out so the type survives in
// packages that resolve core's declarations with node16 rules
export interface ExecutionShellInput extends ShellEnvironment {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  terminalShell?: TerminalShellPreference | "default";
  /** The editor's remote name (`ideInfo.remoteName`); absent or `local` on this machine. */
  remoteName?: string;
}

/**
 * The shell that really reads a command, as #758's `executionShell()`
 * returns it. A remote editor window starts no shell: the command is typed
 * into the editor's terminal, whose shell is not known here.
 */
export function executionShellOf(
  input: ExecutionShellInput = {},
): ExecutionShellFact {
  if (isRemoteName(input.remoteName)) {
    return {
      kind: "unknown",
      source: "terminal",
      label: `the shell of the editor's terminal (${(input.remoteName ?? "").trim()})`,
    };
  }
  const resolved = resolveShell(input);
  const preference = preferenceOf(input);
  const platform = input.platform ?? process.platform;
  let label: string;
  if (preference?.kind === "container") label = "bash in a container";
  else if (platform === "win32" && preference?.kind === "wsl") {
    label = "bash in WSL";
  } else {
    const program = programName(resolved.executable);
    label =
      program === "powershell"
        ? "Windows PowerShell 5.1"
        : program === "pwsh"
          ? "PowerShell 7"
          : program || resolved.kind;
  }
  return { kind: resolved.kind, source: "spawned", label };
}

function preferenceOf(
  input: ShellEnvironment,
): TerminalShellPreference | undefined {
  if (input.terminalShell === "default") return undefined;
  return input.terminalShell ?? getTerminalShellPreference(input.env);
}

/** What the gatherer reads besides git; each has a default from this process. */
export interface GatherInput extends ExecutionShellInput {
  /** The CLI's working folder. */
  cwd?: string;
  /** The editor's workspace folders (paths or file URIs). */
  roots?: readonly string[];
  /** Where git runs; the cwd, or the first root that is a local folder. */
  gitCwd?: string;
  /** Leave git out (a remote window: the local git cannot read the remote repository). */
  skipGit?: boolean;
  now?: Date;
  /** For tests: runs `git <args>` in `cwd` and gives stdout, or throws. */
  git?: (args: string[], cwd: string) => Promise<string>;
  /** For tests: the machine reads (home, account, host, addresses, WSL). */
  machine?: Partial<MachineReads>;
  /** Whether `/proc/version` names WSL (the CLI inside a distribution). */
  hostWsl?: boolean;
  timeoutMs?: number;
}

export interface MachineReads {
  home: string;
  user: string | undefined;
  hostName: string | undefined;
  addresses: string[];
  arch: string;
  osRelease: string;
  timeZone: string | undefined;
  locale: string | undefined;
}

function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function machineReads(): MachineReads {
  return {
    home: guarded(() => os.homedir(), ""),
    user: guarded(() => os.userInfo().username, undefined),
    hostName: guarded(() => os.hostname(), undefined),
    addresses: guarded(
      () =>
        Object.values(os.networkInterfaces())
          .flat()
          .filter((a) => !!a && !a.internal)
          .map((a) => a!.address),
      [],
    ),
    arch: guarded(() => os.arch(), ""),
    osRelease: guarded(() => os.release(), ""),
    timeZone: guarded(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      undefined,
    ),
    locale: guarded(
      () => Intl.DateTimeFormat().resolvedOptions().locale,
      undefined,
    ),
  };
}

function gitRunner(timeoutMs: number) {
  return (args: string[], cwd: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
}

function isTimeout(error: unknown): boolean {
  const e = error as { killed?: boolean; signal?: string; code?: string };
  return !!e && (e.killed === true || e.code === "ETIMEDOUT");
}

/** A local folder from a root that may be a `file://` URI; `undefined` for any other scheme. */
export function localFolderOf(root: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) return root;
  if (!/^file:\/\//i.test(root)) return undefined;
  try {
    const path = decodeURIComponent(new URL(root).pathname);
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
  } catch {
    return undefined;
  }
}

/** The shell half of the snapshot: synchronous, from settings and the process alone. */
export function gatherShellFacts(given: GatherInput = {}): ShellFacts {
  // A new snapshot reads the setting, not a shell an earlier session froze
  const input: GatherInput = {
    ...given,
    terminalShell:
      given.terminalShell ??
      configuredTerminalShellPreference(given.env) ??
      "default",
  };
  const platform = input.platform ?? process.platform;
  const preference = preferenceOf(input);
  const resolved = guarded(() => resolveShell(input), undefined);
  const hostWsl: EnvFact<YesNoUnknown> | undefined =
    input.hostWsl === undefined
      ? undefined
      : {
          value: input.hostWsl ? "yes" : "no",
          confidence: "known",
          source: "/proc/version",
        };
  return shellFactsOf({
    executionShell: guarded(() => executionShellOf(input), {
      kind: "unknown",
      source: "spawned",
      label: "not known",
    }),
    executable: resolved?.executable,
    platform,
    remoteName: input.remoteName,
    preference:
      preference?.kind === "wsl"
        ? { kind: "wsl", distro: preference.distro }
        : preference?.kind === "container"
          ? {
              kind: "container",
              runtime: preference.runtime,
              image: preference.image,
            }
          : undefined,
    // The container executor passes no network option, so `none` is in force
    containerNetwork: "none",
    // The WSL probe (ENV22) is not built yet
    wslInterop: "unknown",
    hostWsl,
  });
}

/**
 * The snapshot without git: what can be read synchronously. The system line
 * and the tool sentence render the same from this as from the full snapshot,
 * so a caller that cannot wait still gets the session's S0 and S1 bytes.
 */
export function baseSnapshot(input: GatherInput = {}): EnvironmentSnapshot {
  const m = { ...machineReads(), ...input.machine };
  const now = input.now ?? new Date();
  const platform = input.platform ?? process.platform;
  return {
    version: 1,
    takenAt: now.toISOString(),
    localDay: localDayOf(now),
    timeZone: m.timeZone,
    locale: m.locale,
    platform,
    arch: m.arch,
    osRelease: m.osRelease,
    shell: gatherShellFacts(input),
    workspace: {
      home: m.home,
      user: m.user,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.roots === undefined ? {} : { roots: [...input.roots] }),
    },
    neverSend: {
      hostName: m.hostName,
      addresses: m.addresses,
    },
  };
}

/**
 * The whole snapshot, once per session: `baseSnapshot` plus git (repository,
 * branch, `status --porcelain -z`, the origin URL) and the git identity for
 * the never-send list. Each git call stops after `timeoutMs`.
 */
export async function gatherEnvironment(
  input: GatherInput = {},
): Promise<EnvironmentSnapshot> {
  const snapshot = baseSnapshot(input);
  const remote = isRemoteName(input.remoteName);
  const cwd =
    input.gitCwd ??
    input.cwd ??
    (input.roots ?? []).map(localFolderOf).find((r) => r !== undefined);
  if (input.skipGit || remote || !cwd) return snapshot;
  const run = input.git ?? gitRunner(input.timeoutMs ?? GIT_TIMEOUT_MS);
  const read = async (args: string[]) => {
    try {
      return { out: await run(args, cwd) };
    } catch (error) {
      return { error, timedOut: isTimeout(error) };
    }
  };
  const inside = await read(["rev-parse", "--is-inside-work-tree"]);
  if (inside.out === undefined || inside.out.trim() !== "true") {
    snapshot.git = { isRepo: false };
    return snapshot;
  }
  const [branch, status, origin, name, email] = await Promise.all([
    read(["branch", "--show-current"]),
    read(["status", "--porcelain", "-z"]),
    read(["remote", "get-url", "origin"]),
    read(["config", "user.name"]),
    read(["config", "user.email"]),
  ]);
  snapshot.git = {
    isRepo: true,
    ...(branch.out?.trim() ? { branch: branch.out.trim() } : {}),
    ...(status.out === undefined ? {} : { statusZ: status.out }),
    ...(status.timedOut ? { statusTimedOut: true } : {}),
    ...(origin.out?.trim() ? { remoteUrl: origin.out.trim() } : {}),
  };
  snapshot.neverSend = {
    ...snapshot.neverSend,
    ...(name.out?.trim() ? { gitUserName: name.out.trim() } : {}),
    ...(email.out?.trim() ? { gitUserEmail: email.out.trim() } : {}),
  };
  return snapshot;
}

/** A saved snapshot this version can reuse; anything else is regathered. */
export function isEnvironmentSnapshot(
  value: unknown,
): value is EnvironmentSnapshot {
  const v = value as Partial<EnvironmentSnapshot> | undefined;
  return (
    !!v &&
    typeof v === "object" &&
    v.version === 1 &&
    typeof v.localDay === "string" &&
    typeof v.platform === "string" &&
    !!v.shell &&
    typeof v.shell === "object" &&
    !!v.shell.shell &&
    !!v.workspace &&
    typeof v.workspace.home === "string"
  );
}

/** The executor facts the snapshot froze, as the shell preference to run with (ENV13). */
export function frozenTerminalShell(
  snapshot: EnvironmentSnapshot,
): TerminalShellPreference | "default" {
  const { wsl, container } = snapshot.shell;
  if (container) {
    const runtime =
      container.runtime === "docker" || container.runtime === "podman"
        ? container.runtime
        : undefined;
    return {
      kind: "container",
      ...(runtime ? { runtime } : {}),
      image: container.image,
    };
  }
  if (wsl)
    return { kind: "wsl", ...(wsl.distro ? { distro: wsl.distro } : {}) };
  return "default";
}
