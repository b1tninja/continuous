import { formatTokens } from "core/llm/utils/sessionUsage";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  continueAfterCompactionHold,
  setCompactionHold,
} from "../../redux/slices/sessionSlice";
import { streamResponseThunk } from "../../redux/thunks/streamResponse";
import { useCompactionEstimate } from "../../hooks/useCompactionEstimate";
import { useCompactConversation } from "../../util/compactConversation";
import { swallowKeyRepeat } from "../../util/compactionHold";

const BUTTON =
  "min-h-6 cursor-pointer rounded border border-solid border-border bg-secondary px-2 py-0.5 text-xs text-secondary-foreground hover:bg-secondary-hover";

/**
 * The forced-path hold (section 6.5, C108; util/compactionHold.ts): the
 * person's message waits while they choose. Compact now has the focus, so
 * Enter chooses it; Continue anyway takes a click (or Tab, then Enter). A
 * repeated key press, such as the Enter that sent the message held down,
 * chooses nothing.
 */
export function CompactionHoldNotice() {
  const dispatch = useAppDispatch();
  const hold = useAppSelector((s) => s.session.compactionHold);
  const historyLength = useAppSelector((s) => s.session.history.length);
  const estimate = useCompactionEstimate();
  const compact = useCompactConversation();
  if (!hold) return null;

  const send = () =>
    void dispatch(
      streamResponseThunk({
        editorState: hold.editorState,
        modifiers: hold.modifiers,
        ...(hold.index !== undefined && { index: hold.index }),
      }),
    );

  return (
    <div
      role="group"
      aria-label="Compact before sending"
      data-testid="compaction-hold"
      onKeyDownCapture={swallowKeyRepeat}
      className="mx-1 mb-1 flex flex-col gap-1 rounded border border-solid border-warning py-1 pr-1 pl-2 text-xs text-foreground"
    >
      <span>
        {hold.pruned
          ? `Your message is waiting. The conversation is already past the point where the oldest turns are dropped to fit, so each cut reads about ${formatTokens(hold.rereadTokens)} tokens again.`
          : `Your message is waiting. It takes the conversation past the point where the oldest turns are dropped to fit, and about ${formatTokens(hold.rereadTokens)} tokens would be read again.`}
        {estimate && ` ${estimate.line}`}
      </span>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          autoFocus
          data-testid="compaction-hold-compact"
          className={BUTTON}
          onClick={async () => {
            dispatch(setCompactionHold(undefined));
            const ok = await compact(historyLength - 1);
            // Failed: the message waits again, and the toast says why
            if (!ok) dispatch(setCompactionHold(hold));
            else send();
          }}
        >
          {hold.prepared
            ? "Compact now (summary ready), then send"
            : "Compact now, then send"}
        </button>
        <button
          type="button"
          data-testid="compaction-hold-continue"
          className={BUTTON}
          onClick={() => {
            dispatch(continueAfterCompactionHold(hold.planId));
            send();
          }}
        >
          Continue anyway
        </button>
      </div>
    </div>
  );
}
