import { getAuditTrail } from "../audit/global";
import {
  readTaintedSessionRule,
  type TaintedSessionRule,
} from "./taintSetting";
import { taintLabelsOfCall, type SourceCall } from "./taintSources";
import {
  DEFAULT_TAINT_SESSION,
  taintRegistry,
  type TaintChange,
  type TaintClearReason,
  type TaintFact,
  type TaintLabel,
} from "./taintState";

/**
 * Every add and clear goes to the audit trail as a `taint` record. Nothing is
 * marked while the rule is `off`, so nothing is written either. Never throws.
 */
export function recordTaintChange(change: TaintChange): void {
  try {
    getAuditTrail().taint(change);
  } catch {
    // the trail is best effort
  }
}

taintRegistry.setListener(recordTaintChange);

/**
 * The few functions the hosts call. Each does nothing when the person's
 * `taintedSessionRule` is `off`, which is the default: no mark, no fact for
 * the evaluator or the reviewer, no field in the audit record.
 */

/** The evaluator input for a call: `{ taint }` for a tainted session, else nothing. */
export function taintInput(
  session: string | undefined,
  callId?: string,
  rule: TaintedSessionRule = readTaintedSessionRule(),
): { taint?: TaintFact } {
  if (rule !== "ask") return {};
  const key = session ?? DEFAULT_TAINT_SESSION;
  if (callId) taintRegistry.bindCall(callId, key);
  const taint = taintRegistry.fact(key);
  return taint ? { taint } : {};
}

/** The audit record's `tainted` field: source kinds, never content. */
export function taintedField(
  session: string | undefined,
  rule: TaintedSessionRule = readTaintedSessionRule(),
): { tainted?: string[] } {
  if (rule !== "ask") return {};
  const kinds = taintRegistry.fact(session ?? DEFAULT_TAINT_SESSION)?.kinds;
  return kinds?.length ? { tainted: [...kinds] } : {};
}

export interface ToolResultNote {
  call: SourceCall;
  /** The session when the host knows it; otherwise the one the call was evaluated in */
  session?: string;
  callId?: string;
  turn?: number;
}

/**
 * A tool result has entered the conversation: mark the session when the call
 * that fetched it is a source. Returns the kind marked, if any. Never throws.
 */
export function noteToolResult(
  note: ToolResultNote,
  rule: TaintedSessionRule = readTaintedSessionRule(),
): TaintLabel | undefined {
  try {
    if (rule !== "ask") return undefined;
    const labels = taintLabelsOfCall(note.call);
    if (labels.length === 0) return undefined;
    const session =
      note.session ??
      taintRegistry.sessionOfCall(note.callId) ??
      DEFAULT_TAINT_SESSION;
    for (const label of labels) {
      taintRegistry.mark(session, label, note.turn, {
        source: note.call.toolName,
      });
    }
    return labels[0];
  } catch {
    return undefined;
  }
}

/**
 * The person acknowledged the content, or started over: the session is clean
 * again. `source` names the control that cleared it, for the audit record.
 */
export function untaintSession(
  session: string | undefined,
  reason: TaintClearReason,
  source?: string,
  labels?: readonly TaintLabel[],
): TaintLabel[] {
  return taintRegistry.clear(
    session ?? DEFAULT_TAINT_SESSION,
    reason,
    source,
    labels,
  );
}

/** The labels a session holds now, in their fixed order. */
export function taintLabels(session: string | undefined): TaintLabel[] {
  return taintRegistry.fact(session ?? DEFAULT_TAINT_SESSION)?.kinds ?? [];
}
