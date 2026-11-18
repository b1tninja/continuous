/**
 * `continuous hooks test <event>`: run the hooks that would fire for a sample
 * event and show what each one did, without running any tool. The hooks run
 * for real through the same runner as a session (same masking, same failure
 * rules), so a command hook executes. Project hooks run only when they are
 * trusted, exactly as in a session.
 */

import { loadHooksConfig } from "./hookConfig.js";
import { getMatchingGroupsForInput } from "./hookMatch.js";
import { getMatcherValue, runHooks } from "./hookRunner.js";
import { HOOK_EVENT_NAMES } from "./types.js";
import type {
  HookEventName,
  HookEventResult,
  HookHandler,
  HookInput,
  HooksConfig,
} from "./types.js";

export interface HooksTestOptions {
  event?: string;
  /** Tool name for a tool event; defaults to Bash. */
  tool?: string;
  /** MCP server for a tool event, to try a `mcp__<server>__<tool>` matcher. */
  server?: string;
  /** JSON object merged over the sample input. */
  input?: string;
}

const TOOL_EVENTS: HookEventName[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
];

/** The event-specific part of a sample input. */
function sampleFields(event: HookEventName): Record<string, unknown> {
  switch (event) {
    case "PreToolUse":
    case "PermissionRequest":
      return {
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
        tool_use_id: "toolu_test",
      };
    case "PostToolUse":
      return {
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
        tool_response: "hello",
        tool_use_id: "toolu_test",
      };
    case "PostToolUseFailure":
      return {
        tool_name: "Bash",
        tool_input: { command: "false" },
        tool_use_id: "toolu_test",
        error: "exit code 1",
      };
    case "UserPromptSubmit":
      return { prompt: "hello" };
    case "SessionStart":
      return { source: "startup" };
    case "SessionEnd":
      return { reason: "other" };
    case "Stop":
      return { stop_hook_active: false, last_assistant_message: "done" };
    case "Notification":
      return {
        message: "Approval needed",
        notification_type: "permission_prompt",
      };
    case "SubagentStart":
      return { agent_id: "agent_test", agent_type: "general-purpose" };
    case "SubagentStop":
      return {
        stop_hook_active: false,
        agent_id: "agent_test",
        agent_transcript_path: "",
        agent_type: "general-purpose",
      };
    case "PreCompact":
      return { trigger: "manual", custom_instructions: null };
    case "ConfigChange":
      return { source: "user_settings" };
    case "TeammateIdle":
      return { teammate_name: "test", team_name: "test" };
    case "TaskCompleted":
      return { task_id: "task_test", task_subject: "test" };
    case "WorktreeCreate":
      return { name: "test" };
    case "WorktreeRemove":
      return { worktree_path: "/tmp/worktree-test" };
  }
}

/**
 * The sample input: the common fields, the event's defaults, `--tool` and
 * `--server`, then whatever `--input` says on top. The event name cannot be
 * overridden.
 */
export function buildSampleInput(
  event: HookEventName,
  cwd: string,
  options: Pick<HooksTestOptions, "tool" | "server" | "input">,
): HookInput {
  const extra = options.input ? JSON.parse(options.input) : {};
  if (extra === null || typeof extra !== "object" || Array.isArray(extra)) {
    throw new Error("--input must be a JSON object");
  }
  return {
    session_id: "hooks-test",
    transcript_path: "",
    cwd,
    permission_mode: "default",
    ...sampleFields(event),
    ...(options.tool ? { tool_name: options.tool } : {}),
    ...(options.server ? { server: options.server } : {}),
    ...extra,
    hook_event_name: event,
  } as HookInput;
}

function describeHandler(handler: HookHandler): string {
  switch (handler.type) {
    case "command":
      return `command: ${handler.command}`;
    case "http":
      return `http: ${handler.url}`;
    default:
      return `${handler.type} hook`;
  }
}

