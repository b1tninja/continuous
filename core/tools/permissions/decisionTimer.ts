import { refusalText } from "../refusalText";

import { POLICY_LEVELS, type PolicyLevel } from "./levelText";

/**
 * The decision timer. The policy evaluates as it always has and gives a
 * decision. With a timer, that decision is held as a proposal for a visible
 * window: the person can do something else, and when the window ends the
 * proposal takes effect. Nothing here changes what the policy decides.
 */

/**
 * The windows a person can choose, in seconds. 0 is off: no timer. None is
 * longer than 30: a hold adds to the gap between two requests to the model, a
 * prompt cache entry lasts 5 minutes by default, and the asks of one turn are
 * shown one after another (turnBudget.ts).
 */
export const TIMER_SECONDS = [0, 5, 10, 15, 30] as const;

/**
 * The longest a proposal to run an allowed call may be held. An ask waits for
 * the person anyway, so its window only caps the wait. An allow does not wait:
 * every call would be delayed, and delays add up over a session.
 */
export const ALLOW_PROPOSAL_MAX_SECONDS = 10;
export type TimerSeconds = (typeof TIMER_SECONDS)[number];

/** A window per level, the level in force for the call's area. Absent is off. */
export type TimerSettings = Partial<Record<PolicyLevel, TimerSeconds>>;

/**
 * The windows for a heads-up on a call the policy allows ("Runs in 5 s unless
 * you answer"). These are not the ask windows: setting a window for asks must
 * not start delaying every allowed call, so the two are separate settings.
 * None is longer than ALLOW_PROPOSAL_MAX_SECONDS.
 */
export const HEADS_UP_SECONDS = [0, 5, 10] as const;

/**
 * Settings from a file or a flag. A level that is not known, or a value that
 * is not one of the windows, is off, so a typo never starts a delay. IDGAF is
 * always off: nothing is checked there, so there is nothing to propose.
 */
export function parseTimerSettings(
  value: unknown,
  windows: readonly number[] = TIMER_SECONDS,
): TimerSettings {
  const out: TimerSettings = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return out;
  }
  for (const level of POLICY_LEVELS) {
    if (level === "idgaf") continue;
    const raw = (value as Record<string, unknown>)[level];
    const n = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (windows.includes(n as number) && n !== 0) {
      out[level] = n as TimerSeconds;
    }
  }
  return out;
}

/** The policy's decision, as the engine reports it. */
export interface PolicyFact {
  policy: "allowedWithoutPermission" | "allowedWithPermission" | "disabled";
  source?: string;
  /** The protection that decided, if any */
  protection?: string;
  reason?: string;
}

/**
 * Asks that keep waiting for the person with no timer: the ones a rule or a
 * guard raised on purpose. Only an ask from the level the person chose, or
 * from a tool's own setting, is something a window can answer.
 */
const TIMED_ASK_SOURCES: ReadonlySet<string> = new Set([
  "tool-setting",
  "manual",
  "cautious",
]);

/** A refusal the person cannot undo from a window: it is their own "never". */
export function isFinalRefusal(fact: PolicyFact): boolean {
  return fact.policy === "disabled";
}

export type Proposed = "allow" | "refuse";

export interface Proposal {
  /** What happens when the window ends */
  proposed: Proposed;
  /** The policy's own decision, kept for the audit */
  decision: PolicyFact;
  /** The window actually held: the level's, capped for an allow, or what a turn budget leaves */
  seconds: number;
  /** Milliseconds since the epoch when the window started */
  startedAt: number;
}

export interface TimerContext {
  /** Someone is at the keyboard and can see a countdown. False for headless and unattended runs. */
  attended: boolean;
  level: PolicyLevel;
  /** The windows for asks (`levels.timer`) */
  settings: TimerSettings;
  /** The windows for a heads-up on an allowed call (`levels.headsUp`); absent is none */
  headsUp?: TimerSettings;
  now: number;
}

/**
 * The proposal for a decision, or undefined when no timer applies: no window
 * at this level, nobody to see it, IDGAF, a refusal that is final, or an ask
 * that a rule or guard raised. An allow proposes to run, and an ask proposes
 * to refuse, which is what the policy does when nobody can answer.
 */
export function propose(
  fact: PolicyFact,
  ctx: TimerContext,
): Proposal | undefined {
  if (!ctx.attended || ctx.level === "idgaf") return undefined;
  if (isFinalRefusal(fact)) return undefined;
  // An ask has the ask windows; an allowed call has its own, separate ones
  const seconds =
    fact.policy === "allowedWithPermission"
      ? ctx.settings[ctx.level]
      : ctx.headsUp?.[ctx.level];
  if (!seconds) return undefined;
  if (fact.policy === "allowedWithPermission") {
    if (fact.protection !== undefined) return undefined;
    if (fact.source === undefined || !TIMED_ASK_SOURCES.has(fact.source)) {
      return undefined;
    }
    return { proposed: "refuse", decision: fact, seconds, startedAt: ctx.now };
  }
  return {
    proposed: "allow",
    decision: fact,
    seconds: Math.min(seconds, ALLOW_PROPOSAL_MAX_SECONDS),
    startedAt: ctx.now,
  };
}

/**
 * Milliseconds left in the window; 0 once it has ended. Never negative and
 * never more than the window, so a clock that steps back (a time change, a
 * resumed laptop) cannot lengthen a countdown the person is watching.
 */
export function remainingMs(p: Proposal, now: number): number {
  const window = p.seconds * 1000;
  return Math.min(window, Math.max(0, p.startedAt + window - now));
}

/** Whole seconds left, rounded up, so the last second reads 1 and never 0 early. */
export function remainingSeconds(p: Proposal, now: number): number {
  return Math.ceil(remainingMs(p, now) / 1000);
}

/** "7 s", and "0:45" from a minute up. For a countdown beside the proposal. */
export function countdownLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** How a proposal ended. The audit keeps these three apart. */
export type TimerOutcome = "default-applied" | "overridden" | "confirmed";

export interface Resolved {
  outcome: TimerOutcome;
  final: Proposed;
}

/**
 * The end of a proposal. `answer` is what the person chose, if they did:
 * allow or deny. Before the window ends with no answer the proposal is still
 * pending, and this returns undefined.
 */
export function resolve(
  p: Proposal,
  answer: "allow" | "deny" | undefined,
  now: number,
): Resolved | undefined {
  if (answer === undefined) {
    return remainingMs(p, now) === 0
      ? { outcome: "default-applied", final: p.proposed }
      : undefined;
  }
  const chosen: Proposed = answer === "allow" ? "allow" : "refuse";
  return {
    outcome: chosen === p.proposed ? "confirmed" : "overridden",
    final: chosen,
  };
}

/**
 * What the model is told, or undefined when it needs no note (the call runs).
 * A refusal says who decided: nobody answered, or the person declined (the
 * same line as a decline with no timer, core/tools/refusalText). It never
 * calls a default a verdict on the command, and never tells the model to try
 * another approach; a model that reads a refusal as a hint to route around
 * starts doing exactly that.
 */
export function modelNote(
  r: Resolved,
  toolName: string,
  seconds: number,
): string | undefined {
  if (r.final === "allow") return undefined;
  if (r.outcome === "default-applied") {
    return (
      `No answer to ${toolName} within ${seconds} s, so it was refused as the ` +
      `policy does when nobody can answer. The call itself was not judged ` +
      `unsafe and the person did not refuse it. Ask again only if the step is ` +
      `needed; do not change the approach to avoid this prompt.`
    );
  }
  return refusalText.declined(toolName);
}
