import type { LoopAnswer, LoopAutonomy, LoopQuestion, LoopState } from "..";
import {
  describeBreach,
  type BreachKind,
  type BudgetKind,
  type ItemBudget,
} from "./itemBudget";
import { questionsNeverAsk } from "../tools/permissions/policy";
import { bankWait, skipItem } from "./loopMode";
import type { StuckLevel } from "./stuckSignals";

/**
 * What happens when an item uses up its own budget (plans/loop-budgets.md,
 * "When an item's budget runs out"). The run has already ended over budget
 * (`LoopItemState.overBudget`, work kept); this decides what follows.
 *
 * - suggest: always ask. The item waits and a question offers Extend,
 *   Split, Skip or Block.
 * - force: always stop. The item ends over budget and the loop's strategy
 *   runs, as it does for any failed item.
 * - review: a reviewer reads the item's progress and answers extend, split
 *   or stop. An extension needs an item that is progressing, comes at most
 *   once, and is at most REVIEW_RESERVE_SHARE of the reserve left.
 *
 * Pure: the caller passes the loop, the item and the clock, and writes back
 * the loop and the item's new budget.
 */
export type LimitPolicy = "suggest" | "force" | "review";

export const LIMIT_POLICIES: readonly LimitPolicy[] = [
  "suggest",
  "force",
  "review",
];

export const LIMIT_POLICY_LABEL: Record<LimitPolicy, string> = {
  suggest: "Suggest",
  force: "Force",
  review: "Review",
};

/** Supervised asks, Auto has the work reviewed, Unattended and IDGAF stop. */
export function defaultLimitPolicy(autonomy: LoopAutonomy): LimitPolicy {
  switch (autonomy) {
    case "supervised":
      return "suggest";
    case "auto":
      return "review";
    case "unattended":
    case "idgaf":
      return "force";
  }
}

export function limitPolicyOf(loop: LoopState): LimitPolicy {
  return loop.limitPolicy ?? defaultLimitPolicy(loop.autonomy ?? "auto");
}

/** An extension is half the item's limit (of the kind that ran out). */
export const EXTENSION_SHARE = 0.5;

/** A reviewer may spend at most this share of the reserve left on one extension. */
export const REVIEW_RESERVE_SHARE = 0.5;

/** The choices Suggest offers, in the order shown. */
export const LIMIT_CHOICES = ["Extend", "Split", "Skip", "Block"] as const;
export type LimitChoice = (typeof LIMIT_CHOICES)[number];

export interface ItemRef {
  id: string;
  budget?: ItemBudget;
}

type Breach = { which: BreachKind; used: number; limit: number };

export type ExtensionPlan =
  | { ok: true; which: BudgetKind; amount: number }
  | { ok: false; reason: string };

const UNIT: Record<BreachKind, string> = {
  usd: "dollars",
  turns: "turns",
  tokens: "tokens",
  minutes: "minutes",
};

/**
 * What an extension would be for the budget that ran out, and why not when
 * it cannot be. Tokens and minutes come out of the loop's reserve
 * (`LoopState.reserve`), so the loop's budget stays a real ceiling: an item
 * with no reserve left cannot be extended. Turns are not divided among
 * items, so there is no reserve of them: half the item's limit, once.
 */
export function planExtension(
  loop: LoopState,
  item: ItemRef,
  breach: Breach,
  options: { review?: boolean } = {},
): ExtensionPlan {
  const state = loop.items.find((i) => i.id === item.id);
  const limit = item.budget?.[breach.which] ?? breach.limit;
  const want = Math.max(1, Math.ceil(limit * EXTENSION_SHARE));
  if (options.review && (state?.extensions ?? 0) >= 1) {
    return { ok: false, reason: "it was extended once already" };
  }
  if (breach.which === "usd") {
    // The loop's reserve holds tokens and minutes only
    return { ok: false, reason: "there is no cost reserve to extend from" };
  }
  if (breach.which === "turns") {
    if ((state?.extensions ?? 0) >= 1) {
      return { ok: false, reason: "its turns were extended once already" };
    }
    return { ok: true, which: "turns", amount: want };
  }
  const left = loop.reserve?.[breach.which] ?? 0;
  if (left <= 0) {
    return { ok: false, reason: `no ${UNIT[breach.which]} reserve is left` };
  }
  const cap = options.review ? Math.floor(left * REVIEW_RESERVE_SHARE) : left;
  const amount = Math.min(want, cap);
  if (amount <= 0) {
    return {
      ok: false,
      reason: `the ${UNIT[breach.which]} reserve is too small to extend from`,
    };
  }
  return { ok: true, which: breach.which, amount };
}

export type ExtendResult =
  | { ok: true; loop: LoopState; budget: ItemBudget; amount: number }
  | { ok: false; error: string };

/**
 * Extends the item: its limit goes up by the planned amount, the reserve goes
 * down by the same, and the item runs again. The extension is counted
 * against the loop's total because the reserve is part of it.
 */
