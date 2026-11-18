import type { ToolCallState, ToolStatus } from "core";
import {
  maskArgsForDisplay,
  maskCommandForDisplay,
} from "core/tools/permissions/displayMask";

const MAX_DETAIL = 120;
export const REPLY_SUMMARY_CHARS = 200;

const DETAIL_KEYS = ["command", "filepath", "path", "url", "query"] as const;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** The tool's name as a person knows it. */
export function toolLabel(state: ToolCallState): string {
  return state.tool?.displayTitle ?? state.toolCall.function.name;
}

/** The one argument that says what the call does, masked for display. */
export function toolDetail(state: ToolCallState): string {
  const args = maskArgsForDisplay(state.parsedArgs ?? {}) as Record<
    string,
    unknown
  >;
  for (const key of DETAIL_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return clip(v.trim(), MAX_DETAIL);
  }
  return "";
}

/** "Approval needed: Run terminal command: npm test". Never carries a secret. */
export function approvalAnnouncement(calls: ToolCallState[]): string {
  if (calls.length === 0) return "";
  const first = calls[0];
  const detail = toolDetail(first);
  const what = detail ? `${toolLabel(first)}: ${detail}` : toolLabel(first);
  const more = calls.length > 1 ? ` and ${calls.length - 1} more` : "";
  return maskCommandForDisplay(`Approval needed: ${what}${more}`);
}

const STATUS_WORDS: Partial<Record<ToolStatus, string>> = {
  calling: "running",
  done: "finished",
  errored: "failed",
  canceled: "canceled",
};

/** The polite sentence for a tool call that changed state, or "" if it is not worth one. */
export function statusAnnouncement(state: ToolCallState): string {
  const word = STATUS_WORDS[state.status];
  return word ? `${toolLabel(state)} ${word}` : "";
}

/** First characters of a finished reply, masked; the whole point is not to read a long answer aloud. */
export function replySummary(text: string): string {
  const flat = maskCommandForDisplay(text).replace(/\s+/g, " ").trim();
  if (!flat) return "Assistant finished";
  return `Assistant replied: ${clip(flat, REPLY_SUMMARY_CHARS)}`;
}
