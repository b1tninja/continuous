import type { ToolPolicy } from "@continuedev/terminal-security";
import type { Tool } from "../..";
import type { ResolvedPath } from "../../util/pathResolver";
import {
  approvalLoosening,
  ApprovalSettings,
  isManualCall,
  levelOfCall,
  skippedProtections,
} from "./approval";
import { hiddenCommandName } from "./commandName";
import { hasUnsafeShellConstruct } from "./command";
import { envAssignmentHit } from "./envAssignments";
import { maskAssignmentValues } from "./envMask";
import type { EnvNameOptions } from "./envNames";
import {
  DecisionSource,
  decideToolCall,
  findRuleMatch,
  type DecideInput,
  type ToolDecision,
} from "./decide";
import type { ShellKind } from "../../util/shell";
import { isPrivateFetchTarget } from "../../util/networkAddress";
import { askProtectionHit } from "./askProtections";
import { deputyCallHit, type DeputyCallInput } from "./deputyCall";
import { outsideTargetReason } from "./outsideEdits";
import { builtinRuleOn } from "./policy";
import { parsePermissions, uriToPath } from "./names";
import { findProtected } from "./protectedCall";
import type { Sink } from "./taint/taintSinks";
import {
  applyTaintedSessionRule,
  type TaintedSessionInput,
} from "./taint/taintRule";
import { runtimeWriteTarget } from "./runtimeWriteTarget";
import { policyFileHit, POLICY_FILE_REASON } from "./selfProtect";
import type { ProtectedHit, ProtectedKind } from "./protected";
import type { RuleSource, ToolPermissions } from "./rules";

/**
 * Brace expansion or `$IFS`: the safety floor never sees the command that will
 * actually run, so the text is refused when that floor is on. PowerShell and
 * cmd have neither (`{ $_.a, $_.b }` is a script block there, `$IFS` an
 * ordinary variable), so they are not refused for it.
 *
 * A variable where the command name is does not refuse: it asks, at every
 * level (hiddenCommandName).
 */
export function floorMustRefuse(
  command: string | undefined,
  shell?: ShellKind,
): boolean {
  if (command === undefined) return false;
  if (shell === "powershell" || shell === "cmd") return false;
  if (unquotedBraceWithComma(command)) return true;
  return /\$\{?IFS\b/.test(command);
}

/** A level must not run a command the floor could not see through. */
function hidesTheCommand(
  command: string | undefined,
  shell?: ShellKind,
  envNames?: EnvNameOptions,
): boolean {
  if (command === undefined) return false;
  return (
    floorMustRefuse(command, shell) ||
    hasUnsafeShellConstruct(command, shell) ||
    hiddenCommandName(command, shell) !== undefined ||
    envAssignmentHit(command, shell, envNames)?.severity === "dangerous"
  );
}

function unquotedBraceWithComma(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let body = "";
  let open = false;
  const flush = () => {
    open = false;
    body = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      flush();
      continue;
    }
    if (c === "\\") {
      i++;
      flush();
      continue;
    }
    if (c === "{") {
      open = true;
      body = "";
      continue;
    }
    if (c === "}" && open) {
      if (body.includes(",")) return true;
      flush();
      continue;
    }
    if (open) body += c;
  }
  return false;
}

export interface ToolPolicyResult {
  policy: ToolPolicy;
  displayValue?: string;
  /** Present only when the user has rules, so existing callers see no change. */
  source?: DecisionSource;
  /** A sentence a person can read, for the prompt or the refusal. */
  reason?: string;
  /** What kind of protected call asked (source "protected-path") */
  protection?: ProtectedKind;
  /** A command the parser vouched as only reading: why it is Context use */
  readOnly?: string;
  /** The rule that decided, as written in config.yaml. */
  rule?: string;
  /** Set only in a tainted session: the sink class the call is (taint/taintSinks.ts) */
  taintSink?: Sink;
  /**
   * IDGAF ran a call the permission layer would have refused or held: what it
   * would have decided, for the audit trail and the "would have objected"
   * count. Never shown to the model.
   */
  idgafOverride?: IdgafOverride;
}

