import { BuiltInToolNames } from "core/tools/builtIn";
import { countdownLabel } from "core/tools/permissions/decisionTimer";
import { useLayoutEffect, useRef } from "react";

import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import { selectPendingToolCalls } from "../../../../redux/selectors/selectToolCalls";
import { callToolById } from "../../../../redux/thunks/callToolById";
import { setToolCallTimer } from "../../../../redux/slices/sessionSlice";
import { cancelToolCallThunk } from "../../../../redux/thunks/cancelToolCall";
import { useApprovalFocus } from "../../../a11y/useApprovalFocus";
import { useRestoreFocusOnResolve } from "../../../a11y/useRestoreFocusOnResolve";
import { getMetaKeyLabel, isJetBrains } from "../../../../util";
import { Button } from "../../../ui";
import { useMainEditor } from "../../TipTapEditor";
import { AlwaysAllowButton } from "./AlwaysAllowButton";
import { PendingActionSummary } from "./PendingActionSummary";
import { useToolTimers } from "./useToolTimers";

export const generateToolCallButtonTestId = (
  action: "accept" | "reject",
  toolCallId: string,
) => {
  return `${action}-tool-call-button-${toolCallId}`;
};

/** "command" for a terminal call, "action" for an edit, a fetch or an MCP tool. */
const itemNoun = (t: { toolCall: { function: { name: string } } }) =>
  t.toolCall.function.name === BuiltInToolNames.RunTerminalCommand
    ? "command"
    : "action";

const actionId = (toolCallId: string) => `pending-action-${toolCallId}`;

export function PendingToolCallToolbar() {
  const dispatch = useAppDispatch();
  const metaKey = getMetaKeyLabel() === "⌘" ? "Meta" : "Control";
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  // The decision timer's countdowns, for the asks that have one
  const now = useToolTimers();
  const editor = useMainEditor();
  // "command" only when every waiting call is one: an edit, a fetch or an MCP
  // tool is not a command, and the card above already names each kind.
  const allCommands = pendingToolCalls.every(
    (t) => t.toolCall.function.name === BuiltInToolNames.RunTerminalCommand,
  );
  const noun = allCommands ? "command" : "action";
  const acceptRef = useRef<HTMLButtonElement>(null);
  useApprovalFocus(pendingToolCalls[0]?.toolCallId, acceptRef);
  // When the last pending action resolves the toolbar disappears; give focus
  // to the chat input instead of letting it fall to the page.
  const focusHandlers = useRestoreFocusOnResolve(
    pendingToolCalls.length > 0,
    () => editor.mainEditor?.commands.focus(),
  );

  // In a short panel the first call can be taller than the list, and its
  // buttons stay in sight (below). Then show what is being approved above
  // them: the end of the call, or from the start of its command when that
  // would be cut. Once per call, so the person's own scrolling is left alone.
  const listRef = useRef<HTMLDivElement>(null);
  const firstId = pendingToolCalls[0]?.toolCallId;
  useLayoutEffect(() => {
    const list = listRef.current;
    const call = list?.firstElementChild;
    if (!list || !call) return;
    const over = call.getBoundingClientRect().height - list.clientHeight;
    if (over <= 0) return;
    // The text itself, not its label: under a pinned reason a line may be
    // all there is room for
    const what =
      call.querySelector('[data-testid^="pending-action-block-"]') ??
      call.querySelector('[data-testid^="pending-action-what-"]');
    const start = what
      ? what.getBoundingClientRect().top - call.getBoundingClientRect().top
      : 0;
    list.scrollTop = Math.min(over, start);
  }, [firstId]);

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
          ? `Approval needed for ${pendingToolCalls.length} ${noun}s`
          : "Approval needed"
      }
      data-testid="pending-tool-call-toolbar"
      {...focusHandlers}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 px-1 pb-0.5">
        <span className="min-w-0 basis-full text-2xs text-description xs:basis-auto">
          Sending a new message cancels{" "}
          {pendingToolCalls.length > 1 ? `these ${noun}s` : `this ${noun}`}.
        </span>
        {pendingToolCalls.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            className="my-0 font-medium"
            onClick={() =>
              pendingToolCalls.forEach((t) => handleAccept(t.toolCallId))
            }
            title={`Run all ${pendingToolCalls.length} waiting ${noun}s once. Scroll the list to check each one first`}
            data-testid="accept-all-tool-calls"
          >
            Accept all ({pendingToolCalls.length})
          </Button>
        )}
      </div>
      {/* In a short panel the list takes what the chat (100 px), the prompt
          with its rows (153 px at 300 wide) and the lines above (35 px)
          leave, and never under 96 px, a call with a one-line command. A
          sum, not a measurement: with more above the prompt the chat gets
          less. */}
      <div
        ref={listRef}
        className="flex max-h-[min(50vh,max(96px,calc(100vh_-_288px)))] flex-col overflow-y-auto"
      >
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
              pinNote={index === 0}
            />

            {/* The first call's buttons stay in sight when the list is
                shorter than the call: its text scrolls under them */}
            <div
              className={
                index === 0
                  ? "sticky bottom-0 ml-auto flex basis-full flex-wrap items-center justify-end gap-x-1 bg-input"
                  : "ml-auto flex flex-wrap items-center justify-end gap-x-1"
              }
            >
              {toolCall.askTimer && !toolCall.askTimer.kept && (
                <span
                  role="timer"
                  aria-live="off"
                  className="text-2xs text-description"
                  data-testid={`ask-timer-${toolCall.toolCallId}`}
                >
                  {toolCall.askTimer.proposed === "refuse"
                    ? "Refused in "
                    : "Runs in "}
                  {countdownLabel(
                    Math.ceil(
                      Math.max(
                        0,
                        toolCall.askTimer.startedAt +
                          toolCall.askTimer.seconds * 1000 -
                          now,
                      ) / 1000,
                    ),
                  )}{" "}
                  unless you answer
                </span>
              )}
              {toolCall.askTimer && !toolCall.askTimer.kept && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="my-0.5 min-h-6 min-w-6 font-medium text-description"
                  title="Stop the countdown; this call waits for you"
                  aria-describedby={actionId(toolCall.toolCallId)}
                  onClick={() =>
                    dispatch(
                      setToolCallTimer({
                        toolCallId: toolCall.toolCallId,
                        timer: { ...toolCall.askTimer!, kept: true },
                      }),
                    )
                  }
                  data-testid={`keep-waiting-${toolCall.toolCallId}`}
                >
                  <span>Keep waiting</span>
                </Button>
              )}
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
                title={`Reject this ${itemNoun(toolCall)}`}
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
                title={`Run this ${itemNoun(toolCall)} once`}
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
