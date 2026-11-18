import { suggestAllowRule } from "../suggest";
import { clipMasked, maskDeep } from "./mask";
import {
  callRows,
  listAuditFiles,
  listCallsBounded,
  readCallRecordsBounded,
  type AuditCallRow,
  type ReadLimits,
} from "./reader";
import type { AuditAgent, DecisionEvent, OutcomeEvent } from "./record";

/**
 * The audit trail as the Permissions page reads it (ROADMAP UX14, O19, O20):
 * pages of calls, the inbox, and one call in full. All of it goes through the
 * bounded reader, so what a read costs is set by its limits, and every field
 * that leaves here is copied by name from a record that was masked when it was
 * written and then masked again. A raw record is never returned.
 */
export const LIST_PAGE_DEFAULT = 50;
/** The most rows one page ever carries, whatever the caller asks for */
export const LIST_PAGE_MAX = 100;
/** Inbox: asks older than this are hidden unless the caller asks for them */
export const INBOX_DEFAULT_MAX_AGE_HOURS = 24;
/**
 * An ask younger than this is not called "possibly from an ended session": a
 * person may still be reading it. No process or session heartbeat is written
 * anywhere, so an older ask whose session file has not been written since is
 * the closest thing to "ended" the record can say.
 */
export const INBOX_LIVE_WINDOW_MS = 10 * 60 * 1000;

const SUMMARY_CHARS = 160;
const FIELD_CHARS = 300;
const ARGS_CHARS = 2000;
const FACET_MAX = 50;

export interface ListedCall {
  session: string;
  callId: string;
  tool: string;
  ts: string;
  policy: "allow" | "ask" | "deny";
  by: "rules" | "reviewer" | "person" | "system";
  asked: boolean;
  /** The masked arguments on one line, clipped */
  summary: string;
  source?: string;
  rule?: string;
  reason?: string;
  reviewerModel?: string;
  agent?: AuditAgent;
  ran?: boolean;
  exit?: number;
  durMs?: number;
}

export interface ListedDecision {
  ts: string;
  policy: DecisionEvent["policy"];
  by: DecisionEvent["by"];
  source?: string;
  rule?: string;
  area?: string;
  level?: string;
  mode?: string;
  reason?: string;
  reviewerModel?: string;
  reviewerCategory?: string;
  jail?: string;
}

export interface CallDetail extends ListedCall {
  /** The full masked arguments (clipped at 2000 characters when written) */
  argsMasked: string;
  displayValue?: string;
  maskedKinds?: string[];
  decisions: ListedDecision[];
  outcome?: {
    ts: string;
    ran: boolean;
    exit?: number;
    durMs?: number;
    outBytes?: number;
    errSig?: string;
    changed?: string[];
  };
}

export interface AuditListRequest {
  /** allow, ask, deny or reviewer */
  decision?: string;
  tool?: string;
  /** An agent's role, id or kind; "main" also matches calls with no agent */
  agent?: string;
  /** ISO date or timestamp, inclusive */
  since?: string;
  /** Opaque; the `nextCursor` of the previous page */
  cursor?: string;
  limit?: number;
}

export interface AuditFacets {
  tools: string[];
  /** "main" and each distinct role (or kind, without a role) in what was read */
  agents: string[];
}

export interface AuditListResponse {
  rows: ListedCall[];
  nextCursor?: string;
  /** What cut the read short: the figures may be partial */
  partial?: "bytes" | "rows";
  facets: AuditFacets;
}

export interface InboxRequest {
  /** Show asks older than the default cut as well */
  includeOlder?: boolean;
  maxAgeHours?: number;
  agent?: string;
  cursor?: string;
  limit?: number;
}

export interface InboxEntry extends ListedCall {
  askedAt: string;
  ageMs: number;
  /** Older than the live window and its session has not written since: say so */
  possiblyEnded: boolean;
  /** A narrow rule for the call when one can be written without guessing */
  suggestedRule?: string;
}

export interface InboxResponse {
  items: InboxEntry[];
  nextCursor?: string;
  /** Open asks older than the cut that were left out */
  hiddenOlder: number;
  /** The age cut in force, in hours; absent when older asks are included */
  maxAgeHours?: number;
  partial?: "bytes" | "rows";
}

const oneLine = (text: string, max: number) =>
  clipMasked(text.replace(/\s+/g, " ").trim(), max);

