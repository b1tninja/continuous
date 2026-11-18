import { getAuditTrail } from "core/tools/permissions/audit/global.js";
import { auditWouldHave } from "core/tools/permissions/audit/hook.js";
import { mainAuditAgent } from "core/tools/permissions/audit/identity.js";
import type {
  AuditAgent,
  AuditWouldHave,
} from "core/tools/permissions/audit/record.js";
import type { AuditTrail } from "core/tools/permissions/audit/trail.js";
import type { IdgafOverride } from "core/tools/permissions/evaluate.js";
import { taintedField } from "core/tools/permissions/taint/taintWiring.js";

import { activeStreamJson } from "../headless/streamJsonRun.js";
import { CLI_SESSION_ID } from "../permissions/coreRules.js";
import { getCurrentSession } from "../session.js";
import { logger } from "../util/logger.js";

import { noteIdgafObjection } from "./idgafObjections.js";

/**
 * The CLI's side of the audit trail (plans/reviewer-audit.md, P12c): the call's
 * decision from the permission path and its outcome from the tool result path,
 * joined by the call id. Nothing here throws; the trail itself reports a
 * failed write once and carries on.
 */
export function cliAuditTrail(): AuditTrail {
  return getAuditTrail((message) => logger.warn(message));
}

export function cliAuditSession(): string {
  try {
    return getCurrentSession().sessionId || "cli";
  } catch {
    return "cli";
  }
}

let currentAgent: AuditAgent | undefined;

/**
 * Who this process is for the audit record: a Loop worker names itself
 * (loopWorker.ts); anything else is the session's main agent. The ids are
 * the agent map's, so a record joins to a node.
 */
export function setCliAuditAgent(agent: AuditAgent | undefined): void {
  currentAgent = agent;
}

export function cliAuditAgent(): AuditAgent {
  return currentAgent ?? mainAuditAgent(cliAuditSession());
}

/** What the permission path learned while deciding one call. */
export interface ApprovalTrace {
  /** The core engine's verdict, when it applied */
  verdict?: {
    decision: "allow" | "ask" | "deny";
    by: "rules" | "reviewer" | "system";
    source?: string;
    rule?: string;
    reason?: string;
    reviewer?: Record<string, unknown>;
    idgafOverride?: IdgafOverride;
  };
  /** A person was asked (a prompt was shown) */
  askedPerson?: boolean;
  /** Loop mode held the call as a question */
  held?: boolean;
  /** The role the tool table applied (core/tools/roleTools.ts) */
  role?: string;
  /** IDGAF ran a call the CLI's own policy would have asked about or excluded */
  idgafLifted?: "ask" | "exclude";
}

let answeredWithoutAuth = false;

/**
 * What a rule or guard would have done to a call IDGAF ran: core's recorded
 * objection, else a Never (exclude) entry of the CLI's own lists. An `ask`
 * lifted from the CLI's lists is the tool's own setting (the catch-all), which
 * core does not count either.
 */
export function idgafWouldHave(
  trace: ApprovalTrace,
): AuditWouldHave | undefined {
  const o = trace.verdict?.idgafOverride;
  if (o) return auditWouldHave(o);
  if (trace.idgafLifted === "exclude") {
    return {
      policy: "deny",
      source: "cli-policy",
      reason:
        "Excluded by the CLI's own tool policy (permissions.yaml, --exclude or a mode).",
    };
  }
  return undefined;
}

/** The audit reason for a call IDGAF ran past the CLI's own ask or exclude. */
function idgafLiftedReason(trace: ApprovalTrace): string | undefined {
  if (!trace.idgafLifted) return undefined;
  return `Allowed: the level is IDGAF. The CLI's own policy would have ${trace.idgafLifted === "ask" ? "asked about" : "excluded"} this call.`;
}

/**
 * cn serve with no token: an approval that came in over an unauthenticated
 * request is recorded as the system's, never as the person's.
 */
export function setApprovalsAnsweredWithoutAuth(value: boolean): void {
  answeredWithoutAuth = value;
}

export function recordCliDecision(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  trace: ApprovalTrace,
  result: { approved: boolean; denialMessage?: string },
): void {
  let wouldHave: AuditWouldHave | undefined;
  try {
    wouldHave = result.approved ? idgafWouldHave(trace) : undefined;
    if (wouldHave) noteIdgafObjection();
  } catch {
    // counting never blocks a call
  }
  try {
    // --format stream-json reports the decision whether or not the trail is on
    activeStreamJson()?.toolDecision(call, trace, result);
  } catch {
    // the stream never blocks a call
  }
  try {
    const trail = cliAuditTrail();
    if (!trail.enabled) return;
    const v = trace.verdict;
    const asked = trace.askedPerson || trace.held;
    const base = {
      session: cliAuditSession(),
      agent: {
        ...cliAuditAgent(),
        ...(trace.role ? { toolRole: trace.role } : {}),
      },
      ...taintedField(CLI_SESSION_ID),
      callId: call.id,
      tool: call.name,
      args: safeJson(call.arguments),
      by: v?.by ?? "rules",
      source: v?.source ?? (v ? undefined : "cli-policy"),
      rule: v?.rule,
      reviewer: v?.reviewer as never,
    } as const;
    if (asked) {
      trail.decision({
        ...base,
        policy: "ask",
        reason: v?.reason ?? "The call needs approval.",
      });
      if (trace.askedPerson) {
        trail.answer(
          call.id,
          result.approved,
          answeredWithoutAuth ? "system" : "person",
        );
      }
      return;
    }
    trail.decision({
      ...base,
      policy: result.approved ? "allow" : "deny",
      reason: v?.reason ?? idgafLiftedReason(trace) ?? result.denialMessage,
      ...(wouldHave ? { level: "idgaf", wouldHave } : {}),
    });
  } catch {
    // the audit never blocks a call
  }
}

export function recordCliOutcome(
  call: { id: string; name: string },
  outcome: {
    ran: boolean;
    exit?: number;
    output?: string;
    error?: string;
    durMs?: number;
  },
): void {
  try {
    const trail = cliAuditTrail();
    if (!trail.enabled) return;
    trail.outcome({ callId: call.id, tool: call.name, ...outcome });
  } catch {
    // the audit never blocks a call
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
