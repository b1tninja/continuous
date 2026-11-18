/**
 * `continuous audit list|show <session>|changes|inbox|suggest|prune`: read the audit trail the
 * permission path writes (plans/reviewer-audit.md, P12d). The files are
 * `<global dir>/audit/<yyyy-mm>/<session>.jsonl`; this only reads them, and
 * `prune` deletes whole files past the retention.
 */

import {
  auditDir,
  auditSettings,
} from "core/tools/permissions/audit/global.js";
import {
  describeAgent,
  listInbox,
} from "core/tools/permissions/audit/inbox.js";
import { maskText } from "core/tools/permissions/audit/mask.js";
import {
  callRows,
  DECISION_FILTERS,
  listCalls,
  listChanges,
  matchesFilter,
  pruneAudit,
  readAuditSession,
  type AuditCallRow,
  type AuditFilter,
} from "core/tools/permissions/audit/reader.js";
import type { DecisionEvent } from "core/tools/permissions/audit/record.js";

import { auditShadowAction } from "./auditShadow.js";
import { auditSuggestCommand } from "./auditSuggest.js";

export interface AuditCommandOptions {
  json?: boolean;
  session?: string;
  decision?: string;
  tool?: string;
  agent?: string;
  since?: string;
  until?: string;
  days?: string | number;
  dryRun?: boolean;
  /** Where the audit files are; defaults to the global directory */
  dir?: string;
  limit?: string | number;
  /** suggest */
  min?: string | number;
  maxAgeDays?: string | number;
  maxMb?: string | number;
  maxRows?: string | number;
  verbose?: boolean;
  /** shadow: only this reviewer model */
  model?: string;
}

