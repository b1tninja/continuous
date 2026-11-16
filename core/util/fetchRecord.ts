import { createHash, randomUUID } from "node:crypto";

import { getAuditTrail } from "../tools/permissions/audit/global";
import { maskText } from "../tools/permissions/audit/mask";

/**
 * One record per web request (plans/research/web-fetch-deep-dive.md, section
 * 7.8, row WB24): where it started, where it ended, what came back, and which
 * rule let it through. Records go to the session's fetch log (in memory, for
 * the Browser panel and `/web` to read), to the audit trail as one masked
 * line, and, for a page the model or the person reads, into the text itself
 * as one provenance line.
 */

/** Which path made the request. */
export type FetchPurpose =
  "tool" | "url" | "favicon" | "search" | "crawler" | "panel";

/**
 * Who chose the URL: the model (a tool call), the person (`@url`, a pasted
 * link), a page (a favicon link), or configuration (a search endpoint).
 */
export type FetchOrigin = "model" | "person" | "page" | "config";

/**
 * The `robots.txt` verdict. Always "not-checked" until the robots rows
 * (WB18 parser, WB20 tool check) land.
 */
// TODO(WB18/WB20): set from the robots check; the field and the provenance
// slot already exist so the record format does not change when it lands.
export type RobotsVerdict =
  "not-checked" | "allowed" | "disallowed" | "unreachable" | "skipped";

export type FetchOutcome = "fetched" | "http-error" | "refused" | "failed";

export interface FetchHop {
  url: string;
  status: number;
}

export interface FetchRecord {
  id: string;
  purpose: FetchPurpose;
  origin: FetchOrigin;
  startUrl: string;
  /** Where the returned response came from, after redirects */
  finalUrl: string;
  /** Every response, redirects first, the final one last */
  hops: FetchHop[];
  redirects: number;
  status?: number;
  contentType?: string;
  /** Bytes of body read (after content decoding), up to the cap */
  bytes: number;
  /** The body was longer than the cap and was cut */
  truncated: boolean;
  /** SHA-256 of the body bytes that were read */
  sha256?: string;
  /** UTC, ISO 8601, when the request started */
  fetchedAt: string;
  durationMs: number;
  robots: RobotsVerdict;
  /** The rule that let the request through, or refused it */
  rule: string;
  /** The final URL was plain http */
  unencrypted: boolean;
  outcome: FetchOutcome;
  /** Why it was refused or failed. Never a response body. */
  error?: string;
  /** The tool call that made the request */
  callId?: string;
  session?: string;
}

/**
 * A refusal by the fetch guard (a redirect to a non-public address, a
 * credential in a redirect, a content type that is not read), as opposed to a
 * network failure. The record calls it `refused`.
 */
export class FetchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefusedError";
  }
}

const MAX_ERROR_CHARS = 300;

/** Collects a record while a request runs. */
export class FetchRecorder {
  private readonly started = Date.now();
  private readonly hops: FetchHop[] = [];
  private finalUrl: string;
  private status?: number;
  private contentType?: string;
  rule: string;

  constructor(
    private readonly base: {
      purpose: FetchPurpose;
      origin: FetchOrigin;
      startUrl: URL;
      rule?: string;
      callId?: string;
      session?: string;
    },
  ) {
    this.finalUrl = base.startUrl.toString();
    this.rule = base.rule ?? "builtin";
  }

  hop(url: URL, status: number): void {
    this.hops.push({ url: url.toString(), status });
    this.finalUrl = url.toString();
  }

  response(status: number, contentType: string | null): void {
    this.status = status;
    this.contentType = contentType ?? undefined;
  }

  private build(
    outcome: FetchOutcome,
    body?: { data: Uint8Array; truncated: boolean },
    error?: string,
  ): FetchRecord {
    const final = this.finalUrl;
    return clean({
      id: randomUUID(),
      purpose: this.base.purpose,
      origin: this.base.origin,
      startUrl: this.base.startUrl.toString(),
      finalUrl: final,
      hops: [...this.hops],
      redirects: Math.max(0, this.hops.length - 1),
      status: this.status,
      contentType: this.contentType,
      bytes: body?.data.length ?? 0,
      truncated: body?.truncated ?? false,
      sha256: body ? sha256Hex(body.data) : undefined,
      fetchedAt: new Date(this.started).toISOString(),
      durationMs: Date.now() - this.started,
      robots: "not-checked" as const,
      rule: this.rule,
      unencrypted: final.startsWith("http:"),
      outcome,
      error: error?.slice(0, MAX_ERROR_CHARS),
      callId: this.base.callId,
      session: this.base.session,
    });
  }

