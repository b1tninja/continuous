import {
  ArrowsPointingInIcon,
  ArrowUturnLeftIcon,
  BarsArrowDownIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { ChatHistoryItem } from "core";
import { hasCheckpointsFrom } from "core/util/checkpoints";
import { useAppSelector } from "../../redux/hooks";
import { useCompactionCacheNote } from "../../hooks/useCompactionCacheNote";
import { useCompactConversation } from "../../util/compactConversation";
import {
  findTurnIdForIndex,
  getTurnOrder,
  useRestoreCheckpoint,
} from "../../util/restoreCheckpoint";
import { RovingToolbar } from "../PolicyControls/RovingToolbar";
import { FeedbackButtons } from "../FeedbackButtons";
import { ForkFromHereButton } from "./ForkFromHereButton";
import { CopyIconButton } from "../gui/CopyIconButton";
import HeaderButtonWithToolTip from "../gui/HeaderButtonWithToolTip";
import {
  copyKeyOf,
  markdownToPlainText,
  messageAsMarkdown,
  rememberFocusedMessage,
} from "../../util/copyAsMarkdown";

export interface ResponseActionsProps {
  isTruncated: boolean;
  onContinueGeneration: () => void;
  index: number;
  onDelete: () => void;
  item: ChatHistoryItem;
  isLast: boolean;
}

export default function ResponseActions({
  onContinueGeneration,
  index,
  item,
  isTruncated,
  onDelete,
  isLast,
}: ResponseActionsProps) {
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const isPruned = useAppSelector((state) => state.session.isPruned);

  const percent = Math.round((contextPercentage ?? 0) * 100);
  const buttonColorClass =
    isLast && (isPruned || percent > 80)
      ? "text-warning"
      : "text-description-muted";

  const showLabel = isLast && (isPruned || percent >= 60);

  const compactConversation = useCompactConversation();
  const compactionNote = useCompactionCacheNote();

  // The turn this response belongs to, if an agent edit during or after it
  // has a checkpoint to roll back
  const restorableTurnId = useAppSelector((state) => {
    const turnId = findTurnIdForIndex(state.session.history, index);
    return turnId &&
      hasCheckpointsFrom(
        state.session.checkpoints,
        getTurnOrder(state.session.history),
        turnId,
      )
      ? turnId
      : undefined;
  });
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const restoreToTurn = useRestoreCheckpoint();
  const sessionTitle = useAppSelector((state) => state.session.title);
  const copyKey = copyKeyOf(item.message, index);
  const markdown = () =>
    messageAsMarkdown(item, { title: sessionTitle, date: new Date() });

  return (
    <RovingToolbar
      label="Message actions"
      copyKey={copyKey}
      onItemFocus={() => rememberFocusedMessage(copyKey)}
      className="mx-2 flex cursor-default items-center justify-end space-x-1 bg-transparent pb-0 text-xs text-description-muted"
    >
      <HeaderButtonWithToolTip
        testId={`compact-button-${index}`}
        text={`${
          showLabel
            ? "Summarize conversation to reduce context length"
            : "Compact conversation"
        }${compactionNote ? `. ${compactionNote}` : ""}`}
        roving
        onClick={() => compactConversation(index)}
      >
        <div className="flex items-center space-x-1">
          <ArrowsPointingInIcon
            className={`h-3.5 w-3.5 ${buttonColorClass || "text-description-muted"}`}
          />
          {showLabel && (
            <span
              className={`text-xs ${buttonColorClass || "text-description-muted"}`}
            >
              Compact conversation
            </span>
          )}
        </div>
      </HeaderButtonWithToolTip>

      {restorableTurnId && !isStreaming && (
        <HeaderButtonWithToolTip
          testId={`restore-checkpoint-button-${index}`}
          text="Restore files to before this turn"
          roving
          onClick={() => void restoreToTurn(restorableTurnId)}
        >
          <ArrowUturnLeftIcon className="h-3.5 w-3.5 text-description-muted" />
        </HeaderButtonWithToolTip>
      )}

      <ForkFromHereButton index={index} />

      {isTruncated && (
        <HeaderButtonWithToolTip
          roving
          text="Continue generation"
          onClick={onContinueGeneration}
        >
          <BarsArrowDownIcon className="h-3.5 w-3.5 text-description-muted" />
        </HeaderButtonWithToolTip>
      )}

      <HeaderButtonWithToolTip
        testId={`delete-button-${index}`}
        text="Delete"
        roving
        onClick={onDelete}
      >
        <TrashIcon className="h-3.5 w-3.5 text-description-muted" />
      </HeaderButtonWithToolTip>

      <CopyIconButton
        roving
        text={markdown}
        plainText={() => markdownToPlainText(markdown())}
        clipboardIconClassName="h-3.5 w-3.5 text-description-muted"
        checkIconClassName="h-3.5 w-3.5 text-success"
      />

      <FeedbackButtons item={item} roving />
    </RovingToolbar>
  );
}
