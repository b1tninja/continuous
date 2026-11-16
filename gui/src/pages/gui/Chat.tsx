import {
  ArrowLeftIcon,
  ChatBubbleOvalLeftIcon,
} from "@heroicons/react/24/outline";
import { Editor, JSONContent } from "@tiptap/react";
import { ChatHistoryItem, InputModifiers } from "core";
import { renderChatMessage } from "core/util/messageContent";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ErrorBoundary } from "react-error-boundary";
import styled from "styled-components";
import { Button, lightGray, vscBackground } from "../../components";
import { useFindWidget } from "../../components/find/FindWidget";
import TimelineItem from "../../components/gui/TimelineItem";
import { NewSessionButton } from "../../components/mainInput/belowMainInput/NewSessionButton";
import ThinkingBlockPeek from "../../components/mainInput/belowMainInput/ThinkingBlockPeek";
import ContinueInputBox from "../../components/mainInput/ContinueInputBox";
import { CacheMissNotice } from "../../components/mainInput/CacheMissNotice";
import { CompactionHoldNotice } from "../../components/mainInput/CompactionHoldNotice";
import { CompactionPreparedNotice } from "../../components/mainInput/CompactionPreparedNotice";
import { CachingOffNotice } from "../../components/mainInput/CachingOffNotice";
import { ToolDialectNotice } from "../../components/mainInput/ToolDialectNotice";
import { ColdCacheNotice } from "../../components/mainInput/ColdCacheNotice";
import { SessionLoadNotice } from "../../components/mainInput/SessionLoadNotice";
import { EditUndoLine } from "../../components/mainInput/EditUndoLine";
import { InstructionFileNotice } from "../../components/mainInput/InstructionFileNotice";
import { AgentsList } from "../../components/BackgroundMode/AgentsList";
import { InterruptConfirm } from "../../components/InterruptConfirm";
import { NeedsYouTray } from "../../components/loop/NeedsYouTray";
import { LoopInbox } from "../../components/mainInput/LoopInbox";
import {
  QuestionPanel,
  QuestionPanelContext,
} from "../../components/QuestionPanel";
import { TaskListPanel } from "../../components/mainInput/TaskListPanel";
import { useLoopDriver } from "../../hooks/useLoopDriver";
import { LargeMessageNotice } from "../../components/mainInput/LargeMessageNotice";
import { PendingToolChangesNotice } from "../../components/mainInput/PendingToolChangesNotice";
import { QueuedMessages } from "../../components/mainInput/QueuedMessages";
import { useMainEditor } from "../../components/mainInput/TipTapEditor";
import { mergeQueuedMessages } from "../../components/mainInput/util/queuedMessages";
import { useOnboardingCard } from "../../components/OnboardingCard";
import StepContainer from "../../components/StepContainer";
import { TabBar } from "../../components/TabBar/TabBar";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useApplyModeModel } from "../../hooks/useApplyModeModel";
import { usePlannedCompaction } from "../../redux/thunks/prepareCompaction";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  selectCurrentToolCalls,
  selectDoneApplyStates,
  selectPendingToolCalls,
} from "../../redux/selectors/selectToolCalls";
import {
  cancelToolCall,
  ChatHistoryItemWithMessageId,
  enqueueMessage,
  newSession,
  QueuedMessage,
  moveQueuedMessage,
  removeQueuedMessage,
  setEditUndo,
  setLoadingSessionId,
  steerQueuedMessages,
  takeQueuedMessages,
  updateToolCallOutput,
} from "../../redux/slices/sessionSlice";
import { streamEditThunk } from "../../redux/thunks/edit";
import { loadLastSession } from "../../redux/thunks/session";
import { streamResponseThunk } from "../../redux/thunks/streamResponse";
import { keepReplacedTurns } from "../../redux/thunks/editCopy";
import ResumeResponse from "../../components/StepContainer/ResumeResponse";
import { ToolCallDiv } from "./ToolCallDiv";
import { McpAppTurn } from "./ToolCallDiv/McpAppTurn";
import { isMcpAppTurn } from "./ToolCallDiv/mcpAppTurnContent";

