import { useEffect, useState } from "react";
import { useAppSelector } from "../../../../redux/hooks";
import {
  formatPromptProgress,
  RECOVERY_HOLD_TEXT,
} from "../../../../util/promptProgress";
import { GeneratingIndicator } from "./GeneratingIndicator";

/** Seconds since `active` became true; 0 while it is false. */
function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(
      () => setSeconds(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [active]);
  return seconds;
}

/** Until then a hold looks like any short pause. */
const SHOW_SECONDS_AFTER = 10;

interface StreamingToolbarProps {
  onStop: () => void;
  displayText?: string;
}

export function StreamingToolbar({
  onStop,
  displayText = "Stop",
}: StreamingToolbarProps) {
  // While a local server reads a long prompt, say how far it is
  const progress = useAppSelector((state) => state.session.promptProgress);
  // While the reply is held for tool call recovery nothing else would show
  const held = useAppSelector((state) => state.session.recoveryHold);
  const heldSeconds = useElapsedSeconds(!!held);

  return (
    <div className="flex w-full items-center justify-between">
      {progress ? (
        <GeneratingIndicator
          text={formatPromptProgress(progress)}
          testId="prompt-progress"
        />
      ) : held ? (
        <GeneratingIndicator
          text={
            heldSeconds >= SHOW_SECONDS_AFTER
              ? `${RECOVERY_HOLD_TEXT} (${heldSeconds} s)`
              : RECOVERY_HOLD_TEXT
          }
          testId="recovery-hold"
        />
      ) : (
        <GeneratingIndicator />
      )}
      <button
        type="button"
        onClick={onStop}
        className="min-h-6 cursor-pointer border-none bg-transparent px-1.5 py-0.5 text-2xs hover:brightness-125"
      >
        <span className="text-description">{displayText}</span>
      </button>
    </div>
  );
}
