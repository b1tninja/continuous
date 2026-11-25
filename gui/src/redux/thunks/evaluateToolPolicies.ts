import { ToolPolicy } from "@continuedev/terminal-security";
import { ChatHistoryItem, MessageModes, Tool, ToolCallState } from "core";
import {
  levelOfCall,
  type ApprovalSettings,
  type CallContext,
} from "core/tools/permissions/approval";
import { resolveShell } from "core/util/shell";
import type { AuditAgent } from "core/tools/permissions/audit/record";
import type { AutoReviewReply } from "core/tools/permissions/auto/handler";
import { userTextForReview } from "core/tools/permissions/auto/history";
import type { ReviewHistory } from "core/tools/permissions/auto/prompt";
import { isFlaggedOutput } from "core/tools/permissions/injection";
import type { DecisionSource } from "core/tools/permissions/decide";
import { planModeVerdict } from "core/tools/permissions/planMode";
import { builtinIsOn } from "core/tools/permissions/policy";
import { refusalText } from "core/tools/refusalText";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { isEditTool } from "../../util/toolCallState";
import {
  addBlockedCall,
  consumeGrant,
  grantKey,
} from "../slices/blockedCallsSlice";
import {
  errorToolCall,
  setToolCallDecision,
  setToolCallPolicyNote,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { DEFAULT_TOOL_SETTING, ToolPolicies } from "../slices/uiSlice";
import { AppThunkDispatch } from "../store";

/** Set when Auto mode is on and usable (see selectAutoApproval). */
export interface AutoReviewContext {
  sessionId: string;
  history: ReviewHistory;
  /** Exact calls the user allowed once from the Recently blocked list. */
  onceGrants?: string[];
  /** Which agent is asking, for the audit trail */
  agent?: AuditAgent;
}

export interface EvaluatedPolicy {
  policy: ToolPolicy;
  displayValue?: string;
  /** Why core decided, when the user has toolPermissions rules. "auto" means the reviewer model. */
  source?: DecisionSource | "auto" | "once";
  /** The reviewer's named reason (Auto mode). */
  category?: string;
  reason?: string;
  /** A refused call sent again: said to the model after the refusal (core) */
  repeatNote?: string;
  /** A command the parser vouched as only reading (core) */
  readOnly?: string;
  rule?: string;
  /** The protection that decided, when source is protected-path. */
  protection?: string;
  /** The level ran the call past an ask or a refusal: what it ran past (core) */
  toolCallState: ToolCallState;
}

/**
 * Arguments for the area lookup. A read-only command is Context use only when
 * the shell that will run it is known; the webview does not have that shell,
 * and then the caller lets core classify the call.
 */
function callContextFor(toolCallState: {
  parsedArgs?: Record<string, unknown>;
}): CallContext {
  const parsedArgs = toolCallState.parsedArgs;
  const platform =
    typeof process !== "undefined" ? process.platform : undefined;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return { parsedArgs };
  }
  try {
    return { parsedArgs, cwd: process.cwd(), shell: resolveShell().kind };
  } catch {
    return { parsedArgs };
  }
}

/**
 * Plan mode's hold is core's rule (planModeVerdict): a call that would run
 * waits for the person unless it only reads. Core applies it to the verdict
 * it returns when the request says the turn is a Plan turn; this applies the
 * same function to what the webview decides itself (an edit, whose ask is
 * its diff, and a verdict it clamps to the tool's setting).
 */
export function holdInPlanMode(
  result: EvaluatedPolicy,
  activeTools: Tool[],
  approval?: ApprovalSettings,
): EvaluatedPolicy {
  if (result.policy !== "allowedWithoutPermission") return result;
  const name = result.toolCallState.toolCall.function.name;
  const tool = activeTools.find((t) => t.function.name === name);
  return planModeVerdict(result, {
    // The flag on the tool, or a command the parser vouched as only reading
    readOnly: !!tool?.readonly || !!result.readOnly,
    // With "Hold changes in Plan mode" off, Plan mode holds nothing
    off: !builtinIsOn(approval?.builtin, "hold-plan-mode"),
  });
}

