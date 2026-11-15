import { isRecoveredCallId } from "@continuedev/openai-adapters";
import { clipMasked, hashMasked, maskForAudit, maskText } from "./mask";

/**
 * The audit record (plans/reviewer-audit.md, section 6): one JSON line per
 * event. A call writes a `decision` event before it runs and an `outcome` event
 * after, joined by `callId`, so no line is ever rewritten. A `turn` event marks
 * a model turn, so a turn with no calls is still visible to the work log.
 *
 * Everything here is data built from already-masked text. The builders mask;
 * nothing in a record is the raw call.
 */
export const AUDIT_VERSION = 1;

export const MAX_ARGS_CHARS = 2000;
export const MAX_REASON_CHARS = 300;
export const MAX_ERROR_SIGNATURE_CHARS = 200;

export type AuditPolicy = "allow" | "ask" | "deny";
/** Who decided; "person" is the answer to an earlier ask */
export type AuditBy = "rules" | "reviewer" | "person" | "system";

export interface AuditEnvelope {
  v: typeof AUDIT_VERSION;
  ev:
    "decision" | "outcome" | "turn" | "policy" | "shadow" | "setting" | "taint";
  /** UTC, ISO 8601 */
  ts: string;
  session: string;
  /** Position in the file, so a missing line shows even without a hash chain */
  seq: number;
  turn?: number;
}

export const AUDIT_AGENT_KINDS = [
  "main",
  "subagent",
  "loop-worker",
  "background",
] as const;
export const MAX_AGENT_FIELD_CHARS = 80;

/**
 * Which agent made a call (ROADMAP O and X): a name, an enum and ids, never a
 * prompt. Ids are the ones the agent map uses (`main-<session>`,
 * `sub-<toolCallId>`, `worker-<itemId>`, `bg-<taskId>`), so a row joins to a node.
 */
export interface AuditAgent {
  id: string;
  kind: (typeof AUDIT_AGENT_KINDS)[number];
  /** The definition's name ("Explore") or "item 3"; clipped and masked */
  role?: string;
  /** The permission mode or loop, as a short word */
  mode?: string;
  /** The role the tool table applied to its calls (core/tools/roleTools.ts): agent, planner, ... */
  toolRole?: string;
  /** The spawning agent's id; absent for the main agent */
  parentId?: string;
}

/** Copy the identity field by field: nothing else a caller attached survives. */
export function auditAgentOf(
  agent: AuditAgent | undefined,
): AuditAgent | undefined {
  if (!agent || typeof agent.id !== "string" || !agent.id) return undefined;
  const line = (v: unknown) =>
    typeof v === "string" && v
      ? clipMasked(maskText(v).text, MAX_AGENT_FIELD_CHARS)
      : undefined;
  return clean({
    id: line(agent.id) as string,
    kind: AUDIT_AGENT_KINDS.includes(agent.kind) ? agent.kind : "subagent",
    role: line(agent.role),
    mode: line(agent.mode),
    toolRole: line(agent.toolRole),
    parentId: line(agent.parentId),
  });
}

/** What the command analysis found; every part is optional while it is wired up */
export interface AuditReading {
  shell?: string;
  understood?: boolean;
  verdict?: "reads" | "writes" | "unsure";
  effects?: string[];
  destinations?: { host: string; kind?: string }[];
  lint?: string[];
}

export interface AuditReviewer {
  model?: string;
  /** Hash of the reviewer's system prompt; the prompt itself is never stored */
  promptVersion?: string;
  category?: string;
  risk?: string;
  authorization?: string;
  /** The verdict was reused from an identical earlier review */
  cached?: boolean;
  latencyMs?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  unusable?: boolean;
}

export interface DecisionEvent extends AuditEnvelope {
  ev: "decision";
  callId: string;
  tool: string;
  argsMasked: string;
  /** SHA-256 of the masked, unclipped text */
  argsHash: string;
  argsLen: number;
  maskedKinds?: string[];
  displayValue?: string;
  reading?: AuditReading;
  policy: AuditPolicy;
  by: AuditBy;
  /** The `DecisionSource` that decided, when rules did */
  source?: string;
  /** Source kinds of untrusted content in the session when the call was decided; absent when none or the rule is off */
  tainted?: string[];
  /** The rule as written in config.yaml */
  rule?: string;
  area?: string;
  level?: string;
  mode?: string;
  /** Which agent made the call; absent in files written before it was added */
  agent?: AuditAgent;
  reason?: string;
  /** The `seq` of the ask this line answers */
  answers?: number;
  reviewer?: AuditReviewer;
  /**
   * IDGAF ran the call past an objection: what the rule or guard would have
   * decided below IDGAF. Masked like `reason`.
   */
  wouldHave?: AuditWouldHave;
  jail?: string;
  loopItem?: string;
  modelMain?: string;
  /**
   * The call was recovered from text the model wrote (tool-dialects), not sent
   * as a native tool call. It went through the same policy; a reviewer can
   * tell the two apart here.
   */
  recovered?: true;
  /**
   * The host gave the call no id, so `callId` was made up here
   * (`nocall-<hash>-<n>`). Such a line cannot be joined to an outcome.
   */
  synthetic?: true;
}

