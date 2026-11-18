import {
  ChevronDownIcon,
  ClipboardDocumentListIcon,
  Cog6ToothIcon,
} from "@heroicons/react/24/outline";
import type { LoopState, TaskPlan } from "core";
import { costMarkOf } from "core/util/loopCost";
import {
  formatLoopStatus,
  isLoopPaused,
  loopTokensFromUsage,
  openLoopItems,
} from "core/util/loopMode";
import { loopUsage } from "core/util/loopUsage";
import { useEffect, useId, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectModeEntry } from "../../redux/selectors/selectModeEntry";
import { cancelStream } from "../../redux/thunks/cancelStream";
import {
  endLoopThunk,
  resumeLoopThunk,
  startFreshThunk,
  stopLoopThunk,
} from "../../redux/thunks/loop";
import { LoopPhaseMark } from "../LoopPhaseMark";
import { LoopStateIcon } from "./LoopStateIcon";
import { loopStripModel } from "./loopStrip";
import { LOOP_VISUAL } from "./loopVisualState";

const TEXT_BUTTON =
  "min-h-6 shrink-0 cursor-pointer border-none bg-transparent px-1 text-xs hover:underline";
const ICON_BUTTON =
  "hover:bg-list-item-hover flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-description";

/** Scrolls to the latest plan tile in the transcript. */
export function jumpToPlan(): boolean {
  const tiles = document.querySelectorAll<HTMLElement>(
    "[data-testid=plan-card]",
  );
  const tile = tiles[tiles.length - 1];
  if (!tile) return false;
  tile.scrollIntoView?.({ block: "center", behavior: "smooth" });
  return true;
}

/**
 * The loop's one status line, above the tray and the input: its mark, its
 * title, Stop (with Stop now in a menu), a gear for the loop's settings and a
 * jump to the plan; then the state's icon and word, the progress of the
 * to-dos, the round and what is left of the time and token budget; then what
 * runs now. It carries the state in an icon, a word and a colour, never the
 * colour alone. There is no pause: Stop ends the loop after the running item,
 * and a loop left for another mode is resumable (isLoopPaused).
 */
