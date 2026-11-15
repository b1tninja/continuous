import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";

import { compactionHoldFor, draftTokens } from "../../util/compactionHold";
import { selectSelectedChatModel } from "../slices/configSlice";
import { setCompactionHold } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { addUserInputToHistory } from "./addUserInputToHistory";
import { applyPreparedCompactionForTurn } from "./prepareCompaction";
import { checkpointSession } from "./session";
import { streamNormalInput } from "./streamNormalInput";
import { streamThunkWrapper } from "./streamThunkWrapper";

export const streamResponseThunk = createAsyncThunk<
  void,
  {
    editorState: JSONContent;
    modifiers: InputModifiers;
    index?: number;
    /**
     * The person's own message from the chat input: it may wait before a
     * forced re-read (util/compactionHold.ts). Loops and resumed turns are
     * never held.
     */
    holdBeforeForcedReread?: boolean;
  },
  ThunkApiType
>(
  "chat/streamResponse",
  async (
    { editorState, modifiers, index, holdBeforeForcedReread },
    { dispatch, extra, getState },
  ) => {
    const atEnd =
      index === undefined || index >= getState().session.history.length;
    if (holdBeforeForcedReread && atEnd) {
      const hold = compactionHoldFor(getState(), draftTokens(editorState));
      if (hold) {
        dispatch(
          setCompactionHold({
            planId: hold.plan.id,
            rereadTokens: hold.rereadTokens,
            editorState,
            modifiers,
            ...(index !== undefined && { index }),
          }),
        );
        return;
      }
    }
    // A summary prepared for this conversation is saved before the message
    // is added, so this turn is the switch-over (C105, C106, D3)
    if (atEnd) applyPreparedCompactionForTurn(dispatch, getState);

    await dispatch(
      streamThunkWrapper(async () => {
        const state = getState();
        const selectedChatModel = selectSelectedChatModel(state);
        const inputIndex = index ?? state.session.history.length; // Either given index or concat to end

        if (!selectedChatModel) {
          throw new Error("No chat model selected");
        }
        const { legacyCommandWithInput, selectedContextItems, selectedCode } =
          await addUserInputToHistory({
            editorState,
            modifiers,
            index: inputIndex,
            dispatch,
            getState,
            ideMessenger: extra.ideMessenger,
          });
        // On disk before the answer starts: a window that dies mid-turn
        // reopens with the message and Resume (STOR6)
        void checkpointSession(getState, extra.ideMessenger);

        unwrapResult(
          await dispatch(
            streamNormalInput({
              legacySlashCommandData: legacyCommandWithInput
                ? {
                    command: legacyCommandWithInput.command,
                    contextItems: selectedContextItems,
                    historyIndex: inputIndex,
                    input: legacyCommandWithInput.input,
                    selectedCode,
                  }
                : undefined,
            }),
          ),
        );
      }),
    );
  },
);
