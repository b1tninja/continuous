/**
 * The terminal agent's side of the opt-in debug prompt log
 * (`core/util/debugPromptLog.ts`): `--debug-prompt-log` turns it on for the
 * run, as `CONTINUOUS_DEBUG_PROMPT_LOG=1` does. Each request's messages are
 * written, scrubbed, to `<global folder>/logs/prompts/`, capped at 50 MB and
 * aged out after 14 days. Off by default; nothing is written then.
 */
import {
  appendDebugPrompt,
  DEBUG_PROMPT_LOG_ENV,
  debugPromptLogEnabled,
} from "core/util/debugPromptLog.js";

/** Turns the log on for this process when the flag was given. */
export function applyDebugPromptLogFlag(options: {
  debugPromptLog?: boolean;
}): void {
  if (options.debugPromptLog) process.env[DEBUG_PROMPT_LOG_ENV] = "1";
}

/** Records one request's messages when the log is on. */
export function logCliDebugPrompt(args: {
  sessionId?: string;
  model: string;
  messages: unknown;
}): void {
  if (!debugPromptLogEnabled()) return;
  appendDebugPrompt({
    sessionId: args.sessionId,
    model: args.model,
    prompt: JSON.stringify(args.messages, undefined, 1),
  });
}
