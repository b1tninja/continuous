import type { ToolPolicy } from "@continuedev/terminal-security";
import { allowReading } from "core/tools/permissions/rules.js";
import { resolveShell, type ShellKind } from "core/util/shell.js";

import { ALL_BUILT_IN_TOOLS } from "src/tools/allBuiltIns.js";

import {
  PermissionCheckResult,
  PermissionPolicy,
  ToolCallRequest,
  ToolPermissionPolicy,
  ToolPermissions,
} from "./types.js";

function wildcardRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexPattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexPattern}$`);
}

function readQuoted(
  command: string,
  start: number,
  quote: "'" | '"',
): { end: number; text: string; closed: boolean } {
  let text = "";
  for (let j = start; j < command.length; j++) {
    const c = command[j];
    text += c;
    if (c === "\\" && quote === '"' && j + 1 < command.length) {
      text += command[++j];
      continue;
    }
    if (c === quote) return { end: j, text, closed: true };
  }
  return { end: command.length, text, closed: false };
}

/** A command separator, or a redirect that an allow rule must not cover. */
function operatorSpan(
  command: string,
  i: number,
): { span: number; split: boolean; redirect: boolean } | undefined {
  const c = command[i];
  const next = command[i + 1];
  if (c === "\n" || c === ";") return { span: 1, split: true, redirect: false };
  if (c === "&" && next === "&")
    return { span: 2, split: true, redirect: false };
  if (c === "|" && (next === "|" || next === "&")) {
    return { span: 2, split: true, redirect: false };
  }
  if (c === "|") return { span: 1, split: true, redirect: false };
  if (c === "&") {
    const prev = command[i - 1];
    if (prev === ">" || prev === "<") return undefined;
    if (next === ">") return { span: 1, split: false, redirect: true };
    return { span: 1, split: true, redirect: false };
  }
  if (c === ">" || c === "<") {
    const dup = next === "&" && /[\d-]/.test(command[i + 2] ?? "");
    if (dup) return undefined;
    return { span: 1, split: false, redirect: true };
  }
  return undefined;
}

/**
 * Segments an allow rule may cover. Undefined when the text hides another
 * command: a separator the pattern's `*` would swallow, a substitution, or a
 * redirect. Ask and exclude rules do not use this; they match the whole text.
 */
function allowCommandSegments(command: string): string[] | undefined {
  if (/\$\(|`|<\(|>\(/.test(command) || /\$\{?IFS\b/.test(command)) {
    return undefined;
  }
  const parts: string[] = [];
  let cur = "";
  let redirect = false;
  let unparsable = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const quoted = readQuoted(command, i + 1, c);
      cur += c + quoted.text;
      i = quoted.end;
      if (!quoted.closed) unparsable = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= command.length) unparsable = true;
      else cur += command[i] + command[++i];
      continue;
    }
    const op = operatorSpan(command, i);
    if (!op) {
      cur += c;
      continue;
    }
    if (op.split) {
      const t = cur.trim();
      if (t) parts.push(t);
      cur = "";
    } else {
      cur += command.slice(i, i + op.span);
    }
    if (op.redirect) redirect = true;
    i += op.span - 1;
  }
  const tail = cur.trim();
  if (tail) parts.push(tail);
  if (unparsable || redirect || parts.length === 0) return undefined;
  return parts;
}

/** The command glob on an allow rule, from `Bash(git status*)` or `command:`. */
function allowCommandPattern(
  policy: ToolPermissionPolicy,
  toolName: string,
): string | undefined {
  const bash = /^Bash\((.+)\)$/.exec(policy.tool);
  if (bash) return bash[1];
  if (
    toolName === "Bash" &&
    typeof policy.argumentMatches?.command === "string"
  ) {
    return policy.argumentMatches.command;
  }
  return undefined;
}

/**
 * True when every simple command matches the prefix. A hidden command does
 * not, and neither does text the shell that runs it reads as other commands
 * than the segments here (core's `allowReading`): PowerShell and cmd do not
 * quote the way a POSIX shell does.
 */
export function allowCoversCommand(
  pattern: string,
  command: string,
  shell: ShellKind = resolveShell().kind,
): boolean {
  const segments = allowCommandSegments(command);
  if (!segments) return false;
  const reading = allowReading(command, shell);
  if (!reading.ok) return false;
  const regex = wildcardRegex(pattern);
  return [...segments, ...(reading.commands ?? [])].every((segment) =>
    regex.test(segment),
  );
}

