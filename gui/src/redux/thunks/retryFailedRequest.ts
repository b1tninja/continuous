import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import type { JSONContent } from "@tiptap/core";
import { findResumableTurn } from "../../util/resumeTurn";
import { clearTurnInterruption } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { resumeTurn } from "./resumeTurn";
import { streamNormalInput } from "./streamNormalInput";
import { streamResponseThunk } from "./streamResponse";
import { streamThunkWrapper } from "./streamThunkWrapper";

/** What Try again does after a failed request, by how the turn was left. */
export type RetryPlan =
  /** The request carried a tool result as its last message: send it again unchanged. */
  | { kind: "resend" }
  /** Part of an answer was kept: Resume carries on from it. */
  | { kind: "resume" }
  /** The failed message went back to the input: send it as a new message. */
  | { kind: "send-input" }
  | { kind: "none" };

/** True when the input holds some text. */
export function inputHasText(input: JSONContent | undefined): boolean {
  const walk = (node: JSONContent | undefined): boolean =>
    !!node &&
    ((typeof node.text === "string" && node.text.trim() !== "") ||
      (node.content ?? []).some(walk));
  return walk(input);
}

export function retryPlanFor(
  history: { message: { role: string } }[],
  hasInput: boolean,
): RetryPlan {
  const last = history.at(-1);
  if (last?.message.role === "tool") return { kind: "resend" };
  if (findResumableTurn(history as never)) return { kind: "resume" };
  return hasInput ? { kind: "send-input" } : { kind: "none" };
}

/**
 * Try again after a failed request (the error dialog's button and its
 * countdown). It sends what failed again without rewriting the
 * conversation, so a local server's prompt cache reads it as the same prompt
 * (docs: "Why a turn re-reads the whole prompt").
 *
 * It used to re-send the history item at the last user or tool message. A
 * failed new message is no longer in the history (it goes back to the input),
 * so that re-sent the turn before it without its attachments, and after a
 * tool call it turned the tool result into an empty user message: the result
 * was lost and the next request rewrote the end of the conversation.
 */
export const retryFailedRequest = createAsyncThunk<
  void,
  /** The input: a failed new message is put back there (clearDanglingMessages). */
  { input?: JSONContent },
  ThunkApiType
>("chat/retryFailedRequest", async ({ input }, { dispatch, getState }) => {
  const state = getState();
  if (state.session.isStreaming) return;
  const plan = retryPlanFor(state.session.history, inputHasText(input));
  if (plan.kind === "resend") {
    dispatch(clearTurnInterruption());
    await dispatch(
      streamThunkWrapper(async () => {
        unwrapResult(await dispatch(streamNormalInput({})));
      }),
    );
  } else if (plan.kind === "resume") {
    await dispatch(resumeTurn());
  } else if (plan.kind === "send-input" && input) {
    await dispatch(
      streamResponseThunk({
        editorState: input,
        modifiers: { noContext: true, useCodebase: false },
      }),
    );
  }
});
