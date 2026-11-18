import type { ToolPolicy } from "@continuedev/terminal-security";
import type { ILLM } from "../../..";
import { levelOfCall, type ApprovalSettings } from "../approval";
import type { EnvNameOptions } from "../envNames";
import type { ShellKind } from "../../../util/shell";
import { DecisionSource } from "../decide";
import { uriToPath } from "../names";
import { EvaluateInput, evaluateToolPolicyWithRules } from "../evaluate";
import { deputyWorkspace } from "../workspaceRoots";
import type { ToolPermissions } from "../rules";
import type { AuditAgent, AuditReviewer } from "../audit/record";
import { ReviewCategory } from "./categories";
import {
  addressedReason,
  findReviewerAddressedText,
} from "./reviewerAddressed";
import { ReviewResult } from "./parse";
import { promptText, type ReviewerPromptVariant } from "./promptV3";
import { assembleGuidance, guidanceHash, type GuidanceInput } from "./guidance";
import {
  ReviewEnvironment,
  ReviewHistory,
  reviewerPromptVersion,
} from "./prompt";
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  reviewToolCall,
  ReviewerReasoning,
  unavailable,
} from "./review";
import { AutoReviewSessions, reviewContextKey } from "./state";
import { reasonOf, TAINTED_SESSION_SOURCE } from "../taint/taintRule";
import { taintInput } from "../taint/taintWiring";

export interface AutoReviewRequest {
  sessionId: string;
  /** The call's id, for the audit trail */
  callId?: string;
  /** Which agent made the call, for the audit trail */
  agent?: AuditAgent;
  toolName: string;
  basePolicy: ToolPolicy;
  parsedArgs: Record<string, unknown>;
  processedArgs?: Record<string, unknown>;
  history: ReviewHistory;
  /** The level of each area; absent means every call is reviewed. */
  approval?: ApprovalSettings;
  /** No person to ask: an unusable reviewer refuses. */
  headless?: boolean;
}

export interface AutoReviewReply {
  decision: "allow" | "ask" | "deny";
  reason: string;
  category?: ReviewCategory;
  /**
   * Who decided. "rules" means the deterministic engine (a deny, ask or allow
   * rule, a protected path, the safety floor, or an allowed policy) and the
   * reviewer was not asked. "reviewer" is the model. "system" is Auto itself
   * (unavailable, off, or a refusal cap).
   */
  by: "rules" | "reviewer" | "system";
  /** For `by: "rules"`: which rule or check decided. */
  ruleSource?: DecisionSource;
  /** The command or path, for showing a refusal. */
  displayValue?: string;
  cached?: boolean;
  /** The reviewer's reply could not be read, so the call was left for the user. */
  unusable?: boolean;
  /**
   * IDGAF only: the call carries text addressed to the reviewer. IDGAF runs it
   * anyway; the notice is for the person to see.
   */
  notice?: string;
  /** Which model answered, how long it took and what it used (for the audit trail) */
  reviewer?: AuditReviewer;
}