export interface OutcomeEvent extends AuditEnvelope {
  ev: "outcome";
  callId: string;
  tool: string;
  ran: boolean;
  exit?: number;
  durMs?: number;
  outBytes?: number;
  /**
   * SHA-256 of the masked, trimmed output. The output is not stored; two runs
   * that printed the same thing have the same hash, which is all the stuck
   * signals ask of it.
   */
  outHash?: string;
  /** Normalised first error line, masked; what the stuck signals compare */
  errSig?: string;
  /** Files the call changed, with a hash of the content after (for edit-revert) */
  changed?: { path: string; hash: string }[];
  read?: string[];
  agent?: AuditAgent;
}

export interface TurnEvent extends AuditEnvelope {
  ev: "turn";
  /** Length of the assistant's text, not the text */
  textChars: number;
  calls: number;
  /** Which agent took the turn; absent in files written before it was added */
  agent?: AuditAgent;
}

/** Who changed a permission rule: the Permissions page, the CLI or the Always allow button. */
export type PolicyChangeSource =
  "permissions-page" | "cli" | "always-allow-button";

export type PolicyChangeOp = "add" | "update" | "remove" | "adopt" | "undo";

/**
 * A change to the person's own permission rules (plans/rule-editor.md, B22).
 * It records what changed and who asked, never the file: the rule is masked
 * like call arguments, and the before and after hashes (of the whole file's
 * text) let a reader see that two changes were or were not adjacent.
 */
export interface PolicyEvent extends AuditEnvelope {
  ev: "policy";
  source: PolicyChangeSource;
  op: PolicyChangeOp;
  /** The list the rule was in or went to: deny, ask or allow */
  decision: AuditPolicy;
  /** The rule, with arguments masked */
  rule: string;
  /** For an update, the list and text it became */
  newDecision?: AuditPolicy;
  newRule?: string;
  /** Adopt: where the rule came from (assistant, workspace) */
  from?: string;
  /** The change lets something run that did not before */
  loosens: boolean;
  /** How the change was confirmed, when it needed it */
  confirmed?: "typed" | "click" | "native";
  /** SHA-256 of the file's text before and after, or undefined when it did not exist */
  beforeHash?: string;
  afterHash?: string;
  maskedKinds?: string[];
}

/** Where a settings change came from. */
export type SettingChangeSource =
  "cli-policy" | "flag" | "gui-settings" | "file" | "cli-command";

/**
 * What kind of setting changed. A reader that does not know a kind shows it
 * as written; new kinds are added here without a version bump.
 */
export type SettingChangeKind =
  | "level"
  | "preset"
  | "floor"
  | "builtin"
  | "mcp-trust"
  | "plan-terminal"
  | "project-trust"
  | "hook-trust";

/**
 * A change to a permission setting that is not a rule: a level, the preset
 * the levels add up to, a floor rule, a built-in rule switched off, a trusted
 * MCP server, or trust granted to a project's configuration or hooks.
 * It records the setting's name and its old and new value (a level word, on or
 * off, a floor rule as masked text, or a trust scope); never file contents.
 * It is a separate `ev` from `policy`, so a reader written before it existed
 * skips it, as it skips every kind it does not know.
 */
export interface SettingEvent extends AuditEnvelope {
  ev: "setting";
  kind: SettingChangeKind;
  op: "set" | "add" | "remove" | "grant" | "revoke";
  source: SettingChangeSource;
  /** The area, built-in rule id, server name, floor rule or trust scope */
  name: string;
  from?: string;
  to?: string;
  /** The change lets something run, or run unasked, that did not before */
  loosens: boolean;
  /** How it was confirmed: a prompt answered, a flag typed on the command line, the IDE's own dialog */
  confirmed?: "prompt" | "flag" | "native";
  /** The session the change was made in, when it is not this file's */
  viaSession?: string;
  maskedKinds?: string[];
}

/**
 * What the reviewer WOULD have decided for a call it was not asked about
 * (shadow mode, ROADMAP B16). It sits beside the real decision, joined by
 * `callId`, and never changes it. `real` is the decision that stood when the
 * shadow review was started: the rules' verdict, or the person's answer.
 */
export interface ShadowEvent extends AuditEnvelope {
  ev: "shadow";
  callId: string;
  tool: string;
  real: { policy: AuditPolicy; by: AuditBy };
  shadow: {
    policy: AuditPolicy;
    category?: string;
    /** The reviewer's sentence, masked and clipped */
    reason?: string;
  };
  /** Model, prompt version, latency and usage of the shadow request */
  reviewer: AuditReviewer;
  /** USD of the request, from the shared price table; absent when the model has no price */
  costUsd?: number;
  agent?: AuditAgent;
  maskedKinds?: string[];
}

