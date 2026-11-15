import type { Tool } from "../..";
import {
  areaOfTool,
  builtinRuleOn,
  readOnlyClaim,
  type BuiltinRuleId,
  type PolicyArea,
  type PolicyLevel,
  type PolicyLevels,
} from "./policy";
import type { ShellKind } from "../../util/shell";
import type { ProtectedKind } from "./protected";

/**
 * What the person has chosen for each area (plans/policy-areas.md). Core never
 * guesses a level: a caller that sends nothing gets Cautious everywhere, which
 * is the behaviour from before levels existed (rules and the tool's own setting).
 *
 * Per area, for tool calls:
 * - manual: asks every time. Allow rules and the tool's own setting are not
 *   consulted; deny and ask rules and every protection still apply.
 * - cautious: the rules and the tool's own setting decide.
 * - automatic: as cautious here. What the rules leave open goes to the reviewer
 *   model, which the caller asks (core's `tools/autoReview`).
 * - permissive: a call the rules left open runs. A deny rule, an ask rule, a
 *   protected path and the safety floor still win.
 * - idgaf: every call runs, whatever a rule, a protected path or the safety
 *   floor says. Only a tool switched off stays off.
 */
export interface ApprovalSettings {
  levels: PolicyLevels;
  /** Built-in rules by id; absent means on (see BUILTIN_RULES) */
  builtin?: Partial<Record<BuiltinRuleId, boolean>>;
  /** Deny rules that bind at every level below IDGAF (IDGAF runs past them and records it) */
  floor?: string[];
}

/** Protected-path kinds whose built-in rule the person switched off. */
export function skippedProtections(
  approval: ApprovalSettings | undefined,
): ProtectedKind[] {
  const skip: ProtectedKind[] = [];
  if (!builtinRuleOn(approval, "protect-secrets")) skip.push("secret");
  if (!builtinRuleOn(approval, "protect-config")) skip.push("config");
  if (!builtinRuleOn(approval, "protect-network-paths")) skip.push("network");
  if (!builtinRuleOn(approval, "no-fetch-and-run")) skip.push("fetch-and-run");
  return skip;
}

/** What a level decided, for the decision chip. */
export interface Loosening {
  source: "permissive" | "idgaf";
  reason: string;
  /** Allows the call whatever else applies (IDGAF). */
  absolute?: boolean;
}

type ToolLike = Pick<
  Tool,
  | "group"
  | "originalFunctionName"
  | "uri"
  | "evaluateToolCallPolicy"
  | "readonly"
>;

export interface LevelOfCall {
  area: "context" | "tools" | "edits";
  level: PolicyLevel;
  /** A command that only reads, as the parser vouched for it */
  readOnly?: string;
}

/** The call a level is looked up for: its arguments and the folder it runs in. */
export interface CallContext {
  parsedArgs?: Record<string, unknown>;
  cwd?: string;
  /** The shell that will run a terminal command (resolveShell) */
  shell?: ShellKind;
}

/**
 * The area a call belongs to and the level set for it. Undefined when the
 * caller sent no levels or the tool only touches the session (the task list,
 * Loop's tools), which no level governs.
 */
export function levelOfCall(
  approval: ApprovalSettings | undefined,
  toolName: string,
  tool: Pick<Tool, "readonly"> | undefined,
  call?: CallContext,
): LevelOfCall | undefined {
  if (!approval) return undefined;
  const area = areaOfTool(toolName, tool, call);
  if (!area) return undefined;
  const level = approval.levels[area as PolicyArea];
  if (!level) return undefined;
  const claim = area === "context" ? readOnlyClaim(call) : undefined;
  return {
    area,
    level,
    ...(claim?.vouched ? { readOnly: claim.claim } : {}),
  };
}

/**
 * Would the tool's own check pass if the user had set it to run without
 * asking? That is false for a file outside the workspace and for a command the
 * safety floor does not call safe, so Permissive never reaches past them for
 * reads.
 */
function passesOwnCheck(
  tool: ToolLike | undefined,
  parsedArgs: Record<string, unknown>,
  processedArgs: Record<string, unknown> | undefined,
): boolean {
  if (!tool?.evaluateToolCallPolicy) return true;
  return (
    tool.evaluateToolCallPolicy(
      "allowedWithoutPermission",
      parsedArgs,
      processedArgs,
    ) === "allowedWithoutPermission"
  );
}

export interface LooseningInput {
  approval: ApprovalSettings | undefined;
  tool: ToolLike | undefined;
  toolName: string;
  parsedArgs: Record<string, unknown>;
  processedArgs?: Record<string, unknown>;
  /** The folder the command runs in, to check git's config for a read-only claim */
  cwd?: string;
  /** The shell that will run it: a command means what its shell makes of it */
  shell?: ShellKind;
}

/**
 * Whether the level for this call's area allows it without asking. The caller
 * applies the result only to a call that is still open (no rule matched, not
 * protected, not refused), except for IDGAF, which is absolute.
 */
export function approvalLoosening(
  input: LooseningInput,
): Loosening | undefined {
  const { approval, tool, toolName, parsedArgs, processedArgs } = input;
  const found = levelOfCall(approval, toolName, tool, {
    parsedArgs,
    cwd: input.cwd,
    shell: input.shell,
  });
  if (!found) return undefined;
  const what = found.readOnly ? ` (the command ${found.readOnly})` : "";

  if (found.level === "idgaf") {
    return {
      source: "idgaf",
      reason: `Allowed: ${found.area === "context" ? "Context use" : found.area === "edits" ? "File edits" : "Tool use"} is set to IDGAF${what}.`,
      absolute: true,
    };
  }
  if (found.level === "permissive") {
    // A read outside the workspace still asks: Permissive is "no rule stops
    // it", and the tool's own workspace check is a protection, not a rule.
    // A command the parser vouched as only reading needs no help from the
    // tool's own check, which does not know pipelines; a refusal or a
    // protected path is settled before this
    if (
      found.area === "context" &&
      !found.readOnly &&
      !passesOwnCheck(tool, parsedArgs, processedArgs)
    ) {
      return undefined;
    }
    return {
      source: "permissive",
      reason: `Allowed: ${found.area === "context" ? "Context use" : found.area === "edits" ? "File edits" : "Tool use"} is Permissive and no rule stops it${what}.`,
    };
  }
  return undefined;
}

/**
 * Manual: ask every time, whatever the tool's own setting or an allow rule
 * says. File edits are excluded because their check is the diff the person
 * accepts or rejects, which is the same at every level below Permissive.
 */
export function isManualCall(
  approval: ApprovalSettings | undefined,
  toolName: string,
  tool: Pick<Tool, "readonly"> | undefined,
  call?: CallContext,
): boolean {
  const found = levelOfCall(approval, toolName, tool, call);
  return found?.level === "manual" && found.area !== "edits";
}
