import path from "path";

import { checkOfProtection } from "core/tools/permissions/checkOfProtection.js";
import { BUILTIN_RULES } from "core/tools/permissions/policy.js";
import {
  suggestAllowRule,
  withLoosensCheck,
  type SuggestedRule,
} from "core/tools/permissions/suggest.js";

import { env } from "../env.js";
import type { Tool } from "../tools/types.js";

import type { AskSource, AskWhy } from "./askWhy.js";
import { toCoreCall, type CoreVerdict } from "./coreRules.js";
import { policyOriginOf, policyRuleText } from "./policyOrigin.js";
import type { ToolPermissionPolicy } from "./types.js";

type AskTool = Pick<
  Tool,
  "readonly" | "mcpServer" | "mcpToolName" | "evaluateToolCallPolicy"
>;

export interface AskFacts {
  /** The CLI's name for the tool (`Bash`, `Read`, ...) */
  toolName: string;
  args: Record<string, unknown>;
  tool?: AskTool;
  /** The engine's verdict, when it is the one asking */
  verdict?: CoreVerdict;
  /** The CLI policy that matched the call */
  matchedPolicy?: ToolPermissionPolicy;
  /** A PreToolUse hook turned an allow into an ask */
  hookAsked?: boolean;
  /** The Web level turned the default Fetch allow into an ask */
  webLevelAsked?: boolean;
}

/**
 * The rule the IDE's "Always allow" would save for the same call. The CLI's
 * tool names and arguments are turned into core's first, as the engine does.
 */
export function suggestRuleForCall(
  toolName: string,
  args: Record<string, unknown>,
  tool?: AskTool,
): SuggestedRule {
  try {
    const call = toCoreCall(toolName, args);
    const mcp = tool?.mcpServer
      ? {
          serverName: tool.mcpServer,
          toolName: tool.mcpToolName ?? toolName,
        }
      : call?.mcp;
    const suggestion = suggestAllowRule({
      toolName: call?.toolName ?? toolName,
      parsedArgs: call?.parsedArgs ?? args,
      readonly: tool?.readonly,
      ...(mcp ? { mcp } : {}),
    });
    // The tool's own check reads the CLI's arguments, not core's
    return withLoosensCheck(suggestion, tool, args);
  } catch {
    return { ok: false, reason: "Could not make a rule." };
  }
}

type Explained = Pick<AskWhy, "reason" | "source" | "ruleStopsAsk">;

/** `the built-in check "Ask before touching credentials" (protect-secrets)` */
function protectionSource(verdict: CoreVerdict): AskSource {
  const id = checkOfProtection(verdict.protection);
  const label = BUILTIN_RULES.find((r) => r.id === id)?.label;
  if (id && label) return { what: `the built-in check "${label}" (${id})` };
  return { what: "the built-in check for protected paths (protected-path)" };
}

function askRuleSource(verdict: CoreVerdict): AskSource {
  const rule = verdict.rule;
  switch (verdict.ruleOrigin) {
    case "user-config":
      return {
        what: "your toolPermissions.ask rule",
        rule,
        file: path.join(env.continueHome, "config.yaml"),
      };
    case "assistant":
      return {
        what: "the toolPermissions.ask rule",
        rule,
        file: "the assistant configuration",
      };
    case "folder":
      return {
        what: "the toolPermissions.ask rule",
        rule,
        file: "a configuration file that came with this workspace",
      };
    default:
      return { what: "a toolPermissions.ask rule", rule };
  }
}

/** Sources where a check asked, so no allow rule turns the ask off. */
const CHECK_SOURCES: Partial<Record<string, AskSource>> = {
  "tainted-session": {
    what: "the check for untrusted content in this session (tainted-session)",
  },
  "secret-egress": {
    what: "the check that a secret read here is not sent out (secret-egress)",
  },
  "shell-hint": {
    what: "the check that a command fits the shell it runs in (shell-hint)",
  },
  manual: { what: "the Manual level set for this kind of call (manual)" },
};

