import {
  HEADS_UP_SECONDS,
  TIMER_SECONDS,
  type TimerSettings,
} from "core/tools/permissions/decisionTimer";
import { policyLevelLabel } from "core/tools/permissions/policy";

import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { changePolicyExtras } from "../../redux/thunks/policySettings";

/** The levels a window can be set for. IDGAF checks nothing, so it has none. */
const LEVELS = ["manual", "cautious", "automatic", "permissive"] as const;

type Which = "timer" | "headsUp";

/** The settings with one level's window changed; 0 removes it. */
export function withWindow(
  current: TimerSettings | undefined,
  level: (typeof LEVELS)[number],
  seconds: number,
): TimerSettings {
  const next: Record<string, number> = { ...(current ?? {}) };
  if (seconds > 0) next[level] = seconds;
  else delete next[level];
  return next as TimerSettings;
}

function WindowSelect({
  which,
  level,
  options,
  label,
}: {
  which: Which;
  level: (typeof LEVELS)[number];
  options: readonly number[];
  label: string;
}) {
  const dispatch = useAppDispatch();
  const current = useAppSelector(
    (s) => s.ui.policyExtras?.[which]?.[level] ?? 0,
  );
  const all = useAppSelector((s) => s.ui.policyExtras?.[which]);
  return (
    <select
      aria-label={label}
      data-testid={`${which}-${level}`}
      value={current}
      onChange={(e) =>
        void dispatch(
          changePolicyExtras({
            [which]: withWindow(all, level, Number(e.target.value)),
          }),
        )
      }
      className="shrink-0 cursor-pointer rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
    >
      {options.map((s) => (
        <option key={s} value={s}>
          {s === 0 ? "Off" : `${s} s`}
        </option>
      ))}
    </select>
  );
}

/**
 * The decision timer (core decisionTimer.ts): how long a decision is held for
 * a countdown before it takes effect, per level. Asks have windows up to 30 s;
 * a heads-up on an allowed call is 5 or 10 s. Both are off by default.
 */
export function DecisionTimerCard() {
  return (
    <section
      className="mt-2 flex flex-col gap-1"
      aria-labelledby="decision-timer-heading"
      data-testid="decision-timer"
    >
      <h4 id="decision-timer-heading" className="my-0 text-xs font-semibold">
        Decision timer
      </h4>
      <p className="my-0 text-2xs text-description">
        Gives you a countdown before a decision takes effect, so you can answer
        without a refusal and a retry. An ask that nobody answers is refused
        when its window ends; an allowed call with a heads-up runs. Asks that a
        rule or a guard raised keep waiting. The model is told when nobody
        answered. A turn adds at most the longest window to the wait.
      </p>
      <div
        className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 text-xs"
        role="group"
        aria-label="Windows by level"
      >
        <span />
        <span className="text-2xs text-description">Asks</span>
        <span className="text-2xs text-description">Allowed calls</span>
        {LEVELS.map((level) => {
          const name = policyLevelLabel("tools", level);
          return (
            <div key={level} className="contents">
              <span>{name}</span>
              <WindowSelect
                which="timer"
                level={level}
                options={TIMER_SECONDS}
                label={`Window for asks at ${name}`}
              />
              <WindowSelect
                which="headsUp"
                level={level}
                options={HEADS_UP_SECONDS}
                label={`Heads-up for allowed calls at ${name}`}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