function out(line = ""): void {
  // The files are masked when written; this covers a record written by
  // anything else, or before masking knew a shape.
  process.stdout.write(`${maskText(line).text}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

function line(row: AuditCallRow): string {
  const who = row.reviewerModel ? `${row.by}:${row.reviewerModel}` : row.by;
  const ran =
    row.ran === undefined
      ? "-"
      : row.ran
        ? row.exit
          ? `exit ${row.exit}`
          : "ran"
        : "not run";
  return [
    row.ts.slice(0, 19).replace("T", " "),
    row.session.slice(0, 12).padEnd(12),
    row.policy.padEnd(5),
    clip(who, 28).padEnd(28),
    row.tool.padEnd(18),
    clip(row.agent?.role ?? row.agent?.kind ?? "-", 12).padEnd(12),
    ran.padEnd(8),
    clip(row.argsMasked.replace(/\s+/g, " "), 60),
  ].join("  ");
}

function parseDays(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function filterOf(options: AuditCommandOptions): AuditFilter | string {
  if (
    options.decision &&
    !(DECISION_FILTERS as readonly string[]).includes(options.decision)
  ) {
    return `--decision must be one of ${DECISION_FILTERS.join(", ")}.`;
  }
  for (const [flag, value] of [
    ["--since", options.since],
    ["--until", options.until],
  ] as const) {
    if (value && Number.isNaN(Date.parse(value))) {
      return `${flag} must be a date such as 2026-11-01.`;
    }
  }
  return {
    session: options.session,
    decision: options.decision,
    tool: options.tool,
    agent: options.agent,
    since: options.since,
    until: options.until,
  };
}

function decisionDetail(d: DecisionEvent): string {
  const usage = d.reviewer?.usage;
  return [
    `${d.policy} by ${d.by}`,
    d.source && `source ${d.source}`,
    d.rule && `rule ${d.rule}`,
    d.reviewer?.model && `model ${d.reviewer.model}`,
    d.reviewer?.latencyMs !== undefined && `${d.reviewer.latencyMs} ms`,
    usage && `tokens ${usage.input ?? "?"} in, ${usage.output ?? "?"} out`,
    d.reason && `"${d.reason}"`,
  ]
    .filter(Boolean)
    .join(", ");
}

function listAction(dir: string, options: AuditCommandOptions): number {
  const filter = filterOf(options);
  if (typeof filter === "string") {
    err(filter);
    return 2;
  }
  let rows = listCalls(dir, filter);
  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0) rows = rows.slice(-limit);
  if (options.json) {
    out(JSON.stringify(rows.map(({ decisions: _d, outcome: _o, ...r }) => r)));
    return 0;
  }
  if (rows.length === 0) {
    out("No audit records match.");
    return 0;
  }
  for (const row of rows) out(line(row));
  return 0;
}

function showAction(
  dir: string,
  session: string | undefined,
  options: AuditCommandOptions,
): number {
  if (!session) {
    err("Usage: continuous audit show <session>");
    return 2;
  }
  const filter = filterOf(options);
  if (typeof filter === "string") {
    err(filter);
    return 2;
  }
  const records = readAuditSession(dir, session);
  if (records.length === 0) {
    err(`No audit records for session ${session}.`);
    return 1;
  }
  if (options.json) {
    out(JSON.stringify(records));
    return 0;
  }
  for (const row of callRows(records).filter((r) => matchesFilter(r, filter))) {
    out(line(row));
    for (const d of row.decisions) out(`    ${decisionDetail(d)}`);
  }
  return 0;
}

/** The calls waiting for an answer, and which agent is waiting on each. */
/** Level, preset, floor, built-in, trust and rule changes, oldest first. */
function changesAction(dir: string, options: AuditCommandOptions): number {
  const filter = filterOf(options);
  if (typeof filter === "string") {
    err(filter);
    return 2;
  }
  let rows = listChanges(dir, { since: filter.since, until: filter.until });
  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0) rows = rows.slice(-limit);
  if (options.json) {
    out(JSON.stringify(rows));
    return 0;
  }
  if (rows.length === 0) {
    out("No setting changes recorded.");
    return 0;
  }
  for (const r of rows) {
    out(
      [
        r.ts.slice(0, 19).replace("T", " "),
        clip(r.source, 12).padEnd(12),
        clip(r.kind, 13).padEnd(13),
        r.loosens ? "loosens" : "       ",
        clip(r.summary.replace(/\s+/g, " "), 100),
      ].join("  "),
    );
  }
  return 0;
}

/** The calls waiting for an answer, and which agent is waiting on each. */
function inboxAction(dir: string, options: AuditCommandOptions): number {
  const filter = filterOf(options);
  if (typeof filter === "string") {
    err(filter);
    return 2;
  }
  const items = listInbox(dir, filter);
  if (options.json) {
    out(JSON.stringify(items));
    return 0;
  }
  if (items.length === 0) {
    out("Nothing is waiting for an answer.");
    return 0;
  }
  for (const item of items) {
    out(
      `${item.askedAt.slice(0, 19).replace("T", " ")}  ${describeAgent(item.agent)}  ${item.tool}  ${clip(item.summary, 60)}`,
    );
  }
  return 0;
}

function pruneAction(dir: string, options: AuditCommandOptions): number {
  const days = parseDays(options.days) ?? auditSettings().retentionDays;
  const result = pruneAudit(dir, {
    retentionDays: days,
    dryRun: options.dryRun,
  });
  if (options.json) {
    out(JSON.stringify(result));
    return 0;
  }
  out(
    `${options.dryRun ? "Would delete" : "Deleted"} ${result.deleted.length} audit file(s), ${result.bytes} bytes, older than ${days} days.`,
  );
  return 0;
}

/** Returns the process exit code. */
export function auditCommand(
  action: string | undefined,
  arg: string | undefined,
  options: AuditCommandOptions = {},
): number {
  const dir = options.dir ?? auditDir();
  switch (action ?? "list") {
    case "list":
      return listAction(dir, options);
    case "show":
      return showAction(dir, arg, options);
    case "changes":
      return changesAction(dir, options);
    case "inbox":
      return inboxAction(dir, options);
    case "prune":
      return pruneAction(dir, options);
    case "suggest":
      return auditSuggestCommand(options);
    case "shadow":
      return auditShadowAction(dir, options, out, err);
    default:
      err(
        `Unknown audit action '${action}'. Use list, show, changes, inbox, suggest, shadow or prune.`,
      );
      return 2;
  }
}
