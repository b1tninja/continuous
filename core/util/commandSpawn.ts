import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { CommandExecutor } from "./commandExecutor";
import { getTerminalShellPreference, withRealExitCode } from "./shell";
import {
  passedEnvNames,
  withPagerDefaults,
  withWslEnvNames,
} from "./terminalEnvironment";

/**
 * How a command the agent starts is given its standard streams, in one place
 * for every terminal tool (the editor's, the CLI's, background jobs and loop
 * checks).
 *
 * Nobody is there to type an answer, so standard input is not a pipe that
 * stays open: a command that reads it (`read x` in bash, `Read-Host`, a
 * confirmation, `git commit` with no message) used to wait until the tool's
 * timeout. With "ignore" the child reads the null device and sees end of file
 * at once, in WSL and in a container as well: `wsl.exe` and `docker run -i`
 * pass their own standard input on.
 *
 * A caller that really feeds a command (a hook's JSON on standard input) does
 * not use this and keeps its pipe.
 */
export const COMMAND_STDIO: ["ignore", "pipe", "pipe"] = [
  "ignore",
  "pipe",
  "pipe",
];

/**
 * The program and arguments a terminal tool starts for `command`, with the
 * exit code the command's own program chose. Windows PowerShell's `-Command`
 * reports 1 for any failing native program (`node -e "process.exit(3)"` came
 * back as 1), so the result the model and the person read named a code no
 * program returned. Other shells already report the real code and get the
 * command unchanged. What is shown, approved, linted and audited is still
 * `command` itself: only the text handed to the shell carries the tail, and
 * the tail prints nothing.
 */
export function realExitInvocation(
  executor: Pick<CommandExecutor, "invocation" | "shell">,
  command: string,
  cwd?: string,
): { shell: string; args: string[] } {
  return executor.invocation(realExitCommand(executor, command), cwd);
}

/** The text handed to the shell for `command`: `command` with the real-exit tail where the shell needs one. */
function realExitCommand(
  executor: Pick<CommandExecutor, "shell">,
  command: string,
): string {
  return withRealExitCode(command, executor.shell.kind, { resetFirst: false });
}

/**
 * Starts a command the agent asked for, the one way every terminal tool does
 * it (the editor's three paths, the CLI's tool and its background jobs):
 * through the executor, so the shell, WSL or a container and anything that
 * later wraps them (an OS sandbox) are chosen in one place, with the exit code
 * the command's own program chose (`realExitInvocation`). The caller passes
 * the environment (`commandEnvironment(terminalEnvironment(...))`) and the
 * streams; `cwd` is where the command starts and what a container mounts.
 */
export function spawnAgentCommand(
  executor: Pick<CommandExecutor, "spawn" | "shell">,
  command: string,
  options: SpawnOptions,
): Promise<ChildProcess> {
  return executor.spawn(realExitCommand(executor, command), options);
}

/**
 * The last step for the environment of a command a terminal tool starts.
 * `env` is the host's environment after the scrub (`terminalEnvironment`);
 * this adds what a command with no terminal needs: pagers that print and end
 * (`withPagerDefaults`, which leaves the person's `terminal.passEnv` names
 * alone). When the command runs in WSL, the `terminal.passEnv` names are added
 * to `WSLENV` so they arrive there (`withWslEnvNames`).
 */
export function commandEnvironment(
  env: Readonly<Record<string, string>>,
  opts: { platform?: NodeJS.Platform; wsl?: boolean } = {},
): Record<string, string> {
  const platform = opts.platform ?? process.platform;
  const wsl =
    opts.wsl ??
    (platform === "win32" && getTerminalShellPreference()?.kind === "wsl");
  const paged = withPagerDefaults(env, { platform });
  return wsl ? withWslEnvNames(paged, passedEnvNames()) : paged;
}