/**
 * A taint label added to or cleared from a session (the tainted-session rule,
 * plans/design/tainted-session.md). Written only while the person's
 * `taintedSessionRule` is `ask`, since nothing is marked otherwise. It names
 * the label and where it came from, never the content: `source` is the tool
 * that brought the content in (an add) or the control that cleared it (a
 * clear), `reason` why. A separate `ev`, so a reader written before it
 * existed skips it.
 */
export interface TaintEvent extends AuditEnvelope {
  ev: "taint";
  op: "add" | "clear";
  /** `web-fetch`, `mcp:<server>`, `secret`, ... */
  label: string;
  source?: string;
  /** add: tool-result, subagent, inherited; clear: user-ack, untaint-command, new-session */
  reason: string;
  maskedKinds?: string[];
}

export type AuditRecord =
  | DecisionEvent
  | OutcomeEvent
  | TurnEvent
  | PolicyEvent
  | ShadowEvent
  | SettingEvent
  | TaintEvent;

/** A record as the builders produce it: the writer adds `v`, `ts` and `seq`. */
export type AuditDraft = DistributiveOmit<AuditRecord, "v" | "seq" | "ts"> & {
  ts?: string;
};
type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

/** What a rule or guard would have decided for a call IDGAF ran anyway. */
export interface AuditWouldHave {
  policy: "ask" | "deny";
  source?: string;
  rule?: string;
  reason?: string;
}

export interface DecisionInput {
  session: string;
  turn?: number;
  callId: string;
  tool: string;
  /** The raw command or arguments (JSON text for a structured call) */
  args: string;
  displayValue?: string;
  reading?: AuditReading;
  policy: AuditPolicy;
  by: AuditBy;
  source?: string;
  rule?: string;
  area?: string;
  level?: string;
  mode?: string;
  agent?: AuditAgent;
  tainted?: string[];
  reason?: string;
  answers?: number;
  reviewer?: AuditReviewer;
  wouldHave?: AuditWouldHave;
  jail?: string;
  loopItem?: string;
  modelMain?: string;
  /** Set for a recovered call; also derived from the call id */
  recovered?: boolean;
  /** Set when `callId` was generated because the host sent none */
  synthetic?: boolean;
}

const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const maskLine = (s: string | undefined, max: number): string | undefined =>
  s === undefined ? undefined : clipMasked(maskText(s).text, max);

export function decisionDraft(input: DecisionInput): AuditDraft {
  const args = maskForAudit(input.args, MAX_ARGS_CHARS);
  const { args: _raw, recovered, ...rest } = input;
  return clean({
    ...rest,
    recovered: recovered || isRecoveredCallId(input.callId) ? true : undefined,
    ev: "decision" as const,
    argsMasked: args.masked,
    argsHash: args.hash,
    argsLen: args.length,
    ...(args.kinds.length ? { maskedKinds: args.kinds } : {}),
    displayValue: maskLine(input.displayValue, MAX_ARGS_CHARS),
    reason: maskLine(input.reason, MAX_REASON_CHARS),
    reviewer: input.reviewer ? clean({ ...input.reviewer }) : undefined,
    wouldHave: input.wouldHave
      ? clean({
          ...input.wouldHave,
          rule: maskLine(input.wouldHave.rule, MAX_REASON_CHARS),
          reason: maskLine(input.wouldHave.reason, MAX_REASON_CHARS),
        })
      : undefined,
    agent: auditAgentOf(input.agent),
  }) as AuditDraft;
}

export interface OutcomeInput {
  session: string;
  turn?: number;
  callId: string;
  tool: string;
  ran: boolean;
  exit?: number;
  durMs?: number;
  outBytes?: number;
  /** The call's output. It is hashed after masking and never stored. */
  output?: string;
  /** The first error line of the output. It is normalised and masked here. */
  error?: string;
  changed?: { path: string; hash: string }[];
  read?: string[];
  agent?: AuditAgent;
}

/** Digits, hex runs and paths-with-ids vary run to run; the signature should not. */
export function errorSignature(error: string): string {
  const first =
    error
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const normal = first
    .replace(/\b0x[0-9a-f]+\b/gi, "#")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ");
  return clipMasked(maskText(normal).text, MAX_ERROR_SIGNATURE_CHARS);
}

export function outcomeDraft(input: OutcomeInput): AuditDraft {
  const { error, output, ...rest } = input;
  return clean({
    ...rest,
    ev: "outcome" as const,
    outBytes:
      input.outBytes ??
      (output === undefined ? undefined : Buffer.byteLength(output, "utf8")),
    outHash:
      output === undefined
        ? undefined
        : hashMasked(maskText(output.trim()).text),
    errSig: error ? errorSignature(error) : undefined,
    agent: auditAgentOf(input.agent),
  }) as AuditDraft;
}

