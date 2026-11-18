import {
  countToolChanges,
  DROPS_REASONING_TEXT,
  describeToolChanges,
  pendingToolChangesText,
  toolChangesId,
  toolChangeWarning,
} from "core/tools/toolListHold";
import { useToolListHold } from "../../hooks/useToolListHold";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  applyToolChangesNow,
  keepToolChangesQueued,
} from "../../redux/slices/sessionSlice";
import { saveCurrentSession } from "../../redux/thunks/session";
import { formatRereadCost } from "../../util/cacheNotices";

function ChoiceButton(props: {
  testId: string;
  title: string;
  pressed?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      title={props.title}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className={`min-h-6 cursor-pointer rounded border border-solid px-2 text-xs ${
        props.pressed
          ? "border-border-focus bg-list-active text-foreground"
          : "border-border bg-transparent text-link hover:brightness-125"
      }`}
    >
      {props.children}
    </button>
  );
}

/**
 * At the tool and MCP server controls (Settings, Tools): while the prompt
 * cache is warm and re-reading it is significant, what a change to the tool
 * list costs, and once a change is waiting, the choice of when it applies.
 * Nothing at all when the cache is cold or the conversation is small: a
 * change then applies at once, as it always did.
 */
export function ToolChangeNotice() {
  const dispatch = useAppDispatch();
  const status = useToolListHold();
  const choiceMade = useAppSelector((s) => s.session.toolChangeChoiceMade);
  if (!status.waits || !status.loss) return null;

  const warning = toolChangeWarning(
    formatRereadCost(status.loss),
    status.dropsThinking,
  );
  const count = countToolChanges(status.pending);
  const id = toolChangesId(status.pending);
  return (
    <div
      role="status"
      data-testid="tool-change-notice"
      className="flex flex-col gap-1 rounded border border-solid border-border px-2 py-1 text-xs text-description"
    >
      <span>
        {warning}
        {status.held ? "" : " A change waits until the cache goes cold."}
      </span>
      {status.held && (
        <div data-testid="tool-change-choice" className="flex flex-col gap-1">
          <span>
            {pendingToolChangesText(count)} (
            {describeToolChanges(status.pending)}
            ). A tool turned off stays offered and is refused if called.
          </span>
          {choiceMade !== id && (
            <div className="flex flex-wrap gap-1">
              <ChoiceButton
                testId="tool-change-apply-now"
                title={
                  status.dropsThinking
                    ? `The next request sends the new tool list: it ${DROPS_REASONING_TEXT}`
                    : "The next request sends the new tool list and re-reads the conversation"
                }
                onClick={() => dispatch(applyToolChangesNow())}
              >
                Apply now
              </ChoiceButton>
              <ChoiceButton
                testId="tool-change-when-cold"
                title="The change applies on the first request after the cache goes cold, after compaction or in a new session"
                pressed
                onClick={() => dispatch(keepToolChangesQueued(id))}
              >
                Apply when the cache goes cold
              </ChoiceButton>
              <ChoiceButton
                testId="tool-change-new-session"
                title="Saves this session and starts an empty one with the new tool list"
                onClick={() =>
                  void dispatch(
                    saveCurrentSession({
                      openNewSession: true,
                      generateTitle: false,
                    }),
                  )
                }
              >
                Start a new session with it
              </ChoiceButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