/** What the permission layer would have decided for a call IDGAF ran anyway. */
export interface IdgafOverride {
  /** "disabled" (refused) or "allowedWithPermission" (asked) */
  policy: Exclude<ToolPolicy, "allowedWithoutPermission">;
  source?: DecisionSource;
  reason?: string;
  protection?: ProtectedKind;
  rule?: string;
}

export interface EvaluateInput extends TaintedSessionInput {
  tool:
    | (Pick<
        Tool,
        | "group"
        | "originalFunctionName"
        | "uri"
        | "evaluateToolCallPolicy"
        | "readonly"
        | "mcpDefinitionChange"
      > & { function?: Pick<Tool["function"], "parameters"> })
    | undefined;
  toolName: string;
  basePolicy: ToolPolicy;
  parsedArgs: Record<string, unknown>;
  processedArgs?: Record<string, unknown>;
  permissions: ToolPermissions | undefined;
  /**
   * The same rules by where each was written. When given, these are the rules
   * that run (`permissions` still carries the reviewer's settings) and each
   * reason names the file its rule came from.
   */
  permissionSources?: Partial<Record<RuleSource, ToolPermissions>>;
  /** The folder a command runs in; lets git be vouched read-only */
  cwd?: string;
  /** Every workspace folder as a path (the first is `cwd`); a path in any is inside */
  workspaceDirs?: readonly string[];
  /** Follows links for an MCP path argument; set only for a local workspace (realPath.ts) */
  resolvePath?: DeputyCallInput["resolvePath"];
  /** The shell that runs it (resolveShell); without one no command is vouched read-only */
  shell?: ShellKind;
  /** The level chosen for each area; absent means Cautious everywhere. */
  approval?: ApprovalSettings;
  /**
   * Domains the person trusts, read from their own config file and nothing
   * else (never a workspace file or an assistant). `ask-unknown-host` acts
   * only when this is non-empty.
   */
  trustedDomains?: readonly string[];
  /** The person's own `largeChangeLines` (default 300); `ask-large-change` asks above it */
  largeChangeLines?: number;
  /**
   * Environment variable names the person added to or took off the lists of
   * names that change what a command does (envNames.ts), from their own
   * config file and nothing else.
   */
  envNames?: EnvNameOptions;
  /** Path syntax to judge file paths by; the host's when absent. Tests set it. */
  platform?: "win32" | "posix";
  /** The home folder; the host's when absent. Tests set it. */
  home?: string;
}

/**
 * The policy for one tool call: the tool's own check first (command safety
 * floor, workspace-only reads), then the user's `toolPermissions` rules on top.
 * Without rules this returns exactly what it did before rules existed. At
 * IDGAF on the call's area every call runs (idgafRunsEverything).
 */
export function evaluateToolPolicyWithRules(
  input: EvaluateInput,
): ToolPolicyResult {
  return idgafRunsEverything(
    input,
    applyTaintedSessionRule(
      input,
      lockRuntimeWrites(input, lockPolicyFiles(input, evaluateRules(input))),
    ),
  );
}

/** Says what IDGAF let through, for the decision chip, the transcript and the audit trail. */
export const IDGAF_OVERRIDE_NOTE =
  "IDGAF runs every call: no rule, guard or safety check is applied.";

const AREA_LABEL = {
  context: "Context use",
  tools: "Tool use",
  edits: "File edits",
} as const;

/**
 * IDGAF: no tool call is refused or held by the permission layer. Deny rules,
 * floor rules, protected paths and secret files, the safety floor, a command
 * that hides what it runs, the policy-file lock, the tainted-session rule and
 * every built-in ask are all decided first, as at any level, so the decision
 * still says what they would have done, and then the call runs. Only a tool
 * the person switched off (its own setting, which also keeps it out of the
 * model's tool list) stays off: that is whether the tool exists, not a check.
 *
 * What would have stopped the call stays in the reason and the audit trail,
 * and output and secret masking are unchanged.
 */
function idgafRunsEverything(
  input: EvaluateInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  if (result.policy === "allowedWithoutPermission") return result;
  if (input.basePolicy === "disabled") return result;
  const found = levelOfCall(input.approval, input.toolName, input.tool, {
    parsedArgs: input.parsedArgs,
    cwd: input.cwd,
    shell: input.shell,
  });
  if (found?.level !== "idgaf") return result;
  const { protection, rule, ...rest } = result;
  return {
    ...rest,
    policy: "allowedWithoutPermission",
    source: "idgaf",
    reason: withWouldHave(
      `Allowed: ${AREA_LABEL[found.area as keyof typeof AREA_LABEL]} is set to IDGAF. ${IDGAF_OVERRIDE_NOTE}`,
      result,
    ),
    idgafOverride: overrideOf({ ...result, protection, rule }),
  };
}

