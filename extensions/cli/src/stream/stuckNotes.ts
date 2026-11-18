import type { ChatHistoryItem } from "core/index.js";
import { readAuditSession } from "core/tools/permissions/audit/reader.js";
import type { AuditRecord } from "core/tools/permissions/audit/record.js";
import { auditToSteps } from "core/tools/permissions/audit/steps.js";
import { stuckAgentNoteOf } from "core/tools/permissions/audit/stuckAgents.js";
import { stepsFromHistory } from "core/util/stuckHistory.js";
import {
  stripStuckNote,
  STUCK_NOTE_MARK,
  stuckNote,
} from "core/util/stuckNotes.js";
import { detectStuck, type StuckStep } from "core/util/stuckSignals.js";

/**
 * L1 of the stuck ladder (plans/stuck-detection.md, S2) for the CLI: after a
 * round of tool calls, read the history with the shared signals and, if one
 * has reached `note`, give the text to append to the newest result.
 *
 * Off with CONTINUE_CLI_DISABLE_STUCK_NOTES=1 (the `stuckDetection` setting of
 * S6 does not exist yet). Notes are on by default (decision D3).
 */
export function stuckNotesEnabled(): boolean {
  const v = process.env.CONTINUE_CLI_DISABLE_STUCK_NOTES;
  return !v || v === "0" || v.toLowerCase() === "false";
}

/** The history as the signals should read it: without the notes themselves. */
function withoutNotes(history: ChatHistoryItem[]): ChatHistoryItem[] {
  return history.map((item) => {
    if (!item.toolCallStates?.some((s) => hasNote(s.output))) return item;
    return {
      ...item,
      toolCallStates: item.toolCallStates.map((s) => ({
        ...s,
        output: s.output?.map((o) => ({
          ...o,
          content: stripStuckNote(o.content ?? ""),
        })),
      })),
    };
  });
}

function hasNote(output: { content?: string }[] | undefined): boolean {
  return !!output?.some((o) => o.content?.includes(STUCK_NOTE_MARK));
}

/**
 * The note to append to the newest result, or undefined. When the history
 * holds no steps (compacted away, or not kept), `auditSteps` supplies them
 * from the audit trail (plans/reviewer-audit.md, section 8). The history stays
 * the first source: with steps in it nothing changes.
 */
export function stuckNoteForHistory(
  history: ChatHistoryItem[],
  auditSteps?: () => StuckStep[],
  auditRecords?: () => readonly AuditRecord[],
): string | undefined {
  if (!stuckNotesEnabled()) return undefined;
  let steps = stepsFromHistory(withoutNotes(history));
  if (steps.length === 0 && auditSteps) {
    try {
      steps = auditSteps();
    } catch {
      // the audit is an optional second source
    }
  }
  // The main agent's own note first; else the note of an agent that is not
  // the main one (a subagent or a Loop worker), named, so one agent's repeats
  // are neither hidden by another's calls nor charged to it (S7).
  return stuckNote(detectStuck(steps)) ?? otherAgentNote(auditRecords);
}

function otherAgentNote(
  auditRecords?: () => readonly AuditRecord[],
): string | undefined {
  if (!auditRecords) return undefined;
  try {
    return stuckAgentNoteOf(auditRecords());
  } catch {
    return undefined;
  }
}

/** The records of a session read from the audit trail in `dir`. */
export function auditRecordsOf(dir: string, session: string): AuditRecord[] {
  return readAuditSession(dir, session);
}

/** The steps of a session read from the audit trail in `dir`. */
export function auditStepsOf(dir: string, session: string): StuckStep[] {
  return auditToSteps(readAuditSession(dir, session));
}
