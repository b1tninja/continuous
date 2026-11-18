import type { LoopState } from "core";
import {
  LIMIT_POLICIES,
  LIMIT_POLICY_LABEL,
  limitPolicyOf,
  type LimitPolicy,
} from "core/util/itemBudgetPolicy";
import {
  describeLoopBudget,
  loopReplanSetting,
  LoopReplanSetting,
  maxRoundsForReplan,
} from "core/util/loopMode";
import { useEffect, useState } from "react";
import { useAppDispatch } from "../../redux/hooks";
import { setLoopBudgetThunk } from "../../redux/thunks/loop";
import { setLimitPolicyThunk } from "../../redux/thunks/loopBudget";

const BUTTON =
  "shrink-0 cursor-pointer rounded border border-solid border-border bg-transparent px-2 py-1 text-xs text-foreground hover:bg-input";
const FIELD =
  "w-20 rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground";

/** The limits as the editor's fields: rounds, tokens, minutes (0: no limit). */
function draftOf(loop: LoopState) {
  return {
    rounds: String(loop.budget.maxRounds),
    tokens: String(loop.budget.maxTokens),
    minutes: String(Math.round(loop.budget.maxWallMs / 60000)),
  };
}

/**
 * How often to re-plan and the loop's limits: rounds, tokens, minutes, and
 * what happens when a to-do uses up its own budget. Every bound is core's
 * (setLoopBudget); a refusal shows under the fields.
 */
export function LoopLimitsEditor({
  loop,
  onApplied,
}: {
  loop: LoopState;
  /** The limits were applied: the item list may show what each run used */
  onApplied: () => void;
}) {
  const dispatch = useAppDispatch();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState(() => draftOf(loop));
  // The limits are out of sight until asked for
  const [budgetOpen, setBudgetOpen] = useState(false);
  const { maxRounds, maxTokens, maxWallMs } = loop.budget;
  useEffect(() => setDraft(draftOf(loop)), [maxRounds, maxTokens, maxWallMs]);

  const report = (result: { ok: boolean; error?: string }) =>
    setError(result.ok ? undefined : result.error);
  const setReplan = async (setting: LoopReplanSetting) =>
    report(
      await dispatch(
        setLoopBudgetThunk({ maxRounds: maxRoundsForReplan(loop, setting) }),
      ).unwrap(),
    );
  const replan = loopReplanSetting(loop);

  return (
    <div data-testid="loop-limits" className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <label className="flex shrink-0 items-center gap-0.5 py-1">
          Re-plan
          <select
            data-testid="loop-replan"
            value={replan.kind}
            onChange={(e) => {
              const kind = e.target.value as LoopReplanSetting["kind"];
              void setReplan(
                kind === "up_to"
                  ? { kind, replans: Math.max(1, maxRounds - 1) }
                  : { kind },
              );
            }}
            className="cursor-pointer rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground"
          >
            <option value="never">never</option>
            <option value="up_to">up to N times</option>
            <option value="until_done">until done</option>
          </select>
        </label>
        {replan.kind === "up_to" && (
          <input
            type="number"
            data-testid="loop-replan-count"
            aria-label="Number of re-plans"
            min={1}
            value={replan.replans}
            onChange={(e) => {
              const replans = Number(e.target.value);
              // An emptied field is not "never"; wait for a number
              if (replans >= 1) void setReplan({ kind: "up_to", replans });
            }}
            className={FIELD}
          />
        )}
        <button
          type="button"
          data-testid="loop-budget-toggle"
          aria-expanded={budgetOpen}
          title={describeLoopBudget(loop.budget)}
          className="min-h-6 shrink-0 cursor-pointer border-none bg-transparent px-1 text-xs text-link hover:underline"
          onClick={() => {
            if (budgetOpen) setDraft(draftOf(loop));
            setBudgetOpen(!budgetOpen);
          }}
        >
          {budgetOpen ? "Hide the budget" : "Set a budget…"}
        </button>
      </div>
      {budgetOpen && (
        <div
          data-testid="loop-budget"
          className="flex min-w-0 flex-wrap items-center gap-1"
        >
          {(
            [
              ["rounds", "Rounds"],
              ["tokens", "Tokens (0: none)"],
              ["minutes", "Minutes (0: none)"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex shrink-0 items-center gap-0.5 py-1"
            >
              {label}
              <input
                type="number"
                data-testid={`loop-limit-${key}`}
                min={0}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                className={FIELD}
              />
            </label>
          ))}
          <label
            className="flex shrink-0 items-center gap-0.5 py-1"
            title="When a to-do uses up its own budget: Suggest asks you, Force stops it, Review has its work reviewed and extends it once if it is progressing"
          >
            At a to-do's limit
            <select
              data-testid="loop-limit-policy"
              value={limitPolicyOf(loop)}
              onChange={(e) =>
                void dispatch(
                  setLimitPolicyThunk(e.target.value as LimitPolicy),
                )
              }
              className="cursor-pointer rounded border border-solid border-border bg-input px-1 py-1 text-xs text-foreground"
            >
              {LIMIT_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {LIMIT_POLICY_LABEL[policy]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="loop-limits-apply"
            className={BUTTON}
            title={describeLoopBudget(loop.budget)}
            onClick={async () => {
              const result = await dispatch(
                setLoopBudgetThunk({
                  maxRounds: Number(draft.rounds),
                  maxTokens: Number(draft.tokens),
                  maxWallMs: Math.round(Number(draft.minutes) * 60000),
                }),
              ).unwrap();
              report(result);
              // Applied: the fields go away; a refusal keeps them open
              if (result.ok) {
                setBudgetOpen(false);
                onApplied();
              }
            }}
          >
            Apply
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          data-testid="loop-controls-error"
          className="break-words text-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}