/**
 * ROADMAP B31. The path guards read a path as it is written, so a terminal
 * command whose write target is built when it runs (`$d`, a wildcard, a
 * backtick, a bare name after a `cd` into the home folder) is not covered by
 * them. At IDGAF, which would otherwise run it, it is marked as asking, so the
 * decision records it; IDGAF then runs it anyway (idgafRunsEverything). The
 * sandbox that denies writes to the policy folders (W8) is what holds for
 * certain.
 */
export const RUNTIME_WRITE_REASON =
  "This command writes to a path built when it runs, which the path guards cannot read.";

function lockRuntimeWrites(
  input: EvaluateInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  const { tool, toolName, parsedArgs } = input;
  const command = parsedArgs.command;
  if (!tool || toolName !== "run_terminal_command") return result;
  if (
    typeof command !== "string" ||
    result.policy !== "allowedWithoutPermission"
  ) {
    return result;
  }
  const level = levelOfCall(input.approval, toolName, tool, {
    parsedArgs,
    cwd: input.cwd,
    shell: input.shell,
  })?.level;
  if (level !== "idgaf") return result;
  const why = runtimeWriteTarget(command, input.shell, input.cwd);
  if (!why) return result;
  return {
    ...result,
    policy: "allowedWithPermission",
    source: "floor",
    reason: `${RUNTIME_WRITE_REASON} (${why})`,
  };
}

/**
 * The locked floor (selfProtect.ts): a call that would write or delete a
 * permission or policy file asks, and is refused at Automatic, where nobody
 * is there to say yes to a change that undoes the other protections. That
 * holds for a path the call names. No rule or built-in switch loosens it;
 * IDGAF runs the call anyway (idgafRunsEverything), with this as the reason
 * it would have stopped.
 */
function lockPolicyFiles(
  input: EvaluateInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  const { tool, toolName } = input;
  if (!tool || result.policy === "disabled") return result;
  const resolved = input.processedArgs?.resolvedPath as
    ResolvedPath | null | undefined;
  const isMcp = !!tool.uri?.startsWith("mcp:") && !!tool.originalFunctionName;
  const hit = policyFileHit({
    toolName,
    parsedArgs: input.parsedArgs,
    resolvedPath: resolved ? uriToPath(resolved.uri) : undefined,
    mcp: isMcp ? { readonly: !!tool.readonly } : undefined,
    cwd: input.cwd,
    shell: input.shell,
  });
  if (!hit) return result;
  const level = levelOfCall(input.approval, toolName, tool, {
    parsedArgs: input.parsedArgs,
    cwd: input.cwd,
    shell: input.shell,
  })?.level;
  // A scan that gave up cannot say the call is a write: it asks, never refuses.
  // IDGAF is decided as Automatic here and then run (idgafRunsEverything).
  const refuse = (level === "automatic" || level === "idgaf") && !hit.capped;
  if (!refuse && result.policy === "allowedWithPermission") return result;
  return {
    ...result,
    policy: refuse ? "disabled" : "allowedWithPermission",
    source: "floor",
    reason: `${POLICY_FILE_REASON} (${hit.path})`,
  };
}

interface ProtectedHitParts {
  resolved: ResolvedPath | null | undefined;
  resolvedPath: string | undefined;
  privateUrl: ProtectedHit | undefined;
  changedDefinition: ProtectedHit | undefined;
  hiddenName: ProtectedHit | undefined;
  envHit: ProtectedHit | undefined;
}

/**
 * The first protection that applies, in the order the checks run. Kept apart
 * from evaluateRules so each new protection does not push that function over
 * the complexity limit.
 */