export function turnDraft(input: {
  session: string;
  turn?: number;
  textChars: number;
  calls: number;
  agent?: AuditAgent;
}): AuditDraft {
  return clean({
    ...input,
    ev: "turn" as const,
    agent: auditAgentOf(input.agent),
  }) as AuditDraft;
}

export interface PolicyInput {
  session?: string;
  source: PolicyChangeSource;
  op: PolicyChangeOp;
  decision: AuditPolicy;
  rule: string;
  newDecision?: AuditPolicy;
  newRule?: string;
  from?: string;
  loosens: boolean;
  confirmed?: "typed" | "click" | "native";
  beforeHash?: string;
  afterHash?: string;
}

/** The session name policy changes are written under: one file a month, not one per window. */
export const POLICY_SESSION = "policy-changes";

export function policyDraft(input: PolicyInput): AuditDraft {
  const rule = maskText(input.rule);
  const newRule =
    input.newRule === undefined ? undefined : maskText(input.newRule);
  const kinds = [...new Set([...rule.kinds, ...(newRule?.kinds ?? [])])];
  const { session, ...rest } = input;
  return clean({
    ...rest,
    session: session ?? POLICY_SESSION,
    ev: "policy" as const,
    rule: clipMasked(rule.text, MAX_ARGS_CHARS),
    newRule: newRule ? clipMasked(newRule.text, MAX_ARGS_CHARS) : undefined,
    maskedKinds: kinds.length ? kinds : undefined,
  }) as AuditDraft;
}

export interface ShadowInput {
  session: string;
  turn?: number;
  callId: string;
  tool: string;
  real: { policy: AuditPolicy; by: AuditBy };
  shadow: { policy: AuditPolicy; category?: string; reason?: string };
  reviewer: AuditReviewer;
  costUsd?: number;
  agent?: AuditAgent;
}

export function shadowDraft(input: ShadowInput): AuditDraft {
  const reason = input.shadow.reason
    ? maskText(input.shadow.reason)
    : undefined;
  return clean({
    ...input,
    ev: "shadow" as const,
    shadow: clean({
      ...input.shadow,
      reason: reason ? clipMasked(reason.text, MAX_REASON_CHARS) : undefined,
    }),
    reviewer: clean({ ...input.reviewer }),
    agent: auditAgentOf(input.agent),
    maskedKinds: reason?.kinds.length ? reason.kinds : undefined,
  }) as AuditDraft;
}

export interface SettingInput {
  session?: string;
  kind: SettingChangeKind;
  op: SettingEvent["op"];
  source: SettingChangeSource;
  name: string;
  from?: string;
  to?: string;
  loosens: boolean;
  confirmed?: SettingEvent["confirmed"];
  viaSession?: string;
}

const MAX_SETTING_FIELD_CHARS = 300;

export function settingDraft(input: SettingInput): AuditDraft {
  const name = maskText(input.name);
  const from = input.from === undefined ? undefined : maskText(input.from);
  const to = input.to === undefined ? undefined : maskText(input.to);
  const kinds = [
    ...new Set([...name.kinds, ...(from?.kinds ?? []), ...(to?.kinds ?? [])]),
  ];
  const { session, ...rest } = input;
  return clean({
    ...rest,
    session: session ?? POLICY_SESSION,
    ev: "setting" as const,
    name: clipMasked(name.text, MAX_SETTING_FIELD_CHARS),
    from: from ? clipMasked(from.text, MAX_SETTING_FIELD_CHARS) : undefined,
    to: to ? clipMasked(to.text, MAX_SETTING_FIELD_CHARS) : undefined,
    maskedKinds: kinds.length ? kinds : undefined,
  }) as AuditDraft;
}

export interface TaintInput {
  session: string;
  op: TaintEvent["op"];
  label: string;
  source?: string;
  reason: string;
  turn?: number;
}

const MAX_TAINT_FIELD_CHARS = 120;

export function taintDraft(input: TaintInput): AuditDraft {
  const label = maskText(input.label);
  const source =
    input.source === undefined ? undefined : maskText(input.source);
  const kinds = [...new Set([...label.kinds, ...(source?.kinds ?? [])])];
  return clean({
    ...input,
    ev: "taint" as const,
    label: clipMasked(label.text, MAX_TAINT_FIELD_CHARS),
    source: source ? clipMasked(source.text, MAX_TAINT_FIELD_CHARS) : undefined,
    reason: input.reason.slice(0, MAX_TAINT_FIELD_CHARS),
    maskedKinds: kinds.length ? kinds : undefined,
  }) as AuditDraft;
}
