import {
  decisionDraft,
  outcomeDraft,
  policyDraft,
  settingDraft,
  shadowDraft,
  taintDraft,
  turnDraft,
  type AuditAgent,
  type AuditPolicy,
  type DecisionInput,
  type OutcomeInput,
  type PolicyInput,
  type SettingInput,
  type ShadowInput,
  type TaintInput,
} from "./record";
import { pruneAudit, type PruneResult } from "./reader";
import { AuditWriter, DEFAULT_MAX_FILE_BYTES } from "./writer";

/**
 * The audit trail as a host uses it (plans/reviewer-audit.md, section 6): one
 * object that turns "this call was decided" and "this call finished" into
 * records, joined by call id.
 *
 * Nothing here may stop a tool call. Every method catches everything, the first
 * failure is reported once through `onError`, and later failures are silent:
 * a full or read-only disk is not worth a line per call.
 */
export interface AuditTrailOptions {
  /** `<global dir>/audit` */
  dir: string;
  enabled: boolean;
  /** Files older than this are deleted by `prune` (default 30) */
  retentionDays?: number;
  maxFileBytes?: number;
  now?: () => Date;
  syncImportant?: boolean;
  /** Called at most once, with the first failure */
  onError?: (message: string) => void;
}

export const DEFAULT_RETENTION_DAYS = 30;

/** How many calls may be waiting for their outcome before the oldest is forgotten */
const MAX_PENDING = 500;
const MAX_PENDING_ARGS = 64 * 1024;

interface Pending {
  input: DecisionInput;
  /** Seq of the latest decision written for the call */
  seq?: number;
  policy: AuditPolicy;
  startedAt: number;
}

export type DecisionRecordInput = Omit<DecisionInput, "session"> & {
  session?: string;
};
export type OutcomeRecordInput = Omit<OutcomeInput, "session" | "tool"> & {
  session?: string;
  tool?: string;
};

export class AuditTrail {
  readonly enabled: boolean;
  readonly dir: string;
  private readonly writer: AuditWriter;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private readonly onError?: (message: string) => void;
  private reported = false;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: AuditTrailOptions) {
    this.enabled = opts.enabled;
    this.dir = opts.dir;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError;
    this.writer = new AuditWriter({
      dir: opts.dir,
      maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      now: this.now,
      syncImportant: opts.syncImportant,
    });
  }

  private fail(message: string): void {
    if (this.reported) return;
    this.reported = true;
    try {
      this.onError?.(`The audit trail could not be written: ${message}`);
    } catch {
      // reporting is also best effort
    }
  }

  private guard(fn: () => void): void {
    if (!this.enabled) return;
    try {
      fn();
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Write the decision for a call. A later decision for the same call id (the
   * reviewer's after the rules asked, the person's answer) is linked to the
   * earlier one through `answers`.
   */
  decision(input: DecisionRecordInput): void {
    this.guard(() => {
      const session = input.session ?? "unknown";
      const previous = this.pending.get(input.callId);
      const full: DecisionInput = {
        ...input,
        session,
        ...(previous?.seq !== undefined && previous.policy === "ask"
          ? { answers: previous.seq }
          : {}),
      };
      const result = this.writer.write(decisionDraft(full));
      if (!result.ok) {
        this.fail(result.error);
        return;
      }
      this.remember(input.callId, {
        input: { ...full, args: full.args.slice(0, MAX_PENDING_ARGS) },
        seq: result.seq,
        policy: input.policy,
        startedAt: previous?.startedAt ?? this.now().getTime(),
      });
    });
  }

  /** The person's answer to an ask. */
  answer(
    callId: string,
    approved: boolean,
    by: "person" | "system" = "person",
  ): void {
    this.guard(() => {
      const p = this.pending.get(callId);
      if (!p || p.policy !== "ask") return;
      this.decision({
        ...p.input,
        policy: approved ? "allow" : "deny",
        by,
        source: undefined,
        rule: undefined,
        reviewer: undefined,
        reason:
          by === "system"
            ? "Answered over a connection with no access token (--no-auth)."
            : approved
              ? "The person approved it."
              : "The person refused it.",
      });
      if (!approved) this.outcome({ callId, ran: false });
    });
  }

  /** The outcome of a call. `tool` and `session` default to those of its decision. */
  outcome(input: OutcomeRecordInput): void {
    this.guard(() => {
      const p = this.pending.get(input.callId);
      const tool = input.tool ?? p?.input.tool ?? "unknown";
      const session = input.session ?? p?.input.session ?? "unknown";
      const turn = input.turn ?? p?.input.turn;
      const agent = input.agent ?? p?.input.agent;
      this.pending.delete(input.callId);
      const result = this.writer.write(
        outcomeDraft({
          ...input,
          tool,
          session,
          ...(agent ? { agent } : {}),
          ...(turn === undefined ? {} : { turn }),
          durMs:
            input.durMs ??
            (p && input.ran ? this.now().getTime() - p.startedAt : undefined),
        }),
      );
      if (!result.ok) this.fail(result.error);
    });
  }

  turn(input: {
    session: string;
    turn?: number;
    textChars: number;
    calls: number;
    agent?: AuditAgent;
  }): void {
    this.guard(() => {
      const result = this.writer.write(turnDraft(input));
      if (!result.ok) this.fail(result.error);
    });
  }

  /** What the reviewer would have decided, beside the real decision (shadow mode). */
  shadow(input: Omit<ShadowInput, "session"> & { session?: string }): void {
    this.guard(() => {
      const p = this.pending.get(input.callId);
      const result = this.writer.write(
        shadowDraft({
          ...input,
          session: input.session ?? p?.input.session ?? "unknown",
        }),
      );
      if (!result.ok) this.fail(result.error);
    });
  }

  /**
   * A change to the person's rules. Returns false when it could not be
   * written, so the caller can say so; the change itself is not undone.
   */
  policy(input: PolicyInput): boolean {
    if (!this.enabled) return true;
    let ok = true;
    this.guard(() => {
      const result = this.writer.write(policyDraft(input));
      if (!result.ok) {
        ok = false;
        this.fail(result.error);
      }
    });
    return ok;
  }

  /**
   * A change to a permission setting that is not a rule (level, preset,
   * floor, built-in switch, trust). Returns false when it could not be
   * written; the change itself is not undone.
   */
  setting(input: SettingInput): boolean {
    if (!this.enabled) return true;
    let ok = true;
    this.guard(() => {
      const result = this.writer.write(settingDraft(input));
      if (!result.ok) {
        ok = false;
        this.fail(result.error);
      }
    });
    return ok;
  }

  /** A taint label added to or cleared from a session. */
  taint(input: TaintInput): void {
    this.guard(() => {
      const result = this.writer.write(taintDraft(input));
      if (!result.ok) this.fail(result.error);
    });
  }

  /** Delete files past the retention. Never throws. */
  prune(): PruneResult {
    try {
      return pruneAudit(this.dir, {
        retentionDays: this.retentionDays,
        now: this.now(),
      });
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return { deleted: [], bytes: 0 };
    }
  }

  private remember(callId: string, p: Pending): void {
    this.pending.delete(callId);
    this.pending.set(callId, p);
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
}
