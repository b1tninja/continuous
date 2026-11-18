/**
 * The local measured-facts file (ROADMAP PL8): what "Test connection" saw on
 * this person's own endpoints, one entry per (provider, host, model, API
 * surface). It lives in the user's global folder, owner-only, and is never
 * written into a repository.
 *
 * Privacy review of what an entry holds:
 *  - provider, model and API surface: names, no secrets;
 *  - host: the host NAME only, lower-cased. No port, scheme, path, query or
 *    user info (`endpointHost`), and the host runs through the audit trail's
 *    masking before it is kept, so a credential that sits in a host position
 *    is refused rather than stored. An internal host name can still reveal
 *    infrastructure, which is why the file is owner-only and local, and why
 *    recording can be turned off (`probes.record: false` in the user-level
 *    config.yaml, or `--no-record` on the CLI);
 *  - a short fingerprint of the response SHAPE (key names, never values);
 *  - counts and dates.
 * Never a key, a URL, a prompt, a reply or a tool argument.
 *
 * Evidence: one probe is k = 1, n = 1. Below the battery minimum
 * (ENABLE_TOOLS_MIN_N) the fact is level "declared", which the evidence floor
 * (actionAllowed) will not let enable tools or recovery, and which never
 * outranks a stronger surface fact. Counts accumulate while the fingerprint
 * stays the same; a changed fingerprint starts over, and an entry expires
 * after 30 days (shown as stale, never acted on).
 */
import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import { maskText } from "../tools/permissions/audit/mask.js";
import { getContinueGlobalPath } from "./paths.js";
import { ensurePrivateDir, writePrivate } from "./privateFiles.js";
import { sha256Hex } from "./secretScan/sha256.js";
import {
  ENABLE_TOOLS_MIN_N,
  type Fact,
  type MeasuredFacts,
} from "./surfaceFacts.js";

export const MEASURED_FACTS_FILE = "measured-facts.json";
export const MEASURED_TTL_DAYS = 30;
const MAX_ENTRIES = 200;

export type ProbeOutcome = "native" | "text" | "none";

export interface MeasuredEntry {
  provider: string;
  /** Host name only. */
  host: string;
  model: string;
  /** API surface, e.g. "openai-chat". */
  api: string;
  /** Hash of the response's key structure, never of its values. */
  fingerprint: string;
  /** The most common outcome, with k of n probes agreeing. */
  value: ProbeOutcome;
  k: number;
  n: number;
  outcomes: Record<ProbeOutcome, number>;
  /** Markup dialect of the last "text" outcome. */
  dialect?: string;
  firstSeen: string;
  /** YYYY-MM-DD of the last probe. */
  readOn: string;
  expires: string;
}

export interface MeasuredFile {
  schemaVersion: 1;
  entries: MeasuredEntry[];
}

export function measuredFactsPath(): string {
  return path.join(getContinueGlobalPath(), MEASURED_FACTS_FILE);
}

/**
 * The host name of an API base, or undefined when there is none or it looks
 * like it carries a secret. Port, scheme, path, query and user info are dropped.
 */