import { useStore } from "react-redux";
import FeedbackDialog from "../../components/dialogs/FeedbackDialog";

import { FatalErrorIndicator } from "../../components/config/FatalErrorNotice";
import InlineErrorMessage from "../../components/mainInput/InlineErrorMessage";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { RootState } from "../../redux/store";
import { interruptStream } from "../../redux/thunks/cancelStream";
import { getLocalStorage, setLocalStorage } from "../../util/localStorage";
import {
  currentWorkspaceDirs,
  lastSessionCandidates,
} from "../../util/sessionWorkspace";
import { EmptyChatBody } from "./EmptyChatBody";
import { ResumingSessionBody } from "./ResumingSessionBody";
import { ExploreDialogWatcher } from "./ExploreDialogWatcher";
import { JumpToLatest } from "./JumpToLatest";
import { TranscriptMessage } from "./TranscriptMessage";
import { useAutoScroll } from "./useAutoScroll";

// Helper function to find the index of the latest conversation summary
function findLatestSummaryIndex(history: ChatHistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].conversationSummary) {
      return i;
    }
  }
  return -1; // No summary found
}

const StepsDiv = styled.div`
  position: relative;
  background-color: transparent;

  & > * {
    position: relative;
  }

  .thread-message {
    margin: 0 0 0 1px;
  }
`;

export const MAIN_EDITOR_INPUT_ID = "main-editor-input";

function fallbackRender({ error, resetErrorBoundary }: any) {
  // Call resetErrorBoundary() to reset the error boundary and retry the render.

  return (
    <div
      role="alert"
      className="px-2"
      style={{ backgroundColor: vscBackground }}
    >
      <p>Something went wrong:</p>
      <pre style={{ color: "red" }}>{error.message}</pre>
      <pre style={{ color: lightGray }}>{error.stack}</pre>

      <div className="text-center">
        <Button onClick={resetErrorBoundary}>Restart</Button>
      </div>
    </div>
  );
}