function firstProtectedHit(
  input: EvaluateInput,
  parts: ProtectedHitParts,
): ProtectedHit | undefined {
  const { tool, toolName, parsedArgs } = input;
  const { resolved, resolvedPath } = parts;
  return [
    findProtected({
      toolName,
      parsedArgs,
      resolvedPath,
      skip: skippedProtections(input.approval),
      cwd: input.cwd,
      shell: input.shell,
    }),
    parts.privateUrl,
    parts.changedDefinition,
    parts.hiddenName,
    parts.envHit,
    askProtectionHit({
      toolName,
      parsedArgs,
      resolvedPath,
      shell: input.shell,
      approval: input.approval,
      trustedDomains: input.trustedDomains,
      largeChangeLines: input.largeChangeLines,
      cwd: input.cwd,
    }),
    deputyCallHit(deputyInputOf(input, resolved, resolvedPath)),
  ].find((hit) => hit !== undefined);
}

function deputyInputOf(
  input: EvaluateInput,
  resolved: ResolvedPath | null | undefined,
  resolvedPath: string | undefined,
): DeputyCallInput {
  const { tool, toolName, parsedArgs } = input;
  return {
    toolName,
    parsedArgs,
    resolved: resolved
      ? {
          path: resolvedPath,
          withinWorkspace: resolved.isWithinWorkspace,
        }
      : undefined,
    cwd: input.cwd,
    workspaceDirs: input.workspaceDirs,
    resolvePath: input.resolvePath,
    schema: tool?.function?.parameters,
    approval: input.approval,
    flavor: input.platform,
    home: input.home,
    mcp: !!tool?.uri?.startsWith("mcp:") && !!tool?.originalFunctionName,
  };
}

/** The decision's reason; at IDGAF on File edits it also names a target outside the workspace. */
function reasonWithOutsideTarget(
  input: EvaluateInput,
  decision: { source?: DecisionSource; policy: ToolPolicy; reason?: string },
  area: string | undefined,
  resolved: ResolvedPath | null | undefined,
  resolvedPath: string | undefined,
): string | undefined {
  if (
    decision.source !== "idgaf" ||
    decision.policy !== "allowedWithoutPermission" ||
    area !== "edits"
  ) {
    return decision.reason;
  }
  const note = outsideTargetNote(input, resolved, resolvedPath);
  return note ? `${decision.reason ?? ""} ${note}`.trim() : decision.reason;
}

/**
 * The absolute path a File edits call reaches outside the workspace, when
 * IDGAF lets it through: said in the decision, so the audit trail and the
 * transcript name the place. The built-in rule is not consulted for the
 * judgement (it may be switched off, and the fact stays true).
 */
function outsideTargetNote(
  input: EvaluateInput,
  resolved: ResolvedPath | null | undefined,
  resolvedPath: string | undefined,
): string | undefined {
  const hit = deputyCallHit({
    ...deputyInputOf(input, resolved, resolvedPath),
    approval: undefined,
  });
  const suffix = ", outside the workspace";
  if (!hit?.path.endsWith(suffix)) return undefined;
  return outsideTargetReason(hit.path.slice(0, -suffix.length));
}