export function endpointHost(apiBase: string | undefined): string | undefined {
  if (!apiBase) return undefined;
  let host: string;
  try {
    host = new URL(apiBase.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host || maskText(host).text !== host) return undefined;
  return host;
}

/**
 * The reply's key structure: object keys (sorted) and value kinds, arrays by
 * their first element. The values themselves are never read.
 */
export function responseShape(data: unknown, depth = 6): string {
  if (data === null) return "null";
  if (Array.isArray(data)) {
    return depth <= 0 || data.length === 0
      ? "[]"
      : `[${responseShape(data[0], depth - 1)}]`;
  }
  if (typeof data === "object") {
    if (depth <= 0) return "{}";
    const o = data as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${k}:${responseShape(o[k], depth - 1)}`)
      .join(",")}}`;
  }
  return typeof data;
}

export function fingerprintOf(data: unknown): string {
  return sha256Hex(responseShape(data)).slice(0, 12);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Key {
  provider: string;
  host: string;
  model: string;
  api: string;
}

function sameKey(e: MeasuredEntry, q: Key): boolean {
  return (
    e.provider === q.provider &&
    e.host === q.host &&
    e.model === q.model &&
    e.api === q.api
  );
}

function isEntry(v: unknown): v is MeasuredEntry {
  const e = v as MeasuredEntry;
  return (
    !!e &&
    typeof e.provider === "string" &&
    typeof e.host === "string" &&
    typeof e.model === "string" &&
    typeof e.api === "string" &&
    typeof e.fingerprint === "string" &&
    ["native", "text", "none"].includes(e.value) &&
    Number.isInteger(e.k) &&
    Number.isInteger(e.n) &&
    typeof e.readOn === "string" &&
    typeof e.expires === "string" &&
    !!e.outcomes
  );
}

/** Entries of the file; empty when it is missing or unreadable. */
export function readMeasuredEntries(
  file = measuredFactsPath(),
): MeasuredEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MeasuredFile;
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** Whether recording is on: `probes.record: false` in the user-level config.yaml turns it off. */
export function recordingEnabled(
  configFile = path.join(getContinueGlobalPath(), "config.yaml"),
): boolean {
  try {
    if (!fs.existsSync(configFile)) return true;
    const parsed = YAML.parse(fs.readFileSync(configFile, "utf8")) as any;
    return parsed?.probes?.record !== false;
  } catch {
    return true;
  }
}

export interface ProbeRecordInput {
  provider: string;
  apiBase?: string;
  model: string;
  api: string;
  outcome: ProbeOutcome;
  dialect?: string;
  fingerprint: string;
  /** YYYY-MM-DD */
  now: string;
}

function majority(o: Record<ProbeOutcome, number>): [ProbeOutcome, number] {
  const order: ProbeOutcome[] = ["native", "text", "none"];
  let best: ProbeOutcome = "native";
  for (const k of order) if (o[k] > o[best]) best = k;
  return [best, o[best]];
}

/** The entry after one more probe; pure. */
export function withProbe(
  prev: MeasuredEntry | undefined,
  input: ProbeRecordInput,
  host: string,
): MeasuredEntry {
  const same = !!prev && prev.fingerprint === input.fingerprint;
  const outcomes: Record<ProbeOutcome, number> = {
    native: 0,
    text: 0,
    none: 0,
    ...(same ? prev.outcomes : {}),
  };
  outcomes[input.outcome] += 1;
  const [value, k] = majority(outcomes);
  const dialect =
    input.outcome === "text" ? input.dialect : same ? prev.dialect : undefined;
  return {
    provider: input.provider,
    host,
    model: input.model,
    api: input.api,
    fingerprint: input.fingerprint,
    value,
    k,
    n: outcomes.native + outcomes.text + outcomes.none,
    outcomes,
    ...(dialect ? { dialect } : {}),
    firstSeen: same ? prev.firstSeen : input.now,
    readOn: input.now,
    expires: addDays(input.now, MEASURED_TTL_DAYS),
  };
}

/**
 * Add one probe to the file. Returns the entry, or undefined when nothing was
 * written (no usable host, or the file could not be written). Never throws.
 */
export function recordProbe(
  input: ProbeRecordInput,
  file = measuredFactsPath(),
): MeasuredEntry | undefined {
  const host = endpointHost(input.apiBase);
  if (!host) return undefined;
  try {
    const entries = readMeasuredEntries(file);
    const key: Key = {
      provider: input.provider,
      host,
      model: input.model,
      api: input.api,
    };
    const prev = entries.find((e) => sameKey(e, key));
    const entry = withProbe(prev, input, host);
    const next = [...entries.filter((e) => e !== prev), entry]
      .sort((a, b) => a.readOn.localeCompare(b.readOn))
      .slice(-MAX_ENTRIES);
    const body: MeasuredFile = { schemaVersion: 1, entries: next };
    ensurePrivateDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    writePrivate(tmp, `${JSON.stringify(body, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return entry;
  } catch {
    return undefined;
  }
}

/** The entry for an exact endpoint, or undefined. */
export function findMeasured(
  q: { provider: string; apiBase?: string; model: string; api: string },
  file = measuredFactsPath(),
): MeasuredEntry | undefined {
  const host = endpointHost(q.apiBase);
  if (!host) return undefined;
  const key: Key = {
    provider: q.provider,
    host,
    model: q.model,
    api: q.api,
  };
  return readMeasuredEntries(file).find((e) => sameKey(e, key));
}

/**
 * The entry as resolver input (`ResolveInput.measured`). Level is "measured"
 * only from ENABLE_TOOLS_MIN_N probes on; fewer is "declared" (weak), which
 * the evidence floor and the resolver both treat as not enough to act on.
 */
export function measuredFactsOf(entry: MeasuredEntry): MeasuredFacts {
  const weak = entry.n < ENABLE_TOOLS_MIN_N;
  const fact: Fact<"toolsHonoured"> = {
    value: entry.value === "native",
    level: weak ? "declared" : "measured",
    source: "local probe (Test connection)",
    readOn: entry.readOn,
    k: entry.k,
    n: entry.n,
    clientPath: "openai-chat /chat/completions",
    expires: entry.expires,
    ...(weak
      ? {
          note: `${entry.n} probe${entry.n === 1 ? "" : "s"}: enabling anything needs k = n and n >= ${ENABLE_TOOLS_MIN_N}`,
        }
      : {}),
  };
  return { toolsHonoured: fact };
}

export type ProbeStatusKind = ProbeOutcome | "unknown";

export interface ProbeStatus {
  kind: ProbeStatusKind;
  n?: number;
  readOn?: string;
  stale?: boolean;
  dialect?: string;
}

/** What the health chip shows: the last local result for this endpoint. */
export function probeStatusFor(
  q: { provider: string; apiBase?: string; model: string; api?: string },
  now: string,
  file = measuredFactsPath(),
): ProbeStatus {
  const e = findMeasured({ ...q, api: q.api ?? "openai-chat" }, file);
  if (!e) return { kind: "unknown" };
  return {
    kind: e.value,
    n: e.n,
    readOn: e.readOn,
    ...(e.expires < now ? { stale: true } : {}),
    ...(e.dialect ? { dialect: e.dialect } : {}),
  };
}
