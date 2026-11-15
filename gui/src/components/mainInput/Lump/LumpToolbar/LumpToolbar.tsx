import { BuiltInToolNames } from "core/tools/builtIn";
import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import {
  selectFirstPendingToolCall,
  selectPendingToolCalls,
  selectToolCallsByStatus,
} from "../../../../redux/selectors/selectToolCalls";
import { callToolById } from "../../../../redux/thunks/callToolById";
import { stopResponseThunk } from "../../../../redux/thunks/paletteCommands";
import { BlockSettingsTopToolbar } from "./BlockSettingsTopToolbar";
import { EditOutcomeToolbar } from "./EditOutcomeToolbar";
import { EditToolbar } from "./EditToolbar";
import { IsApplyingToolbar } from "./IsApplyingToolbar";
import { PendingApplyStatesToolbar } from "./PendingApplyStatesToolbar";
import { PendingToolCallToolbar } from "./PendingToolCallToolbar";
import { StreamingToolbar } from "./StreamingToolbar";
import { TtsActiveToolbar } from "./TtsActiveToolbar";

// Keyboard shortcut detection utilities
const isExecuteToolCallShortcut = (event: KeyboardEvent) => {
  const metaKey = event.metaKey || event.ctrlKey;
  return metaKey && event.key === "Enter";
};

// Check if a tool call is a terminal command
const isTerminalCommand = (toolCallState: any) => {
  return (
    toolCallState?.toolCall?.function?.name ===
    BuiltInToolNames.RunTerminalCommand
  );
};

export type LumpToolbarKind =
  | "applying"
  | "edit-outcome"
  | "edit"
  | "tts"
  | "terminal"
  | "streaming"
  | "pending-tool-calls"
  | "pending-apply"
  | "idle";

/**
 * Which toolbar the row above the input shows. One place decides, in priority
 * order, so the row's neighbours (the session controls) can tell whether the
 * toolbar is a single line that sits beside them or a block that needs the
 * full width.
 */
export function useLumpToolbarKind(): LumpToolbarKind {
  const ttsActive = useAppSelector((state) => state.ui.ttsActive);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const isInEdit = useAppSelector((state) => state.session.isInEdit);
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  const editApplyStatus = useAppSelector(
    (state) => state.editModeState.applyState.status,
  );
  const applyStates = useAppSelector(
    (state) => state.session.codeBlockApplyStates.states,
  );
  const hasRunningTerminalCommand = useAppSelector(
    (state) =>
      selectToolCallsByStatus(state, "calling").filter(isTerminalCommand)
        .length > 0,
  );

  if (applyStates.some((state) => state.status === "streaming")) {
    return "applying";
  }
  if (isInEdit) return editApplyStatus === "done" ? "edit-outcome" : "edit";
  if (ttsActive) return "tts";
  if (hasRunningTerminalCommand) return "terminal";
  if (isStreaming) return "streaming";
  if (pendingToolCalls.length > 0) return "pending-tool-calls";
  if (applyStates.some((state) => state.status === "done")) {
    return "pending-apply";
  }
  return "idle";
}

/** Kinds that are one line and can share the row with the session controls. */
export function isInlineToolbarKind(kind: LumpToolbarKind): boolean {
  return kind === "idle" || kind === "streaming" || kind === "terminal";
}

export function LumpToolbar() {
  const kind = useLumpToolbarKind();
  const dispatch = useAppDispatch();
  const firstPendingToolCall = useAppSelector(selectFirstPendingToolCall);
  const applyStates = useAppSelector(
    (state) => state.session.codeBlockApplyStates.states,
  );
  const pendingApplyStates = applyStates.filter(
    (state) => state.status === "done",
  );

  // Get ALL running terminal commands
  const runningToolCalls = useAppSelector((state) =>
    selectToolCallsByStatus(state, "calling"),
  );
  const runningTerminalCalls = runningToolCalls.filter(isTerminalCommand);
  const hasRunningTerminalCommand = runningTerminalCalls.length > 0;

  // The same Stop as the Command Palette's "Stop Response": running
  // terminal commands are killed and the reply is cancelled
  const handleStopAction = () => {
    void dispatch(stopResponseThunk());
  };

  useEffect(() => {
    if (!firstPendingToolCall && !hasRunningTerminalCommand) {
      return;
    }

    const handleToolCallKeyboardShortcuts = (event: KeyboardEvent) => {
      if (isExecuteToolCallShortcut(event) && firstPendingToolCall) {
        event.preventDefault();
        event.stopPropagation();

        void dispatch(
          callToolById({ toolCallId: firstPendingToolCall.toolCallId }),
        );
      }
    };

    document.addEventListener("keydown", handleToolCallKeyboardShortcuts);
    return () => {
      document.removeEventListener("keydown", handleToolCallKeyboardShortcuts);
    };
  }, [firstPendingToolCall, hasRunningTerminalCommand, runningTerminalCalls]);

  switch (kind) {
    case "applying":
      return <IsApplyingToolbar />;
    case "edit-outcome":
      return <EditOutcomeToolbar />;
    case "edit":
      return <EditToolbar />;
    case "tts":
      return <TtsActiveToolbar />;
    case "terminal": {
      const count = runningTerminalCalls.length;
      const stopText = `Stop Terminal${count > 1 ? ` (${count})` : ""}`;
      return (
        <StreamingToolbar onStop={handleStopAction} displayText={stopText} />
      );
    }
    case "streaming":
      return <StreamingToolbar onStop={handleStopAction} />;
    case "pending-tool-calls":
      return <PendingToolCallToolbar />;
    case "pending-apply":
      return (
        <PendingApplyStatesToolbar pendingApplyStates={pendingApplyStates} />
      );
    default:
      return <BlockSettingsTopToolbar />;
  }
}