function evaluateRules(input: EvaluateInput): ToolPolicyResult {
  const { tool, toolName, basePolicy, parsedArgs, processedArgs } = input;

  // A tool we do not know has nothing to check, as before.
  if (!tool) return { policy: basePolicy };

  // The command, so a refusal can show what was refused. (This used to compare
  // against "runTerminalCommand", which is never the tool's real name, so the
  // command was never shown.)
  let displayValue: string | undefined;
  if (toolName === "run_terminal_command" && parsedArgs.command) {
    // A secret in an assignment (`API_KEY=sk-... curl`) is not shown
    displayValue = maskAssignmentValues(parsedArgs.command as string);
  }

  let evaluated = tool.evaluateToolCallPolicy
    ? tool.evaluateToolCallPolicy(basePolicy, parsedArgs, processedArgs)
    : basePolicy;
  const commandText =
    toolName === "run_terminal_command" &&
    typeof parsedArgs.command === "string"
      ? parsedArgs.command
      : undefined;
  const floorOn = builtinRuleOn(input.approval, "refuse-dangerous-commands");
  // The person switched off the safety check's refusals: such a command asks
  if (
    evaluated === "disabled" &&
    basePolicy !== "disabled" &&
    commandText !== undefined &&
    !floorOn
  ) {
    evaluated = "allowedWithPermission";
  }
  // Obfuscation the floor cannot see through is the same as a refusal: a level
  // must not turn it into a run.
  if (
    floorOn &&
    basePolicy !== "disabled" &&
    evaluated !== "disabled" &&
    floorMustRefuse(commandText, input.shell)
  ) {
    evaluated = "disabled";
  }

  const resolved = processedArgs?.resolvedPath as
    ResolvedPath | null | undefined;
  const resolvedPath = resolved ? uriToPath(resolved.uri) : undefined;

  // Credentials and files that change what runs later always ask, with or
  // without rules, so this runs for every user and not only those with rules.
  // It only ever tightens: a call that is already refused stays refused.
  // A private or local URL always asks. Permissive (Hands-off) and an allow
  // rule can loosen the tool's own "ask", so this is a protection, like a
  // protected path. IDGAF still reaches past it.
  const privateUrl =
    toolName === "fetch_url_content" &&
    isPrivateFetchTarget(parsedArgs.url, processedArgs)
      ? ({
          kind: "private-url",
          path: fetchHost(parsedArgs.url),
        } satisfies ProtectedHit)
      : undefined;
  // A tool whose MCP definition changed since approval asks again. Never in
  // the skip list: no setting turns it off, and IDGAF alone reaches past it.
  const changedDefinition = changedDefinitionHit(
    tool.mcpDefinitionChange,
    basePolicy,
  );
  const hiddenName = floorOn
    ? hiddenNameHit(commandText, input.shell)
    : undefined;
  const envHit = floorOn
    ? envAssignmentProtection(commandText, input.shell, input.envNames)
    : undefined;
  const protectedHit = firstProtectedHit(input, {
    resolved,
    resolvedPath,
    privateUrl,
    changedDefinition,
    hiddenName,
    envHit,
  });

  // The floor: deny rules the person wrote to bind even at IDGAF
  const floorRules = parsePermissions({ deny: input.approval?.floor }, "floor");
  if (floorRules.length) {
    const isMcpCall =
      !!tool.uri?.startsWith("mcp:") && !!tool.originalFunctionName;
    const floorMatch = findRuleMatch({
      toolName,
      mcp: isMcpCall
        ? { serverName: tool.group, toolName: tool.originalFunctionName! }
        : undefined,
      parsedArgs,
      resolvedPath,
      base: basePolicy,
      evaluated,
      rules: floorRules,
      shell: input.shell,
    });
    if (floorMatch?.decision === "deny") {
      return {
        policy: "disabled",
        displayValue,
        source: "floor",
        rule: floorMatch.rule.raw,
        reason: `Blocked by your floor rule ${floorMatch.rule.raw}, which binds at every level.`,
      };
    }
  }

  const rules = input.permissionSources
    ? Object.entries(input.permissionSources).flatMap(([origin, perms]) =>
        parsePermissions(perms, origin as RuleSource),
      )
    : parsePermissions(input.permissions);
  const call = { parsedArgs, cwd: input.cwd, shell: input.shell };
  const found = levelOfCall(input.approval, toolName, tool, call);
  // A hidden command is not loosened by a level here; IDGAF runs it later
  // (idgafRunsEverything) and records why it would have stopped. Otherwise
  // IDGAF reaches past a refusal, a rule and a protected path, and Permissive
  // acts only on a call that would otherwise ask.
  const hidden =
    floorOn && hidesTheCommand(commandText, input.shell, input.envNames);
  const loosening = hidden
    ? undefined
    : found?.level === "idgaf" || evaluated === "allowedWithPermission"
      ? approvalLoosening({
          approval: input.approval,
          tool,
          toolName,
          parsedArgs,
          processedArgs,
          cwd: input.cwd,
          shell: input.shell,
        })
      : undefined;
  const manual =
    isManualCall(input.approval, toolName, tool, call) &&
    basePolicy !== "disabled" &&
    !loosening;
  if (rules.length === 0 && !protectedHit && !loosening && !manual) {
    return {
      policy: evaluated,
      displayValue,
      ...(found?.readOnly ? { readOnly: found.readOnly } : {}),
    };
  }

  const isMcp = !!tool.uri?.startsWith("mcp:") && !!tool.originalFunctionName;

  const decideInput: DecideInput = {
    toolName,
    mcp: isMcp
      ? { serverName: tool.group, toolName: tool.originalFunctionName! }
      : undefined,
    parsedArgs,
    resolvedPath,
    base: basePolicy,
    evaluated,
    rules,
    protectedHit,
    loosening,
    manual,
    shell: input.shell,
  };
  const decision = decideToolCall(decideInput);

  const reason = reasonWithOutsideTarget(
    input,
    decision,
    found?.area,
    resolved,
    resolvedPath,
  );
  const idgaf = idgafRecord(reason, objectionUnderIdgaf(decideInput));
  return {
    policy: decision.policy,
    displayValue,
    source: decision.source,
    ...(idgaf.reason ? { reason: idgaf.reason } : {}),
    ...(decision.protection ? { protection: decision.protection } : {}),
    ...(decision.rule ? { rule: decision.rule } : {}),
    ...(found?.readOnly ? { readOnly: found.readOnly } : {}),
    ...(idgaf.idgafOverride ? { idgafOverride: idgaf.idgafOverride } : {}),
  };
}

