import {
  IDGAF_OBJECTION_KEY,
  ruleKeyOf,
  type DayCounts,
} from "./auditIndexKeys";
import type { AuditIndex, IndexKey } from "./auditIndex";

/**
 * What the Permissions page shows from the audit index (ROADMAP B69): per rule
 * how often it asked and matched, a most-asked list, and a hint for rules with
 * no use. Read-only and masked: it is built from the index alone, never from
 * the trail, and nothing here changes a rule.
 */
export const USE_WINDOW_DAYS = 30;
export const UNUSED_WINDOW_DAYS = 90;
/** Answers needed, all the same, before an ask is offered in the overview */
export const MIN_SAME_ANSWERS = 3;
export const MOST_ASKED_LIMIT = 10;
/** Candidates the guards look at at most, so the page's cost has a bound */
export const GUARD_LOOKS = 200;

const DAY_MS = 86_400_000;

export interface RuleUse {
  /** Times a call asked because of this rule, in the last 30 days */
  asked: number;
  /** Times a call was decided by this rule (asks included), in the last 30 days */
  matched: number;
  last?: string;
  /**
   * No decision of this rule in the days the audit covers (up to 90): a hint
   * only, and only when the audit has history. Nothing is changed for it.
   */
  unused: boolean;
}

export interface MostAskedRow {
  /** The rule that would settle these asks, as the rule editor reads it */
  rule: string;
  /** The way the person answered every time */
  answer: "allow" | "deny";
  asks: number;
  answered: number;
  last: string;
}

export interface AuditOverview {
  /** "empty" when the audit has no history yet: no hint is claimed then */
  state: "ready" | "empty";
  /** Days from the first indexed event to now, at most 90 */
  coverageDays: number;
  /** The audit was not fully read yet, so counts may be low */
  partial: boolean;
  updatedAt?: string;
  rules: Record<string, RuleUse>;
  mostAsked: MostAskedRow[];
  /** Some rows were not checked in time and are left for the next open */
  guardsCut?: boolean;
  /**
   * Calls IDGAF ran in the last 30 days that a rule or guard would have
   * refused or asked about. Absent when there were none.
   */
  idgafObjections?: number;
}

function sumSince(key: IndexKey | undefined, from: string): DayCounts {
  const out: DayCounts = [0, 0, 0, 0, 0, 0];
  if (!key) return out;
  for (const [day, c] of Object.entries(key.days)) {
    if (day < from) continue;
    for (let i = 0; i < out.length; i++) out[i] += c[i];
  }
  return out;
}

const dayAt = (now: Date, days: number) =>
  new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);

/** The candidates before the guards: the top asks the person always answered the same way. */
export function mostAskedCandidates(
  index: AuditIndex,
  now: Date,
  limit = MOST_ASKED_LIMIT,
): MostAskedRow[] {
  const from = dayAt(now, USE_WINDOW_DAYS);
  const rows: MostAskedRow[] = [];
  for (const [rule, key] of Object.entries(index.calls)) {
    if (rule.startsWith("tool:")) continue;
    const c = sumSince(key, from);
    const [asks, , , allowed, denied] = c;
    const answered = allowed + denied;
    if (answered < MIN_SAME_ANSWERS || (allowed > 0 && denied > 0)) continue;
    rows.push({
      rule,
      answer: allowed > 0 ? "allow" : "deny",
      asks,
      answered,
      last: key.last,
    });
  }
  return rows
    .sort((a, b) => b.asks - a.asks || a.rule.localeCompare(b.rule))
    .slice(0, limit);
}

/**
 * The page's data from the index. `rules` are the rule texts on the page; the
 * answer holds an entry for each. `keepCandidate` filters the most-asked list
 * (the guards of `audit suggest`); without it nothing is filtered.
 */
export function buildOverview(
  index: AuditIndex | undefined,
  ruleTexts: readonly string[],
  now: Date = new Date(),
  keepCandidate: (row: MostAskedRow) => boolean = () => true,
): AuditOverview {
  if (!index?.since) {
    return {
      state: "empty",
      coverageDays: 0,
      partial: index ? !index.complete : true,
      updatedAt: index?.updatedAt,
      rules: {},
      mostAsked: [],
    };
  }
  const coverageDays = Math.min(
    UNUSED_WINDOW_DAYS,
    Math.max(1, Math.ceil((now.getTime() - Date.parse(index.since)) / DAY_MS)),
  );
  const from30 = dayAt(now, USE_WINDOW_DAYS);
  const from90 = dayAt(now, UNUSED_WINDOW_DAYS);
  const rules: Record<string, RuleUse> = {};
  for (const text of ruleTexts) {
    const key = index.rules[ruleKeyOf(text)];
    const month = sumSince(key, from30);
    const all = sumSince(key, from90);
    rules[text] = {
      asked: month[0],
      matched: month[0] + month[1] + month[2],
      ...(key ? { last: key.last } : {}),
      unused: all[0] + all[1] + all[2] === 0,
    };
  }
  // Walk the candidates in order, most asked first, until ten pass the guards
  const mostAsked: MostAskedRow[] = [];
  for (const row of mostAskedCandidates(index, now, GUARD_LOOKS)) {
    if (mostAsked.length >= MOST_ASKED_LIMIT) break;
    if (keepCandidate(row)) mostAsked.push(row);
  }
  const idgafObjections = sumSince(index.rules[IDGAF_OBJECTION_KEY], from30)[1];
  return {
    state: "ready",
    coverageDays,
    partial: !index.complete,
    updatedAt: index.updatedAt,
    rules,
    mostAsked,
    ...(idgafObjections > 0 ? { idgafObjections } : {}),
  };
}