/**
 * Checks if a tool name matches a pattern.
 * Supports wildcards (*) for pattern matching.
 * Also handles special Bash command patterns like "Bash(ls*)"
 */
export function matchesToolPattern(
  toolName: string,
  pattern: string,
  toolArguments?: Record<string, any>,
): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;

  // Handle special Bash command patterns like "Bash(ls*)"
  const bashCommandMatch = pattern.match(/^Bash\((.+)\)$/);
  if (bashCommandMatch) {
    // Check if this is a bash/terminal tool
    const isBashTool = toolName === "Bash";
    if (isBashTool && toolArguments?.command) {
      const commandPattern = bashCommandMatch[1];
      const command = toolArguments.command;

      // Handle command patterns with wildcards
      if (commandPattern.includes("*") || commandPattern.includes("?")) {
        return wildcardRegex(commandPattern).test(command);
      }

      // Exact command match
      return command === commandPattern;
    }
    return false;
  }

  // Handle regular wildcard patterns like "external_*"
  if (pattern.includes("*") || pattern.includes("?")) {
    // Escape all regex metacharacters except * and ?
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    // Convert * and ? to their regex equivalents
    const regexPattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(toolName);
  }

  return false;
}

/**
 * Checks if tool call arguments match the specified patterns.
 * Supports glob patterns with * and ? wildcards.
 */
export function matchesArguments(
  args: Record<string, any>,
  patterns?: Record<string, any>,
): boolean {
  if (!patterns) return true;

  for (const [key, pattern] of Object.entries(patterns)) {
    const argValue = args[key];

    if (pattern === "*") continue; // Wildcard matches anything

    // Handle glob patterns with wildcards (only for string patterns)
    if (
      typeof pattern === "string" &&
      (pattern.includes("*") || pattern.includes("?"))
    ) {
      // Convert argValue to string for pattern matching
      const stringValue = String(argValue ?? "");

      if (!wildcardRegex(pattern).test(stringValue)) {
        return false;
      }
    } else {
      // Exact match for non-glob patterns (preserve original behavior)
      if (argValue !== pattern) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Converts CLI's PermissionPolicy to core's ToolPolicy
 */
function permissionPolicyToToolPolicy(
  permission: PermissionPolicy,
): ToolPolicy {
  switch (permission) {
    case "allow":
      return "allowedWithoutPermission";
    case "ask":
      return "allowedWithPermission";
    case "exclude":
      return "disabled";
    default:
      return "allowedWithPermission";
  }
}

/**
 * Evaluates a tool call request against a set of permission policies.
 * Returns the permission for the first matching policy.
 */
export function checkToolPermission(
  toolCall: ToolCallRequest,
  permissions: ToolPermissions,
): PermissionCheckResult {
  const policies = permissions.policies;

  // First, get the base permission from static policies
  let basePermission: PermissionPolicy = "ask";
  let matchedPolicy = undefined;

  for (const policy of policies) {
    if (
      matchesToolPattern(toolCall.name, policy.tool, toolCall.arguments) &&
      matchesArguments(toolCall.arguments, policy.argumentMatches)
    ) {
      // A prefix allow covers each simple command, not a compound line.
      if (policy.permission === "allow") {
        const pattern = allowCommandPattern(policy, toolCall.name);
        const command = toolCall.arguments?.command;
        if (
          pattern !== undefined &&
          typeof command === "string" &&
          !allowCoversCommand(pattern, command)
        ) {
          continue;
        }
      }
      basePermission = policy.permission;
      matchedPolicy = policy;
      break;
    }
  }

  // Check if tool has dynamic policy evaluation
  const tool = ALL_BUILT_IN_TOOLS.find((t) => t.name === toolCall.name);
  if (tool?.evaluateToolCallPolicy) {
    // Convert CLI permission to core policy
    const basePolicy = permissionPolicyToToolPolicy(basePermission);

    // Evaluate the dynamic policy
    const evaluatedPolicy = tool.evaluateToolCallPolicy(
      basePolicy,
      toolCall.arguments,
    );

    // If dynamic evaluation says disabled, that ALWAYS takes precedence
    if (evaluatedPolicy === "disabled") {
      return {
        permission: "exclude",
        matchedPolicy,
      };
    }

    // A matched allow stands. Prefix allows never match a compound command,
    // so this does not approve one the pattern did not cover.
    return {
      permission: basePermission,
      matchedPolicy,
    };
  }

  // No dynamic evaluation, return static result
  return {
    permission: basePermission,
    matchedPolicy,
  };
}
