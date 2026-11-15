import { useRef } from "react";

import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import { selectPendingToolCalls } from "../../../../redux/selectors/selectToolCalls";
import { callToolById } from "../../../../redux/thunks/callToolById";
import { cancelToolCallThunk } from "../../../../redux/thunks/cancelToolCall";
import { useApprovalFocus } from "../../../a11y/useApprovalFocus";
import { useRestoreFocusOnResolve } from "../../../a11y/useRestoreFocusOnResolve";
import { getAltKeyLabel, getMetaKeyLabel, isJetBrains } from "../../../../util";
import { Button } from "../../../ui";
import { useMainEditor } from "../../TipTapEditor";
import { AlwaysAllowButton } from "./AlwaysAllowButton";
import { PendingActionSummary } from "./PendingActionSummary";

export const generateToolCallButtonTestId = (
  action: "accept" | "reject",
  toolCallId: string,
) => {
  return `${action}-tool-call-button-${toolCallId}`;
};

const actionId = (toolCallId: string) => `pending-action-${toolCallId}`;

export function PendingToolCallToolbar() {
  const dispatch = useAppDispatch();
  const metaKey = getMetaKeyLabel() === "⌘" ? "Meta" : "Control";
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  const editor = useMainEditor();
  const acceptRef = useRef<HTMLButtonElement>(null);
  useApprovalFocus(pendingToolCalls[0]?.toolCallId, acceptRef);
  // When the last pending action resolves the toolbar disappears; give focus
  // to the chat input instead of letting it fall to the page.
  const focusHandlers = useRestoreFocusOnResolve(
    pendingToolCalls.length > 0,
    () => editor.mainEditor?.commands.focus(),
  );

  if (pendingToolCalls.length === 0) {
    return null;
  }

  const handleAccept = (toolCallId: string) => {
    void dispatch(callToolById({ toolCallId }));
  };

  const handleReject = (toolCallId: string) => {
    // put cursor in editor after last rejection
    if (pendingToolCalls.length === 1) {
      editor.mainEditor?.commands.focus();
    }
    void dispatch(cancelToolCallThunk({ toolCallId }));
  };

  return (
    <div
      className="flex w-full flex-col pb-0.5"
      role="group"
      aria-label={
        pendingToolCalls.length > 1
          ? `Approval needed for ${pendingToolCalls.length} commands`
          : "Approval needed"
      }
      data-testid="pending-tool-call-toolbar"
      {...focusHandlers}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 px-1 pb-0.5">
        <span className="min-w-0 basis-full text-2xs text-description xs:basis-auto">
          Sending a new message cancels{" "}
          {pendingToolCalls.length > 1 ? "these commands" : "this command"}.
        </span>
        {pendingToolCalls.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            className="my-0 font-medium"
            onClick={() =>
              pendingToolCalls.forEach((t) => handleAccept(t.toolCallId))
            }
            data-testid="accept-all-tool-calls"
          >
            Accept all ({pendingToolCalls.length})
          </Button>
        )}
      </div>
      <div className="flex max-h-[50vh] flex-col overflow-y-auto">
        {pendingToolCalls.map((toolCall, index) => (
          <div
            key={toolCall.toolCallId}
            className="flex flex-wrap items-center gap-x-2 rounded-sm border border-input bg-input"
          >
            <PendingActionSummary
              id={actionId(toolCall.toolCallId)}
              testId={toolCall.toolCallId}
              toolName={toolCall.toolCall.function.name}
              args={toolCall.parsedArgs}
              tool={toolCall.tool}
              note={toolCall.policyNote}
              rule={toolCall.policyRule}
            />

            <div className="ml-auto flex flex-wrap items-center justify-end gap-x-1">
              {!isJetBrains() && (
                <AlwaysAllowButton
                  toolCallId={toolCall.toolCallId}
                  toolName={toolCall.toolCall.function.name}
                  parsedArgs={toolCall.parsedArgs}
                  describedBy={actionId(toolCall.toolCallId)}
                />
              )}
              <Button
                variant="ghost"
                size="sm"
                className="my-0.5 min-h-6 min-w-6 font-medium text-description"
                title="Reject this command"
                aria-describedby={actionId(toolCall.toolCallId)}
                onClick={() => handleReject(toolCall.toolCallId)}
                data-testid={generateToolCallButtonTestId(
                  "reject",
                  toolCall.toolCallId,
                )}
              >
                <span>Reject</span>
              </Button>

              <Button
                ref={index === 0 ? acceptRef : undefined}
                variant="primary"
                size="sm"
                className="my-0.5 min-h-6 min-w-6 font-medium"
                aria-keyshortcuts={`${metaKey}+Enter`}
                title="Run this command"
                aria-describedby={actionId(toolCall.toolCallId)}
                onClick={() => handleAccept(toolCall.toolCallId)}
                data-testid={generateToolCallButtonTestId(
                  "accept",
                  toolCall.toolCallId,
                )}
              >
                {index === 0 && (
                  <span className="mr-1 shrink-0 text-2xs" aria-hidden="true">
                    {getMetaKeyLabel()}⏎
                  </span>
                )}
                <span>Accept</span>
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
