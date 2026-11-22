import {
  HEADS_UP_SECONDS,
  TIMER_SECONDS,
  type TimerSettings,
} from "core/tools/permissions/decisionTimer";
import {
  levelAsks,
  levelRunsHeld,
  POLICY_LEVELS,
  type PolicyLevel,
} from "core/tools/permissions/levelText";
import { policyLevelLabel } from "core/tools/permissions/policy";

import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { changePolicyExtras } from "../../redux/thunks/policySettings";

/** The levels that ask: each has a window for its asks and a heads-up. */
const LEVELS = POLICY_LEVELS.filter(levelAsks);
/** The levels that run what a lower level would hold (IDGAF): a heads-up only. */
const TOP_LEVELS = POLICY_LEVELS.filter(levelRunsHeld);

type Which = "timer" | "headsUp";

/** The settings with one level's window changed; 0 removes it. */
export function withWindow(
  current: TimerSettings | undefined,
  level: PolicyLevel,
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
  zero = "Off",
}: {
  which: Which;
  level: PolicyLevel;
  options: readonly number[];
  label: string;
  /** What 0 is called in this select */
  zero?: string;
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
          {s === 0 ? zero : `${s} s`}
        </option>
      ))}
    </select>
  );
}

/**
 * The row of a level that never asks (IDGAF): no window for asks, and a delay
 * for the calls it runs past an ask or a refusal. The line under it says the
 * value in use in words, 0 included, so the state is never a bare "Off".
 */
function TopLevelRow({ level }: { level: PolicyLevel }) {
  const name = policyLevelLabel("tools", level);
  const seconds = useAppSelector(
    (s) => s.ui.policyExtras?.headsUp?.[level] ?? 0,
  );
  return (
    <div className="contents">
      <span>{name}</span>
      <span
        className="text-2xs text-description"
        data-testid={`timer-${level}-none`}
      >
        Never asks
      </span>
      <WindowSelect
        which="headsUp"
        level={level}
        options={HEADS_UP_SECONDS}
        zero="0 s"
        label={`Delay at ${name} before a call a lower level would have asked about or refused`}
      />
      <span
        className="col-span-3 text-2xs text-description"
        data-testid={`headsUp-${level}-state`}
      >
        {seconds === 0
          ? `${name} delay: 0 seconds. Every call runs at once.`
          : `${name} delay: ${seconds} seconds, for a call a lower level would have asked about or refused. Other calls run at once.`}
      </span>
    </div>
  );
}

/**
 * The decision timer (core decisionTimer.ts): how long a decision is held for
 * a countdown before it takes effect, per level. Asks have windows up to 30 s;
 * a heads-up on an allowed call is 5 or 10 s. Both are off by default.
 *
 * The top level, IDGAF, has no asks, so its row has a heads-up only: a delay
 * before a call it runs past an ask or a refusal. 0 is what it does unset.
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
        answered. A turn adds at most the longest window to the wait. IDGAF has
        a delay of 0. Set one, and a call it runs that a lower level would have
        asked about or refused is shown first and runs when the delay ends.
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
        {TOP_LEVELS.map((level) => (
          <TopLevelRow key={level} level={level} />
        ))}
      </div>
    </section>
  );
}
