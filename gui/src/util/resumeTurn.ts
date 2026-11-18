import type { ChatHistoryItem, TurnInterruption } from "core";
import { renderChatMessage } from "core/util/messageContent";

/** What the model is asked when Resume continues a partial answer. */
export const RESUME_PROMPT =
  "Continue your response exactly where you left off:";
/** Added when a tool call in the stopped turn was cancelled before it ran. */
export const RESUME_CANCELLED_TOOL_NOTE =
  "A tool call that was cancelled did not run. Call it again if you still need it.";

/**
 * How Resume carries on the last turn:
 * - continue: the turn has an answer (text, tool calls or tool results), so a
 *   short user message asks the model to go on from it;
 * - regenerate: the turn ended before any answer (only reasoning, or nothing),
 *   so the user message at `userIndex` is sent again in its place.
 */
export type ResumePlan =
  | { kind: "continue"; userIndex: number; cancelledToolCall: boolean }
  | { kind: "regenerate"; userIndex: number };

function hasAnswer(item: ChatHistoryItem): boolean {
  const { message } = item;
  if (message.role === "tool") return true;
  if (message.role !== "assistant") return false;
  return !!message.toolCalls?.length || !!renderChatMessage(message).trim();
}

/** The Resume plan for the last turn, when it was stopped, failed or cut off. */
export function findResumableTurn(
  history: ChatHistoryItem[],
): ResumePlan | undefined {
  let userIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].message.role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) return undefined;
  const turn = history.slice(userIndex);
  if (!turn.some((item) => item.interrupted)) return undefined;

  const answered = turn.slice(1).some(hasAnswer);
  if (!answered && history[userIndex].editorState) {
    return { kind: "regenerate", userIndex };
  }
  const cancelledToolCall = turn.some((item) =>
    item.toolCallStates?.some((call) => call.status === "canceled"),
  );
  return { kind: "continue", userIndex, cancelledToolCall };
}

/**
 * For a session being loaded: a turn the window closed or reloaded on (a
 * reply still reasoning, a tool call still being written or running, or no
 * reply yet) is marked so the chat offers Resume. Call it before the tool
 * calls are ended (it reads their saved status). Mutates `history`.
 */
export function markTurnCutOffOnLoad(
  history: ChatHistoryItem[],
  reason: TurnInterruption = "reloaded",
): void {
  const last = history.at(-1);
  if (!last) return;
  let userIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].message.role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) return;
  const turn = history.slice(userIndex);
  if (turn.some((item) => item.interrupted)) return;

  const cutOff =
    last.message.role === "user" ||
    last.message.role === "thinking" ||
    (last.message.role === "assistant" &&
      !last.message.toolCalls?.length &&
      !renderChatMessage(last.message).trim()) ||
    // Tool calls that finished but whose results the model never read
    (last.message.role === "assistant" &&
      !!last.toolCallStates?.length &&
      last.toolCallStates.every(
        (call) => call.status === "done" || call.status === "errored",
      )) ||
    turn.some(
      (item) =>
        item.reasoning?.active ||
        item.toolCallStates?.some(
          (call) => call.status === "generating" || call.status === "calling",
        ),
    );
  if (!cutOff) return;

  for (const item of turn) {
    if (item.reasoning?.active) {
      item.reasoning.active = false;
      item.reasoning.endAt = item.reasoning.endAt ?? Date.now();
    }
  }
  last.interrupted = reason;
}
