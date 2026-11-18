import {
  countToolChanges,
  DROPS_REASONING_TEXT,
  describeToolChanges,
  pendingToolChangesText,
} from "core/tools/toolListHold";
import { useToolListHold } from "../../hooks/useToolListHold";
import { useAppDispatch } from "../../redux/hooks";
import { applyToolChangesNow } from "../../redux/slices/sessionSlice";
import { formatRereadCost } from "../../util/cacheNotices";
import { NoticeAction } from "./NoticeBar";

/**
 * One line above the input while a change to the tool list waits for the
 * prompt cache to go cold (C80): how many, and Apply now. It goes by itself
 * when the change applies.
 */
export function PendingToolChangesNotice() {
  const dispatch = useAppDispatch();
  const status = useToolListHold();
  if (!status.held) return null;
  const count = countToolChanges(status.pending);
  return (
    <div
      role="status"
      data-testid="pending-tool-changes"
      title={describeToolChanges(status.pending)}
      className="mx-1 mb-1 flex flex-wrap items-center gap-x-1 rounded border border-solid border-border py-0.5 pl-2 text-xs text-description"
    >
      <span>{pendingToolChangesText(count)}</span>
      <span aria-hidden="true">·</span>
      <NoticeAction
        testId="pending-tool-changes-apply"
        title={`The next request sends the new tool list${
          status.loss ? ` and re-reads ${formatRereadCost(status.loss)}` : ""
        }${status.dropsThinking ? `; it ${DROPS_REASONING_TEXT}` : ""}`}
        onClick={() => dispatch(applyToolChangesNow())}
      >
        Apply now
      </NoticeAction>
    </div>
  );
}