/**
 * Evaluates the tool policy for a tool call, including dynamic policy evaluation
 * Note that tool group policies are not considered here because activeTools already excludes disabled groups
 */
export async function evaluateToolPolicy(
  ideMessenger: IIdeMessenger,
  activeTools: Tool[],
  toolCallState: ToolCallState,
  toolPolicies: ToolPolicies,
  approval?: ApprovalSettings,
  mode?: MessageModes,
  sessionId?: string,
  agent?: AuditAgent,
  history?: ReviewHistory,
): Promise<EvaluatedPolicy> {
  const result = await evaluateBasePolicy(
    ideMessenger,
    activeTools,
    toolCallState,
    toolPolicies,
    approval,
    sessionId,
    agent,
    history,
    mode === "plan",
  );
  // Plan mode changes nothing until the plan is accepted, at every level,
  // while its switch is on
  return mode === "plan"
    ? holdInPlanMode(result, activeTools, approval)
    : result;
}

async function evaluateBasePolicy(
  ideMessenger: IIdeMessenger,
  activeTools: Tool[],
  toolCallState: ToolCallState,
  toolPolicies: ToolPolicies,
  approval?: ApprovalSettings,
  sessionId?: string,
  agent?: AuditAgent,
  history?: ReviewHistory,
  planMode?: boolean,
): Promise<EvaluatedPolicy> {
  const toolName = toolCallState.toolCall.function.name;
  // Core writes the decision to the audit trail when it knows the call
  const auditIds = {
    callId: toolCallState.toolCallId,
    ...(sessionId ? { sessionId } : {}),
    ...(agent ? { agent } : {}),
    // Core holds a call that would run in a Plan turn, and records that
    ...(planMode ? { planMode: true } : {}),
  };
  // Offered for shadow review (core ignores it unless the person turned that
  // on). Not for edits: their answer is a diff the person accepts or rejects.
  const shadowHistory = history && !isEditTool(toolName) ? { history } : {};

  // Edit tools are reviewed as a diff the user accepts or rejects, so they
  // are not asked about up front. They still go through core so a deny rule
  // (for example writeFile(.github/**)) can refuse them, and so an edit to a
  // protected file (a workflow, a git hook, .env) is held for approval instead
  // of being applied as soon as the diff is ready. An ordinary ask or allow
  // rule changes nothing here: the diff review already is the ask.
  if (isEditTool(toolName)) {
    try {
      const result = await ideMessenger.request("tools/evaluatePolicy", {
        toolName,
        basePolicy: "allowedWithoutPermission",
        parsedArgs: toolCallState.parsedArgs,
        processedArgs: toolCallState.processedArgs,
        ...(approval ? { approval } : {}),
        ...auditIds,
      });
      if (result.status === "success") {
        const { policy, source } = result.content;
        if (policy === "disabled") {
          return { ...result.content, toolCallState };
        }
        if (source === "protected-path" || source === "plan-mode") {
          return { ...result.content, toolCallState };
        }
      } else {
        // Core could not decide. Waiting is the closed failure: a deny rule,
        // a floor rule or a protected path may have been missed.
        console.error(
          `Error evaluating tool policy for ${toolName}`,
          result.error,
        );
        return editUnchecked(toolCallState);
      }
    } catch (e) {
      console.error(`Could not check rules for ${toolName}`, e);
      return editUnchecked(toolCallState);
    }
    return { policy: "allowedWithoutPermission", toolCallState };
  }

  const basePolicy =
    toolPolicies[toolName] ??
    activeTools.find((tool) => tool.function.name === toolName)
      ?.defaultToolPolicy ??
    DEFAULT_TOOL_SETTING;

  const result = await ideMessenger.request("tools/evaluatePolicy", {
    toolName,
    basePolicy,
    parsedArgs: toolCallState.parsedArgs,
    processedArgs: toolCallState.processedArgs,
    ...(approval ? { approval } : {}),
    ...auditIds,
    ...shadowHistory,
  });

  // Evaluate the policy dynamically
  if (result.status === "error") {
    console.error(`Error evaluating tool policy for ${toolName}`, result.error);
    return { policy: "disabled", toolCallState };
  }

  const { policy: dynamicPolicy, ...details } = result.content;

  // Ensure dynamic policy cannot be more lenient than base policy
  // Policy hierarchy (most restrictive to least): disabled > allowedWithPermission > allowedWithoutPermission
  if (basePolicy === "disabled") {
    return { ...details, policy: "disabled", toolCallState }; // Cannot override disabled
  }
  if (
    basePolicy === "allowedWithPermission" &&
    dynamicPolicy === "allowedWithoutPermission" &&
    // The one exception: the user's own allow rule, which core has already
    // checked cannot loosen a disabled tool or a refused command. The same
    // goes for the approval mode and switches, which core applies only to a
    // call no rule, protected path or safety check has settled.
    details.source !== "allow-rule" &&
    details.source !== "permissive" &&
    details.source !== "trusted-host"
  ) {
    return { ...details, policy: "allowedWithPermission", toolCallState }; // Cannot make more lenient
  }

  return { ...details, policy: dynamicPolicy, toolCallState };
}