export function extendItem(
  loop: LoopState,
  item: ItemRef,
  breach: Breach,
  options: { review?: boolean } = {},
): ExtendResult {
  const plan = planExtension(loop, item, breach, options);
  if (!plan.ok) return { ok: false, error: `Not extended: ${plan.reason}` };
  const { which, amount } = plan;
  const limit = item.budget?.[which] ?? breach.limit;
  const reserve =
    which === "turns"
      ? loop.reserve
      : {
          ...loop.reserve,
          [which]: Math.max(0, (loop.reserve?.[which] ?? 0) - amount),
        };
  return {
    ok: true,
    amount,
    budget: { ...item.budget, [which]: limit + amount },
    loop: {
      ...loop,
      ...(reserve ? { reserve } : {}),
      items: loop.items.map((i) =>
        i.id === item.id
          ? {
              ...i,
              status: "pending",
              attempts: 0,
              overBudget: undefined,
              extensions: (i.extensions ?? 0) + 1,
            }
          : i,
      ),
      ...(loop.status === "waiting"
        ? {
            status: "running" as const,
            waitingSince: undefined,
            waitedMs: bankWait(loop).waitedMs,
          }
        : {}),
    },
  };
}

/** What the item had done by the end of its run, as the reviewer reads it. */
export interface ItemProgress {
  /** Files changed since the run began */
  changedFiles: number;
  /** The check moved toward passing */
  checkImproved?: boolean;
  /** The strongest stuck signal during the run (core/util/stuckSignals.ts) */
  stuckLevel?: StuckLevel;
}

/**
 * An item is progressing if files changed or its check moved toward passing,
 * and no stuck signal says it is going in circles. With no evidence at all
 * the answer is no: an extension is never given on faith.
 */
export function isProgressing(progress: ItemProgress | undefined): boolean {
  if (!progress) return false;
  if (progress.stuckLevel === "stuck") return false;
  return progress.changedFiles > 0 || !!progress.checkImproved;
}

export type ReviewVerdict = "extend" | "split" | "stop";

export interface ReviewInput {
  loop: LoopState;
  item: ItemRef;
  breach: Breach;
  progress?: ItemProgress;
  /** What an extension would be now; not ok when it is not allowed */
  extension: ExtensionPlan;
}

/**
 * The reviewer when no model is plugged in: extend a progressing item that
 * may be extended; a progressing one that may not (already extended, no
 * reserve) is split; one that is not progressing, and one that is stuck on
 * top of being over budget, stops.
 */
export function ruleReview(input: ReviewInput): ReviewVerdict {
  if (!isProgressing(input.progress)) return "stop";
  return input.extension.ok ? "extend" : "split";
}

export type LimitDecision =
  | { kind: "stop"; loop: LoopState; reason: string }
  | { kind: "ask"; loop: LoopState; question: LoopQuestion }
  | { kind: "extend"; loop: LoopState; budget: ItemBudget; amount: number }
  | { kind: "split"; loop: LoopState; reason: string };

function describeAmount(plan: ExtensionPlan): string {
  return plan.ok
    ? `by ${plan.amount.toLocaleString("en-US")} ${UNIT[plan.which]}${plan.which === "turns" ? "" : " from the reserve"}`
    : "";
}

/** Asks the person (suggest): the item waits on a question with the choices. */
function ask(
  loop: LoopState,
  item: ItemRef,
  breach: Breach,
  now: Date,
): LimitDecision {
  const open = loop.questions.find(
    (q) => q.itemId === item.id && q.overBudget && !q.answerId,
  );
  if (open) return { kind: "ask", loop, question: open };
  const extension = planExtension(loop, item, breach);
  const choices = LIMIT_CHOICES.filter((c) => c !== "Extend" || extension.ok);
  const ids = loop.questions.map((q) =>
    Number(q.id.startsWith("q") ? q.id.slice(1) : 0),
  );
  const question: LoopQuestion = {
    id: `q${Math.max(0, ...ids.filter(Number.isInteger)) + 1}`,
    itemId: item.id,
    question: `Item ${item.id} ${describeBreach(breach)}. ${
      extension.ok
        ? `Extend it ${describeAmount(extension)}, split it into smaller to-dos, skip it, or mark it blocked?`
        : `It cannot be extended (${extension.reason}). Split it, skip it, or mark it blocked?`
    }`,
    kind: "blocking",
    type: "cost",
    options: [...choices],
    overBudget: breach,
    askedAt: now.toISOString(),
  };
  return {
    kind: "ask",
    question,
    loop: {
      ...loop,
      questions: [...loop.questions, question],
      items: loop.items.map((i) =>
        i.id === item.id ? { ...i, status: "waiting" } : i,
      ),
    },
  };
}

/**
 * The policy at the limit for an item whose run just ended over its budget.
 * Does nothing (returns undefined) for an item that did not.
 */
