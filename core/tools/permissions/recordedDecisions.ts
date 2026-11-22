import { BuiltInToolNames } from "../builtIn";

/**
 * The decisions `tools/evaluatePolicy` returned, kept in core by call id, so
 * a later message that asks core to start something can be held to one.
 *
 * The audit trail cannot serve: it can be turned off, and then remembers
 * nothing. This does not depend on it.
 */

export type RecordedPolicy = "allow" | "ask" | "deny";

/** A decision older than this starts nothing: a run follows its decision at once. */
export const DECISION_MAX_AGE_MS = 5 * 60_000;

const MAX_RECORDED = 500;

interface Recorded {
  tool: string;
  /** The terminal command decided on, when the call had one */
  command?: string;
  policy: RecordedPolicy;
  /** The person's answer to an ask, as the webview reported it (audit/answer) */
  approved?: boolean;
  at: number;
}

export type TakenDecision = { ok: true } | { ok: false; reason: string };

export class RecordedDecisions {
  private readonly byCall = new Map<string, Recorded>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The decision for a call. A later one for the same call id replaces it. */
  record(
    callId: string | undefined,
    tool: string,
    parsedArgs: Record<string, unknown> | undefined,
    policy: RecordedPolicy,
  ): void {
    if (typeof callId !== "string" || !callId) return;
    const command = parsedArgs?.command;
    this.byCall.delete(callId);
    this.byCall.set(callId, {
      tool,
      ...(typeof command === "string" ? { command } : {}),
      policy,
      at: this.now(),
    });
    while (this.byCall.size > MAX_RECORDED) {
      const oldest = this.byCall.keys().next().value;
      if (oldest === undefined) break;
      this.byCall.delete(oldest);
    }
  }

  /** The person's answer to a call that asked. Any other call is left as it is. */
  answer(callId: string, approved: boolean): void {
    const found = this.byCall.get(callId);
    if (!found || found.policy !== "ask") return;
    found.approved = approved;
  }

  /**
   * Uses the decision for `callId` to run `command` in the terminal tool: it
   * must be there, recent, for this exact command, and allow the run (allowed
   * outright, or asked and approved). A decision is used once.
   */
  takeTerminalRun(callId: unknown, command: string): TakenDecision {
    const found =
      typeof callId === "string" && callId
        ? this.byCall.get(callId)
        : undefined;
    if (!found) {
      return refused("no decision is recorded for this call");
    }
    if (this.now() - found.at > DECISION_MAX_AGE_MS) {
      this.byCall.delete(callId as string);
      return refused("the decision for this call is too old");
    }
    if (found.tool !== BuiltInToolNames.RunTerminalCommand) {
      return refused(
        "the decision for this call is not for a terminal command",
      );
    }
    if (found.command !== command) {
      return refused("the decision for this call is for a different command");
    }
    if (found.policy === "deny" || found.approved === false) {
      return refused("the command was refused");
    }
    if (found.policy === "ask" && found.approved !== true) {
      return refused("the command needs approval, and none is recorded");
    }
    this.byCall.delete(callId as string);
    return { ok: true };
  }
}

function refused(why: string): TakenDecision {
  return { ok: false, reason: `The command was not run: ${why}.` };
}

/** This process's decisions. */
export const recordedDecisions = new RecordedDecisions();
