import type { ToolPolicyResult, EvaluateInput } from "../evaluate";
import { sinkOfCall, type Sink, type SinkClass } from "./taintSinks";
import type { TaintFact } from "./taintState";

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