export function applyLimitPolicy(
  loop: LoopState,
  item: ItemRef,
  ctx: {
    now: Date;
    progress?: ItemProgress;
    /** A model reviewer; the rule above when absent */
    review?: (input: ReviewInput) => ReviewVerdict;
  },
): LimitDecision | undefined {
  const state = loop.items.find((i) => i.id === item.id);
  const breach = state?.overBudget;
  if (!state || !breach) return undefined;
  // Questions is IDGAF: nobody is asked, so a limit that would ask (Suggest)
  // is decided by the review rule instead (extend, split or stop)
  const policy =
    limitPolicyOf(loop) === "suggest" &&
    loop.policy &&
    questionsNeverAsk(loop.policy.questions)
      ? "review"
      : limitPolicyOf(loop);
  switch (policy) {
    case "force":
      return {
        kind: "stop",
        loop,
        reason: `Item ${item.id} ${describeBreach(breach)}; the limit policy is Force.`,
      };
    case "suggest":
      return ask(loop, item, breach, ctx.now);
    case "review": {
      const extension = planExtension(loop, item, breach, { review: true });
      const verdict = (ctx.review ?? ruleReview)({
        loop,
        item,
        breach,
        progress: ctx.progress,
        extension,
      });
      if (verdict === "extend") {
        const extended = extendItem(loop, item, breach, { review: true });
        if (extended.ok) {
          return {
            kind: "extend",
            loop: extended.loop,
            budget: extended.budget,
            amount: extended.amount,
          };
        }
        return {
          kind: "stop",
          loop,
          reason: `Item ${item.id} ${describeBreach(breach)}; ${extended.error}.`,
        };
      }
      if (verdict === "split") {
        return {
          kind: "split",
          loop: { ...loop, replanRequested: true },
          reason: `Item ${item.id} ${describeBreach(breach)}; it is to be split by the re-plan.`,
        };
      }
      return {
        kind: "stop",
        loop,
        reason: `Item ${item.id} ${describeBreach(breach)}; the review found no progress to extend for.`,
      };
    }
  }
}

export type LimitAnswerResult =
  | {
      ok: true;
      loop: LoopState;
      answer: LoopAnswer;
      /** Extend: the item's new budget, for the host to write to the plan */
      budget?: ItemBudget;
    }
  | { ok: false; error: string };

/**
 * The person's answer to the question `applyLimitPolicy` held (suggest).
 * Extend raises the item's limit from the reserve and runs it again; Split
 * asks for a re-plan that sees the item's findings; Skip finishes it as
 * skipped; Block leaves it failed, for the person to deal with.
 */
export function answerLimitQuestion(
  loop: LoopState,
  item: ItemRef,
  questionId: string,
  choice: string,
  now: Date,
): LimitAnswerResult {
  const question = loop.questions.find((q) => q.id === questionId);
  if (!question?.overBudget) {
    return { ok: false, error: `${questionId} is not a budget question` };
  }
  if (question.answerId) {
    return { ok: false, error: `${questionId} is already answered` };
  }
  const picked = LIMIT_CHOICES.find(
    (c) => c.toLowerCase() === choice.trim().toLowerCase(),
  );
  if (!picked) {
    return {
      ok: false,
      error: `Choose one of ${LIMIT_CHOICES.join(", ")}: the item's budget is not changed by a written answer.`,
    };
  }
  const breach = question.overBudget;
  let next: LoopState = loop;
  let budget: ItemBudget | undefined;
  let text: string = picked;
  switch (picked) {
    case "Extend": {
      const extended = extendItem(loop, item, breach);
      if (!extended.ok) return { ok: false, error: extended.error };
      next = extended.loop;
      budget = extended.budget;
      text = `Extend by ${extended.amount.toLocaleString("en-US")} ${UNIT[breach.which]}`;
      break;
    }
    case "Split":
      next = {
        ...loop,
        replanRequested: true,
        items: loop.items.map((i) =>
          i.id === item.id ? { ...i, status: "failed" } : i,
        ),
      };
      break;
    case "Skip": {
      const skipped = skipItem(loop, item.id);
      if (!skipped.ok) return { ok: false, error: skipped.error };
      next = skipped.loop;
      break;
    }
    case "Block":
      next = {
        ...loop,
        items: loop.items.map((i) =>
          i.id === item.id ? { ...i, status: "failed" } : i,
        ),
      };
      break;
  }
  const ids = loop.answers.map((a) => Number(a.id.slice(1)));
  const answer: LoopAnswer = {
    id: `a${Math.max(0, ...ids.filter(Number.isInteger)) + 1}`,
    questionId,
    itemId: item.id,
    text,
    route: "confirmed",
    givenAt: now.toISOString(),
    delivered: true,
  };
  next = {
    ...next,
    answers: [...next.answers, answer],
    questions: next.questions.map((q) =>
      q.id === questionId ? { ...q, answerId: answer.id } : q,
    ),
  };
  if (next.status === "waiting") {
    next = { ...bankWait(next, now), status: "running" };
  }
  return { ok: true, loop: next, answer, ...(budget ? { budget } : {}) };
}
