import type { ToolPolicy } from "@continuedev/terminal-security";
import { shadowSeed, shadowSpend } from "../audit/shadowReport";
import { sharedLedger } from "../audit/shadowLedger";
import { readShadowSettings } from "../audit/shadowSettings";
import { getAuditTrail } from "../audit/global";
import { auditPolicyOf, clampPolicy } from "../audit/hook";
import type { AuditAgent } from "../audit/record";
import type { AuditTrail } from "../audit/trail";
import type { ToolPolicyResult } from "../evaluate";
import type { ReviewEnvironment, ReviewHistory } from "./prompt";
import type { ReviewerReasoning } from "./review";
import {
  ShadowReviewer,
  type ShadowReviewerClient,
  type ShadowStatus,
} from "./shadow";
import { readUserGuidance } from "../../../util/userGuidance";

/**
 * Shadow mode in the IDE (ROADMAP B64). `ShadowReviewer` runs beside the real
 * decision for the calls core settled or the person answered, as the CLI hook
 * does. Nothing here returns a value a handler could act on, nothing is awaited
 * by the tool path, and every entry point swallows its errors.
 *
 * Where the real decision is known in core:
 *  - `tools/evaluatePolicy` returns allow or deny: settled by the rules, observe now.
 *  - It returns ask: the call waits, remembered by call id.
 *  - `tools/autoReview` answers for the reviewer or Auto: the reviewer already
 *    decided, the entry is dropped (a second review would only repeat it).
 *  - `audit/answer` (a refusal) and `tools/call` (an approval, the call reached
 *    the tool path) carry the person's answer: observe with `by: "person"`.
 * A call whose answer never arrives (a Loop-held question, an abandoned
 * prompt) is never reviewed. A call without a call id or without the history
 * the GUI sends is not reviewed either; the GUI sends none for edits, whose
 * answer is a diff the person accepts, not this call's approval.
 */
export interface IdeShadowContext {
  reviewer: ShadowReviewerClient | null | undefined;
  environment: ReviewEnvironment;
  reasoning?: ReviewerReasoning;
}

export interface IdeShadowCall {
  session?: string;
  callId?: string;
  toolName: string;
  parsedArgs: Record<string, unknown>;
  /** Absent: the host did not offer this call for shadow review */
  history?: ReviewHistory;
  agent?: AuditAgent;
}

interface Pending {
  call: IdeShadowCall & { callId: string; history: ReviewHistory };
  context: IdeShadowContext;
}

const MAX_PENDING = 100;

export class IdeShadow {
  private readonly pending = new Map<string, Pending>();
  private shadow: { key: string; reviewer: ShadowReviewer } | undefined;
  private current: IdeShadowContext | undefined;

  constructor(
    private readonly opts: {
      settingsFile?: string;
      trail?: () => AuditTrail;
    } = {},
  ) {}

  /** What `tools/evaluatePolicy` decided. Allow and deny settle; ask waits. */
  afterPolicy(
    call: IdeShadowCall,
    basePolicy: ToolPolicy,
    result: Pick<ToolPolicyResult, "policy" | "source">,
    context: () => IdeShadowContext,
  ): Promise<ShadowStatus> | undefined {
    try {
      if (!call.callId || !call.history) return undefined;
      const policy = auditPolicyOf(clampPolicy(basePolicy, result));
      const kept = { ...call, callId: call.callId, history: call.history };
      if (policy === "ask") {
        this.remember(kept, context);
        return undefined;
      }
      return this.start(kept, { policy, by: "rules" }, context);
    } catch {
      return undefined;
    }
  }

  /** What `tools/autoReview` decided: the reviewer or Auto answered, so no shadow. */
  afterAutoReview(
    callId: string | undefined,
    by: "rules" | "reviewer" | "system",
  ): void {
    if (callId && by !== "rules") this.pending.delete(callId);
  }

  /** The person's answer to a call that asked. */
  answered(
    callId: string,
    approved: boolean,
  ): Promise<ShadowStatus> | undefined {
    try {
      const p = this.pending.get(callId);
      if (!p) return undefined;
      this.pending.delete(callId);
      return this.start(
        p.call,
        { policy: approved ? "allow" : "deny", by: "person" },
        () => p.context,
      );
    } catch {
      return undefined;
    }
  }

  private remember(call: Pending["call"], context: () => IdeShadowContext) {
    // Off: nothing is kept, so the default costs one file read per asked call
    if (!this.settings()) return;
    this.pending.set(call.callId, { call, context: context() });
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  private settings() {
    // The person's own config.yaml is the only switch
    return readShadowSettings(this.opts.settingsFile);
  }

  private start(
    call: Pending["call"],
    real: { policy: "allow" | "deny"; by: "rules" | "person" },
    context: () => IdeShadowContext,
  ): Promise<ShadowStatus> | undefined {
    const settings = this.settings();
    if (!settings) return undefined;
    const trail = (this.opts.trail ?? (() => getAuditTrail()))();
    if (!trail.enabled) return undefined;
    // One ShadowReviewer per settings value, so its budget and busy state persist
    const key = JSON.stringify(settings);
    if (this.shadow?.key !== key) {
      const current = () => this.current;
      this.shadow = {
        key,
        reviewer: new ShadowReviewer({
          trail,
          settings,
          reviewer: () => current()?.reviewer,
          get environment() {
            return current()?.environment ?? {};
          },
          get reasoning() {
            return current()?.reasoning;
          },
          guidance: () => readUserGuidance(),
          spentSoFar: () => shadowSpend(trail.dir),
          ledger: sharedLedger(trail.dir, () => shadowSeed(trail.dir)),
        }),
      };
    }
    this.current = context();
    return this.shadow.reviewer.observe({
      session: call.session ?? "unknown",
      callId: call.callId,
      toolName: call.toolName,
      args: call.parsedArgs,
      history: call.history,
      real,
      ...(call.agent ? { agent: call.agent } : {}),
    });
  }
}
