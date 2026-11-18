import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectPendingToolCalls } from "../../redux/selectors/selectToolCalls";
import { resumeTurn } from "../../redux/thunks/resumeTurn";
import { findResumableTurn } from "../../util/resumeTurn";

const WHY: Record<string, string> = {
  stopped: "Response stopped.",
  failed: "Response failed.",
  reloaded: "Response interrupted when the window closed.",
};

/**
 * Under the last turn when it was stopped, failed or cut off by a reload:
 * Resume carries it on without retyping (see resumeTurn).
 */
export default function ResumeResponse() {
  const dispatch = useAppDispatch();
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const history = useAppSelector((state) => state.session.history);
  const hasPendingToolCalls = useAppSelector(
    (state) => selectPendingToolCalls(state).length > 0,
  );
  if (isStreaming || hasPendingToolCalls) return null;
  const plan = findResumableTurn(history);
  if (!plan) return null;
  const reason = history
    .slice(plan.userIndex)
    .reverse()
    .find((item) => item.interrupted)?.interrupted;

  return (
    <div className="mx-1.5 my-2 flex items-center gap-2 text-xs text-description">
      <span>{(reason && WHY[reason]) ?? WHY.stopped}</span>
      <button
        type="button"
        aria-label="Resume response"
        data-testid="resume-response"
        className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-solid border-description bg-transparent px-1.5 py-0.5 text-xs text-description hover:bg-input hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus"
        onClick={() => void dispatch(resumeTurn())}
      >
        <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Resume
      </button>
    </div>
  );
}