/** An edit whose rules could not be checked waits for the person. */
function editUnchecked(toolCallState: ToolCallState): EvaluatedPolicy {
  return {
    policy: "allowedWithPermission",
    source: "manual",
    reason:
      "Could not check this edit against your rules, so it waits for you.",
    toolCallState,
  };
}

/**
 * What the reviewer is shown of the conversation: the user's own messages and
 * the earlier tool calls (name and arguments), never the agent's prose or any
 * tool output.
 */
export function buildReviewHistory(history: ChatHistoryItem[]): ReviewHistory {
  const userMessages: string[] = [];
  const toolCalls: ReviewHistory["toolCalls"] = [];
  for (const item of history) {
    const { message } = item;
    if (message.role === "user") {
      const text = userTextForReview(item);
      if (text.trim()) userMessages.push(text);
    }
    for (const call of item.toolCallStates ?? []) {
      toolCalls.push({
        name: call.toolCall.function.name,
        args: call.parsedArgs,
        // Only the fact, never the text: the reviewer must not read outputs.
        ...(call.output?.some((o) => isFlaggedOutput(o.content))
          ? { outputFlagged: true }
          : {}),
      });
    }
  }
  return { userMessages, toolCalls };
}

/**
 * Auto mode: ask core's reviewer about calls that wait for approval. Core runs
 * the rules again first, so a deny rule, protected path or ask rule comes back
 * unchanged and the model is never asked. The reviewer can allow a call, leave
 * it for the user, or refuse it; anything that goes wrong leaves it for the user.
 */
