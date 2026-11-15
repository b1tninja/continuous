import type { ToolPolicy } from "@continuedev/terminal-security";
import { createHash } from "node:crypto";
import { levelOfCall, type ApprovalSettings } from "../approval";
import type { AutoReviewReply } from "../auto/handler";
import type { ToolPolicyResult } from "../evaluate";
import { taintedField } from "../taint/taintWiring";
import type { IdgafOverride } from "../evaluate";
import type {
  AuditAgent,
  AuditBy,
  AuditPolicy,
  AuditWouldHave,
  DecisionInput,
} from "./record";
import type { AuditTrail } from "./trail";

/**
 * The hook in core's decision path (plans/reviewer-audit.md, P12c): turns what
 * `evaluateToolPolicyWithRules` and `autoReviewToolCall` returned into a
 * `decision` record. A call without an id is still recorded, under a made-up
 * id marked `synthetic` (see `syntheticCallId`); its outcome cannot be
 * joined to it, but the decision is not lost.
 */
export interface AuditCallContext {
  session?: string;
  callId?: string;
  turn?: number;
  toolName: string;
  parsedArgs: Record<string, unknown>;
  approval?: ApprovalSettings;
  loopItem?: string;
  /** Which agent made the call; absent for a host that does not say */
  agent?: AuditAgent;
}

export function auditPolicyOf(policy: ToolPolicy): AuditPolicy {
  return policy === "disabled"
    ? "deny"
    : policy === "allowedWithPermission"
      ? "ask"
      : "allow";
}

function argsText(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
}

let syntheticCounter = 0;

/**
 * An id for a decision the host sent no call id for: `nocall-<hash>-<n>`.
 * The hash is of the session, turn, tool and arguments, so it is the same for
 * the same call; `n` counts calls without ids in this process so two identical
 * ones stay two rows. It cannot match an outcome, and the record says so.
 */
export function syntheticCallId(
  ctx: Pick<AuditCallContext, "session" | "turn" | "toolName" | "parsedArgs">,
  n: number,
): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        ctx.session ?? "",
        ctx.turn ?? "",
        ctx.toolName,
        argsText(ctx.parsedArgs),
      ]),
    )
    .digest("hex")
    .slice(0, 12);
  return `nocall-${hash}-${n}`;
}

function baseInput(
  ctx: AuditCallContext,
): Omit<DecisionInput, "policy" | "by"> | null {
  const synthetic = !ctx.callId;
  const callId = ctx.callId || syntheticCallId(ctx, ++syntheticCounter);
  let area: string | undefined;
  let level: string | undefined;
  try {
    const found = levelOfCall(ctx.approval, ctx.toolName, undefined, {
      parsedArgs: ctx.parsedArgs,
    });
    area = found?.area;
    level = found?.level;
  } catch {
    // the area is a nicety
  }
  return {
    session: ctx.session ?? "unknown",
    callId,
    ...(synthetic ? { synthetic: true } : {}),
    ...(ctx.turn === undefined ? {} : { turn: ctx.turn }),
    tool: ctx.toolName,
    args: argsText(ctx.parsedArgs),
    ...(area ? { area } : {}),
    ...(level ? { level } : {}),
    ...(ctx.loopItem ? { loopItem: ctx.loopItem } : {}),
    ...(ctx.agent ? { agent: ctx.agent, mode: ctx.agent.mode } : {}),
    ...taintedField(ctx.session),
  };
}

/**
 * What a host does with a core result for a tool whose own setting is
 * `basePolicy`: a decision may not be more lenient than the setting, except an
 * allow rule or a level the person chose. The GUI applies the same clamp.
 */
export function clampPolicy(
  basePolicy: ToolPolicy,
  result: Pick<ToolPolicyResult, "policy" | "source">,
): ToolPolicy {
  if (basePolicy === "disabled") return "disabled";
  if (
    basePolicy === "allowedWithPermission" &&
    result.policy === "allowedWithoutPermission" &&
    result.source !== "allow-rule" &&
    result.source !== "permissive" &&
    result.source !== "idgaf"
  ) {
    return "allowedWithPermission";
  }
  return result.policy;
}

/** A refused call never reaches the host's tool path, so its outcome is written here. */
function closeRefused(trail: AuditTrail, callId: string): void {
  trail.outcome({ callId, ran: false });
}

/** The audit form of what IDGAF ran past. */
export function auditWouldHave(o: IdgafOverride): AuditWouldHave {
  return {
    policy: o.policy === "disabled" ? "deny" : "ask",
    ...(o.source ? { source: o.source } : {}),
    ...(o.rule ? { rule: o.rule } : {}),
    ...(o.reason ? { reason: o.reason } : {}),
  };
}

/** Record what the rules decided. Never throws. */
export function recordPolicyDecision(
  trail: AuditTrail,
  ctx: AuditCallContext,
  basePolicy: ToolPolicy,
  result: ToolPolicyResult,
): void {
  try {
    if (!trail.enabled) return;
    const base = baseInput(ctx);
    if (!base) return;
    const policy = auditPolicyOf(clampPolicy(basePolicy, result));
    trail.decision({
      ...base,
      displayValue: result.displayValue,
      policy,
      by: "rules",
      source: result.source ?? "tool-setting",
      rule: result.rule,
      reason: result.reason,
      ...(result.idgafOverride
        ? { level: "idgaf", wouldHave: auditWouldHave(result.idgafOverride) }
        : {}),
    });
    if (policy === "deny") closeRefused(trail, base.callId);
  } catch {
    // the audit never blocks a call
  }
}

/** Record what the reviewer, or Auto itself, decided. Never throws. */
export function recordReviewDecision(
  trail: AuditTrail,
  ctx: AuditCallContext,
  reply: AutoReviewReply,
): void {
  try {
    if (!trail.enabled) return;
    // The rules settled it: evaluatePolicy ran first and wrote that
    if (reply.by === "rules") return;
    const base = baseInput(ctx);
    if (!base) return;
    const by: AuditBy = reply.by;
    trail.decision({
      ...base,
      displayValue: reply.displayValue,
      policy: reply.decision,
      by,
      reason: reply.reason,
      reviewer: {
        ...reply.reviewer,
        ...(reply.category ? { category: reply.category } : {}),
        ...(reply.cached ? { cached: true } : {}),
        ...(reply.unusable ? { unusable: true } : {}),
      },
    });
    if (reply.decision === "deny") closeRefused(trail, base.callId);
  } catch {
    // the audit never blocks a call
  }
}
