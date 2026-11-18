import { getAuditTrail } from "../audit/global";
import {
  readTaintedSessionRule,
  type TaintedSessionRule,
} from "./taintSetting";
import {
  secretSourceForAudit,
  secretSourceOfCall,
  taintLabelsOfCall,
  type SourceCall,
} from "./taintSources";
import {
  DEFAULT_TAINT_SESSION,
  secretReads,
  taintRegistry,
  type SecretRead,
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
 * The few functions the hosts call. The taint labels do nothing when the
 * person's `taintedSessionRule` is `off`, which is the default: no mark, no
 * fact for the evaluator or the reviewer, no field in the audit record. The
 * one exception is B92's secret read (`secretReads`), which is noted and
 * handed to the evaluator whatever the rule says.
 */

/**
 * The evaluator input for a call: `{ taint }` for a tainted session (rule
 * `ask` only) and `{ secretRead }` when a secret was read in the session
 * (always), else nothing.
 */
export function taintInput(
  session: string | undefined,
  callId?: string,
  rule: TaintedSessionRule = readTaintedSessionRule(),
): { taint?: TaintFact; secretRead?: SecretRead } {
  const key = session ?? DEFAULT_TAINT_SESSION;
  if (callId) taintRegistry.bindCall(callId, key);
  const secretRead = secretReads.get(key);
  const secret = secretRead ? { secretRead } : {};
  if (rule !== "ask") return secret;
  const taint = taintRegistry.fact(key);
  return taint ? { taint, ...secret } : secret;
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
    const session =
      note.session ??
      taintRegistry.sessionOfCall(note.callId) ??
      DEFAULT_TAINT_SESSION;
    noteSecretRead(note, session);
    if (rule !== "ask") return undefined;
    const labels = taintLabelsOfCall(note.call);
    if (labels.length === 0) return undefined;
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
 * B92: the call read a secret (a file tool's read of a protected secret
 * path, `~/.npmrc` included, a command that reads such a file or sends it, or
 * one that prints a credential). Noted whatever `taintedSessionRule` says,
 * with a `secret-read` audit record the first time. Never throws.
 */
function noteSecretRead(note: ToolResultNote, session: string): void {
  if (note.call.mcp) return;
  const source = secretSourceOfCall(note.call);
  if (!source) return;
  const turn = note.turn === undefined ? {} : { turn: note.turn };
  if (!secretReads.mark(session, { source, ...turn })) return;
  // The record a later `secret-egress` decision is explained by
  try {
    getAuditTrail().secretRead({
      session,
      source: secretSourceForAudit(note.call) ?? source,
      ...turn,
    });
  } catch {
    // the trail is best effort
  }
}

/**
 * The person acknowledged the content, or started over: the session is clean
 * again. `source` names the control that cleared it, for the audit record.
 * Only a new session ends B92's secret read; acknowledging content does not.
 */
export function untaintSession(
  session: string | undefined,
  reason: TaintClearReason,
  source?: string,
  labels?: readonly TaintLabel[],
): TaintLabel[] {
  const key = session ?? DEFAULT_TAINT_SESSION;
  if (reason === "new-session") secretReads.clear(key);
  return taintRegistry.clear(key, reason, source, labels);
}

/** B92: what read a secret in this session, if anything did. */
export function secretReadOf(
  session: string | undefined,
): SecretRead | undefined {
  return secretReads.get(session ?? DEFAULT_TAINT_SESSION);
}

/** The labels a session holds now, in their fixed order. */
export function taintLabels(session: string | undefined): TaintLabel[] {
  return taintRegistry.fact(session ?? DEFAULT_TAINT_SESSION)?.kinds ?? [];
}
