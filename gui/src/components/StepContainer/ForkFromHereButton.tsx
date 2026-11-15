import { Square2StackIcon } from "@heroicons/react/24/outline";
import { useId, useState } from "react";
import { useForkCostLine } from "../../hooks/useForkCostLine";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { forkSessionThunk } from "../../redux/thunks/forkSession";
import { ToolTip } from "../gui/Tooltip";

/**
 * "Fork from here" in a response's actions: a new session with the history up
 * to and including this turn, opened beside the original. The line saying
 * what the fork's first message re-reads (and costs) is its tooltip and its
 * accessible description; it is worked out when the button is pointed at or
 * focused, not for every turn on every render.
 */
export function ForkFromHereButton({ index }: { index: number }) {
  const dispatch = useAppDispatch();
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const [armed, setArmed] = useState(false);
  const line = useForkCostLine(index, armed);
  const descriptionId = useId();

  return (
    <>
      <ToolTip
        place="bottom"
        content={
          <span className="text-xs">
            Fork from here{line ? `. ${line}` : ""}
          </span>
        }
      >
        <button
          type="button"
          data-testid={`fork-from-here-button-${index}`}
          aria-label="Fork from here"
          aria-describedby={line ? descriptionId : undefined}
          disabled={isStreaming}
          onMouseEnter={() => setArmed(true)}
          onFocus={() => setArmed(true)}
          onClick={() => void dispatch(forkSessionThunk({ upTo: index }))}
          className="flex min-h-6 min-w-6 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0.5 text-description-muted hover:bg-input focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus disabled:cursor-default"
        >
          <Square2StackIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </ToolTip>
      {line && (
        <span id={descriptionId} className="sr-only">
          {line}
        </span>
      )}
    </>
  );
}