  /** The request returned a response (any status). Logs and returns the record. */
  finish(body?: { data: Uint8Array; truncated: boolean }): FetchRecord {
    const ok = this.status !== undefined && this.status < 400;
    return logFetch(this.build(ok ? "fetched" : "http-error", body));
  }

  /** The request was refused or failed. Logs and returns the record. */
  fail(error: unknown): FetchRecord {
    const message = error instanceof Error ? error.message : String(error);
    const refused =
      error instanceof FetchRefusedError || /^Refused\b/.test(message);
    return logFetch(
      this.build(refused ? "refused" : "failed", undefined, message),
    );
  }
}

const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

const MAX_PROVENANCE_URL = 80;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The one line the model and the person see ahead of a fetched page, about
 * 40 tokens:
 *
 * `[fetched https://final.example/path · 200 text/html · 48 KiB ·
 * 2026-11-15T10:04:12Z · sha256:3f2a9c1b0d4e · robots: not checked ·
 * rule: builtin:public · via 1 redirect]`
 */
export function provenanceLine(record: FetchRecord): string {
  const type = (record.contentType ?? "").split(";")[0].trim();
  const parts = [
    // A credential-shaped value in a URL the person pasted is not repeated
    `fetched ${clip(maskText(record.finalUrl).text, MAX_PROVENANCE_URL)}`,
    [record.status ?? "-", type].filter(Boolean).join(" "),
    `${size(record.bytes)}${record.truncated ? " (cut at the cap)" : ""}`,
    record.fetchedAt.replace(/\.\d+Z$/, "Z"),
    record.sha256 ? `sha256:${record.sha256.slice(0, 12)}` : "",
    `robots: ${record.robots.replace("-", " ")}`,
    `rule: ${record.rule}`,
    record.redirects
      ? `via ${record.redirects} redirect${record.redirects === 1 ? "" : "s"}`
      : "",
    record.unencrypted ? "unencrypted" : "",
  ].filter(Boolean);
  return `[${parts.join(" · ")}]`;
}

/** The provenance line, a blank line, then the text. */
export function withProvenance(record: FetchRecord, text: string): string {
  return `${provenanceLine(record)}\n\n${text}`;
}

/** Matches a provenance line at the start of a text. */
export const PROVENANCE_LINE = /^\[fetched [^\n]*\]\n\n/;

const MAX_LOG_RECORDS = 500;

/**
 * The fetch log: every web request this process made, newest last, bounded.
 * A record carries the session of the tool call that made it when that is
 * known, so `list(session)` gives one session's fetches. Bodies are never
 * kept here; the record has the hash.
 */
export class FetchLog {
  private records: FetchRecord[] = [];

  add(record: FetchRecord): void {
    this.records.push(record);
    if (this.records.length > MAX_LOG_RECORDS) {
      this.records.splice(0, this.records.length - MAX_LOG_RECORDS);
    }
  }

  /** Newest first. With a session, only that session's records. */
  list(session?: string): FetchRecord[] {
    const all = session
      ? this.records.filter((r) => r.session === session)
      : this.records;
    return [...all].reverse();
  }

  get(id: string): FetchRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  clear(): void {
    this.records = [];
  }
}

let sharedLog = new FetchLog();

export function getFetchLog(): FetchLog {
  return sharedLog;
}

/** For tests */
export function resetFetchLogForTests(): void {
  sharedLog = new FetchLog();
}

/**
 * Put a record in the fetch log and write its audit line. Never throws: a
 * full disk must not fail the fetch.
 */
export function logFetch(record: FetchRecord): FetchRecord {
  let full = record;
  try {
    const trail = getAuditTrail();
    const session =
      record.session ??
      (record.callId ? trail.sessionOf(record.callId) : undefined);
    full = session ? { ...record, session } : record;
    trail.fetch(full);
  } catch {
    // the audit trail is best effort
  }
  getFetchLog().add(full);
  return full;
}
