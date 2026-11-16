import type { ToolPolicyResult, EvaluateInput } from "../evaluate";
import { sinkOfCall, type Sink, type SinkClass } from "./taintSinks";
import type { SecretRead, TaintFact } from "./taintState";

/**
 * The sinks a session that holds only the `secret` label asks on: the ones
 * that send data out. Another local secret read or a write outside the
 * workspace moves nothing off the machine, so a secret alone leaves them be.
 * With any untrusted-content label present every sink asks, as before.
 */
const EGRESS_SINKS: ReadonlySet<SinkClass> = new Set([
  "network-egress",
  "vcs-publish",
  "package-publish",
  "mcp-send",
]);

function secretOnly(taint: TaintFact): boolean {
  return taint.kinds.every((k) => k === "secret");
}

/**
 * The tainted-session rule as a deterministic step after every other check:
 * when untrusted content has entered the session and the call is a sink, an
 * allow becomes an ask. It only raises. A refusal, a floor rule, a protected
 * path and a call that already asks are returned as they are, and no level,
 * rule or reviewer verdict later turns the ask back into an allow (the Auto
 * handler lists `tainted-session` among the sources it cannot move).
 * plans/design/tainted-session.md.
 */
export const TAINTED_SESSION_SOURCE = "tainted-session" as const;

export interface TaintedSessionInput {
  /** Set by the host only when `taintedSessionRule` is `ask` and the session is tainted */
  taint?: TaintFact;
  /**
   * B92: a secret was read in this session. Set by the host whatever
   * `taintedSessionRule` says (taintWiring.ts `taintInput`).
   */
  secretRead?: SecretRead;
}

export function reasonOf(sink: Sink, taint: TaintFact): string {
  const untrusted = taint.kinds.filter((k) => k !== "secret");
  const secret = taint.kinds.includes("secret");
  const what = untrusted.length
    ? `Untrusted content (${untrusted.join(", ")}) entered this session${secret ? " and a secret was read in it" : ""}`
    : "A secret was read in this session";
  return `${what}, and this call can send data out or change state (${sink.class}: ${sink.detail}), so it asks. Acknowledge the content to stop these asks.`;
}

/**
 * Whether the rule applies to a call, without changing a result (the replay
 * uses this). With `taint` given, a session that holds `secret` makes a
 * trusted host an egress too.
 */
export function taintSinkFor(
  input: EvaluateInput,
  taint?: TaintFact,
): Sink | undefined {
  const { tool, toolName, parsedArgs, processedArgs } = input;
  return sinkOfCall({
    toolName,
    parsedArgs,
    tool,
    resolved: processedArgs?.resolvedPath as
      { isWithinWorkspace: boolean } | null | undefined,
    trustedDomains: input.trustedDomains,
    secretHeld: !!taint?.kinds.includes("secret"),
    shell: input.shell,
  });
}

export function applyTaintedSessionRule(
  input: EvaluateInput & TaintedSessionInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  const { taint } = input;
  if (!taint || taint.kinds.length === 0) return result;
  const sink = taintSinkFor(input, taint);
  if (!sink) return result;
  if (secretOnly(taint) && !EGRESS_SINKS.has(sink.class)) return result;
  // Named on every result of a tainted session, so a replay can count the
  // calls the rule would ask on that already ask
  if (result.policy !== "allowedWithoutPermission") {
    return { ...result, taintSink: sink };
  }
  // The allow rule that matched would read as a contradiction beside the new reason
  const { rule: _allowRule, ...rest } = result;
  return {
    ...rest,
    policy: "allowedWithPermission",
    taintSink: sink,
    source: TAINTED_SESSION_SOURCE,
    reason: reasonOf(sink, taint),
  };
}

/**
 * B92, the exfiltration pair: a session that read a secret, then a call that
 * can send data out (a network destination, a push, a publish, an MCP send).
 * It does not depend on `taintedSessionRule`.
 *
 * - Below IDGAF it asks the person, at every level: an allow (Permissive, an
 *   allow rule, a tool set to run on its own) becomes an ask, and an ask that
 *   Automatic's reviewer could have answered becomes the person's.
 * - At IDGAF it is refused, with or without Questions at IDGAF. IDGAF never
 *   asks, so the choice there is run or refuse, and a secret leaving the
 *   machine is the one call IDGAF refuses rather than runs.
 *
 * A call already refused stays refused. plans/decisions-2026-11-15.md, B92.
 */
export const SECRET_EGRESS_SOURCE = "secret-egress" as const;

const SECRET_ONLY: TaintFact = { kinds: ["secret"] };

function sendsTo(sink: Sink): string {
  if (sink.class === "network-egress") return `send it to ${sink.detail}`;
  if (sink.class === "mcp-send") {
    return `send it to the MCP tool ${sink.detail}`;
  }
  return `send it out with ${sink.detail}`;
}

/** The reason a person and the model are given for the pair. */
export function secretEgressReason(
  sink: Sink,
  read: SecretRead,
  atIdgaf: boolean,
): string {
  const pair = `A secret was read in this session (${read.source}), and this call can ${sendsTo(sink)} (${sink.class})`;
  return atIdgaf
    ? `Refused at IDGAF: ${pair}. IDGAF runs every other call, but a secret leaving the machine is refused there, with or without Questions at IDGAF, and is never asked. To send it, set this area below IDGAF and approve the call, or run it yourself.`
    : `${pair}, so it asks at every level. At IDGAF it is refused.`;
}

/**
 * The B92 step, after every other one (idgafRunsEverything included, so
 * IDGAF cannot run the pair). `atIdgaf` is read only when the pair applies.
 */
export function applySecretEgressRule(
  input: EvaluateInput & TaintedSessionInput,
  result: ToolPolicyResult,
  atIdgaf: () => boolean,
): ToolPolicyResult {
  const read = input.secretRead;
  if (!read) return result;
  // A tool the person switched off stays off, as it would anyway
  if (input.basePolicy === "disabled") return result;
  const sink = taintSinkFor(input, SECRET_ONLY);
  if (!sink || !EGRESS_SINKS.has(sink.class)) return result;
  // A refusal stays as it is (below IDGAF; IDGAF has run past every other one)
  if (result.policy === "disabled") {
    return { ...result, taintSink: result.taintSink ?? sink };
  }
  const idgaf = atIdgaf();
  const reason = secretEgressReason(sink, read, idgaf);
  if (idgaf) {
    // What IDGAF ran past no longer describes the call: it is refused
    const {
      rule: _rule,
      protection: _protection,
      idgafOverride: _override,
      ...rest
    } = result;
    return {
      ...rest,
      policy: "disabled",
      source: SECRET_EGRESS_SOURCE,
      taintSink: sink,
      reason,
    };
  }
  if (result.policy === "allowedWithoutPermission") {
    // The allow rule that matched would read as a contradiction beside the new reason
    const { rule: _rule, ...rest } = result;
    return {
      ...rest,
      policy: "allowedWithPermission",
      source: SECRET_EGRESS_SOURCE,
      taintSink: sink,
      reason,
    };
  }
  // Already an ask: it becomes the person's (no reviewer answers it), and
  // what else made it ask is kept after the pair's reason
  return {
    ...result,
    source: SECRET_EGRESS_SOURCE,
    taintSink: sink,
    reason: result.reason ? `${reason} ${result.reason}` : reason,
  };
}
