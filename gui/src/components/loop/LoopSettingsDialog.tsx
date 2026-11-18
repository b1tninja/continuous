import {
  Dialog,
  DialogPanel,
  DialogTitle,
  Description,
} from "@headlessui/react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { LoopState, LoopStrategy } from "core";
import { policyLevelLabel } from "core/tools/permissions/policy";
import {
  LOOP_LIMITS,
  LOOP_MAX_PARALLEL,
  LOOP_STRATEGIES,
  LOOP_STRATEGY_ORDER,
  loopStrategy,
} from "core/util/loopMode";
import { useState } from "react";
import { useAppDispatch } from "../../redux/hooks";
import {
  answerLoopQuestion,
  setLoopParallelThunk,
  setLoopStrategyThunk,
} from "../../redux/thunks/loop";
import { LoopLimitsEditor } from "./LoopLimitsEditor";
import { LoopUsagePanel } from "./LoopUsagePanel";

/** The note about the whole plan, and where it goes; kept while the dialog is closed. */
export function useLoopNoteDraft() {
  const [note, setNote] = useState("");
  const [replanNow, setReplanNow] = useState(false);
  const [standing, setStanding] = useState(false);
  return { note, setNote, replanNow, setReplanNow, standing, setStanding };
}
export type LoopNoteDraft = ReturnType<typeof useLoopNoteDraft>;

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1 border-0 border-t border-solid border-border pt-2">
      <h3 className="m-0 text-xs font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Everything the person can change about a running loop, in one dialog
 * opened from the status line's gear: how a failed item is handled (strategy),
 * Parallel, how often to re-plan and the limits, the usage so far, the
 * permission levels in force (read only: the toolbar owns them), and a note
 * about the whole plan. Escape closes it and focus goes back to the gear; the
 * dialog traps focus while it is open.
 */
export function LoopSettingsDialog({
  loop,
  open,
  onClose,
  draft,
  onBudgetApplied,
}: {
  loop: LoopState;
  open: boolean;
  onClose: () => void;
  draft: LoopNoteDraft;
  onBudgetApplied: () => void;
}) {
  const dispatch = useAppDispatch();
  const [noteError, setNoteError] = useState<string>();
  const { note, setNote, replanNow, setReplanNow, standing, setStanding } =
    draft;
  // Parallel waves need a level that does not ask before each edit
  const supervised = (loop.autonomy ?? "auto") === "supervised";

  const sendNote = async () => {
    const result = await dispatch(
      answerLoopQuestion({ text: note, replanNow, standing }),
    ).unwrap();
    const failed = result.ok ? undefined : result.error;
    setNoteError(failed);
    if (!failed) {
      setNote("");
      setReplanNow(false);
      setStanding(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-start justify-center overflow-y-auto p-2">
        <DialogPanel
          data-testid="loop-settings"
          className="flex w-full max-w-md min-w-0 flex-col gap-2 rounded border border-solid border-border bg-background p-3 text-xs text-foreground shadow-lg"
        >
          <div className="flex items-center gap-1">
            <DialogTitle className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
              Loop settings
            </DialogTitle>
            <button
              type="button"
              data-testid="loop-settings-close"
              aria-label="Close loop settings"
              className="hover:bg-list-item-hover flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-description"
              onClick={onClose}
            >
              <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <Description className="m-0 text-description">
            Changes apply to the running loop at its next step.
          </Description>

          <Section title="How it runs">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <label className="flex items-center gap-1">
                Strategy
                <select
                  data-testid="loop-strategy"
                  value={loopStrategy(loop)}
                  title={LOOP_STRATEGIES[loopStrategy(loop)].description}
                  onChange={(e) =>
                    void dispatch(
                      setLoopStrategyThunk(e.target.value as LoopStrategy),
                    )
                  }
                  className="shrink-0 cursor-pointer rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground"
                >
                  {LOOP_STRATEGY_ORDER.map((strategy) => (
                    <option key={strategy} value={strategy}>
                      {LOOP_STRATEGIES[strategy].label}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className="flex shrink-0 items-center gap-0.5 py-1 text-description"
                title={
                  supervised
                    ? "Parallel waves run only at a level that does not ask before each edit"
                    : `Run items with disjoint files: lines at the same time, up to ${LOOP_MAX_PARALLEL}, each in its own worktree; the change applies at the next step`
                }
              >
                <input
                  type="checkbox"
                  data-testid="loop-parallel"
                  checked={!!loop.parallelOn}
                  disabled={supervised}
                  onChange={(e) =>
                    void dispatch(setLoopParallelThunk(e.target.checked))
                  }
                />
                Parallel
              </label>
            </div>
            <div
              data-testid="loop-policy"
              title="Plan edits and Questions: change them in the toolbar or in Settings > Tools"
              className="text-description"
            >
              Plan {policyLevelLabel("plan", loop.policy?.plan ?? "cautious")} ·
              Questions{" "}
              {policyLevelLabel(
                "questions",
                loop.policy?.questions ?? "cautious",
              )}
            </div>
          </Section>

          <Section title="Plan and limits">
            <LoopLimitsEditor loop={loop} onApplied={onBudgetApplied} />
            <LoopUsagePanel loop={loop} />
          </Section>

          <Section title="A note about the whole plan">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <input
                data-testid="loop-plan-note"
                aria-label="A note about the whole plan"
                value={note}
                maxLength={LOOP_LIMITS.maxAnswerLength}
                placeholder="Read at the next re-plan, or by every item"
                onChange={(e) => setNote(e.target.value)}
                className="min-w-0 flex-1 basis-40 rounded border border-solid border-border bg-transparent px-1 py-1 text-xs text-foreground placeholder:text-description"
              />
              <label className="flex shrink-0 items-center gap-0.5 py-1 text-description">
                <input
                  type="checkbox"
                  data-testid="loop-replan-now"
                  checked={replanNow}
                  onChange={(e) => {
                    setReplanNow(e.target.checked);
                    if (e.target.checked) setStanding(false);
                  }}
                />
                Re-plan now
              </label>
              <label
                className="flex shrink-0 items-center gap-0.5 py-1 text-description"
                title="Send this with every item from now on, instead of waiting for the re-plan"
              >
                <input
                  type="checkbox"
                  data-testid="loop-standing"
                  checked={standing}
                  onChange={(e) => {
                    setStanding(e.target.checked);
                    if (e.target.checked) setReplanNow(false);
                  }}
                />
                For every item
              </label>
              <button
                type="button"
                data-testid="loop-plan-note-send"
                disabled={!note.trim()}
                className="shrink-0 cursor-pointer rounded border border-solid border-border bg-transparent px-2 py-1 text-xs text-foreground hover:bg-input disabled:cursor-default disabled:opacity-50"
                onClick={() => void sendNote()}
              >
                Add
              </button>
            </div>
            {noteError && (
              <div role="alert" className="break-words text-error">
                {noteError}
              </div>
            )}
          </Section>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