export interface AutoReviewDeps {
  tool: EvaluateInput["tool"];
  permissions: ToolPermissions | undefined;
  /** `experimental.enableAutoApproval`. */
  enabled: boolean;
  /** The model chosen for the reviewer role; never a chat model. */
  reviewer: Pick<ILLM, "chat"> | null | undefined;
  /** The shell commands run in (resolveShell) */
  shell?: ShellKind;
  /** `modeModels.reviewer.reasoningEffort`, as completion options. */
  reviewerReasoning?: ReviewerReasoning;
  environment: ReviewEnvironment;
  /**
   * The person's own `toolPermissions.auto.guidance`, and nothing else. The
   * reviewer's trusted block is built only from this; `permissions.auto.guidance`
   * may have come from a repository or an assistant and is never read.
   */
  guidance?: GuidanceInput;
  /** The person's own `toolPermissions.auto.environment.trustedDomains`, and nothing else. */
  trustedDomains?: readonly string[];
  /** The person's own `toolPermissions.auto.environment.envNames`, and nothing else. */
  envNames?: EnvNameOptions;
  /**
   * `toolPermissions.auto.reviewerPrompt` from the person's own config.yaml
   * and nothing else (userReviewerPrompt.ts). `v3` is the tightened prompt;
   * absent is the shipped one.
   */
  reviewerPrompt?: ReviewerPromptVariant;
  sessions: AutoReviewSessions;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A workspace folder as a path: the IDE gives file URIs. */
function folderPath(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  return dir.startsWith("file:") ? uriToPath(dir) : dir;
}

/** Sources where the user or the safety floor already spoke: the reviewer cannot move them. */
const FINAL_SOURCES: DecisionSource[] = [
  "deny-rule",
  "ask-rule",
  "allow-rule",
  "protected-path",
  "safety-floor",
  "tainted-session",
  // B92: a secret read then a network call is the person's to approve
  "secret-egress",
  // A command written for another shell: the person sees the warning
  "shell-hint",
];

/**
 * Decide one call in Auto mode.
 *
 * Order (plans/tool-auto-approval.md section 5): the deterministic engine runs
 * first and anything it settles is returned as is. Only a call it leaves open,
 * that is an "ask" that came from the tool's own setting or default and not
 * from a rule, a protected path or the safety floor, reaches the reviewer. The
 * reviewer can turn that ask into allow or deny, never the other way round.
 */
export async function autoReviewToolCall(
  deps: AutoReviewDeps,
  req: AutoReviewRequest,
): Promise<AutoReviewReply> {
  const tainted = taintInput(req.sessionId, req.callId);
  const evaluated = evaluateToolPolicyWithRules({
    tool: deps.tool,
    toolName: req.toolName,
    basePolicy: req.basePolicy,
    parsedArgs: req.parsedArgs,
    processedArgs: req.processedArgs,
    permissions: deps.permissions,
    approval: req.approval,
    cwd: folderPath(deps.environment.workspaceDirs?.[0]),
    ...deputyWorkspace(deps.environment.workspaceDirs ?? []),
    shell: deps.shell,
    trustedDomains: deps.trustedDomains,
    envNames: deps.envNames,
    ...tainted,
  });
  const base = { displayValue: evaluated.displayValue };
  const settled = (
    decision: AutoReviewReply["decision"],
    fallback: string,
  ): AutoReviewReply => ({
    ...base,
    decision,
    by: "rules",
    ruleSource: evaluated.source,
    reason: evaluated.reason ?? fallback,
  });

  if (evaluated.policy === "disabled") {
    return settled("deny", "Refused by a rule or the safety check.");
  }
  if (evaluated.policy === "allowedWithoutPermission") {
    const allowed = settled("allow", "Allowed without review.");
    if (evaluated.source === "idgaf") {
      const hits = findReviewerAddressedText(req.parsedArgs);
      if (hits.length > 0) {
        return { ...allowed, notice: addressedReason(hits) };
      }
    }
    return allowed;
  }
  if (evaluated.protection === "fetch-and-run") {
    const area = levelOfCall(req.approval, req.toolName, deps.tool, {
      parsedArgs: req.parsedArgs,
      cwd: folderPath(deps.environment.workspaceDirs?.[0]),
      shell: deps.shell,
    });
    // Automatic does not weigh this: running a download is refused outright
    if (area?.level === "automatic") {
      return settled(
        "deny",
        "This runs what it downloads, which Automatic refuses.",
      );
    }
  }
  if (evaluated.source && FINAL_SOURCES.includes(evaluated.source)) {
    return settled("ask", "Your rules ask before this runs.");
  }
  // A sink in a tainted session is the person's to approve, not the reviewer's
  if (evaluated.taintSink && tainted.taint) {
    return {
      ...settled("ask", ""),
      reason: reasonOf(evaluated.taintSink, tainted.taint),
      ruleSource: TAINTED_SESSION_SOURCE,
    };
  }

  // Only an area set to Automatic has a reviewer: the others leave an open
  // call to the person
  const found = levelOfCall(req.approval, req.toolName, deps.tool, {
    parsedArgs: req.parsedArgs,
    cwd: folderPath(deps.environment.workspaceDirs?.[0]),
    shell: deps.shell,
  });
  if (found && found.level !== "automatic") {
    return settled("ask", "This area is not set to Automatic.");
  }

  // The call is open. From here Auto is the only thing that may loosen it.
  const system = (result: ReviewResult): AutoReviewReply => ({
    ...base,
    ...result,
    by: "system",
  });
  // Text addressed to the reviewer is an attack, never evidence of safety:
  // settled here, before the model is asked, so its allow cannot be used.
  const addressed = findReviewerAddressedText(req.parsedArgs);
  if (addressed.length > 0) {
    return {
      ...system({
        decision: req.headless ? "deny" : "ask",
        category: "reviewer-addressed-text",
        reason: addressedReason(addressed),
      }),
      reviewer: { promptVersion: "reviewer-addressed-text" },
    };
  }
  if (!deps.enabled) {
    return system(unavailable("Auto approval is turned off.", false));
  }
  if (!deps.reviewer) {
    return system(
      unavailable(
        "Choose a reviewer model in Settings > Models.",
        req.headless,
      ),
    );
  }

  // Refuse to review with guidance that does not pass: dropping a "never"
  // entry silently would loosen the reviewer without anyone seeing it.
  const assembled = assembleGuidance(deps.guidance);
  if (assembled.errors.length > 0) {
    return system(
      unavailable(
        `Reviewer guidance in config.yaml was refused. ${assembled.errors.join(" ")}`,
        req.headless,
      ),
    );
  }
  const guidance = assembled.guidance;
  const variant = deps.reviewerPrompt === "v3" ? "v3" : "default";
  const promptVersion = reviewerPromptVersion(
    guidance,
    undefined,
    promptText(variant),
  );

  const state = deps.sessions.get(req.sessionId);
  const limits = deps.permissions?.auto?.limits;
  // A verdict is only reused under the same words and the same guidance
  const taintKey = tainted.taint?.kinds.join("+") ?? "";
  const context = `${reviewContextKey(req.history.userMessages)}:${guidanceHash(guidance)}:${variant}:${taintKey}`;
  const cached = state.cached(req.toolName, req.parsedArgs, context);
  // A cached answer is not counted again. The cap is for new refusals.
  if (cached) {
    return {
      ...base,
      ...cached,
      by: reviewedBy(cached),
      cached: true,
      reviewer: { promptVersion },
    };
  }
  // The audit wants the model, how long it took and what it used
  let usage: AuditReviewer["usage"];
  const startedAt = Date.now();
  const measured: Pick<ILLM, "chat"> = {
    chat: async (...args: Parameters<ILLM["chat"]>) => {
      const reply = await deps.reviewer!.chat(...args);
      usage = usageOf((reply as { usage?: unknown } | undefined)?.usage);
      return reply;
    },
  };
  const raw = await reviewToolCall(
    measured,
    {
      toolName: req.toolName,
      args: req.parsedArgs,
      history: req.history,
      environment: {
        ...deps.environment,
        ...(tainted.taint ? { taint: tainted.taint } : {}),
      },
      settings: deps.permissions?.auto,
      guidance,
    },
    {
      timeoutMs: deps.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      signal: deps.signal,
      headless: req.headless,
      reasoning: deps.reviewerReasoning,
      promptVariant: variant,
    },
  );
  state.remember(req.toolName, req.parsedArgs, raw, context);

  const result = state.record(raw, limits);
  return {
    ...base,
    ...result,
    by: reviewedBy(result),
    reviewer: {
      model: (deps.reviewer as { model?: string }).model,
      promptVersion,
      latencyMs: Date.now() - startedAt,
      ...(usage ? { usage } : {}),
    },
  };
}

/** Token counts from whichever shape a provider reports them in. */
export function usageOf(raw: unknown): AuditReviewer["usage"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (...keys: string[]) => {
    for (const k of keys) if (typeof u[k] === "number") return u[k] as number;
    return undefined;
  };
  const out = {
    input: num("promptTokens", "prompt_tokens", "input_tokens"),
    output: num("completionTokens", "completion_tokens", "output_tokens"),
    cacheRead: num("cacheReadTokens", "cache_read_input_tokens"),
    cacheWrite: num("cacheWriteTokens", "cache_creation_input_tokens"),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

function reviewedBy(result: ReviewResult): "system" | "reviewer" {
  return result.category === "reviewer-unavailable" ||
    result.category === "reviewer-addressed-text" ||
    result.category === "denial-limit"
    ? "system"
    : "reviewer";
}
