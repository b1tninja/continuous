import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  ApplyState,
  ApplyToFilePayload,
  ContextItem,
  ToolCallState,
} from "core";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import {
  editFailureResult,
  type EditNotAppliedReason,
} from "core/edit/editFailure";
import { logAgentModeEditOutcome } from "../../util/editOutcomeLogger";
import {
  allowOutsideWorkspaceOf,
  outsideEditNote,
} from "../../util/outsideEdits";
import {
  problemsAfterEdit,
  rememberProblemsBeforeEdit,
} from "../../util/problemsAfterEdit";
import {
  selectApplyStateByToolCallId,
  selectToolCallById,
} from "../selectors/selectToolCalls";
import { updateEditStateApplyState } from "../slices/editState";
import {
  acceptToolCall,
  cancelToolCall,
  errorToolCall,
  updateApplyState,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById, logToolUsage } from "../util";
import { exitEdit } from "./edit";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

/**
 * The file as the model named it: the result must name the path the model
 * can use again, and the apply state carries a URI.
 */
function editedPath(
  toolCallState: ToolCallState,
  fallback: string | undefined,
): string | undefined {
  const given = toolCallState.parsedArgs?.filepath;
  return typeof given === "string" && given ? given : fallback;
}

export const handleApplyStateUpdate = createAsyncThunk<
  void,
  ApplyState,
  ThunkApiType
>(
  "apply/handleStateUpdate",
  async (applyState, { dispatch, getState, extra }) => {
    if (applyState.streamId === EDIT_MODE_STREAM_ID) {
      dispatch(updateEditStateApplyState(applyState));

      if (applyState.status === "closed") {
        const toolCallState = findToolCallById(
          getState().session.history,
          applyState.toolCallId!,
        );
        if (toolCallState) {
          logToolUsage(toolCallState, true, true, extra.ideMessenger);
        }
        void dispatch(exitEdit({}));
      }
    } else {
      // chat or agent
      dispatch(updateApplyState(applyState));

      // Handle apply status updates - use toolCallId from event payload
      if (applyState.toolCallId) {
        const toolCallState = findToolCallById(
          getState().session.history,
          applyState.toolCallId,
        );

        if (
          applyState.status === "done" &&
          toolCallState?.toolCall.function.name &&
          // Nobody is expected to be watching a loop's edits: Supervised
          // asks before the edit (applyLoopHolds), and each item can be reverted
          (getState().ui.policyLevels.edits === "permissive" ||
            getState().session.loop?.current?.kind === "item" ||
            getState().ui.toolSettings[toolCallState.toolCall.function.name] ===
              "allowedWithoutPermission")
        ) {
          extra.ideMessenger.post("acceptDiff", {
            streamId: applyState.streamId,
            filepath: applyState.filepath,
          });
        }

        if (applyState.status === "closed") {
          if (toolCallState) {
            // A diff rejected in the editor (its own Reject, not the chat's)
            // arrives with the call still running. It is a cancelled call
            // like any other rejection, not an edit that succeeded.
            if (applyState.rejected && toolCallState.status === "calling") {
              dispatch(cancelToolCall({ toolCallId: applyState.toolCallId }));
            }
            const accepted =
              toolCallState.status !== "canceled" && !applyState.rejected;

            logToolUsage(toolCallState, accepted, true, extra.ideMessenger);

            // Log edit outcome for Agent Mode
            const newApplyState =
              getState().session.codeBlockApplyStates.states.find(
                (s) => s.streamId === applyState.streamId,
              );
            const newState = getState();
            if (newApplyState) {
              void logAgentModeEditOutcome(
                newState.session.history,
                newState.config.config,
                toolCallState,
                newApplyState,
                accepted,
                extra.ideMessenger,
              );
            }

            if (accepted) {
              if (toolCallState.status !== "errored") {
                dispatch(
                  acceptToolCall({
                    toolCallId: applyState.toolCallId,
                  }),
                );

                // Add autoformatting diff to tool output if present
                const contextItems: ContextItem[] =
                  applyState.autoFormattingDiff
                    ? [
                        {
                          icon: "info",
                          name: "Auto-formatting Applied",
                          description: "Editor auto-formatting changes",
                          content: `Along with your edits, the editor applied the following auto-formatting:\n\n${applyState.autoFormattingDiff}\n\n(Note: Pay close attention to changes such as single quotes being converted to double quotes, semicolons being removed or added, long lines being broken into multiple lines, adjusting indentation style, adding/removing trailing commas, etc. This will help you ensure future SEARCH/REPLACE operations to this file are accurate.)`,
                          hidden: false,
                        },
                      ]
                    : [
                        {
                          name: "Edit Success",
                          content: `Successfully edited ${applyState.filepath}`,
                          description: "",
                          hidden: true,
                        },
                      ];

                // Errors and warnings the edit introduced, once the
                // language servers have caught up
                if (applyState.filepath) {
                  const problems = await problemsAfterEdit(
                    extra.ideMessenger,
                    applyState.toolCallId,
                    applyState.filepath,
                  );
                  if (problems) contextItems.push(problems);
                }

                // Said once, so the person can see the edit left the workspace
                const outside = await outsideEditNote(
                  extra.ideMessenger.ide,
                  applyState.filepath,
                  allowOutsideWorkspaceOf(getState()),
                );
                if (outside) contextItems.push(outside);

                dispatch(
                  updateToolCallOutput({
                    toolCallId: applyState.toolCallId,
                    contextItems,
                  }),
                );
              } else if (!toolCallState.output?.length) {
                // An apply error already says why (applyForEditTool). This
                // is a call that failed and said nothing: no cause is known,
                // and the result says so.
                dispatch(
                  updateToolCallOutput({
                    toolCallId: applyState.toolCallId,
                    contextItems: [
                      {
                        name: "Edit Failed",
                        content: editFailureResult({
                          tool: toolCallState.toolCall.function.name,
                          file: editedPath(toolCallState, applyState.filepath),
                          cause: "apply-failed",
                        }),
                        description: "",
                        hidden: true,
                      },
                    ],
                  }),
                );
              }

              void dispatch(
                streamResponseAfterToolCall({
                  toolCallId: applyState.toolCallId,
                }),
              );
            }
          }
        }
      }
    }
  },
);

