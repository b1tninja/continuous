import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { COMMAND_STDIO, commandEnvironment } from "./commandSpawn";
import { containerArgs } from "./containerArgs";
import {
  containerUnavailableMessage,
  DEFAULT_CONTAINER_IMAGE,
  pickContainerRuntime,
  type ContainerStatus,
} from "./containerStatus";
import { terminalEnvironment } from "./terminalEnvironment";
import { wslStatus, wslUnavailableMessage, type WslDistro } from "./wslStatus";
import {
  getTerminalShellPreference,
  hostUser,
  resolveShell,
  type ResolvedShell,
  type ShellEnvironment,
  type TerminalShellPreference,
} from "./shell";

/**
 * Where and how a terminal command runs, in one place (plans/isolation.md,
 * W0). The IDE's and the CLI's terminal tools ask for an executor instead of
 * choosing a shell themselves, so a new place to run commands (a container, a
 * dev container, an OS sandbox) is a new executor and not a change to every
 * tool.
 *
 * Today there are two: the machine's own shell, and bash inside a WSL
 * distribution (`CONTINUOUS_TERMINAL_SHELL` and the editor's setting). The
 * interface is small on purpose: what the command analysis needs to read the
 * command (the shell), how to start it, and a sentence saying where it runs.
 */
export interface CommandExecutor {
  kind: "local" | "wsl" | "container";
  /**
   * The shell that parses the command. The command lint, the classifiers and
   * the policy engine read it with this shell's grammar, whatever the host is.
   */
  shell: ResolvedShell;
  /**
   * The program and arguments that run `command` and exit, started from `cwd`
   * (the process's own working folder when not given). A container mounts
   * `cwd`, so a caller that starts the command elsewhere must pass it.
   */
  invocation(command: string, cwd?: string): { shell: string; args: string[] };
  /**
   * Starts `command`, the only way a tool starts an agent command. Options are
   * those of `child_process.spawn`. It resolves once the process is running
   * and rejects with the error that kept it from starting (a shell that is not
   * there), so a caller never misses that error. It is asynchronous because an
   * executor may have to prepare something first (an OS sandbox).
   */
  spawn(command: string, options?: SpawnOptions): Promise<ChildProcess>;
  /** One sentence saying where commands run, for a status line or a tool description. */
  describe(): string;
  /**
   * Why commands cannot run here (WSL asked for but not installed, a
   * distribution that is not there), or undefined when they can. The tools
   * return it instead of running the command: an executor that is not there
   * fails closed and never falls back to the host's shell.
   */
  unavailable?: string;
}

/** The executor for the current settings, or for `opts` when given. */
export function getCommandExecutor(
  opts: ShellEnvironment & {
    wslDistros?: WslDistro[];
    /** For tests: the container runtime's status, instead of asking it */
    containerStatus?: ContainerStatus;
  } = {},
): CommandExecutor {
  const preference =
    opts.terminalShell === "default"
      ? undefined
      : (opts.terminalShell ?? getTerminalShellPreference(opts.env));
  if (preference?.kind === "container") {
    return containerExecutor(preference, opts);
  }
  const shell = resolveShell(opts);
  const wsl = shell.executable.toLowerCase().endsWith("wsl.exe");
  const unavailable = wsl
    ? wslUnavailableMessage(
        wslStatus(wslDistroOf(shell), {
          platform: opts.platform,
          distros: opts.wslDistros,
        }),
      )
    : undefined;
  return {
    unavailable,
    kind: wsl ? "wsl" : "local",
    shell,
    invocation: (command) => ({
      shell: shell.executable,
      args: shell.args(command),
    }),
    // A caller that passes its own `env` owns it; otherwise the host's
    // secrets are not handed on (terminalEnvironment). The same for `stdio`:
    // without one, standard input is not left open (COMMAND_STDIO)
    spawn: async (command, options) =>
      started(
        spawn(shell.executable, shell.args(command), {
          ...options,
          stdio: options?.stdio ?? COMMAND_STDIO,
          env: options?.env ?? commandEnvironment(terminalEnvironment()),
        }),
      ),
    describe: () =>
      wsl
        ? "bash inside WSL, started from the workspace folder"
        : `${shell.kind} on this machine`,
  };
}

/**
 * Resolves with `child` once it is running ("spawn"), or rejects with the
 * error that kept it from starting. Waiting for one of the two means the
 * error cannot be emitted before the caller has listeners on the process.
 */
function started(child: ChildProcess): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve(child);
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

/** The distribution named in a WSL invocation (`-d <name>`), or undefined for the default. */
function wslDistroOf(shell: ResolvedShell): string | undefined {
  const args = shell.args("");
  const i = args.indexOf("-d");
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * One `docker run` or `podman run` per command (plans/isolation.md, W2): the
 * workspace the command starts in is the only thing mounted, there is no
 * network, no capability, no Docker socket and no host environment, and the
 * image cannot be changed (see `containerArgs`). Where the runtime is missing
 * or its daemon is not running the executor is `unavailable`: the command is
 * not run and never falls back to the host's shell.
 */
function containerExecutor(
  preference: Extract<TerminalShellPreference, { kind: "container" }>,
  opts: ShellEnvironment & { containerStatus?: ContainerStatus },
): CommandExecutor {
  const status =
    opts.containerStatus ??
    pickContainerRuntime(preference.runtime, { platform: opts.platform });
  const runtime =
    "runtime" in status ? status.runtime : (preference.runtime ?? "docker");
  const image = preference.image ?? DEFAULT_CONTAINER_IMAGE;
  const platform = opts.platform ?? process.platform;
  const run = (command: string, cwd: string) =>
    containerArgs(command, { runtime, image, cwd, platform, user: hostUser() });
  const cwdOf = (options?: SpawnOptions) =>
    typeof options?.cwd === "string" ? options.cwd : process.cwd();
  return {
    kind: "container",
    unavailable: containerUnavailableMessage(status),
    // The command is bash's inside the container, whatever the host is
    shell: {
      kind: "bash",
      executable: runtime,
      args: (command) => run(command, process.cwd()),
      runsProfile: false,
    },
    // The folder mounted is the one the command starts in, never the
    // process's own: in an editor that is not the workspace (W28)
    invocation: (command, cwd) => ({
      shell: runtime,
      args: run(command, cwd ?? process.cwd()),
    }),
    spawn: async (command, options) =>
      started(
        spawn(runtime, run(command, cwdOf(options)), {
          ...options,
          stdio: options?.stdio ?? COMMAND_STDIO,
        }),
      ),
    describe: () =>
      `bash in a ${runtime} container (${image}): the workspace folder only, no network, no capabilities, no host secrets`,
  };
}