export function Chat() {
  // Loop mode: take the next step whenever nothing is running
  useLoopDriver();
  const hasLoop = useAppSelector((state) => !!state.session.loop);
  useApplyModeModel();
  // Planned compaction: the summary is prepared while the person is idle
  usePlannedCompaction();
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const reduxStore = useStore<RootState>();
  const onboardingCard = useOnboardingCard();
  const showSessionTabs = useAppSelector(
    (store) => store.config.config.ui?.showSessionTabs,
  );
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const [stepsOpen] = useState<(boolean | undefined)[]>([]);
  const mainTextInputRef = useRef<HTMLInputElement>(null);
  const stepsDivRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const history = useAppSelector((state) => state.session.history);
  const showChatScrollbar = useAppSelector(
    (state) => state.config.config.ui?.showChatScrollbar,
  );
  const codeToEdit = useAppSelector((state) => state.editModeState.codeToEdit);
  const isInEdit = useAppSelector((store) => store.session.isInEdit);

  const lastSessionId = useAppSelector((state) => state.session.lastSessionId);
  const lastSessionIdByWorkspace = useAppSelector(
    (state) => state.session.lastSessionIdByWorkspace,
  );
  const allSessionMetadata = useAppSelector(
    (state) => state.session.allSessionMetadata,
  );
  // "Last Session" reopens a session of this workspace (thunks/session.ts
  // loadLastSession), so it is offered only when this workspace has one
  const canReopenLastSession = useMemo(
    () =>
      lastSessionCandidates({
        byWorkspace: lastSessionIdByWorkspace,
        legacyLastSessionId: lastSessionId,
        sessions: allSessionMetadata,
        workspaceDirs: currentWorkspaceDirs(),
      }).length > 0,
    [lastSessionIdByWorkspace, lastSessionId, allSessionMetadata],
  );
  const loadingSessionId = useAppSelector(
    (state) => state.session.loadingSessionId,
  );
  const isResumingSession =
    history.length === 0 && !!loadingSessionId && !isInEdit;
  const hasDismissedExploreDialog = useAppSelector(
    (state) => state.ui.hasDismissedExploreDialog,
  );

  const { paused: autoScrollPaused, scrollToLatest } = useAutoScroll(
    stepsDivRef,
    history,
  );

  const { widget, highlights } = useFindWidget(
    stepsDivRef,
    tabsRef,
    isStreaming,
  );

  const sendInput = useCallback(
    (
      editorState: JSONContent,
      modifiers: InputModifiers,
      index?: number,
      editorToClearOnSend?: Editor,
    ) => {
      const stateSnapshot = reduxStore.getState();
      const latestPendingToolCalls = selectPendingToolCalls(stateSnapshot);
      const latestPendingApplyStates = selectDoneApplyStates(stateSnapshot);
      const isCurrentlyInEdit = stateSnapshot.session.isInEdit;
      const codeToEditSnapshot = stateSnapshot.editModeState.codeToEdit;
      const selectedModelByRole =
        stateSnapshot.config.config.selectedModelByRole;
      const currentMode = stateSnapshot.session.mode;

      // Typed while the agent works: queue it for when the turn ends, and
      // leave the running turn alone. An approved tool that is running is
      // work too, though nothing streams then: sending would start a second
      // request alongside the turn that is waiting for the tool's result.
      const isToolRunning = selectCurrentToolCalls(stateSnapshot).some(
        (tc) => tc.status === "calling",
      );
      if (stateSnapshot.session.isStreaming || isToolRunning) {
        if (index === undefined && !isCurrentlyInEdit) {
          dispatch(enqueueMessage({ editorState, modifiers }));
          editorToClearOnSend?.commands.clearContent(false);
        }
        return;
      }

      // Sent while a saved session is still loading: the person has moved
      // on, so the load is dropped and cannot replace what they sent. With
      // an empty chat the current id may be the session being loaded, so
      // the message goes to a fresh session rather than over it. (Typing
      // already dropped it, useDropSessionLoadOnTyping; this is the backstop.)
      if (stateSnapshot.session.loadingSessionId && !isCurrentlyInEdit) {
        if (stateSnapshot.session.history.length === 0) {
          dispatch(newSession());
        } else {
          dispatch(setLoadingSessionId(undefined));
        }
      }

      // Cancel all pending tool calls
      latestPendingToolCalls.forEach((toolCallState) => {
        dispatch(
          cancelToolCall({
            toolCallId: toolCallState.toolCallId,
          }),
        );
      });

      // Reject all pending apply states
      latestPendingApplyStates.forEach((applyState) => {
        if (applyState.status !== "closed") {
          ideMessenger.post("rejectDiff", applyState);
        }
      });
      const model = isCurrentlyInEdit
        ? (selectedModelByRole.edit ?? selectedModelByRole.chat)
        : selectedModelByRole.chat;

      if (!model) {
        return;
      }

      if (isCurrentlyInEdit && codeToEditSnapshot.length === 0) {
        return;
      }

      if (isCurrentlyInEdit) {
        void dispatch(
          streamEditThunk({
            editorState,
            codeToEdit: codeToEditSnapshot,
          }),
        );
      } else {
        // An earlier message edited: what it replaces is kept (NI7). Any
        // other message ends the last edit's undo line.
        const before = stateSnapshot.session.history;
        if (index !== undefined && index < before.length) {
          void dispatch(keepReplacedTurns({ index, before }));
        } else if (stateSnapshot.session.editUndo) {
          dispatch(setEditUndo(undefined));
        }
        void dispatch(
          streamResponseThunk({
            editorState,
            modifiers,
            index,
            // A new message from the input may wait before a forced re-read
            holdBeforeForcedReread: index === undefined,
          }),
        );

        if (editorToClearOnSend) {
          editorToClearOnSend.commands.clearContent(false);
        }
      }

      // Increment localstorage counter for popup
      const currentCount = getLocalStorage("mainTextEntryCounter");
      if (currentCount) {
        setLocalStorage("mainTextEntryCounter", currentCount + 1);
        if (currentCount === 300) {
          dispatch(setDialogMessage(<FeedbackDialog />));
          dispatch(setShowDialog(true));
        }
      } else {
        setLocalStorage("mainTextEntryCounter", 1);
      }
    },
    [dispatch, ideMessenger, reduxStore],
  );

  // Messages queued while the agent worked (see QueuedMessages)
  const { mainEditor } = useMainEditor();
  const isQueueSendRequested = useAppSelector(
    (state) => state.session.isQueueSendRequested,
  );

  const sendQueuedMessages = useCallback(
    async (ids?: string[]) => {
      // Loop answers are steered into the item's run (or kept for its next
      // one by the loop), never sent as a turn of their own
      const all = reduxStore.getState().session.queuedMessages;
      const queuedMessages = all.filter((m) => !m.loopAnswerId);
      const chosen = ids
        ? queuedMessages.filter((m) => ids.includes(m.id))
        : queuedMessages;
      const merged = mergeQueuedMessages(chosen);
      if (!merged) return;

      if (chosen.length === all.length) {
        dispatch(takeQueuedMessages());
      } else {
        chosen.forEach((m) => dispatch(removeQueuedMessage(m.id)));
      }
      sendInput(merged.editorState, merged.modifiers);
    },
    [dispatch, reduxStore, sendInput],
  );

  // "Send now" while the agent works steers: the messages go in after the
  // running tool calls finish, without stopping the turn (Stop does that).
  // Otherwise, or when the reply is text with no tools, they go at turn end.
  const sendNowOrSteer = useCallback(
    (ids: string[]) => {
      const state = reduxStore.getState();
      const isAgentWorking =
        state.session.isStreaming ||
        selectCurrentToolCalls(state).some(
          (tc) =>
            tc.status === "generating" ||
            tc.status === "generated" ||
            tc.status === "calling",
        );
      if (isAgentWorking) {
        dispatch(steerQueuedMessages(ids));
      } else {
        void sendQueuedMessages(ids);
      }
    },
    [dispatch, reduxStore, sendQueuedMessages],
  );

  // "Steer now" while the model writes: end its reply where it is (what it
  // wrote stays, unfinished tool calls are cancelled) and send these at once,
  // instead of after the next tool round. Other queued messages keep waiting
  // for the end of the new turn. A running tool is never cut short.
  const steerNow = useCallback(
    async (ids: string[]) => {
      const state = reduxStore.getState();
      const isToolRunning = selectCurrentToolCalls(state).some(
        (tc) => tc.status === "calling",
      );
      if (!state.session.isStreaming || isToolRunning) {
        sendNowOrSteer(ids);
        return;
      }
      await dispatch(interruptStream());
      await sendQueuedMessages(ids);
    },
    [dispatch, reduxStore, sendNowOrSteer, sendQueuedMessages],
  );

  useEffect(() => {
    if (isQueueSendRequested && !isStreaming) {
      void sendQueuedMessages();
    }
  }, [isQueueSendRequested, isStreaming, sendQueuedMessages]);

  const editQueuedMessage = useCallback(
    (message: QueuedMessage) => {
      dispatch(removeQueuedMessage(message.id));
      if (!mainEditor) return;
      if (mainEditor.isEmpty) {
        mainEditor.chain().setContent(message.editorState).focus("end").run();
      } else {
        // Ahead of anything already typed, as the queue was written first
        mainEditor
          .chain()
          .insertContentAt(0, message.editorState.content ?? [])
          .focus("end")
          .run();
      }
    },
    [dispatch, mainEditor],
  );

  useWebviewListener(
    "newSession",
    async () => {
      // unwrapResult(response) // errors if session creation failed
      mainTextInputRef.current?.focus?.();
    },
    [mainTextInputRef],
  );

  // Handle partial tool call output for streaming updates
  useWebviewListener(
    "toolCallPartialOutput",
    async (data) => {
      // Update tool call output in Redux store
      dispatch(
        updateToolCallOutput({
          toolCallId: data.toolCallId,
          contextItems: data.contextItems,
        }),
      );
    },
    [dispatch],
  );

  const isLastUserInput = useCallback(
    (index: number): boolean => {
      return !history
        .slice(index + 1)
        .some((entry) => entry.message.role === "user");
    },
    [history],
  );

  const renderChatHistoryItem = useCallback(
    (item: ChatHistoryItemWithMessageId, index: number) => {
      const {
        message,
        editorState,
        contextItems,
        appliedRules,
        toolCallStates,
      } = item;

      // Calculate once for the entire function
      const latestSummaryIndex = findLatestSummaryIndex(history);
      const isBeforeLatestSummary =
        latestSummaryIndex !== -1 && index < latestSummaryIndex;

      if (message.role === "user") {
        if (isMcpAppTurn(message)) {
          const serverName =
            typeof message.metadata?.mcpServerName === "string"
              ? message.metadata.mcpServerName
              : "MCP app";
          return (
            <McpAppTurn
              serverName={serverName}
              text={renderChatMessage(message)}
            />
          );
        }
        return (
          <ContinueInputBox
            onEnter={(editorState, modifiers) =>
              sendInput(editorState, modifiers, index)
            }
            isLastUserInput={isLastUserInput(index)}
            isMainInput={false}
            editorState={editorState ?? item.message.content}
            contextItems={contextItems}
            appliedRules={appliedRules}
            inputId={message.id}
          />
        );
      }

      if (message.role === "tool") {
        return null;
      }

      if (message.role === "assistant") {
        return (
          <>
            {/* Always render assistant content through normal path */}
            <div className="thread-message">
              <TimelineItem
                item={item}
                iconElement={
                  <ChatBubbleOvalLeftIcon width="16px" height="16px" />
                }
                open={
                  typeof stepsOpen[index] === "undefined"
                    ? true
                    : stepsOpen[index]!
                }
                onToggle={() => {}}
              >
                <StepContainer
                  index={index}
                  isLast={index === history.length - 1}
                  item={item}
                  latestSummaryIndex={latestSummaryIndex}
                />
              </TimelineItem>
            </div>

            {toolCallStates && (
              <ToolCallDiv
                toolCallStates={toolCallStates}
                historyIndex={index}
              />
            )}
          </>
        );
      }

      if (message.role === "thinking") {
        const thinkingContent = renderChatMessage(message);
        const thinkingInProgress = index === history.length - 1 && isStreaming;
        // An empty block (a model that hides its thinking) has nothing to
        // reopen once it is done; while it streams it still says "Thinking"
        if (!thinkingContent?.trim() && !thinkingInProgress) {
          return null;
        }
        return (
          <div className={isBeforeLatestSummary ? "opacity-50" : ""}>
            <ThinkingBlockPeek
              content={thinkingContent}
              redactedThinking={message.redactedThinking}
              index={index}
              prevItem={index > 0 ? history[index - 1] : null}
              inProgress={thinkingInProgress}
              signature={message.signature}
            />
          </div>
        );
      }

      // Default case - regular assistant message
      return (
        <div className="thread-message">
          <TimelineItem
            item={item}
            iconElement={<ChatBubbleOvalLeftIcon width="16px" height="16px" />}
            open={
              typeof stepsOpen[index] === "undefined" ? true : stepsOpen[index]!
            }
            onToggle={() => {}}
          >
            <StepContainer
              index={index}
              isLast={index === history.length - 1}
              item={item}
              latestSummaryIndex={latestSummaryIndex}
            />
          </TimelineItem>
        </div>
      );
    },
    [sendInput, isLastUserInput, history, stepsOpen, isStreaming],
  );

  const showScrollbar = showChatScrollbar ?? window.innerHeight > 5000;

  return (
    <QuestionPanelContext.Provider value={true}>
      {!!showSessionTabs && !isInEdit && <TabBar ref={tabsRef} />}
      {widget}

      <StepsDiv
        ref={stepsDivRef}
        role="region"
        aria-label="Conversation"
        className={`pt-[8px] ${showScrollbar ? "thin-scrollbar" : "no-scrollbar"} ${history.length > 0 ? "min-h-0 flex-1 overflow-y-scroll" : "shrink-0"}`}
      >
        {highlights}
        {history
          .filter((item) => item.message.role !== "system")
          .map((item, index: number) => (
            <TranscriptMessage
              key={item.message.id}
              role={item.message.role}
              minHeight={index === history.length - 1 ? "200px" : 0}
            >
              <ErrorBoundary
                FallbackComponent={fallbackRender}
                onReset={() => {
                  dispatch(newSession());
                }}
              >
                {renderChatHistoryItem(item, index)}
              </ErrorBoundary>
              {index === history.length - 1 && <InlineErrorMessage />}
            </TranscriptMessage>
          ))}
        <ResumeResponse />
        {/* Inside the scroll area, so it does not push the input down */}
        <ToolDialectNotice />
      </StepsDiv>
      <JumpToLatest paused={autoScrollPaused} scrollToLatest={scrollToLatest} />
      <div className={"relative shrink-0"}>
        <CompactionHoldNotice />
        <CompactionPreparedNotice />
        <CacheMissNotice />
        <ColdCacheNotice />
        <SessionLoadNotice />
        <EditUndoLine />
        <InstructionFileNotice />
        <CachingOffNotice />
        <PendingToolChangesNotice />
        <LargeMessageNotice />
        {/* A loop shows its own plan in its panel */}
        {!hasLoop && <TaskListPanel />}
        <LoopInbox />
        <AgentsList />
        {/* A loop asks through its Needs you tray, which holds the same questions */}
        {hasLoop ? <NeedsYouTray /> : <QuestionPanel />}
        <QueuedMessages
          onSendNow={sendNowOrSteer}
          onSteerNow={(ids) => void steerNow(ids)}
          onEdit={editQueuedMessage}
          onRemove={(id) => dispatch(removeQueuedMessage(id))}
          onMove={(id, to) => dispatch(moveQueuedMessage({ id, to }))}
        />
        {/* Before a key stops the reply or a switch stops the agent */}
        <InterruptConfirm />
        <ContinueInputBox
          isMainInput
          isLastUserInput={false}
          onEnter={(editorState, modifiers, editor) =>
            sendInput(editorState, modifiers, undefined, editor)
          }
          inputId={MAIN_EDITOR_INPUT_ID}
        />

        <div
          style={{
            pointerEvents: isStreaming ? "none" : "auto",
          }}
        >
          <div className="flex flex-row items-center justify-between pr-2 pb-1 pl-0.5">
            <div className="hidden xs:inline">
              {history.length === 0 &&
                canReopenLastSession &&
                !isInEdit &&
                !isResumingSession && (
                  <NewSessionButton
                    onClick={async () => {
                      await dispatch(loadLastSession());
                    }}
                    className="flex items-center gap-2"
                  >
                    <ArrowLeftIcon className="h-3 w-3" />
                    <span className="text-xs">Last Session</span>
                  </NewSessionButton>
                )}
            </div>
          </div>
          <FatalErrorIndicator />
          {!hasDismissedExploreDialog && <ExploreDialogWatcher />}
          {isResumingSession && loadingSessionId ? (
            <ResumingSessionBody loadingSessionId={loadingSessionId} />
          ) : (
            history.length === 0 && (
              <EmptyChatBody showOnboardingCard={onboardingCard.show} />
            )
          )}
        </div>
      </div>
    </QuestionPanelContext.Provider>
  );
}
