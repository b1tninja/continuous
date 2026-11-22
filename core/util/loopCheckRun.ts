import { spawn, type ChildProcess } from "node:child_process";
import { BuiltInToolNames } from "../tools/builtIn";
import type { AuditTrail } from "../tools/permissions/audit/trail";
import { commandLintGate } from "../tools/permissions/commandLint";
import { missingBinaryGate } from "../tools/permissions/missingBinaryGate";
import type { RecordedDecisions } from "../tools/permissions/recordedDecisions";
import { getCommandExecutor, type CommandExecutor } from "./commandExecutor";
import { decodeCommandOutput } from "./commandOutput";
import { spawnAgentCommand } from "./commandSpawn";
import { LOOP_LIMITS } from "./loopMode";
import {
  killCommandsOnExit,
  markProcessAsRunning,
  removeRunningProcess,
} from "./processTerminalStates";
import { executionShell } from "./shell";

/**
 * Loop mode's item checks (TaskItem.check) in the editor, run by core.
 *
 * The webview used to hand the command to the editor's `subprocess`, a plain
 * `exec` on the host: the `terminal.shell` setting (WSL, a container), the
 * environment scrub, the command lint and the audit outcome did not apply, and
 * a check that timed out was left running. A check now starts where a terminal
 * command starts, through the command executor, and is stopped with everything
 * it started when its time is up.
 */

/** A check that runs longer than this is stopped and counts as failed. */
export const LOOP_CHECK_TIMEOUT_MS = 10 * 60_000;

/** How long a stopped check gets after SIGTERM before SIGKILL. */
export const LOOP_CHECK_KILL_GRACE_MS = 2_000;

/**
 * After a stop, how long to wait for the check's streams to close. Something
 * it started can outlive it and hold the pipes open.
 */
export const LOOP_CHECK_FORCE_FINISH_MS = 3_000;

/** What is kept of each stream while the check runs: the end is what is shown. */
const KEPT_OUTPUT_CHARS = LOOP_LIMITS.maxCheckOutput * 4;

export interface LoopCheckRun {
  /** The command's own exit code; null when it did not run, was stopped, or could not start */
  exitCode: number | null;
  /** What it printed (the end of it), or why it did not run */
  output: string;
  /** Stopped because it ran past the time limit */
  timedOut?: true;
  /** Nothing was started: `output` is the reason */
  notRun?: true;
}

export interface LoopCheckOptions {
  /** Where the check starts, and what a container mounts */
  cwd: string;
  /** The editor's remote name: a remote window's commands do not start here */
  remoteName?: string;
  timeoutMs?: number;
  /** For tests: the executor, instead of the one for the current settings */
  executor?: CommandExecutor;
  /** The name the running process is kept under until it ends */
  id?: string;
}

/**
 * Why a check is not started, with the terminal tool's own verdicts: the
 * place it should run in is not there, the lint (a certain mistake always
 * stops it, a likely one stops it once), or its program is missing.
 */
export function loopCheckBlocked(
  command: string,
  executor: CommandExecutor,
  remoteName?: string,
): string | undefined {
  if (executionShell(remoteName).source === "terminal") {
    // The terminal tool types into the remote window's terminal, which gives
    // back no exit code; starting the check here would run it on the wrong
    // machine
    return "The check was not run: in a remote window commands go to the editor's terminal, which cannot report whether a check passed.";
  }
  return (
    executor.unavailable ??
    commandLintGate(command, executor.shell.kind) ??
    missingBinaryGate(command, executor)
  );
}

/**
 * Stops the check and what it started. On Windows taskkill /T takes the tree,
 * and it must find the shell still there: `kill` first would end the shell
 * alone and leave what it started running, with nothing to find it by.
 * Elsewhere the check is its own process group, and the group is signalled.
 */
function stopCheck(child: ChildProcess, signal: NodeJS.Signals): void {
  const fallback = () => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  if (!child.pid) return fallback();
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", fallback);
    } catch {
      fallback();
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // not a group of its own, or already gone
    fallback();
  }
}

