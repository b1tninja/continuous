import {
  isLoopPaused,
  openLoopItems,
  standingInstructions,
} from "core/util/loopMode";
import { useState } from "react";
import { useAppSelector } from "../../redux/hooks";
import { selectModeEntry } from "../../redux/selectors/selectModeEntry";
import {
  LoopSettingsDialog,
  useLoopNoteDraft,
} from "../loop/LoopSettingsDialog";
import { loopShowsUsage } from "../loop/LoopItemList";
import { LoopStatusLine } from "../loop/LoopStatusLine";
import { LoopControls } from "./LoopControls";

/**
 * Loop mode's inbox, above the input: one status line, and under the gear the
 * loop's settings dialog (strategy, parallel, limits, a note about the whole plan). Answers
 * can be given at any time; the loop routes each one (core/util/loopMode.ts
 * answerLoop).
 */
export function LoopInbox() {
  const loop = useAppSelector((s) => s.session.loop);
  const taskPlan = useAppSelector((s) => s.session.taskPlan);
  const entry = useAppSelector(selectModeEntry);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const noteDraft = useLoopNoteDraft();
  // Once a budget has been set, or differs from the level's own, show what each run used
  const [budgetApplied, setBudgetApplied] = useState(false);
  if (!loop) return null;

  const standingNotes = standingInstructions(loop);
  const showUsage = loopShowsUsage(loop, budgetApplied);
  const paused = isLoopPaused(loop);
  const tasksLeft = openLoopItems(loop);
  const modeLabel = entry.charAt(0).toUpperCase() + entry.slice(1);

  return (
    <div data-testid="loops-panel" className="mx-1 mb-1 min-w-0">
      <div
        data-testid="loop-inbox"
        className="min-w-0 rounded border border-solid border-border px-2 py-1 text-xs"
      >
        <LoopStatusLine
          loop={loop}
          taskPlan={taskPlan}
          settingsOpen={settingsOpen}
          onToggleSettings={() => setSettingsOpen(!settingsOpen)}
        />
        <LoopSettingsDialog
          loop={loop}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          draft={noteDraft}
          onBudgetApplied={() => setBudgetApplied(true)}
        />
        {paused && (
          <div
            data-testid="loop-paused"
            className="mt-0.5 break-words text-description"
          >
            {entry === "loop"
              ? `Paused: you came back to Loop. ${tasksLeft > 0 ? `Resume it (${tasksLeft} left; budgets restart from now) or start fresh.` : "Nothing is left to run, so the next message plans again."}`
              : `Paused: you are in ${modeLabel} mode. Choose Loop to resume.`}
          </div>
        )}
        {loop.current?.kind === "check" && (
          <div
            data-testid="loop-check-running"
            className="mt-0.5 truncate text-description"
          >
            Running the check for {loop.current.itemId}:{" "}
            <code>
              {
                taskPlan?.items.find((i) => i.id === loop.current?.itemId)
                  ?.check
              }
            </code>
          </div>
        )}
        <LoopControls loop={loop} taskPlan={taskPlan} showUsage={showUsage} />
        {(loop.autoDecisions ?? []).slice(-3).map((d, i) => (
          <div
            key={`${d.at}-${i}`}
            data-testid="loop-auto-decision"
            title={`By the system, under ${d.source}`}
            className="mt-0.5 truncate text-description"
          >
            {d.text}
          </div>
        ))}
        {standingNotes.length > 0 && (
          <ul
            data-testid="loop-standing-list"
            className="m-0 mt-1 list-none p-0 text-description"
          >
            {standingNotes.map((text, i) => (
              <li key={i} className="break-words">
                For every item: {text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