/**
 * IDGAF decided the call outright: what it would have met without IDGAF, when
 * a rule or a guard objects, for the record (idgafRunsEverything carries the
 * calls that stopped even at IDGAF).
 */
function objectionUnderIdgaf(input: DecideInput): ToolDecision | undefined {
  if (!input.loosening?.absolute) return undefined;
  const without = decideToolCall({ ...input, loosening: undefined });
  return objects(without) ? without : undefined;
}

/** The reason and the record for a call IDGAF ran past an objection. */
function idgafRecord(
  reason: string | undefined,
  recorded: ToolDecision | undefined,
): { reason?: string; idgafOverride?: IdgafOverride } {
  if (!recorded) return { reason };
  return {
    reason: withWouldHave(reason, recorded),
    idgafOverride: overrideOf(recorded),
  };
}

/**
 * A rule or a guard would have refused or held the call. The tool's own
 * setting asking (no rule involved) is not counted: at IDGAF that is every
 * call, and the count is of what something would have objected to.
 */
function objects(d: { policy: ToolPolicy; source?: DecisionSource }): boolean {
  if (d.policy === "allowedWithoutPermission") return false;
  return (
    d.source !== undefined &&
    d.source !== "tool-setting" &&
    d.source !== "default" &&
    d.source !== "manual"
  );
}

/** The reason, with what would have stopped the call below IDGAF. */
function withWouldHave(
  reason: string | undefined,
  d: { policy: ToolPolicy; reason?: string },
): string {
  const was = d.policy === "disabled" ? "refused" : "asked";
  return `${reason ?? "Allowed at IDGAF."} Below IDGAF this call would have been ${was}${d.reason ? `: ${d.reason}` : "."}`;
}

function overrideOf(d: {
  policy: ToolPolicy;
  source?: DecisionSource;
  reason?: string;
  protection?: ProtectedKind;
  rule?: string;
}): IdgafOverride {
  return {
    policy: d.policy as IdgafOverride["policy"],
    ...(d.source ? { source: d.source } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.protection ? { protection: d.protection } : {}),
    ...(d.rule ? { rule: d.rule } : {}),
  };
}

/** A command whose program is a variable asks, whatever else is said about it. */
function hiddenNameHit(
  command: string | undefined,
  shell: ShellKind | undefined,
): ProtectedHit | undefined {
  const why =
    command === undefined ? undefined : hiddenCommandName(command, shell);
  return why ? { kind: "hidden-command", path: why } : undefined;
}

/** A variable set in front of the command that changes what it does: the name, never the value. */
function envAssignmentProtection(
  command: string | undefined,
  shell: ShellKind | undefined,
  names: EnvNameOptions | undefined,
): ProtectedHit | undefined {
  const hit =
    command === undefined ? undefined : envAssignmentHit(command, shell, names);
  return hit ? { kind: "env-assignment", path: hit.reason } : undefined;
}

function changedDefinitionHit(
  change: { kind: "changed" | "added" | "launch"; summary: string } | undefined,
  basePolicy: ToolPolicy,
): ProtectedHit | undefined {
  if (!change || basePolicy === "disabled") return undefined;
  return {
    kind: "mcp-definition-changed",
    path:
      change.kind === "launch"
        ? change.summary
        : `${change.kind === "added" ? "new tool" : "changed"}, ${change.summary}`,
  };
}

function fetchHost(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return raw;
  }
}
