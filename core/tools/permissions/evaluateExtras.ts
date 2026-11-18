import type { BuiltinRuleId } from "./policy";
import { exemptedRules, type ExemptableRule } from "./builtinExemptions";
import { levelOfCall } from "./approval";
import { hostTrusted } from "./askProtections";
import { isPrivateFetchTarget } from "../../util/networkAddress";
import type { EvaluateInput, ToolPolicyResult } from "./evaluate";

/**
 * Two layers kept out of evaluate.ts, whose rule evaluation is at its
 * complexity limit: the exemption a person's own exact Always rule gives from
 * the command ask rules (ROADMAP B55, builtinExemptions.ts) and the allow for
 * a plain GET of a trusted host (ROADMAP B56).
 */

const commandOf = (input: EvaluateInput): string | undefined =>
  input.toolName === "run_terminal_command" &&
  typeof input.parsedArgs.command === "string"
    ? input.parsedArgs.command
    : undefined;

function exemptionOf(input: EvaluateInput) {
  const command = commandOf(input);
  return command === undefined
    ? undefined
    : exemptedRules(command, input.permissionSources, {
        shell: input.shell,
        cwd: input.cwd,
      });
}

/** The built-in rules this call is exempt from, read from the person's own exact Always rule. */
export function exemptionsFor(
  input: EvaluateInput,
): ReadonlySet<BuiltinRuleId> | undefined {
  const found = exemptionOf(input);
  return found ? new Set<BuiltinRuleId>(found.exempts) : undefined;
}

/** Name the exemption on a result that an Always rule settled, so it shows in the audit and the page. */
export function annotateExemptions(
  input: EvaluateInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  if (
    result.source !== "allow-rule" ||
    result.policy !== "allowedWithoutPermission"
  ) {
    return result;
  }
  const found = exemptionOf(input);
  if (!found) return result;
  const exempts: ExemptableRule[] = found.exempts;
  return {
    ...result,
    exempts,
    reason:
      `${result.reason ?? ""} It is exempt from ${exempts.join(", ")}, as your rule ${found.rule} names this exact command.`.trim(),
  };
}

/** The host of a plain https URL with no credentials, query, fragment or port, or undefined. */
export function plainHttpsHost(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    if (u.search || u.hash || u.port) return undefined;
    return u.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

/**
 * ROADMAP B56. At Automatic and Permissive a GET of a host in the person's own
 * trusted domains runs without the reviewer. The evaluator can prove the
 * method and the body because the tool has no argument for either: the call
 * must carry `url` and nothing else. It never applies to a URL with
 * credentials, a query, a fragment or a port, to a private address, or when
 * anything else (a rule, a protected hit, a refusal) already settled the call.
 * The tool itself stops a redirect that leaves the trusted domains
 * (fetchUrlContent.ts), so a trusted host cannot hand the call to another.
 */
export function trustedFetchAllow(
  input: EvaluateInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  const { tool, toolName, parsedArgs, trustedDomains } = input;
  if (!tool || toolName !== "fetch_url_content" || !trustedDomains?.length) {
    return result;
  }
  const open =
    result.policy === "allowedWithPermission" &&
    (result.source === undefined ||
      result.source === "tool-setting" ||
      result.source === "default");
  if (!open || Object.keys(parsedArgs).some((k) => k !== "url")) return result;
  const host = plainHttpsHost(parsedArgs.url);
  if (!host || !hostTrusted(host, trustedDomains)) return result;
  if (isPrivateFetchTarget(parsedArgs.url, input.processedArgs)) return result;
  const level = levelOfCall(input.approval, toolName, tool, {
    parsedArgs,
    cwd: input.cwd,
    shell: input.shell,
  })?.level;
  if (level !== "automatic" && level !== "permissive") return result;
  return {
    ...result,
    policy: "allowedWithoutPermission",
    source: "trusted-host",
    reason: `A plain GET of ${host}, which is in your trusted domains: no body, no query, and a redirect that leaves your trusted domains is refused.`,
  };
}
