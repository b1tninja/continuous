import { maskText } from "./audit/mask";
import { maskAssignmentValues } from "./envMask";

/**
 * What a person is shown of a command or of a tool call's arguments, in an
 * approval card, a prompt, a title or a "try a call" result: the value of an
 * environment variable assignment is hidden when the variable is named like a
 * secret or the value has the shape of a credential (`maskAssignmentValues`),
 * and every other credential shape the shared masker knows is hidden too
 * (`maskText`). The variable NAME stays visible.
 *
 * Display only. The tool is always called with the real arguments; nothing
 * here may feed a rule, a decision, the clipboard of a copy for running, or
 * the call itself. Idempotent, and pure, so the GUI bundles it.
 */
export function maskCommandForDisplay(text: string): string {
  if (!text) return text;
  return maskText(maskAssignmentValues(text)).text;
}

const CACHE = new Map<string, string>();
const CACHE_MAX = 2000;

function cached(text: string): string {
  const hit = CACHE.get(text);
  if (hit !== undefined) return hit;
  const out = maskCommandForDisplay(text);
  if (text.length <= 20000) {
    if (CACHE.size >= CACHE_MAX) CACHE.clear();
    CACHE.set(text, out);
  }
  return out;
}

/**
 * A copy of a JSON-like value with every string run through
 * `maskCommandForDisplay`. The input is not changed.
 */
export function maskArgsForDisplay<T>(value: T): T {
  if (typeof value === "string") return cached(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => maskArgsForDisplay(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskArgsForDisplay(v);
    }
    return out as T;
  }
  return value;
}