async function reviewOpenCalls(
  ideMessenger: IIdeMessenger,
  results: EvaluatedPolicy[],
  auto: AutoReviewContext,
  toolPolicies: ToolPolicies,
  activeTools: Tool[],
  dispatch: AppThunkDispatch,
  approval?: ApprovalSettings,
  planMode?: boolean,
): Promise<EvaluatedPolicy[]> {
  return Promise.all(
    results.map(async (r) => {
      const toolName = r.toolCallState.toolCall.function.name;
      const open =
        r.policy === "allowedWithPermission" &&
        !isEditTool(toolName) &&
        r.source !== "ask-rule" &&
        r.source !== "protected-path" &&
        // The tainted-session rule's ask is the person's, not the reviewer's
        r.source !== "tainted-session" &&
        // So is the secret-read plus network pair's (B92)
        r.source !== "secret-egress" &&
        // A shell-hint warning is for the person to read, not the reviewer
        r.source !== "shell-hint" &&
        // Plan mode's hold is for the user, not the reviewer
        r.source !== "plan-mode" &&
        // Manual asks every time; only an area set to Automatic has a reviewer
        r.source !== "manual";
      if (!open) return r;
      const tool = activeTools.find((t) => t.function.name === toolName);
      const call = callContextFor(r.toolCallState);
      const found = levelOfCall(approval, toolName, tool, call);
      // Without a shell the area of a terminal command is not known here.
      // Core classifies it, so a read-only command can still be reviewed.
      if (call.shell && found && found.level !== "automatic") return r;

      const basePolicy =
        toolPolicies[toolName] ??
        activeTools.find((t) => t.function.name === toolName)
          ?.defaultToolPolicy ??
        DEFAULT_TOOL_SETTING;
      // The user allowed this exact call once after Auto refused it. This is
      // reached only for a call the rules left open, so no deny rule, protected
      // path or ask rule can be skipped by it.
      const key = grantKey(toolName, r.toolCallState.parsedArgs);
      if (auto.onceGrants?.includes(key)) {
        dispatch(consumeGrant(key));
        return {
          ...r,
          policy: "allowedWithoutPermission" as const,
          source: "once" as const,
          reason: "You allowed this exact call once.",
        };
      }
      let reply: AutoReviewReply;
      try {
        const res = await ideMessenger.request("tools/autoReview", {
          sessionId: auto.sessionId,
          callId: r.toolCallState.toolCallId,
          ...(auto.agent ? { agent: auto.agent } : {}),
          toolName,
          basePolicy,
          parsedArgs: r.toolCallState.parsedArgs,
          processedArgs: r.toolCallState.processedArgs,
          history: auto.history,
          ...(approval ? { approval } : {}),
          // In a Plan turn core leaves a call that changes things to the person
          ...(planMode ? { planMode: true } : {}),
        });
        if (res.status !== "success") return r;
        reply = res.content;
      } catch (e) {
        console.error(`Auto review failed for ${toolName}`, e);
        return r;
      }

      // The reviewer only ever acts on a call that was waiting for the user.
      if (reply.by === "rules") return r;
      switch (reply.decision) {
        case "allow":
          return {
            ...r,
            policy: "allowedWithoutPermission" as const,
            source: "auto" as const,
            reason: `Allowed by Auto: ${reply.reason}`,
          };
        case "deny":
          return {
            ...r,
            policy: "disabled" as const,
            source: "auto" as const,
            category: reply.category,
            reason: reply.reason,
          };
        default:
          return {
            ...r,
            source: "auto" as const,
            category: reply.category,
            reason: `Auto: ${reply.reason}${reply.category ? ` [${reply.category}]` : ""}`,
          };
      }
    }),
  );
}

/** The text the model sees when a call is refused, naming who refused it. */
export function refusalMessage(
  command: string,
  source: EvaluatedPolicy["source"],
  reason: string | undefined,
  category?: string,
): { description: string; content: string } {
  // One shape for every source: who refused, the call, what to do next. The
  // text never says to stop and ask: whether the model must stop is the
  // harness's decision (the refusal cap), not the prose's
  // (plans/policy-areas.md, "Decision order"; policy-areas-prompts.md, 7.1).
  // The sentences are core's, shared with the CLI (core/tools/refusalText).
  switch (source) {
    case "auto":
      return {
        description: `Blocked by Auto${category ? ` [${category}]` : ""}`,
        content: refusalText.reviewerRefused(command, reason, category),
      };
    case "deny-rule":
      return {
        description: "Blocked by your rule",
        content: refusalText.denyRule(command, reason),
      };
    case "tool-setting":
      return {
        description: "Tool turned off",
        content: refusalText.toolOff(command, reason),
      };
    case "shell-hint":
      return {
        description: "Command was not run",
        content: reason ?? "The command was not run. Fix it and call again.",
      };
    default:
      return {
        description: "Command Disabled",
        content: refusalText.disabledByPolicy(command),
      };
  }
}

