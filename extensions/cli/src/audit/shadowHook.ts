import type { ChatHistoryItem } from "core/index.js";
import { getAuditTrail } from "core/tools/permissions/audit/global.js";
import { sharedLedger } from "core/tools/permissions/audit/shadowLedger.js";
import {
  shadowSeed,
  shadowSpend,
} from "core/tools/permissions/audit/shadowReport.js";
import {
  readShadowSettings,
  type ShadowSettings,
} from "core/tools/permissions/audit/shadowSettings.js";
import { buildReviewHistory } from "core/tools/permissions/auto/history.js";
import {
  ShadowReviewer,
  type ShadowDeps,
  type ShadowStatus,
} from "core/tools/permissions/auto/shadow.js";
import { readUserGuidance } from "core/util/userGuidance.js";

import { getReviewer, toCoreCall } from "../permissions/coreRules.js";
import {
  SERVICE_NAMES,
  serviceContainer,
  services,
} from "../services/index.js";
import type { ModelServiceState } from "../services/types.js";
import { logger } from "../util/logger.js";

import { cliAuditSession, type ApprovalTrace } from "./cliAudit.js";

/**
 * Shadow mode in the CLI (ROADMAP B16). Called after the call's decision has
 * been written to the audit trail; it starts the reviewer on a call the rules or
 * the person settled and returns at once. The tool path never awaits it and
 * nothing it computes flows back.
 */
let shadow: { key: string; reviewer: ShadowReviewer } | undefined;

/** One ShadowReviewer per settings value, so its budget and busy state persist. */
function shadowFor(
  settings: ShadowSettings,
  deps: () => ShadowDeps,
): ShadowReviewer {
  const key = JSON.stringify(settings);
  if (shadow?.key !== key) {
    shadow = { key, reviewer: new ShadowReviewer(deps()) };
  }
  return shadow.reviewer;
}

/** For tests */
export function resetShadowForTests(): void {
  shadow = undefined;
}

export function startShadowReview(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  trace: ApprovalTrace,
  result: { approved: boolean },
  settingsFile?: string,
): Promise<ShadowStatus> | undefined {
  try {
    // The person's own config.yaml is the only switch; absent, nothing runs
    const settings = readShadowSettings(settingsFile);
    if (!settings) return undefined;
    // A held loop question has no answer yet
    if (trace.held) return undefined;
    const trail = getAuditTrail();
    if (!trail.enabled) return undefined;
    const core = toCoreCall(call.name, call.arguments);
    const real = trace.askedPerson
      ? {
          policy: result.approved ? ("allow" as const) : ("deny" as const),
          by: "person" as const,
        }
      : {
          policy: result.approved ? ("allow" as const) : ("deny" as const),
          by: trace.verdict?.by ?? ("rules" as const),
        };
    const history: ChatHistoryItem[] = services.chatHistory.getHistory();
    const reviewer = shadowFor(settings, () => ({
      trail,
      settings,
      reviewer: () => {
        const state = serviceContainer.getSync<ModelServiceState>(
          SERVICE_NAMES.MODEL,
        )?.value;
        return state?.authConfig
          ? getReviewer(state.assistant, state.authConfig)
          : null;
      },
      environment: { workspaceDirs: [process.cwd()], os: process.platform },
      guidance: () => readUserGuidance(),
      spentSoFar: () => shadowSpend(trail.dir),
      // One ledger for every process that shares this audit directory
      ledger: sharedLedger(trail.dir, () => shadowSeed(trail.dir)),
    }));
    return reviewer.observe({
      session: cliAuditSession(),
      callId: call.id,
      toolName: core?.toolName ?? call.name,
      args: core?.parsedArgs ?? call.arguments,
      history: buildReviewHistory(history),
      real,
    });
  } catch (e) {
    logger.debug("Shadow review not started", { error: e });
    return undefined;
  }
}
