/**
 * What goes into and comes out of a hook, apart from running it: the masking
 * of hook input, the failure setting and the size cap on added context.
 */

import { scrubDeep } from "core/util/secretScan/scrubForDisk.js";

import { MAX_ADDITIONAL_CONTEXT_CHARS } from "./types.js";
import type { HookHandler, HookInput } from "./types.js";

/**
 * Whether the input to this handler is masked first. The input holds
 * conversation content (prompts, tool arguments, tool output). A project's
 * hook script is trusted by its hash, but what it is sent is not the project's
 * to read, so a project hook gets it masked. An http hook sends it off the
 * machine and gets it masked whoever wrote it. The user's own command hooks
 * get the real values: they are the user's code, and a guard that checks a
 * command needs to see it as it is.
 */
export function inputIsMasked(handler: HookHandler): boolean {
  return handler.origin === "project" || handler.type === "http";
}

/**
 * The input with every secret the outbound rules know replaced by its
 * `[REDACTED:kind:xxxx]` placeholder. Best effort, like every pattern masker.
 * A masker that throws must not let the raw input through to a project hook,
 * so the failure is passed on and the hook then fails like any other.
 */
export function maskHookInput(input: HookInput): HookInput {
  return scrubDeep(input, "outbound");
}

/**
 * Whether a failed hook lets the action go ahead. `onError` is ours and
 * `onFailure` is Claude Code's spelling ("continue" or "block"). Only an
 * explicit "allow" or "continue" lets it through; anything else, including no
 * setting, blocks. When both are set, one "block" (or any value that is not
 * the permissive one) is enough.
 */
export function failureLetsActionThrough(handler: HookHandler): boolean {
  const onError = handler.onError;
  const onFailure = handler.onFailure;
  if (onError === undefined && onFailure === undefined) return false;
  const errorOk = onError === undefined || onError === "allow";
  const failureOk = onFailure === undefined || onFailure === "continue";
  return errorOk && failureOk;
}

/** The text cut to the cap, with a notice that it was. */
export function capAdditionalContext(
  text: string,
  max: number = MAX_ADDITIONAL_CONTEXT_CHARS,
): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[Hook context truncated: ${text.length} characters, limit ${max}]`;
}
