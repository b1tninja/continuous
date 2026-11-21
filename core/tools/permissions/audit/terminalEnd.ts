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
  exit: number;
  /** Why it counts as failed, for the audit's step detection (non-zero only) */
  error?: string;
  /** Ended by the time limit, or stopped by us */
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
 * for any other tool, for a command that is still running (a background
 * command returns before it ends), and for one with no recorded code.
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
  if (typeof code !== "number") return undefined;
  const end: TerminalEnd = { exit: code };
  if (code !== 0) {
    end.error =
      lastLine(withOutput?.content ?? "") || `exited with code ${code}`;
  }
  if (record.stoppedFor) end.timedOut = true;
  return end;
}
