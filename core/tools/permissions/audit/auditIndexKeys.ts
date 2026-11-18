import { canonicalRuleName } from "../names";
import { suggestAllowRule } from "../suggest";
import { clipMasked, maskText } from "./mask";
import type { DecisionEvent } from "./record";

/**
 * What one decision event adds to the audit index (ROADMAP B75). Pure and
 * stateless, so the index can be built from appended bytes alone: nothing here
 * needs the lines before it.
 *
 * Two key spaces, both built from text that is already masked:
 * - `rules`: the rule text of a decision a rule made, as written in
 *   config.yaml (masked and clipped again here);
 * - `calls`: the narrowest allow rule for the call (the shape the rule editor
 *   would offer), or `tool:<name>` when there is none. A call with a masked
 *   value or cut-short arguments is never turned into a rule text.
 *
 * Raw arguments are never stored, only these keys.
 */
export const MAX_KEY_CHARS = 200;

/** Per day: asks, allows, denies, allowed by the person, denied by the person, decided by the reviewer. */
export type DayCounts = [number, number, number, number, number, number];

export const EMPTY_DAY = (): DayCounts => [0, 0, 0, 0, 0, 0];

export interface EventKeys {
  day: string;
  counts: DayCounts;
  ruleKey?: string;
  callKey?: string;
  /** What the call key adds: asks and the person's answers */
  callCounts?: DayCounts;
  /** IDGAF ran the call past a rule or guard that would have objected */
  idgafObjected?: boolean;
}

/**
 * The index key that counts calls IDGAF ran past an objection (in the
 * "allows" column). Not a rule text: no rule can be written this way.
 */
export const IDGAF_OBJECTION_KEY = "~idgaf:would-have-objected";

/** The index's own key for a rule text: masked and clipped, so lookups use the same form. */
export function ruleKeyOf(rule: string): string {
  return clipMasked(maskText(rule.trim()).text, MAX_KEY_CHARS);
}

function callKeyOf(ev: DecisionEvent, cache: Map<string, string>): string {
  const hit = cache.get(ev.argsHash);
  if (hit !== undefined) return hit;
  const tool = canonicalRuleName(ev.tool);
  let key = `tool:${tool}`;
  if (!ev.argsMasked.includes("«masked:") && !ev.argsMasked.endsWith("[cut]")) {
    try {
      const args = JSON.parse(ev.argsMasked);
      if (args && typeof args === "object") {
        const s = suggestAllowRule({ toolName: ev.tool, parsedArgs: args });
        if (s.ok && s.rule.length <= MAX_KEY_CHARS) key = s.rule;
      }
    } catch {
      // unreadable arguments: the tool name only
    }
  }
  if (cache.size > 5000) cache.clear();
  cache.set(ev.argsHash, key);
  return key;
}

/** The counts and keys of one decision event, or undefined for a line that is not one. */
export function keysOfEvent(
  ev: DecisionEvent,
  cache: Map<string, string>,
): EventKeys | undefined {
  const day = typeof ev.ts === "string" ? ev.ts.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const counts = EMPTY_DAY();
  if (ev.policy === "ask") counts[0] = 1;
  else if (ev.policy === "allow") counts[1] = 1;
  else if (ev.policy === "deny") counts[2] = 1;
  else return undefined;
  const callCounts = EMPTY_DAY();
  callCounts[0] = counts[0];
  if (ev.by === "person" && ev.policy !== "ask") {
    callCounts[ev.policy === "allow" ? 3 : 4] = 1;
  }
  if (ev.by === "reviewer") counts[5] = 1;
  const out: EventKeys = { day, counts };
  if (ev.wouldHave) out.idgafObjected = true;
  if (ev.rule && ev.by !== "person") out.ruleKey = ruleKeyOf(ev.rule);
  if (ev.policy === "ask" || ev.by === "person") {
    out.callKey = callKeyOf(ev, cache);
    out.callCounts = callCounts;
  }
  return out;
}
