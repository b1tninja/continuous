import { folderHasTrustRecord } from "core/config/projectTrust.js";
import {
  isTaintLabel,
  type TaintLabel,
} from "core/tools/permissions/taint/taintState.js";
import {
  noteToolResult,
  taintLabels,
  untaintSession,
} from "core/tools/permissions/taint/taintWiring.js";

import { CLI_SESSION_ID, toCoreCall } from "./coreRules.js";

/**
 * The CLI's side of the tainted-session rule (plans/design/tainted-session.md).
 * One CLI process is one session for the rule: the main agent and every
 * subagent it starts share this key, so taint reaches a subagent and comes
 * back without any copying. Everything here does nothing while the person's
 * `taintedSessionRule` is `off`, which is the default.
 */
const CLI_TAINT_SESSION = CLI_SESSION_ID;

/** A tool result has entered the conversation: mark the session when the call was a source. */
export function noteCliToolResult(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  mcpServer: string | undefined,
  cwd: string = process.cwd(),
): void {
  try {
    const core = toCoreCall(call.name, call.arguments);
    noteToolResult({
      session: CLI_TAINT_SESSION,
      callId: call.id,
      call: {
        toolName: core?.toolName ?? call.name,
        parsedArgs: core?.parsedArgs ?? call.arguments,
        mcp: !!mcpServer || !!core?.mcp,
        mcpServer,
        workspaceDirs: [cwd],
        folderTrusted: (dir: string) => folderHasTrustRecord(dir),
      },
    });
  } catch {
    // the taint is a guard; a failure to record it never fails the call
  }
}

/**
 * `/untaint`: the person has reviewed what came in. With no argument every
 * label is cleared; `/untaint mcp:github` (or any label the session holds)
 * clears that one and leaves the rest, so forgiving one server's output does
 * not forgive another's.
 */
export function handleUntaint(args: readonly string[] = []): {
  exit: false;
  output: string;
} {
  const named = args.map((a) => a.trim()).filter(Boolean);
  const held = taintLabels(CLI_TAINT_SESSION);
  if (held.length === 0) {
    return {
      exit: false,
      output:
        "Nothing to acknowledge: no untrusted content has been marked in this session.",
    };
  }
  const unknown = named.filter(
    (n) => !isTaintLabel(n) || !held.includes(n as TaintLabel),
  );
  if (unknown.length) {
    return {
      exit: false,
      output: `${unknown.join(", ")} is not marked in this session. Marked: ${held.join(", ")}. Use /untaint <label> for one, or /untaint for all.`,
    };
  }
  const cleared = untaintSession(
    CLI_TAINT_SESSION,
    "untaint-command",
    named.length ? `/untaint ${named.join(" ")}` : "/untaint",
    named.length ? (named as TaintLabel[]) : undefined,
  );
  const left = taintLabels(CLI_TAINT_SESSION);
  return {
    exit: false,
    output:
      `Acknowledged: untrusted content from ${cleared.join(", ")} no longer makes network, publish and credential calls ask.` +
      (left.length ? ` Still marked: ${left.join(", ")}.` : ""),
  };
}
