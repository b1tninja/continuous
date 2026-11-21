import { EventEmitter } from "node:events";

import { levelOfCall } from "core/tools/permissions/approval.js";
import {
  propose,
  type Proposal,
} from "core/tools/permissions/decisionTimer.js";
import {
  createTurnBudget,
  TURN_BUDGET_SECONDS,
} from "core/tools/permissions/turnBudget.js";
import { resolveShell } from "core/util/shell.js";

import { toCoreCall } from "./coreRules.js";
import { effectiveLevels, getPolicyExtras } from "./policyLevels.js";

/**
 * The decision timer in the terminal UI. The countdown is drawn by the Ink
 * prompt, so only a process that has one may hold a decision: `cn serve`, the
 * editor link and a headless run have nobody looking at a screen, and a
 * timer there would refuse calls the person never saw. The UI says it can by
 * calling `setCountdownAvailable(true)` when it starts.
 */
let available = false;

export function setCountdownAvailable(value: boolean): void {
  available = value;
}

export function countdownAvailable(): boolean {
  return available;
}

export interface CountdownState {
  requestId: string;
  /** Whole seconds left in the window */
  secondsLeft: number;
  seconds: number;
  /** What happens when it reaches zero */
  proposed: "allow" | "refuse";
}

/**
 * Holding adds to the gap between two requests to the model, and a prompt
 * cache entry lasts 5 minutes by default, so one turn may spend only so long
 * holding decisions (turnBudget.ts). A new request to the model starts a new
 * turn. The 5 minute figure is used whatever the configured cache lifetime,
 * which is the safe side of both.
 */
const budget = createTurnBudget(TURN_BUDGET_SECONDS["5m"]);

export function resetTurnBudget(): void {
  budget.reset();
}

/** Takes the time actually held from this turn's budget. */
export function spendTurnBudget(seconds: number): void {
  budget.spend(seconds);
}

const events = new EventEmitter();
events.setMaxListeners(50);
const current = new Map<string, CountdownState>();

/** The countdown for a request, if one is running. */
export function getCountdown(requestId: string): CountdownState | undefined {
  return current.get(requestId);
}

export function publishCountdown(state: CountdownState): void {
  current.set(state.requestId, state);
  events.emit("tick", state);
}

export function clearCountdown(requestId: string): void {
  if (current.delete(requestId)) events.emit("clear", requestId);
}

/** Subscribes to changes; returns the way to stop. */
export function onCountdown(listener: (requestId: string) => void): () => void {
  const handler = (arg: CountdownState | string) =>
    listener(typeof arg === "string" ? arg : arg.requestId);
  events.on("tick", handler);
  events.on("clear", handler);
  return () => {
    events.off("tick", handler);
    events.off("clear", handler);
  };
}

/** A request the person asked to keep waiting on: its countdown is cancelled. */
const keepWaiting = new Set<string>();
const keepWaitingListeners = new Map<string, () => void>();

export function keepWaitingFor(requestId: string): void {
  keepWaiting.add(requestId);
  keepWaitingListeners.get(requestId)?.();
}

export function onKeepWaiting(requestId: string, fn: () => void): () => void {
  if (keepWaiting.has(requestId)) {
    fn();
    return () => undefined;
  }
  keepWaitingListeners.set(requestId, fn);
  return () => {
    keepWaitingListeners.delete(requestId);
  };
}

export function forgetRequest(requestId: string): void {
  keepWaiting.delete(requestId);
  keepWaitingListeners.delete(requestId);
  clearCountdown(requestId);
}

/**
 * The proposal for an ask the CLI is about to show, or undefined when no
 * timer applies: no screen to draw it on, no window at the call's level, or an
 * ask that a rule or guard raised (core's `source` says which). The ask is
 * proposed to be refused, which is what the policy does when nobody answers.
 */
export function proposalForAsk(
  call: {
    name: string;
    arguments: Record<string, unknown>;
    readonly?: boolean;
  },
  mode: "normal" | "plan" | "auto" | undefined,
  verdictSource: string | undefined,
  now: number = Date.now(),
): Proposal | undefined {
  if (!available) return undefined;
  try {
    const levels = effectiveLevels(mode ?? "normal");
    const core = toCoreCall(call.name, call.arguments);
    const found = levelOfCall(
      { levels },
      core?.toolName ?? call.name,
      { readonly: !!call.readonly },
      {
        parsedArgs: core?.parsedArgs ?? call.arguments,
        cwd: process.cwd(),
        shell: resolveShell().kind,
      },
    );
    if (!found) return undefined;
    // The Web area has its own level names; the timer is set per level
    const level = found.level as keyof NonNullable<
      ReturnType<typeof getPolicyExtras>["timer"]
    >;
    const proposal = propose(
      {
        policy: "allowedWithPermission",
        // A call the CLI's own policy asks about has no engine source: it is
        // the tool's own setting
        source: verdictSource ?? "tool-setting",
      },
      {
        attended: true,
        level,
        settings: getPolicyExtras().timer ?? {},
        now,
      },
    );
    if (!proposal) return undefined;
    // What this turn has left: a smaller window, or none (the ask waits)
    const seconds = budget.grant(proposal.seconds);
    return seconds > 0 ? { ...proposal, seconds } : undefined;
  } catch {
    return undefined;
  }
}
