import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ModelCatalogSettings } from "../modelCatalogStore.js";
import { GEO_PREFIX, nameMatchesModelId } from "./bedrockModelNames.js";

/**
 * The account's applied Bedrock quotas from Service Quotas (service code
 * `bedrock`, `ListServiceQuotas`), so a model whose tokens-per-minute quota
 * is 0 is named before the first request instead of after a refused one
 * (plans/research/provider-model-metadata.md, owner decision 1).
 *
 * Optional and advisory. It needs `servicequotas:ListServiceQuotas`, which
 * many Bedrock users do not have; a refusal is remembered per account and
 * region for a day (or until the credentials change) and shown as one quiet
 * line, never as an error. Throttling, a timeout, a network failure or a
 * region without Service Quotas are remembered for a shorter time. Nothing
 * here throws, and the chat request never waits for it.
 */

/** How long the whole lookup (every page) may take. */
export const QUOTA_LOOKUP_TIMEOUT_MS = 5_000;
/** At most this many pages of 100 quotas (Bedrock has a few thousand). */
export const QUOTA_MAX_PAGES = 60;
export const QUOTA_CACHE_SCHEMA_VERSION = 1;

/** Where the IAM permission is explained. */
export const QUOTA_DOCS_URL =
  "https://b1tninja.github.io/continuous/customize/model-providers/top-level/bedrock#optional-quota-check";