/*
    1. Get arg-dependent tool policies from core
    2. Mark any disabled ones as errored
    3. Mark others as generated
*/
export async function evaluateToolPolicies(
  dispatch: AppThunkDispatch,
  ideMessenger: IIdeMessenger,
  activeTools: Tool[],
  generatedToolCalls: ToolCallState[],
  toolPolicies: ToolPolicies,
  auto?: AutoReviewContext,
  approval?: ApprovalSettings,
  mode?: MessageModes,
  sessionId?: string,
  agent?: AuditAgent,
  history?: ReviewHistory,
): Promise<EvaluatedPolicy[]> {
  // Check if ALL tool calls are auto-approved using dynamic evaluation
  let policyResults = await Promise.all(
    generatedToolCalls.map((toolCallState) =>
      evaluateToolPolicy(
        ideMessenger,
        activeTools,
        toolCallState,
        toolPolicies,
        approval,
        mode,
        sessionId,
        agent,
        history,
      ),
    ),
  );
  if (auto) {
    policyResults = await reviewOpenCalls(
      ideMessenger,
      policyResults,
      auto,
      toolPolicies,
      activeTools,
      dispatch,
      approval,
      mode === "plan",
    );
  }

  const disabledResults = policyResults.filter(
    ({ policy }) => policy === "disabled",
  );

  // Say why a call is waiting, when a rule or protected path made it wait, so
  // the prompt is not a mystery for a tool the user set to run on its own.
  for (const { policy, source, reason, rule, toolCallState } of policyResults) {
    if (
      policy === "allowedWithPermission" &&
      reason &&
      (source === "protected-path" ||
        source === "tainted-session" ||
        source === "secret-egress" ||
        source === "ask-rule" ||
        source === "shell-hint" ||
        source === "manual" ||
        source === "auto" ||
        source === "plan-mode")
    ) {
      dispatch(
        setToolCallPolicyNote({
          toolCallId: toolCallState.toolCallId,
          note: reason,
          ...(rule ? { rule } : {}),
          ...(source ? { source } : {}),
        }),
      );
    }
  }

  // The decision chip: say why a call ran without asking.
  for (const r of policyResults) {
    const { source, reason, rule, toolCallState } = r;
    if (
      r.policy === "allowedWithoutPermission" &&
      (source === "allow-rule" ||
        source === "auto" ||
        source === "once" ||
        source === "permissive" ||
        source === "trusted-host")
    ) {
      dispatch(
        setToolCallDecision({
          toolCallId: toolCallState.toolCallId,
          decision: {
            outcome: "allowed",
            source,
            ...(reason ? { reason } : {}),
            ...(rule ? { rule } : {}),
          },
        }),
      );
    }
  }

  for (const {
    displayValue,
    source,
    reason,
    rule,
    category,
    protection,
    repeatNote,
    toolCallState,
  } of disabledResults) {
    dispatch(errorToolCall({ toolCallId: toolCallState.toolCallId }));
    const blockedSource = source ?? "safety-floor";
    dispatch(
      setToolCallDecision({
        toolCallId: toolCallState.toolCallId,
        decision: {
          outcome: "blocked",
          source: blockedSource,
          ...(reason ? { reason } : {}),
          ...(rule ? { rule } : {}),
          ...(category ? { category } : {}),
        },
      }),
    );
    dispatch(
      addBlockedCall({
        id: toolCallState.toolCallId,
        toolName: toolCallState.toolCall.function.name,
        summary: displayValue || toolCallState.toolCall.function.name,
        source: blockedSource,
        ...(reason ? { reason } : {}),
        ...(category ? { category } : {}),
        ...(protection ? { protection } : {}),
        parsedArgs: toolCallState.parsedArgs ?? {},
        at: Date.now(),
      }),
    );

    // Use the displayValue from the policy evaluation, or fallback to function name
    const command = displayValue || toolCallState.toolCall.function.name;
    const { description, content } = refusalMessage(
      command,
      source,
      reason,
      category,
    );

    // Add error message explaining why it's disabled
    dispatch(
      updateToolCallOutput({
        toolCallId: toolCallState.toolCallId,
        contextItems: [
          {
            icon: "problems",
            name:
              source === "shell-hint"
                ? description
                : "Security Policy Violation",
            description,
            // The repeat note is in the text the model reads, not only on the card
            content: repeatNote ? `${content}\n\n${repeatNote}` : content,
            hidden: false,
          },
        ],
      }),
    );
  }

  return policyResults;
}
