import type { ToolPermissionPolicy } from "./types.js";

/** Where one of the CLI's own policies was written, so a prompt can name it. */
export type PolicyOrigin =
  | { kind: "flag" }
  | { kind: "permissions-file"; file: string }
  | { kind: "default" }
  | { kind: "mode"; mode: "plan" | "auto" };

// Kept beside the policy, not on it: a policy is compared and copied as
// `{ tool, permission }` all over, and where it came from is not part of that.
const origins = new WeakMap<ToolPermissionPolicy, PolicyOrigin>();

export function markPolicyOrigin(
  policies: readonly ToolPermissionPolicy[],
  origin: PolicyOrigin,
): void {
  for (const policy of policies) origins.set(policy, origin);
}

/** Undefined for a policy built somewhere that does not record it (a copy, a runtime override). */
export function policyOriginOf(
  policy: ToolPermissionPolicy | undefined,
): PolicyOrigin | undefined {
  return policy ? origins.get(policy) : undefined;
}

/** The policy as it is written in a list: `Bash`, or `Bash(npm publish*)`. */
export function policyRuleText(policy: ToolPermissionPolicy): string {
  const pattern = Object.values(policy.argumentMatches ?? {})[0];
  return typeof pattern === "string" && pattern
    ? `${policy.tool}(${pattern})`
    : policy.tool;
}