/** Runs `command` through the executor and keeps the end of what it printed. */
export async function runLoopCheckCommand(
  command: string,
  opts: LoopCheckOptions,
): Promise<LoopCheckRun> {
  const executor = opts.executor ?? getCommandExecutor();
  const blocked = loopCheckBlocked(command, executor, opts.remoteName);
  if (blocked) return { exitCode: null, output: blocked, notRun: true };

  const timeoutMs = opts.timeoutMs ?? LOOP_CHECK_TIMEOUT_MS;
  let child: ChildProcess;
  try {
    // No `env`: the executor gives the scrubbed one (terminalEnvironment)
    child = await spawnAgentCommand(executor, command, {
      cwd: opts.cwd,
      windowsHide: true,
      // Its own process group on POSIX, so a stop reaches what it started
      detached: process.platform !== "win32",
    });
  } catch (error) {
    return {
      exitCode: null,
      output: error instanceof Error ? error.message : String(error),
      notRun: true,
    };
  }

  // Nothing the loop starts outlives the window
  const id = opts.id ?? `loop-check-${child.pid ?? Date.now()}`;
  killCommandsOnExit();
  markProcessAsRunning(id, child);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null, fallback = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      removeRunningProcess(id);
      const output = [stdout, stderr]
        .filter((s) => s.trim())
        .join("\n")
        .trim();
      resolve({
        exitCode,
        output: output || fallback,
        ...(timedOut ? { timedOut: true as const } : {}),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stopCheck(child, "SIGTERM");
      killTimer = setTimeout(
        () => stopCheck(child, "SIGKILL"),
        LOOP_CHECK_KILL_GRACE_MS,
      );
      forceTimer = setTimeout(() => {
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        finish(null);
      }, LOOP_CHECK_FORCE_FINISH_MS);
    }, timeoutMs);

    const keep = (text: string, data: Buffer | string) =>
      (
        text + (typeof data === "string" ? data : decodeCommandOutput(data))
      ).slice(-KEPT_OUTPUT_CHARS);
    child.stdout?.on("data", (data) => (stdout = keep(stdout, data)));
    child.stderr?.on("data", (data) => (stderr = keep(stderr, data)));
    child.on("error", (error) => finish(null, error.message));
    // A check that was stopped has no exit code of its own: taskkill makes
    // it 1, and that is not what the check chose
    child.on("close", (code) =>
      finish(typeof code === "number" && !timedOut ? code : null),
    );
  });
}

/**
 * Runs a check and writes how it ended to the audit trail, under the call id
 * of the decision the webview asked for (tools/evaluatePolicy), as a terminal
 * command's outcome is written.
 *
 * The message comes from the webview, which renders what models and web pages
 * wrote, so its word that the check was allowed is not taken: core must hold
 * a decision for this call id and this exact command that allows the run.
 * Without one nothing starts, and the refusal is written to the trail.
 */
export async function runAuditedLoopCheck(
  input: { command: string; callId: string },
  deps: LoopCheckOptions & {
    trail: Pick<AuditTrail, "decision" | "outcome">;
    decisions: Pick<RecordedDecisions, "takeTerminalRun">;
    run?: typeof runLoopCheckCommand;
  },
): Promise<LoopCheckRun> {
  const { trail, decisions, run = runLoopCheckCommand, ...opts } = deps;
  const { command } = input;
  // The webview names the call; one it did not name is still written
  const callId =
    typeof input.callId === "string" && input.callId
      ? input.callId
      : `loop-check-${Date.now()}`;
  if (typeof command !== "string" || !command.trim()) {
    return {
      exitCode: null,
      output: "The check has no command.",
      notRun: true,
    };
  }
  const taken = decisions.takeTerminalRun(input.callId, command);
  if (!taken.ok) {
    trail.decision({
      callId,
      tool: BuiltInToolNames.RunTerminalCommand,
      args: JSON.stringify({ command }),
      policy: "deny",
      by: "system",
      source: "recorded-decision",
      reason: taken.reason,
    });
    trail.outcome({ callId, ran: false, error: taken.reason });
    return { exitCode: null, output: taken.reason, notRun: true };
  }
  const startedAt = Date.now();
  const result = await run(command, { ...opts, id: callId });
  trail.outcome({
    callId,
    tool: BuiltInToolNames.RunTerminalCommand,
    ran: !result.notRun,
    ...(typeof result.exitCode === "number" ? { exit: result.exitCode } : {}),
    ...(result.timedOut ? { timedOut: true as const } : {}),
    ...(result.timedOut
      ? { error: "timed out" }
      : result.notRun || result.exitCode !== 0
        ? { error: lastLine(result.output) || "the check failed" }
        : {}),
    durMs: Date.now() - startedAt,
    output: result.output,
  });
  return result;
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
