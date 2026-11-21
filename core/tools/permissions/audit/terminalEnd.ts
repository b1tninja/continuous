import type { ContextItem } from "../../../index";
import { findCommand } from "../../../util/commandOutputStore";

/**
 * What the audit trail records about how a terminal command ended.
 *
 * The outcome event used to carry `exit` only when the tool threw. A command
 * that ran and exited non-zero returns an ordinary result, so 709 of 710
 * terminal outcomes in the usage data had none, and nothing could say how
 * often a command failed. The command's record holds the code; this reads it.
 */
export interface TerminalEnd {
  /**
   * The exit code. Absent for a command ended by a signal: such a command has
   * no code, and recording one (the 1 it used to get, or 0) would be a guess.
   */
  exit?: number;
  /** The signal that ended it (SIGTERM, SIGKILL) */
  signal?: string;
  /** Why it counts as failed, for the audit's step detection */
  error?: string;
  /** Ended by the foreground time limit. A stop we asked for is not this. */
  timedOut?: true;
}

/** Last non-empty line of the output, trimmed, as the failure's label. */
function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/**
 * The end of a terminal command, from the items its tool returned. Undefined
 * for any other tool and for a command that is still running (a background
 * command returns before it ends).
 *
 * A command that exited has its code. One ended by a signal (the time limit,
 * a stop, a runaway check) has no code, and is reported by its signal: it used
 * to be reported as nothing, so a command that hit its time limit left no
 * outcome at all.
 */
export function terminalEndOf(
  items: readonly ContextItem[] | undefined,
): TerminalEnd | undefined {
  const withOutput = items?.find((i) => i.commandOutput?.id);
  const id = withOutput?.commandOutput?.id;
  if (!id) return undefined;
  const record = findCommand(id);
  if (!record || record.endedAt === undefined) return undefined;
  const code = record.exitCode;
  const label = lastLine(withOutput?.content ?? "");
  const end: TerminalEnd = {};
  if (typeof code === "number") {
    end.exit = code;
    if (code !== 0) end.error = label || `exited with code ${code}`;
  } else if (record.signal || record.timedOut || record.stoppedFor) {
    // No code, so the failure is the way it ended
    if (record.signal) end.signal = record.signal;
    end.error = record.timedOut
      ? "timed out"
      : label || (record.signal ? `ended by ${record.signal}` : "stopped");
  } else {
    // Ended with neither a code nor a known reason: nothing to say
    return undefined;
  }
  if (record.signal && typeof code === "number") end.signal = record.signal;
  if (record.timedOut) end.timedOut = true;
  return end;
}