export const applyForEditTool = createAsyncThunk<
  void,
  ApplyToFilePayload & { toolCallId: string },
  ThunkApiType
>("apply/editTool", async (payload, { dispatch, getState, extra }) => {
  const { toolCallId, streamId } = payload;
  dispatch(
    updateApplyState({
      streamId,
      toolCallId,
      status: "not-started",
    }),
  );

  // The file's problems before the edit, to report only what it adds
  if (payload.filepath) {
    rememberProblemsBeforeEdit(
      extra.ideMessenger,
      toolCallId,
      payload.filepath,
    );
  }

  let didError = false;
  // Why the apply stopped: the IDE's reason when it gave one (the file
  // changed under the edit), otherwise the error's own message
  let notApplied: EditNotAppliedReason | undefined;
  let reason: string | undefined;
  try {
    const response = await extra.ideMessenger.request("applyToFile", payload);
    if (response.status === "error") {
      didError = true;
      reason = response.error;
    } else if (response.content?.notApplied) {
      didError = true;
      notApplied = response.content.notApplied;
    }
  } catch (e) {
    didError = true;
    reason = e instanceof Error ? e.message : undefined;
  }
  if (didError) {
    const state = getState();

    const toolCallState = selectToolCallById(state, toolCallId);
    const applyState = selectApplyStateByToolCallId(state, toolCallId);
    if (
      toolCallState &&
      applyState &&
      applyState.status !== "closed" &&
      toolCallState.status === "calling"
    ) {
      dispatch(
        errorToolCall({
          toolCallId,
        }),
      );
      dispatch(
        updateToolCallOutput({
          toolCallId,
          contextItems: [
            {
              icon: "problems",
              name: "Apply Error",
              description: "Failed to apply changes",
              content: editFailureResult({
                tool: toolCallState.toolCall.function.name,
                file: editedPath(toolCallState, payload.filepath),
                cause: "apply-failed",
                ...(notApplied ? { notApplied } : {}),
                ...(reason ? { detail: reason } : {}),
              }),
              hidden: false,
            },
          ],
        }),
      );
      void dispatch(
        handleApplyStateUpdate({
          status: "closed",
          streamId: applyState.streamId,
          toolCallId,
        }),
      );
    }
  }
});
