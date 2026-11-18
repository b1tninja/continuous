import { callRows, listAuditFiles } from "./reader";
import type {
  AuditPolicy,
  AuditRecord,
  DecisionEvent,
  ShadowEvent,
} from "./record";
import { readAuditFile } from "./writer";

/**
 * The shadow report (ROADMAP B16): the agreement matrix of what actually
 * happened against what the reviewer would have decided, built only from audit
 * records, which are already masked. Pure over records; `readShadowRecords`
 * reads the directory.
 */
export const POLICIES: readonly AuditPolicy[] = ["allow", "ask", "deny"];

export interface ShadowDisagreement {
  session: string;
  callId: string;
  ts: string;
  tool: string;
  real: ShadowEvent["real"];
  shadow: ShadowEvent["shadow"];
  model?: string;
  /** The masked arguments of the call, from its decision record */
  argsMasked: string;
}

export interface ShadowModelRow {
  model: string;
  reviews: number;
  agreed: number;
  costUsd: number;
  /** Reviews whose request had no price */
  unpriced: number;
}

export interface ShadowReport {
  reviews: number;
  agreed: number;
  /** matrix[real][shadow] */
  matrix: Record<AuditPolicy, Record<AuditPolicy, number>>;
  /** The reviewer would have allowed what the real decision refused or asked */
  looser: number;
  /** The reviewer would have asked or refused what the real decision allowed */
  tighter: number;
  disagreements: ShadowDisagreement[];
  byModel: ShadowModelRow[];
  costUsd: number;
  unpriced: number;
}

const RANK: Record<AuditPolicy, number> = { allow: 0, ask: 1, deny: 2 };

export interface ShadowFilter {
  since?: string;
  until?: string;
  session?: string;
  model?: string;
}

function emptyMatrix(): ShadowReport["matrix"] {
  const row = () => ({ allow: 0, ask: 0, deny: 0 });
  return { allow: row(), ask: row(), deny: row() };
}

function inFilter(e: ShadowEvent, f: ShadowFilter): boolean {
  const t = Date.parse(e.ts);
  if (f.session && e.session !== f.session) return false;
  if (f.model && e.reviewer.model !== f.model) return false;
  if (f.since && t < Date.parse(f.since)) return false;
  if (f.until) {
    const end = /^\d{4}-\d{2}-\d{2}$/.test(f.until)
      ? Date.parse(f.until) + 24 * 3600 * 1000 - 1
      : Date.parse(f.until);
    if (t > end) return false;
  }
  return true;
}

/** Every record of the audit directory, grouped by session. */
export function readShadowRecords(dir: string): Map<string, AuditRecord[]> {
  const bySession = new Map<string, AuditRecord[]>();
  for (const file of listAuditFiles(dir)) {
    const list = bySession.get(file.session) ?? [];
    list.push(...readAuditFile(file.file));
    bySession.set(file.session, list);
  }
  return bySession;
}

/** USD already spent on shadow reviews in the retained trail. */
export function shadowSpend(dir: string): number {
  let total = 0;
  for (const records of readShadowRecords(dir).values()) {
    for (const r of records) {
      if (r.ev === "shadow" && typeof r.costUsd === "number") {
        total += r.costUsd;
      }
    }
  }
  return total;
}

/** Spend and review count in the retained trail: what a new spend ledger starts from. */
export function shadowSeed(dir: string): { usd: number; reviews: number } {
  let usd = 0;
  let reviews = 0;
  for (const records of readShadowRecords(dir).values()) {
    for (const r of records) {
      if (r.ev !== "shadow") continue;
      reviews++;
      if (typeof r.costUsd === "number") usd += r.costUsd;
    }
  }
  return { usd, reviews };
}

export function shadowReport(
  bySession: ReadonlyMap<string, readonly AuditRecord[]>,
  filter: ShadowFilter = {},
): ShadowReport {
  const report: ShadowReport = {
    reviews: 0,
    agreed: 0,
    matrix: emptyMatrix(),
    looser: 0,
    tighter: 0,
    disagreements: [],
    byModel: [],
    costUsd: 0,
    unpriced: 0,
  };
  const models = new Map<string, ShadowModelRow>();
  for (const records of bySession.values()) {
    const shadows = records.filter(
      (r): r is ShadowEvent => r.ev === "shadow" && inFilter(r, filter),
    );
    if (shadows.length === 0) continue;
    const rows = new Map(callRows(records).map((r) => [r.callId, r]));
    for (const e of shadows) {
      const model = e.reviewer.model ?? "unknown";
      const m = models.get(model) ?? {
        model,
        reviews: 0,
        agreed: 0,
        costUsd: 0,
        unpriced: 0,
      };
      models.set(model, m);
      report.reviews++;
      m.reviews++;
      report.matrix[e.real.policy][e.shadow.policy]++;
      if (typeof e.costUsd === "number") {
        report.costUsd += e.costUsd;
        m.costUsd += e.costUsd;
      } else {
        report.unpriced++;
        m.unpriced++;
      }
      if (e.real.policy === e.shadow.policy) {
        report.agreed++;
        m.agreed++;
        continue;
      }
      if (RANK[e.shadow.policy] < RANK[e.real.policy]) report.looser++;
      else report.tighter++;
      const row = rows.get(e.callId);
      const first: DecisionEvent | undefined = row?.decisions[0];
      report.disagreements.push({
        session: e.session,
        callId: e.callId,
        ts: e.ts,
        tool: e.tool,
        real: e.real,
        shadow: e.shadow,
        ...(e.reviewer.model ? { model: e.reviewer.model } : {}),
        argsMasked: first?.argsMasked ?? "(call record not found)",
      });
    }
  }
  report.byModel = [...models.values()].sort((a, b) => b.reviews - a.reviews);
  report.disagreements.sort((a, b) => a.ts.localeCompare(b.ts));
  return report;
}