/** The Service Quotas console page for Bedrock in `region`. */
export function serviceQuotasConsoleUrl(region: string): string {
  return `https://console.aws.amazon.com/servicequotas/home/services/bedrock/quotas?region=${encodeURIComponent(region)}`;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long each kind of failure is remembered before the next try. */
export const QUOTA_RETRY_AFTER_MS: Record<QuotaFailureKind, number> = {
  denied: DAY_MS,
  "region-unavailable": DAY_MS,
  throttled: 15 * 60 * 1000,
  timeout: HOUR_MS,
  network: HOUR_MS,
  error: HOUR_MS,
};

/** Which inference route a quota limits. */
export type QuotaRoute = "on-demand" | "cross-region" | "global";
export type QuotaMetric = "tokens" | "requests";

/** One per-minute inference quota, as kept in the cache. */
export interface BedrockInferenceQuota {
  /** The quota name as Service Quotas gives it */
  name: string;
  code?: string;
  value: number;
  route: QuotaRoute;
  metric: QuotaMetric;
  /** The model part of the name: "Anthropic Claude Sonnet 4.5 V1" */
  model: string;
}

/** The fields of a Service Quotas `ServiceQuota` this module reads. */
export interface RawServiceQuota {
  QuotaName?: string;
  QuotaCode?: string;
  Value?: number;
}

export type QuotaFailureKind =
  | "denied"
  | "throttled"
  | "timeout"
  | "network"
  | "region-unavailable"
  | "error";

const QUOTA_NAME =
  /^\s*(global cross-region|cross-region|on-demand)\s+(?:model inference|invokemodel)\s+(tokens|requests)\s+per\s+minute\s+for\s+(.+?)\s*$/i;

/**
 * The route, metric and model of an inference quota name, or undefined for
 * every other Bedrock quota (per day, batch, latency-optimized, provisioned,
 * knowledge bases, ...). Names are prose, such as "Cross-region model
 * inference tokens per minute for Anthropic Claude Sonnet 4.5 V1".
 */
export function parseQuotaName(
  name: string,
): { route: QuotaRoute; metric: QuotaMetric; model: string } | undefined {
  const m = QUOTA_NAME.exec(name);
  if (!m) return undefined;
  const route = m[1].toLowerCase();
  return {
    route:
      route === "global cross-region"
        ? "global"
        : route === "cross-region"
          ? "cross-region"
          : "on-demand",
    metric: m[2].toLowerCase() === "tokens" ? "tokens" : "requests",
    model: m[3],
  };
}

/** Keep only the per-minute inference quotas, with a numeric value. */
export function inferenceQuotas(
  raw: RawServiceQuota[],
): BedrockInferenceQuota[] {
  const out: BedrockInferenceQuota[] = [];
  for (const q of raw) {
    if (typeof q.QuotaName !== "string") continue;
    if (typeof q.Value !== "number" || !Number.isFinite(q.Value)) continue;
    const parsed = parseQuotaName(q.QuotaName);
    if (!parsed) continue;
    out.push({
      name: q.QuotaName,
      ...(q.QuotaCode ? { code: q.QuotaCode } : {}),
      value: q.Value,
      ...parsed,
    });
  }
  return out;
}

/**
 * The route a request to `effectiveModelId` (after `crossRegionInference`
 * is applied) uses, which decides the quota that limits it.
 */
export function quotaRouteOf(effectiveModelId: string): QuotaRoute {
  if (/^global\./i.test(effectiveModelId)) return "global";
  if (GEO_PREFIX.test(effectiveModelId)) return "cross-region";
  return "on-demand";
}

/** The quotas that limit requests to `effectiveModelId` on its route. */
export function quotasForModel(
  quotas: BedrockInferenceQuota[],
  effectiveModelId: string,
): BedrockInferenceQuota[] {
  const route = quotaRouteOf(effectiveModelId);
  return quotas.filter(
    (q) => q.route === route && nameMatchesModelId(q.model, effectiveModelId),
  );
}

/**
 * The warning to show before the first request when the account's quota for
 * this model and route is 0, or undefined. Tokens per minute is named first:
 * it is the one AWS sets to 0 for a model it has not enabled for the account.
 */
export function zeroQuotaWarning(
  quotas: BedrockInferenceQuota[],
  effectiveModelId: string,
  region: string,
  displayName = effectiveModelId,
): string | undefined {
  const mine = quotasForModel(quotas, effectiveModelId);
  const zero =
    mine.find((q) => q.metric === "tokens" && q.value === 0) ??
    mine.find((q) => q.metric === "requests" && q.value === 0);
  if (!zero) return undefined;
  const what =
    zero.metric === "tokens" ? "tokens-per-minute" : "requests-per-minute";
  return `${displayName} has a 0 ${what} quota in ${region} for this account; request an increase in Service Quotas: ${serviceQuotasConsoleUrl(region)}`;
}

// ---------------------------------------------------------------------------
// Errors

/**
 * What kind of failure a Service Quotas error is. `credentials` means no
 * credentials could be loaded at all: the Bedrock listing reports that, so
 * the quota check says nothing and remembers nothing.
 */
export function classifyQuotaError(
  error: unknown,
): QuotaFailureKind | "credentials" {
  const e = error as
    | {
        name?: string;
        code?: string;
        message?: string;
        $metadata?: { httpStatusCode?: number };
      }
    | undefined;
  const text = `${e?.name ?? ""} ${e?.code ?? ""} ${e?.message ?? ""}`;
  const status = e?.$metadata?.httpStatusCode;
  if (
    /CredentialsProviderError|Could not load credentials|Missing credentials|ExpiredToken|token included in the request is expired|sso/i.test(
      text,
    ) &&
    !/AccessDenied/i.test(text)
  ) {
    return "credentials";
  }
  if (
    /AccessDenied|UnauthorizedOperation|not authorized to perform|DependencyAccessDenied|servicequotas:ListServiceQuotas/i.test(
      text,
    ) ||
    status === 403
  ) {
    return "denied";
  }
  if (
    /TooManyRequests|Throttl|Rate exceeded|SlowDown/i.test(text) ||
    status === 429
  ) {
    return "throttled";
  }
  if (/AbortError|TimeoutError|timed out|aborted|ETIMEDOUT/i.test(text)) {
    return "timeout";
  }
  if (
    /UnknownEndpoint|Could not resolve endpoint|not supported in (this|the) region|InvalidRegion|NoSuchResource|UnrecognizedClient|Region .* is not (supported|available)/i.test(
      text,
    )
  ) {
    return "region-unavailable";
  }
  if (
    /ENOTFOUND|getaddrinfo|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|certificate|self.signed|proxy/i.test(
      text,
    )
  ) {
    return "network";
  }
  return "error";
}

/** The one quiet line shown for a skipped check. */
export function quotaSkipNote(kind: QuotaFailureKind, region: string): string {
  switch (kind) {
    case "denied":
      return "Quota check skipped: this profile lacks servicequotas:ListServiceQuotas";
    case "throttled":
      return "Quota check skipped: Service Quotas is throttling requests; it will be tried again later";
    case "timeout":
      return `Quota check skipped: Service Quotas did not answer within ${QUOTA_LOOKUP_TIMEOUT_MS / 1000} seconds`;
    case "network":
      return `Quota check skipped: Service Quotas in ${region} could not be reached`;
    case "region-unavailable":
      return `Quota check skipped: Service Quotas is not available in ${region}`;
    default:
      return "Quota check skipped: Service Quotas did not answer";
  }
}

export const API_KEY_QUOTA_NOTE =
  "Quota check skipped: a Bedrock API key cannot read Service Quotas (that needs AWS credentials with servicequotas:ListServiceQuotas)";

// ---------------------------------------------------------------------------
// Cache

interface QuotaFailureRecord {
  kind: QuotaFailureKind;
  /** ISO time of the failure */
  at: string;
  /** A hash of the access key used, so new credentials try again at once */
  credentials?: string;
}

interface QuotaCacheFile {
  schemaVersion: number;
  key: string;
  region: string;
  fetchedAt?: string;
  quotas?: BedrockInferenceQuota[];
  failure?: QuotaFailureRecord;
}

/** A short hash of a credential identifier; never the identifier itself. */
export function credentialFingerprint(
  accessKeyId: string | undefined,
): string | undefined {
  return accessKeyId
    ? createHash("sha256").update(accessKeyId).digest("hex").slice(0, 16)
    : undefined;
}

export function quotaCacheFile(dir: string, key: string): string {
  return path.join(
    dir,
    `bedrock-quotas-${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`,
  );
}

function readQuotaCache(file: string, key: string): QuotaCacheFile | undefined {
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as QuotaCacheFile;
    if (
      parsed?.schemaVersion !== QUOTA_CACHE_SCHEMA_VERSION ||
      parsed.key !== key
    ) {
      return undefined;
    }
    if (parsed.quotas && !Array.isArray(parsed.quotas)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Through a temporary file, so a reader never sees half a file. Best effort. */
function writeQuotaCache(file: string, entry: QuotaCacheFile): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(entry), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
  }
}

// ---------------------------------------------------------------------------
// The check

/** What started the check, which decides what it may do under the setting. */
export type QuotaCheckTrigger =
  "test-connection" | "model-selected" | "background";

export interface BedrockQuotaReport {
  /**
   * `ok`: quotas are known (fresh, or from the cache). `skipped`: not
   * checked, with `note` saying why when the person should know. `off`:
   * model information updates are off, nothing was requested.
   */
  status: "ok" | "skipped" | "off";
  region: string;
  quotas?: BedrockInferenceQuota[];
  /** ISO date the quotas were read from Service Quotas */
  fetchedAt?: string;
  /** True when no request was made this time */
  fromCache?: boolean;
  /** One quiet line for a skipped check, with `docsUrl` to explain it */
  note?: string;
  docsUrl?: string;
  failure?: QuotaFailureKind;
}

export interface QuotaCheckOptions {
  /** The account and region, as `bedrockCatalogCacheKey` makes it */
  key: string;
  region: string;
  trigger: QuotaCheckTrigger;
  settings: ModelCatalogSettings;
  /** The folder the cache file goes in (`model-catalog/`) */
  dir: string;
  /** Signed with a Bedrock API key: Service Quotas cannot be asked */
  apiKey?: boolean;
  /** A fingerprint of the credentials, resolved without a network call where possible */
  credentials?: () => Promise<string | undefined>;
  /** One page of ListServiceQuotas for service code `bedrock` */
  listPage: (
    nextToken: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ Quotas?: RawServiceQuota[]; NextToken?: string }>;
  now?: () => number;
  timeoutMs?: number;
}

function isFresh(
  fetchedAt: string | undefined,
  hours: number,
  now: number,
): boolean {
  const t = fetchedAt ? Date.parse(fetchedAt) : NaN;
  return Number.isFinite(t) && t <= now && now - t < hours * HOUR_MS;
}

function fromCacheReport(
  region: string,
  cached: QuotaCacheFile | undefined,
  extra: Partial<BedrockQuotaReport> = {},
): BedrockQuotaReport {
  return cached?.quotas
    ? {
        status: "ok",
        region,
        quotas: cached.quotas,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        ...extra,
      }
    : { status: "skipped", region, fromCache: true, ...extra };
}

function failureReport(
  region: string,
  cached: QuotaCacheFile | undefined,
  kind: QuotaFailureKind,
): BedrockQuotaReport {
  return {
    ...fromCacheReport(region, cached),
    note: quotaSkipNote(kind, region),
    docsUrl: QUOTA_DOCS_URL,
    failure: kind,
  };
}

/**
 * Read the account's per-minute inference quotas for Bedrock, through the
 * cache. Never throws and never takes longer than the timeout.
 *
 * - Model information updates `off`: nothing is requested and nothing cached
 *   is used.
 * - A refusal (no `servicequotas:ListServiceQuotas`) is remembered for a
 *   day, or until the credentials change, also across Test connection.
 * - Test connection asks again unless refused; a selected model and the
 *   background refresh use a copy younger than the refresh interval, and a
 *   selected model asks only under `automatic`.
 */
export async function checkBedrockQuotas(
  opts: QuotaCheckOptions,
): Promise<BedrockQuotaReport> {
  const { region } = opts;
  if (opts.settings.policy === "off") return { status: "off", region };
  if (opts.apiKey) {
    return {
      status: "skipped",
      region,
      note: API_KEY_QUOTA_NOTE,
      docsUrl: QUOTA_DOCS_URL,
    };
  }
  const now = opts.now?.() ?? Date.now();
  const file = quotaCacheFile(opts.dir, opts.key);
  const cached = readQuotaCache(file, opts.key);

  let credentials: string | undefined;
  try {
    credentials = await opts.credentials?.();
  } catch {
    // No credentials: the Bedrock listing says so; nothing to add here
    return fromCacheReport(region, cached);
  }

  const failure = cached?.failure;
  if (failure) {
    const at = Date.parse(failure.at);
    const waiting =
      Number.isFinite(at) &&
      at <= now &&
      now - at < QUOTA_RETRY_AFTER_MS[failure.kind];
    const sameCredentials =
      !failure.credentials ||
      !credentials ||
      failure.credentials === credentials;
    // A refusal holds for Test connection too; other failures are retried
    // when the person asks.
    const holds =
      failure.kind === "denied"
        ? waiting && sameCredentials
        : waiting && opts.trigger !== "test-connection";
    if (holds) return failureReport(region, cached, failure.kind);
  }

  if (
    opts.trigger !== "test-connection" &&
    !failure &&
    cached?.quotas &&
    isFresh(cached.fetchedAt, opts.settings.refreshHours, now)
  ) {
    return fromCacheReport(region, cached);
  }
  if (
    opts.trigger === "model-selected" &&
    opts.settings.policy !== "automatic"
  ) {
    return fromCacheReport(region, cached);
  }

  const timeoutMs = opts.timeoutMs ?? QUOTA_LOOKUP_TIMEOUT_MS;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      const e = new Error("Service Quotas timed out");
      e.name = "TimeoutError";
      reject(e);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const raw: RawServiceQuota[] = [];
    const pages = (async () => {
      let nextToken: string | undefined;
      let page = 0;
      do {
        const answer = await opts.listPage(nextToken, abort.signal);
        raw.push(...(answer.Quotas ?? []));
        nextToken = answer.NextToken;
        page += 1;
      } while (nextToken && page < QUOTA_MAX_PAGES && !abort.signal.aborted);
    })();
    // A page still in flight when the timeout wins must not reject unheard
    pages.catch(() => {});
    timeout.catch(() => {});
    await Promise.race([pages, timeout]);
    const quotas = inferenceQuotas(raw);
    const fetchedAt = new Date(now).toISOString();
    writeQuotaCache(file, {
      schemaVersion: QUOTA_CACHE_SCHEMA_VERSION,
      key: opts.key,
      region,
      fetchedAt,
      quotas,
    });
    return { status: "ok", region, quotas, fetchedAt };
  } catch (e) {
    const kind = classifyQuotaError(e);
    if (kind === "credentials") return fromCacheReport(region, cached);
    writeQuotaCache(file, {
      schemaVersion: QUOTA_CACHE_SCHEMA_VERSION,
      key: opts.key,
      region,
      ...(cached?.quotas
        ? { quotas: cached.quotas, fetchedAt: cached.fetchedAt }
        : {}),
      failure: {
        kind,
        at: new Date(now).toISOString(),
        ...(credentials ? { credentials } : {}),
      },
    });
    return failureReport(region, cached, kind);
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
}
