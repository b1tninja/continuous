/**
 * Scrub-on-write for files the product persists (ROADMAP X15). Pure: no fs.
 *
 * `scrubForDisk` replaces every secret the shared rule set recognises with the
 * same `[REDACTED:<kind>:xxxx]` placeholder the outbound redactor uses, so a
 * file never holds a value this machine's rules know. `scrubDeep` does the same
 * for every string inside a JSON-shaped value, which keeps a JSON line valid
 * (a span is never cut across a quote or an escape).
 *
 * Best effort, like every pattern masker: a credential in a shape nobody listed
 * passes through, and a secret split across two separate writes is not seen.
 * Do not use it on a file that must round-trip (a session needed for resume).
 */
import { redact, scanText } from "./scan";
import type { ScanOptions, SecretProfile } from "./types";

export function scrubForDisk(
  text: string,
  profile: SecretProfile = "at-rest",
  options: ScanOptions = {},
): string {
  if (!text) return text;
  const found = scanText(text, profile, options);
  return found.length ? redact(text, found) : text;
}

/** `scrubForDisk` on every string in `value`; keys, numbers and shape are kept. */
export function scrubDeep<T>(
  value: T,
  profile: SecretProfile = "at-rest",
  options: ScanOptions = {},
): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return scrubForDisk(v, profile, options);
    if (depth > 40 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  return walk(value, 0) as T;
}

/**
 * `scrubDeep`, with the number of values it replaced (a `/export` reports
 * it, V13). The same rules and the same placeholders.
 */
export function scrubDeepCounted<T>(
  value: T,
  profile: SecretProfile = "at-rest",
  options: ScanOptions = {},
): { value: T; count: number } {
  let count = 0;
  const scrub = (text: string): string => {
    if (!text) return text;
    const found = scanText(text, profile, options);
    count += found.length;
    return found.length ? redact(text, found) : text;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return scrub(v);
    if (depth > 40 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  return { value: walk(value, 0) as T, count };
}
