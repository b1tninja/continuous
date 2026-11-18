import { GlobalContext } from "core/util/GlobalContext.js";

/**
 * How the terminal UI shows the model's reasoning:
 * - `fold` (default): dimmed while the model thinks, then one line, "Thought
 *   for 4s", above the answer;
 * - `expanded`: the same, and the reasoning stays under that line;
 * - `hide`: not shown at all (it is still kept with the session).
 *
 * Set with `--thinking <mode>`, the `CONTINUE_CLI_THINKING` variable, or
 * `/thinking <mode>` in a session; without any, the shared **Keep Thinking
 * Expanded** setting (`ui.keepThinkingExpanded`, the IDE's) means `expanded`.
 */
export type ThinkingDisplay = "fold" | "expanded" | "hide";

export const THINKING_DISPLAYS: readonly ThinkingDisplay[] = [
  "fold",
  "expanded",
  "hide",
];

export function parseThinkingDisplay(
  value: string | undefined,
): ThinkingDisplay | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "show" || normalized === "collapsed") return "fold";
  if (normalized === "off" || normalized === "none") return "hide";
  return (THINKING_DISPLAYS as readonly string[]).includes(normalized)
    ? (normalized as ThinkingDisplay)
    : undefined;
}

function sharedKeepExpanded(): boolean {
  try {
    return (
      new GlobalContext().get("sharedConfig")?.keepThinkingExpanded === true
    );
  } catch {
    return false;
  }
}

let current: ThinkingDisplay | undefined;
const listeners = new Set<() => void>();

/**
 * Sets the mode for this process from the flag, else the variable, else the
 * shared setting. An unknown flag value is an error, so a typo is not
 * silently ignored; an unknown variable value is skipped.
 */
export function initThinkingDisplay(
  flag?: string,
  env: Record<string, string | undefined> = process.env,
): ThinkingDisplay {
  if (flag !== undefined && flag !== "") {
    const parsed = parseThinkingDisplay(flag);
    if (!parsed) {
      throw new Error(
        `--thinking: "${flag}" is not a thinking display; use ${THINKING_DISPLAYS.join(", ")}`,
      );
    }
    current = parsed;
    return parsed;
  }
  current =
    parseThinkingDisplay(env.CONTINUE_CLI_THINKING) ??
    (sharedKeepExpanded() ? "expanded" : "fold");
  return current;
}

export function getThinkingDisplay(): ThinkingDisplay {
  return current ?? "fold";
}

export function setThinkingDisplay(mode: ThinkingDisplay): void {
  if (mode === current) return;
  current = mode;
  for (const listener of listeners) listener();
}

export function subscribeThinkingDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
