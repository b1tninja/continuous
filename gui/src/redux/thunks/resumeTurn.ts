import { createAsyncThunk } from "@reduxjs/toolkit";
import type { JSONContent } from "@tiptap/react";
import {
  findResumableTurn,
  RESUME_CANCELLED_TOOL_NOTE,
  RESUME_PROMPT,
} from "../../util/resumeTurn";
import { ThunkApiType } from "../store";
import { streamResponseThunk } from "./streamResponse";

function textEditorState(text: string): JSONContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/**
 * Resume for the last turn when it was stopped, failed or cut off by a
 * reload, through the normal send path. A partial answer is kept and the
 * model is asked to go on from it; a turn with no answer sends its message
 * again. Tool calls that ran keep their results and are not run again; a
 * call cancelled before it ran is not run either: the model is told so and
 * calls it again if it needs to, which asks for approval as the current mode
 * decides.
 */
export const resumeTurn = createAsyncThunk<void, undefined, ThunkApiType>(
  "chat/resumeTurn",
  async (_, { dispatch, getState }) => {
    const state = getState();
    if (state.session.isStreaming) return;
    const plan = findResumableTurn(state.session.history);
    if (!plan) return;

    if (plan.kind === "regenerate") {
      const user = state.session.history[plan.userIndex];
      await dispatch(
        streamResponseThunk({
          editorState: user.editorState,
          modifiers: user.modifiers ?? { useCodebase: false, noContext: true },
          index: plan.userIndex,
        }),
      );
      return;
    }

    const text = plan.cancelledToolCall
      ? `${RESUME_PROMPT}\n\n${RESUME_CANCELLED_TOOL_NOTE}`
      : RESUME_PROMPT;
    await dispatch(
      streamResponseThunk({
        editorState: textEditorState(text),
        modifiers: { useCodebase: false, noContext: true },
      }),
    );
  },
);
