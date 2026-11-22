import type { ToolPolicyResult } from "core/tools/permissions/evaluate.js";
import type { ProtectedKind } from "core/tools/permissions/protected.js";
import { ruleSourcesOfLoadedConfig } from "core/tools/permissions/readRuleSources.js";
import type {
  RuleSource,
  ToolPermissions,
} from "core/tools/permissions/rules.js";

/** What the prompt names beside the engine's reason: the file or the check. */
export interface VerdictDetail {
  /** Whose file an ask rule is in, when it could be told */
  ruleOrigin?: RuleSource;
  /** Which kind of protected call asked (source "protected-path"); names the check */
  protection?: ProtectedKind;
}

/**
 * Whose file the ask rule that decided is in: the person's own config.yaml,
 * or the assistant's. Only looked up for an ask, which is when it is shown.
 */
function askRuleOrigin(
  permissions: ToolPermissions | undefined,
  result: ToolPolicyResult,
): RuleSource | undefined {
  if (result.source !== "ask-rule" || !result.rule || !permissions) {
    return undefined;
  }
  try {
    const bySource = ruleSourcesOfLoadedConfig(permissions);
    for (const [origin, perms] of Object.entries(bySource)) {
      if (perms?.ask?.some((raw: string) => raw.trim() === result.rule)) {
        return origin as RuleSource;
      }
    }
  } catch {
    // The prompt names the rule without its file
  }
  return undefined;
}

export function verdictDetail(
  permissions: ToolPermissions | undefined,
  result: ToolPolicyResult,
): VerdictDetail {
  const ruleOrigin = askRuleOrigin(permissions, result);
  return {
    ...(ruleOrigin ? { ruleOrigin } : {}),
    ...(result.protection ? { protection: result.protection } : {}),
  };
}
