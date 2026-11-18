import type { LoopState, TaskPlan } from "core";
import { describeLoopReplan } from "core/util/loopMode";
import { useState } from "react";
import { LoopItemList, loopShowsUsage } from "../loop/LoopItemList";

/**
 * The loop's to-dos, under its status line in the inbox: skip an item or run
 * it again, and under each item what it runs on and what it may use. The
 * re-plan setting and the limits are in the loop settings dialog. Every
 * decision and bound is core's (skipItem, runItemAgain); a refusal shows here.
 */
export function LoopControls({
  loop,
  taskPlan,
  showUsage,
}: {
  loop: LoopState;
  taskPlan?: TaskPlan;
  /** Show what each item's runs used; by default once the limits differ from the level's */
  showUsage?: boolean;
}) {
  const [error, setError] = useState<string>();
  return (
    <details data-testid="loop-controls" open className="mt-1 text-description">
      <summary className="cursor-pointer">
        To-dos · {describeLoopReplan(loop)}
      </summary>
      {taskPlan && (
        <LoopItemList
          loop={loop}
          taskPlan={taskPlan}
          showUsage={showUsage ?? loopShowsUsage(loop, false)}
          onResult={(result) => setError(result.ok ? undefined : result.error)}
        />
      )}
      {error && (
        <div
          role="alert"
          data-testid="loop-controls-error"
          className="mt-0.5 break-words text-error"
        >
          {error}
        </div>
      )}
    </details>
  );
}
