import type { ApprovalSettings } from "core/tools/permissions/approval";
import {
  POLICY_AREAS,
  type PolicyArea,
  type PolicyLevels,
  type PolicySettings,
} from "core/tools/permissions/policy";
import { loopPolicyOf } from "core/util/loopMode";
import type { LoopPolicy } from "core";
import type { RootState } from "../store";

export const REVIEWER_NEEDED_MESSAGE =
  "Choose a reviewer model in Settings > Models";

/** Areas a reviewer model can judge today: a tool call. */
export const REVIEWABLE_AREAS: readonly PolicyArea[] = [
  "context",
  "tools",
  "edits",
];

export interface AutoApprovalStatus {
  /** The experimental setting is on, so the option is shown at all. */
  offered: boolean;
  /** Automatic can be used: offered and a reviewer model is chosen. */
  available: boolean;
  /** Some area is set to Automatic and it can be used. */
  active: boolean;
  /** Why it cannot be used, for the disabled option. */
  unavailableReason?: string;
}

/**
 * Automatic is unavailable until a reviewer model is chosen. No chat model
 * stands in for it, because that would send the conversation to a provider the
 * user did not pick for this.
 */
export function selectAutoApproval(state: RootState): AutoApprovalStatus {
  const config = state.config.config;
  const offered = config.experimental?.enableAutoApproval === true;
  const hasReviewer = !!config.selectedModelByRole?.reviewer;
  const available = offered && hasReviewer;
  const levels = state.ui.policyLevels;
  return {
    offered,
    available,
    active:
      available && REVIEWABLE_AREAS.some((a) => levels[a] === "automatic"),
    ...(offered && !hasReviewer
      ? { unavailableReason: REVIEWER_NEEDED_MESSAGE }
      : {}),
  };
}

/**
 * The levels that are really in force. A saved Automatic that cannot be used
 * (no reviewer, the experiment turned off, or an area no reviewer judges yet)
 * falls back to Cautious, so a lost reviewer never makes the app more
 * permissive.
 */
export function selectEffectiveLevels(state: RootState): PolicyLevels {
  const saved = state.ui.policyLevels;
  const { available } = selectAutoApproval(state);
  const levels = { ...saved };
  for (const area of POLICY_AREAS) {
    if (
      levels[area] === "automatic" &&
      !(available && REVIEWABLE_AREAS.includes(area))
    ) {
      levels[area] = "cautious";
    }
  }
  return levels;
}

export function selectPolicySettings(state: RootState): PolicySettings {
  const { maxNewPlanItems, questions, builtin } = state.ui.policyExtras ?? {};
  return {
    levels: selectEffectiveLevels(state),
    ...(maxNewPlanItems !== undefined ? { maxNewPlanItems } : {}),
    ...(questions ? { questions } : {}),
    ...(builtin ? { builtin } : {}),
  };
}

/** What is sent to core with every policy check. */
export function selectApprovalSettings(state: RootState): ApprovalSettings {
  const { builtin, floor } = state.ui.policyExtras ?? {};
  return {
    levels: selectEffectiveLevels(state),
    ...(builtin && Object.keys(builtin).length ? { builtin } : {}),
    ...(floor?.length ? { floor } : {}),
  };
}

/** The Plan edits and Questions levels a loop follows. */
export function selectLoopPolicy(state: RootState): LoopPolicy {
  return loopPolicyOf(selectPolicySettings(state));
}

/** Areas set to IDGAF, for the banner. */
export function selectIdgafAreas(state: RootState): PolicyArea[] {
  const levels = selectEffectiveLevels(state);
  return POLICY_AREAS.filter((a) => levels[a] === "idgaf");
}