function engineExplains(verdict: CoreVerdict): Explained | undefined {
  if (verdict.by === "reviewer") {
    const model = verdict.reviewer?.model;
    return {
      reason:
        verdict.reason ?? "The reviewer left this call for you to decide.",
      source: {
        what: `the Auto reviewer, the model that checks calls${model ? ` (${model})` : ""}`,
      },
      ruleStopsAsk: true,
    };
  }
  if (verdict.by === "system") {
    return {
      reason: verdict.reason ?? "This call could not be checked, so it asks.",
      source: { what: "the permission check itself, not a rule" },
      ruleStopsAsk: false,
    };
  }
  if (verdict.source === "protected-path") {
    return {
      reason: verdict.reason ?? "This call touches a protected path.",
      source: protectionSource(verdict),
      ruleStopsAsk: false,
    };
  }
  if (verdict.source === "ask-rule") {
    return {
      reason:
        verdict.reason ??
        `The rule ${verdict.rule ?? ""} asks before running this.`,
      source: askRuleSource(verdict),
      ruleStopsAsk: true,
    };
  }
  const check = verdict.source ? CHECK_SOURCES[verdict.source] : undefined;
  if (check) {
    return {
      reason: verdict.reason ?? "A safety check asks about this call.",
      source: check,
      ruleStopsAsk: false,
    };
  }
  if (verdict.ownCheck) {
    return {
      reason:
        verdict.reason ?? "This tool's own safety check asks about this call.",
      source: { what: "this tool's own safety check" },
      ruleStopsAsk: true,
    };
  }
  if (verdict.reason) {
    return {
      reason: verdict.reason,
      source: {
        what: verdict.source
          ? `a permission check (${verdict.source})`
          : "a permission check",
      },
      ruleStopsAsk: true,
    };
  }
  // Nothing of the engine's own to say: the CLI's lists are why it asks
  return undefined;
}

function cliExplains(facts: AskFacts): Explained {
  const { toolName } = facts;
  // A policy that allows is not why the call asks
  const matchedPolicy =
    facts.matchedPolicy?.permission === "ask" ? facts.matchedPolicy : undefined;
  if (facts.hookAsked) {
    return {
      reason: "A PreToolUse hook asked for this call to be confirmed.",
      source: { what: "a PreToolUse hook from your hooks settings" },
      ruleStopsAsk: false,
    };
  }
  if (facts.webLevelAsked) {
    return {
      reason:
        "The Web level asks before a fetch that only the default list allows.",
      source: { what: "the Web permission level" },
      ruleStopsAsk: true,
    };
  }
  const origin = policyOriginOf(matchedPolicy);
  if (matchedPolicy && origin?.kind === "permissions-file") {
    const rule = policyRuleText(matchedPolicy);
    return {
      reason: `Your rule ${rule} asks before running this.`,
      source: { what: "your ask rule", rule, file: origin.file },
      ruleStopsAsk: true,
    };
  }
  if (matchedPolicy && origin?.kind === "flag") {
    const rule = policyRuleText(matchedPolicy);
    return {
      reason: `This session was started with --ask ${rule}, so this asks.`,
      source: { what: "the command-line flag --ask", rule },
      ruleStopsAsk: true,
    };
  }
  if (origin?.kind === "mode") {
    return {
      reason: "Plan mode asks before anything that could change the workspace.",
      source: { what: "Plan mode, the mode this session is in" },
      ruleStopsAsk: true,
    };
  }
  if (origin?.kind === "default") {
    return {
      reason:
        matchedPolicy?.tool === "*"
          ? `${toolName} is not in any permission list, and unlisted tools ask.`
          : `${toolName} asks by default, and no allow rule covers this call.`,
      source: { what: "the default permissions (no rule of yours matched)" },
      ruleStopsAsk: true,
    };
  }
  return {
    reason: "No allow rule covers this call, so it asks.",
    source: { what: "the permissions in force for this session" },
    ruleStopsAsk: true,
  };
}

/** Why this call asks, where that was decided, and the rule that would allow it. */
export function explainAsk(facts: AskFacts): AskWhy {
  const explained =
    (facts.verdict?.decision === "ask"
      ? engineExplains(facts.verdict)
      : undefined) ?? cliExplains(facts);
  return {
    ...explained,
    suggestion: suggestRuleForCall(facts.toolName, facts.args, facts.tool),
  };
}
