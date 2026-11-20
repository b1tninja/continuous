import { TIMER_SECONDS, type TimerSeconds } from "./decisionTimer";

/**
 * How long a turn may spend holding decisions before the next request to the
 * model. Prompt cache entries last 5 minutes by default (1 hour when chosen),
 * and each read refreshes the clock, so what matters is the gap between two
 * requests. That gap is the model's time, the tools' time and every hold, and
 * the asks of one turn are shown one after another, so their windows add up.
 *
 * Measured gaps between requests (1,449 on one machine): median 19 s, 90th
 * percentile 89 s, 95th percentile 133 s. A budget of 60 s keeps the 95th
 * percentile gap near 190 s, inside five minutes; 300 s keeps it inside an hour.
 */
export const TURN_BUDGET_SECONDS = { "5m": 60, "1h": 300 } as const;

/** The smallest window worth starting. Less than this is not a window. */
export const SMALLEST_WINDOW: Exclude<TimerSeconds, 0> = 5;

export interface TurnBudget {
  /** Seconds of holding left in this turn */
  remaining(): number;
  /**
   * The window to use for a hold that wants `wanted` seconds: the whole of it
   * while the budget lasts, what is left if that is at least the smallest
   * window, and 0 (no timer; the ask waits, as it does today) after that.
   */
  grant(wanted: number): number;
  /** Takes `seconds` from the budget, for what was actually held. */
  spend(seconds: number): void;
  /** A new request to the model starts a new turn. */
  reset(): void;
}

export function createTurnBudget(limitSeconds: number): TurnBudget {
  let left = Math.max(0, limitSeconds);
  return {
    remaining: () => left,
    grant(wanted) {
      if (!(wanted > 0)) return 0;
      if (left >= wanted) return wanted;
      return left >= SMALLEST_WINDOW ? Math.floor(left) : 0;
    },
    spend(seconds) {
      if (seconds > 0) left = Math.max(0, left - seconds);
    },
    reset() {
      left = Math.max(0, limitSeconds);
    },
  };
}

/** True when `seconds` is one of the windows a person can choose. */
export function isWindow(seconds: number): boolean {
  return (TIMER_SECONDS as readonly number[]).includes(seconds) && seconds > 0;
}
