import { getAuditTrail } from "core/tools/permissions/audit/global.js";
import { mainAuditAgent } from "core/tools/permissions/audit/identity.js";
import type { AuditAgent } from "core/tools/permissions/audit/record.js";
import type { AuditTrail } from "core/tools/permissions/audit/trail.js";
import { taintedField } from "core/tools/permissions/taint/taintWiring.js";

import { activeStreamJson } from "../headless/streamJsonRun.js";
import { CLI_SESSION_ID } from "../permissions/coreRules.js";
import { getCurrentSession } from "../session.js";
import { logger } from "../util/logger.js";

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
  };
  /** A person was asked (a prompt was shown) */
  askedPerson?: boolean;
  /** A decision timer ran for the ask: how it ended (core decisionTimer.ts) */
  timer?: {
    resolved: {
      outcome: "default-applied" | "overridden" | "confirmed";
      final: "allow" | "refuse";
    };
    held: { proposed: "allow" | "refuse"; seconds: number };
  };
  /** The call was allowed and shown first as a heads-up (a window set for its level) */
  headsUp?: boolean;
  /** Loop mode held the call as a question */
  held?: boolean;
  /** The role the tool table applied (core/tools/roleTools.ts) */
  role?: string;
  /** The CLI's own ask or exclude was not read (apply-rules is off), so the call ran */
  idgafLifted?: "ask" | "exclude";
}

let answeredWithoutAuth = false;

/** The audit reason for a call whose CLI-side ask or exclude was not read. */
function idgafLiftedReason(trace: ApprovalTrace): string | undefined {
  if (!trace.idgafLifted) return undefined;
  return `Allowed: the "Apply my deny, ask and floor rules" check is off, so the CLI's own policy was not read. It would have ${trace.idgafLifted === "ask" ? "asked about" : "excluded"} this call.`;
}

/**
 * cn serve with no token: an approval that came in over an unauthenticated
 * request is recorded as the system's, never as the person's.
 */
export function setApprovalsAnsweredWithoutAuth(value: boolean): void {
  answeredWithoutAuth = value;
}

/**
 * How a heads-up ended, as its own row: the window ran out, or the person
 * answered inside it (the timer's outcome), or they stopped the countdown and
 * answered later. A window that ran out is never recorded as their choice.
 */
function recordHeadsUpEnd(
  trail: ReturnType<typeof cliAuditTrail>,
  callId: string,
  trace: ApprovalTrace,
  approved: boolean,
): void {
  if (trace.timer) {
    trail.timerResolved(callId, trace.timer.resolved, trace.timer.held);
    return;
  }
  trail.answer(callId, approved, answeredWithoutAuth ? "system" : "person");
}

export function recordCliDecision(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  trace: ApprovalTrace,
  result: { approved: boolean; denialMessage?: string },
): void {
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
      if (trace.askedPerson && trace.timer) {
        // The timer's own row says who decided, so a default is never the person's
        trail.timerResolved(call.id, trace.timer.resolved, trace.timer.held);
      } else if (trace.askedPerson) {
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
      // A heads-up the person declined was still allowed by the policy
      policy: result.approved || trace.headsUp ? "allow" : "deny",
      reason: v?.reason ?? idgafLiftedReason(trace) ?? result.denialMessage,
    });
    if (trace.headsUp) recordHeadsUpEnd(trail, call.id, trace, result.approved);
  } catch {
    // the audit never blocks a call
  }
}

export function recordCliOutcome(
  call: { id: string; name: string },
  outcome: {
    ran: boolean;
    exit?: number;
    signal?: string;
    timedOut?: true;
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