/** Mask once more and clip: the second pass the page's data gets. */
function safe(text: string | undefined, max = FIELD_CHARS) {
  if (text === undefined) return undefined;
  return clipMasked(maskDeep(text), max);
}

function safeAgent(a: AuditAgent | undefined): AuditAgent | undefined {
  if (!a) return undefined;
  return maskDeep({
    id: a.id,
    kind: a.kind,
    ...(a.role ? { role: a.role } : {}),
    ...(a.mode ? { mode: a.mode } : {}),
    ...(a.parentId ? { parentId: a.parentId } : {}),
  });
}

function defined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

export function listedCall(row: AuditCallRow): ListedCall {
  return defined({
    session: row.session,
    callId: row.callId,
    tool: row.tool,
    ts: row.ts,
    policy: row.policy,
    by: row.by,
    asked: row.asked,
    summary: oneLine(
      safe(row.decisions[0]?.displayValue, SUMMARY_CHARS) ??
        maskDeep(row.argsMasked),
      SUMMARY_CHARS,
    ),
    source: row.source,
    rule: safe(row.rule),
    reason: safe(row.reason),
    reviewerModel: safe(row.reviewerModel, 80),
    agent: safeAgent(row.agent),
    ran: row.ran,
    exit: row.exit,
    durMs: row.durMs,
  });
}

function listedDecision(d: DecisionEvent): ListedDecision {
  return defined({
    ts: d.ts,
    policy: d.policy,
    by: d.by,
    source: d.source,
    rule: safe(d.rule),
    area: d.area,
    level: d.level,
    mode: d.mode,
    reason: safe(d.reason),
    reviewerModel: safe(d.reviewer?.model, 80),
    reviewerCategory: safe(d.reviewer?.category, 80),
    jail: safe(d.jail, 80),
  });
}

function listedOutcome(o: OutcomeEvent): NonNullable<CallDetail["outcome"]> {
  return defined({
    ts: o.ts,
    ran: o.ran,
    exit: o.exit,
    durMs: o.durMs,
    outBytes: o.outBytes,
    errSig: safe(o.errSig),
    changed: o.changed?.slice(0, 20).map((c) => safe(c.path, 200) as string),
  });
}

export function callDetail(row: AuditCallRow): CallDetail {
  const first = row.decisions[0];
  return defined({
    ...listedCall(row),
    argsMasked: clipMasked(maskDeep(row.argsMasked), ARGS_CHARS),
    displayValue: safe(first?.displayValue, 200),
    maskedKinds: first?.maskedKinds?.slice(0, 20),
    decisions: row.decisions.map(listedDecision),
    outcome: row.outcome ? listedOutcome(row.outcome) : undefined,
  });
}

const clampLimit = (n: number | undefined) =>
  Math.max(1, Math.min(LIST_PAGE_MAX, Math.floor(n ?? LIST_PAGE_DEFAULT) || 1));

const keyOf = (r: { ts: string; session: string; callId: string }) =>
  `${r.ts}\u0001${r.session}\u0001${r.callId}`;

/** Newest first, a total order, so a cursor names a place and not an offset. */
function newestFirst<T extends { ts: string; session: string; callId: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => keyOf(b).localeCompare(keyOf(a)));
}

function page<T extends { ts: string; session: string; callId: string }>(
  sorted: T[],
  cursor: string | undefined,
  limit: number,
  order: "newest" | "oldest",
): { rows: T[]; nextCursor?: string } {
  const after = cursor
    ? sorted.filter((r) =>
        order === "newest"
          ? keyOf(r).localeCompare(cursor) < 0
          : keyOf(r).localeCompare(cursor) > 0,
      )
    : sorted;
  const rows = after.slice(0, limit);
  const more = after.length > rows.length;
  return {
    rows,
    ...(more && rows.length
      ? { nextCursor: keyOf(rows[rows.length - 1]) }
      : {}),
  };
}

export function matchesAgent(
  row: Pick<AuditCallRow, "agent">,
  agent: string | undefined,
): boolean {
  if (!agent) return true;
  const a = row.agent;
  // A record from before agent identity existed is the main agent's
  if (agent === "main") return !a || a.kind === "main";
  return Boolean(a && (a.role === agent || a.id === agent || a.kind === agent));
}