/** What the hooks decided, in a sentence. */
function describeDecision(result: HookEventResult): string {
  const parts: string[] = [];
  if (result.blocked) {
    parts.push(`block (${result.blockReason ?? "Blocked by hook"})`);
  } else if (result.permissionDecision) {
    parts.push(result.permissionDecision);
  } else {
    parts.push("none (the action would go ahead)");
  }
  if (result.projectAllowIgnored) {
    parts.push(
      'its "allow" is ignored: only your own hooks can approve a call',
    );
  }
  if (result.updatedInput) {
    parts.push(`rewrites the input to ${JSON.stringify(result.updatedInput)}`);
  }
  if (result.additionalContext) {
    parts.push(`adds context: ${result.additionalContext}`);
  }
  return parts.join("; ");
}

const out = (line = "") => process.stdout.write(`${line}\n`);

/** Runs one handler alone and prints its exit code, failure and decision. */
async function tryHandler(
  event: HookEventName,
  handler: HookHandler,
  input: HookInput,
  cwd: string,
): Promise<void> {
  // Alone and in the foreground, so each hook has its own result. The origin
  // mark stays, so a project hook is masked and cannot approve a call.
  const alone: HookHandler =
    handler.type === "command" ? { ...handler, async: false } : handler;
  const started = Date.now();
  const result = await runHooks({ [event]: [{ hooks: [alone] }] }, input, cwd);
  const outcome = result.results[0];
  const origin = handler.origin === "project" ? "project" : "your own";
  out(`    ${describeHandler(handler)} (${origin})`);
  if (outcome) {
    const exit =
      handler.type === "command" ? `exit ${outcome.exitCode}` : "done";
    const failed = outcome.failed ? `, failed: ${outcome.failureReason}` : "";
    out(`      ${exit}, ${Date.now() - started} ms${failed}`);
    const firstLine = outcome.stderr.split("\n")[0];
    if (firstLine) out(`      stderr: ${firstLine}`);
  }
  out(`      decision: ${describeDecision(result)}`);
}

/** Returns the process exit code: 0 when the hooks were tried, 1 on a usage error. */
export async function hooksTestCommand(
  options: HooksTestOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  const event = HOOK_EVENT_NAMES.find((name) => name === options.event);
  if (!event) {
    process.stderr.write(
      `Usage: continuous hooks test <event> [--tool <name>] [--server <name>] [--input <json>]\nEvents: ${HOOK_EVENT_NAMES.join(", ")}\n`,
    );
    return 1;
  }
  if ((options.tool || options.server) && !TOOL_EVENTS.includes(event)) {
    process.stderr.write("--tool and --server apply to tool events only.\n");
    return 1;
  }

  let input: HookInput;
  try {
    input = buildSampleInput(event, cwd, options);
  } catch (error) {
    const reason =
      error instanceof SyntaxError
        ? "--input is not valid JSON"
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`${reason}\n`);
    return 1;
  }

  const loaded = loadHooksConfig(cwd);
  const subject = getMatcherValue(input);
  out(
    `Trying ${event}${subject === undefined ? "" : ` for "${subject}"`}. No tool is run; the hooks that match do run.`,
  );
  if (loaded.disabled) {
    out("disableAllHooks is set: no hooks run.");
    return 0;
  }
  if (loaded.managedOnly) {
    out(
      "managedHooksOnly is set: this project's hooks are not read, trusted or not.",
    );
  }
  if (loaded.untrustedProject) {
    const n = loaded.untrustedProject.handlers.length;
    out(
      `${n} project hook${n === 1 ? " is" : "s are"} not trusted and did not run (see \`continuous hooks\`):`,
    );
    for (const line of loaded.untrustedProject.handlers) out(`  ${line}`);
  }

  const config: HooksConfig = loaded.hooks;
  const groups = config[event] ?? [];
  if (groups.length === 0) {
    out(`No hook is configured for ${event}.`);
    return 0;
  }
  const matching = new Set(
    getMatchingGroupsForInput(config, event, subject, input),
  );

  let ran = 0;
  for (const group of groups) {
    const label = group.matcher ? `matcher "${group.matcher}"` : "no matcher";
    if (!matching.has(group)) {
      out(`- ${label}: does not match`);
      continue;
    }
    out(`- ${label}: matches`);
    for (const handler of group.hooks) {
      await tryHandler(event, handler, input, cwd);
      ran += 1;
    }
  }
  if (ran === 0) out("No hook matched, so nothing ran.");
  return 0;
}
