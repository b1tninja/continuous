import type { BuiltinRuleId } from "core/tools/permissions/policy";

/**
 * What the shield shows. Absent follows the mode: off when any area is IDGAF,
 * on otherwise. An explicit value is the person's choice everywhere.
 */
export function safetyShieldOn(
  safetyChecks: boolean | undefined,
  anyAreaIdgaf: boolean,
): boolean {
  if (safetyChecks === true) return true;
  if (safetyChecks === false) return false;
  return !anyAreaIdgaf;
}

/** The built-in switch a blocked call's source turns off, when there is one. */
export function builtinForBlockedCall(item: {
  source: string;
  protection?: string;
}): BuiltinRuleId | undefined {
  switch (item.source) {
    case "secret-egress":
      return "protect-secrets";
    case "safety-floor":
      return "refuse-dangerous-commands";
    case "protected-path":
      return builtinForProtection(item.protection);
    default:
      return undefined;
  }
}

function builtinForProtection(
  kind: string | undefined,
): BuiltinRuleId | undefined {
  switch (kind) {
    case "secret":
    case "private-url":
      return "protect-secrets";
    case "config":
      return "protect-config";
    case "network":
      return "protect-network-paths";
    case "fetch-and-run":
      return "no-fetch-and-run";
    case "destructive-command":
      return "ask-destructive-commands";
    case "large-change":
      return "ask-large-change";
    case "dependency-change":
      return "ask-dependency-change";
    case "unknown-host":
      return "ask-unknown-host";
    case "file-deputy":
      return "ask-outside-paths";
    case "hidden-command":
    case "env-assignment":
      return "refuse-dangerous-commands";
    default:
      return undefined;
  }
}