export function LoopStatusLine({
  loop,
  taskPlan,
  settingsOpen,
  onToggleSettings,
}: {
  loop: LoopState;
  taskPlan?: TaskPlan;
  settingsOpen: boolean;
  onToggleSettings: () => void;
}) {
  const dispatch = useAppDispatch();
  const entry = useAppSelector(selectModeEntry);
  const sessionUsage = useAppSelector((s) => s.session.usage);
  const [now, setNow] = useState(() => new Date());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (loop.status === "stopped") return;
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [loop.status]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (!menuRoot.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [menuOpen]);

  const usage = loopUsage(loop, {
    sessionTokens: sessionUsage ? loopTokensFromUsage(sessionUsage) : 0,
    costMark: costMarkOf(sessionUsage),
    now,
  });
  const model = loopStripModel(loop, taskPlan, usage);
  const style = LOOP_VISUAL[model.state];
  const stopped = loop.status === "stopped";
  const paused = isLoopPaused(loop);
  const tasksLeft = openLoopItems(loop);
  const waveRunning = !!loop.parallel?.length;
  const title = loop.title ?? "Loop";
  const stopLabel = waveRunning ? "Stop the wave" : "Stop after this item";
  const stopTitle = waveRunning
    ? "Stop the wave's workers now; their items go back to pending"
    : "Stop once the running item or re-plan ends";
  const percent =
    model.total > 0 ? Math.round((model.done / model.total) * 100) : 0;
  const summary = `${title} · ${formatLoopStatus(loop, { level: false })}`;
  const stopAfter = () => {
    setMenuOpen(false);
    void dispatch(stopLoopThunk());
  };

  return (
    <section
      aria-label="Loop status"
      data-testid="loop-strip"
      data-state={model.state}
      className="flex min-w-0 flex-col gap-0.5"
    >
      <span data-testid="loop-status" className="sr-only">
        {summary}
      </span>
      <div className="flex min-w-0 items-center gap-1">
        <LoopPhaseMark className="h-3.5 w-[25px] shrink-0" />
        <span
          data-testid="loop-title"
          title={title}
          className="min-w-0 flex-1 truncate font-semibold"
        >
          {title}
        </span>
        {stopped ? (
          <>
            {paused && tasksLeft > 0 && entry === "loop" && (
              <button
                type="button"
                data-testid="loop-start-fresh"
                title="Drop the paused loop and plan again"
                className={`${TEXT_BUTTON} text-description hover:text-foreground`}
                onClick={() => void dispatch(startFreshThunk())}
              >
                Start fresh
              </button>
            )}
            {loop.stopReason !== "done" && (
              <button
                type="button"
                data-testid="loop-resume"
                className={`${TEXT_BUTTON} text-link`}
                title={
                  paused
                    ? "Budgets restart from now; the next item is told you worked outside the loop"
                    : "Budgets restart from now"
                }
                onClick={() => void dispatch(resumeLoopThunk())}
              >
                {paused && tasksLeft > 0
                  ? `Resume loop (${tasksLeft} task${tasksLeft === 1 ? "" : "s"} left)`
                  : "Resume"}
              </button>
            )}
            <button
              type="button"
              data-testid="loop-end"
              className={`${TEXT_BUTTON} text-description hover:text-foreground`}
              onClick={() => void dispatch(endLoopThunk())}
            >
              Close
            </button>
          </>
        ) : (
          <div ref={menuRoot} className="relative flex shrink-0 items-center">
            {!loop.stopRequested && (
              <button
                type="button"
                data-testid="loop-stop"
                aria-label={stopLabel}
                title={stopTitle}
                className="min-h-6 cursor-pointer rounded-l border border-solid border-border bg-transparent px-2 text-xs text-foreground hover:bg-input"
                onClick={stopAfter}
              >
                Stop
              </button>
            )}
            <button
              ref={menuButton}
              type="button"
              data-testid="loop-stop-menu"
              aria-label="More ways to stop"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              className={`flex min-h-6 w-6 cursor-pointer items-center justify-center border border-solid border-border bg-transparent p-0 text-foreground hover:bg-input ${loop.stopRequested ? "rounded" : "rounded-r border-l-0"}`}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <ChevronDownIcon className="h-2.5 w-2.5" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div
                id={menuId}
                role="menu"
                aria-label="Stop"
                data-testid="loop-stop-options"
                className="absolute top-full right-0 z-10 mt-0.5 flex min-w-40 flex-col rounded border border-solid border-border bg-input py-0.5 text-xs shadow-lg"
              >
                {!loop.stopRequested && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="loop-stop-after"
                    title={stopTitle}
                    className="cursor-pointer border-none bg-transparent px-2 py-1 text-left text-foreground hover:bg-list-active"
                    onClick={stopAfter}
                  >
                    {stopLabel}
                  </button>
                )}
                {loop.current && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="loop-stop-now"
                    title="Stop the running item now; it goes back to pending"
                    className="cursor-pointer border-none bg-transparent px-2 py-1 text-left text-foreground hover:bg-list-active"
                    onClick={() => {
                      setMenuOpen(false);
                      void dispatch(cancelStream());
                    }}
                  >
                    Stop now
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          data-testid="loop-settings-toggle"
          aria-label="Loop settings"
          title="Loop settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          className={ICON_BUTTON}
          onClick={onToggleSettings}
        >
          <Cog6ToothIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        {taskPlan && (
          <button
            type="button"
            data-testid="loop-jump-to-plan"
            aria-label="Jump to plan"
            title="Jump to the plan"
            className={ICON_BUTTON}
            onClick={() => void jumpToPlan()}
          >
            <ClipboardDocumentListIcon
              className="h-3.5 w-3.5"
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      <div
        data-testid="loop-strip-progress-row"
        className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-description"
      >
        <span className="flex shrink-0 items-center gap-1">
          <LoopStateIcon state={model.state} />
          <span
            data-testid="loop-state-word"
            className="font-semibold text-foreground"
          >
            {model.word}
          </span>
        </span>
        <span
          role="progressbar"
          aria-label="To-dos done"
          aria-valuemin={0}
          aria-valuemax={model.total}
          aria-valuenow={model.done}
          aria-valuetext={`${model.done} of ${model.total} done`}
          className="h-1 min-w-10 flex-1 basis-10 overflow-hidden rounded-full bg-lightgray/30"
        >
          <span
            className={`block h-full ${style.fill}`}
            style={{ width: `${percent}%` }}
          />
        </span>
        <span data-testid="loop-strip-done" className="shrink-0">
          {model.done}/{model.total}
        </span>
        <span
          data-testid="loop-strip-round"
          className="hidden shrink-0 min-[360px]:inline"
          title={
            model.maxRounds > 0
              ? `Round ${model.round} of ${model.maxRounds}`
              : `Round ${model.round}`
          }
        >
          {model.maxRounds > 0
            ? `R${model.round}/${model.maxRounds}`
            : `R${model.round}`}
        </span>
        <span
          data-testid="loop-strip-budget"
          className="hidden shrink-0 min-[360px]:inline"
          title="What is left of the loop's time and token budget"
        >
          {model.time} · {model.tokens}
        </span>
      </div>
      {model.now && (
        <div
          data-testid="loop-now"
          title={model.now}
          className="min-w-0 truncate text-description"
        >
          Now: {model.now}
        </div>
      )}
    </section>
  );
}