function facetsOf(rows: readonly AuditCallRow[]): AuditFacets {
  const tools = new Set<string>();
  const agents = new Set<string>(["main"]);
  for (const r of rows) {
    tools.add(r.tool);
    if (r.agent && r.agent.kind !== "main") {
      agents.add(r.agent.role ?? r.agent.kind);
    }
  }
  return {
    tools: [...tools].sort().slice(0, FACET_MAX),
    agents: [...agents].sort().slice(0, FACET_MAX),
  };
}

/** One page of calls, newest first. */
export function auditListPage(
  dir: string,
  req: AuditListRequest = {},
  opts: { limits?: ReadLimits } = {},
): AuditListResponse {
  const { rows, stats } = listCallsBounded(
    dir,
    {
      ...(req.decision ? { decision: req.decision } : {}),
      ...(req.tool ? { tool: req.tool } : {}),
      ...(req.since ? { since: req.since } : {}),
    },
    opts.limits,
  );
  const sorted = newestFirst(rows.filter((r) => matchesAgent(r, req.agent)));
  const p = page(sorted, req.cursor, clampLimit(req.limit), "newest");
  return {
    rows: p.rows.map(listedCall),
    ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}),
    ...(stats.truncatedBy ? { partial: stats.truncatedBy } : {}),
    facets: facetsOf(rows),
  };
}

/**
 * A rule to start the editor from: the same narrow allow rule "Always allow"
 * would write, built from the masked arguments only when they parse and hold
 * nothing masked. Otherwise none, and the person writes it.
 */
export function suggestedRuleFor(
  tool: string,
  argsMasked: string,
): string | undefined {
  if (argsMasked.includes("«")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsMasked);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  try {
    const s = suggestAllowRule({
      toolName: tool,
      parsedArgs: parsed as Record<string, unknown>,
    });
    return s.ok ? s.rule : undefined;
  } catch {
    return undefined;
  }
}

/** Open asks: the last decision is an ask and the call has no outcome. Oldest first. */
export function auditInboxPage(
  dir: string,
  req: InboxRequest = {},
  opts: { limits?: ReadLimits; now?: Date } = {},
): InboxResponse {
  const now = (opts.now ?? new Date()).getTime();
  const { rows, stats } = listCallsBounded(dir, {}, opts.limits);
  const lastWrite = new Map<string, number>();
  for (const f of listAuditFiles(dir)) {
    lastWrite.set(
      f.session,
      Math.max(lastWrite.get(f.session) ?? 0, f.mtimeMs),
    );
  }
  const open = rows
    .filter((r) => r.policy === "ask" && r.outcome === undefined)
    .filter((r) => matchesAgent(r, req.agent));
  const hours = req.maxAgeHours ?? INBOX_DEFAULT_MAX_AGE_HOURS;
  const cut = req.includeOlder ? undefined : hours;
  const shown = open.filter(
    (r) => cut === undefined || now - Date.parse(r.ts) <= cut * 3_600_000,
  );
  const sorted = [...shown].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const p = page(sorted, req.cursor, clampLimit(req.limit), "oldest");
  const items = p.rows.map((r): InboxEntry => {
    const ageMs = Math.max(0, now - Date.parse(r.ts));
    const quiet = now - (lastWrite.get(r.session) ?? 0) > INBOX_LIVE_WINDOW_MS;
    const call = listedCall(r);
    return defined({
      ...call,
      askedAt: r.ts,
      ageMs,
      possiblyEnded: ageMs > INBOX_LIVE_WINDOW_MS && quiet,
      suggestedRule: suggestedRuleFor(r.tool, maskDeep(r.argsMasked)),
    });
  });
  return {
    items,
    ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}),
    hiddenOlder: open.length - shown.length,
    ...(cut !== undefined ? { maxAgeHours: cut } : {}),
    ...(stats.truncatedBy ? { partial: stats.truncatedBy } : {}),
  };
}

/** One call in full (masked), or undefined when it is not in what the bounded read sees. */
export function auditCallDetail(
  dir: string,
  ref: { session: string; callId: string },
  opts: { limits?: ReadLimits } = {},
): CallDetail | undefined {
  if (typeof ref?.session !== "string" || typeof ref.callId !== "string") {
    return undefined;
  }
  const { bySession } = readCallRecordsBounded(dir, opts.limits, ref.session);
  const records = bySession.get(ref.session) ?? [];
  const row = callRows(records).find((r) => r.callId === ref.callId);
  return row ? callDetail(row) : undefined;
}
