import { GlobalContext } from "core/util/GlobalContext.js";
import { Text } from "ink";
import React, { useEffect, useState } from "react";

import { planToOffer, type PlanSummary } from "../plans/planStore.js";
import { isServe, supportsInteractive } from "../util/cli.js";

/** The line offering a plan: a name `plan build` takes and how far it got. */
export function planResumeText(plan: PlanSummary): string {
  return `Resume plan "${plan.title}" (${plan.done}/${plan.total} done)? Run: continuous plan build ${plan.name}. Shown once per change to the plan.`;
}

/**
 * One non-blocking line under the header when the workspace has a plan in
 * progress. It is offered once: the plan's modified time is recorded, so the
 * same plan is not offered again until it changes. Never in headless, serve
 * or a terminal without a TTY (supportsInteractive).
 */
export const PlanResumeLine: React.FC = () => {
  const [plan] = useState<PlanSummary | undefined>(() => {
    if (!supportsInteractive() || isServe()) return undefined;
    try {
      return planToOffer(offeredPlans());
    } catch {
      return undefined;
    }
  });
  useEffect(() => {
    if (plan) markPlanOffered(plan);
  }, [plan]);
  if (!plan) return null;
  return <Text color="dim">{planResumeText(plan)}</Text>;
};

function offeredPlans(): Record<string, number> | undefined {
  return new GlobalContext().get("cliPlanResumeOffered");
}

function markPlanOffered(plan: PlanSummary): void {
  try {
    const ctx = new GlobalContext();
    ctx.update("cliPlanResumeOffered", {
      ...(ctx.get("cliPlanResumeOffered") ?? {}),
      [plan.file]: plan.modifiedMs,
    });
  } catch {
    // best effort
  }
}
