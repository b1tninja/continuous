import { ToolCallState } from "core";
import { ContinueErrorReason } from "core/util/errors";
import {
  incompleteToolCallResult,
  isTruncatedJson,
  stoppedForLength,
  truncatedToolCallResult,
} from "core/util/truncatedJson";

import { IIdeMessenger } from "../../context/IdeMessenger";
import {
  clearToolCallArguments,
  errorToolCall,
  setProcessedToolCallArgs,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { AppThunkDispatch } from "../store";

/**
 * A call whose arguments stop part-way is not run. The lenient parser would
 * turn them into a valid-looking object, so create_new_file would write part
 * of the file and report success.
 *
 * The reply's stop reason says why. Only a reply that hit its output limit
 * (or reported no reason) was cut off; for any other the arguments arrived
 * incomplete, and telling the model to send smaller pieces sent it chasing a
 * limit it never reached (a 1,100-character edit was refused as "cut off at
 * 128000 tokens" after its fragments landed on another call).
 */
export function refuseTruncatedToolCalls(
  dispatch: AppThunkDispatch,
  generatedToolCalls: ToolCallState[],
  maxTokens: number | undefined,
  stopReason?: string,
): void {
  const cutOff = stoppedForLength(stopReason) !== false;
  for (const { toolCall, toolCallId } of generatedToolCalls) {
    if (!isTruncatedJson(toolCall.function.arguments ?? "")) continue;
    dispatch(errorToolCall({ toolCallId }));
    dispatch(clearToolCallArguments({ toolCallId }));
    dispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: [
          cutOff
            ? {
                icon: "problems",
                name: "Cut off",
                description: "Hit the output limit; not run",
                content: truncatedToolCallResult(
                  toolCall.function.name,
                  maxTokens,
                ),
                hidden: false,
              }
            : {
                icon: "problems",
                name: "Incomplete arguments",
                description: "The arguments arrived incomplete; not run",
                content: incompleteToolCallResult(toolCall.function.name),
                hidden: false,
              },
        ],
      }),
    );
  }
}

export async function preprocessToolCalls(
  dispatch: AppThunkDispatch,
  ideMessenger: IIdeMessenger,
  generatedToolCalls: ToolCallState[],
  allowOutsideWorkspace = false,
): Promise<void> {
  // Tool call pre-processing
  await Promise.all(
    generatedToolCalls.map(async (tcState) => {
      let errorReason: ContinueErrorReason | undefined = undefined;
      let errorMessage: string | undefined = undefined;
      let preprocessedArgs: Record<string, unknown> | undefined = undefined;
      const result = await ideMessenger.request("tools/preprocessArgs", {
        toolName: tcState.toolCall.function.name,
        args: tcState.parsedArgs,
        ...(allowOutsideWorkspace ? { allowOutsideWorkspace } : {}),
      });
      if (result.status === "success") {
        preprocessedArgs = result.content.preprocessedArgs;
        errorMessage = result.content.errorMessage;
        errorReason = result.content.errorReason;
      } else {
        errorMessage = result.error;
        errorReason = ContinueErrorReason.Unknown;
      }
      if (errorReason) {
        dispatch(
          errorToolCall({
            toolCallId: tcState.toolCallId,
          }),
        );
        dispatch(
          updateToolCallOutput({
            toolCallId: tcState.toolCallId,
            contextItems: [
              {
                icon: "problems",
                name: "Invalid Tool Call",
                description: "",
                content: `${tcState.toolCall.function.name} failed because the arguments were invalid, with the following message: ${errorMessage}\n\nPlease try something else or request further instructions.`,
                hidden: false,
              },
            ],
          }),
        );
      } else if (preprocessedArgs) {
        dispatch(
          setProcessedToolCallArgs({
            toolCallId: tcState.toolCallId,
            newArgs: preprocessedArgs,
          }),
        );
      }
    }),
  );
}
