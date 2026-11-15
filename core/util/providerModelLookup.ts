/**
 * One model's facts from the provider the person configured, with their own
 * key: `GET {base}/models/{id}` on Anthropic's API or an OpenAI-compatible
 * one. Used by Test connection (to say whether the configured id exists and
 * what the provider reports for it) and by the background refresh of the
 * selected model (core/llm/providerModelInfoStore.ts).
 *
 * Every outcome is a value, never a throw: a key the provider refuses, an id
 * it does not know, a rate limit, a timeout and an endpoint without a models
 * API are told apart so the caller can say which. The facts are advisory and
 * nothing waits on them except the Test connection that asked.
 *
 * Pure apart from `fetchFn`, and imports nothing from Node: the add-model
 * form reads the types and the close-match helper.
 */

export type ModelInfoProvider = "anthropic" | "openai";

/** What the provider reported for one model; absent fields were not sent. */
export interface ProviderModelFacts {
  /** The id the provider answered with (a dated id for an alias). */
  id: string;
  displayName?: string;
  /** Anthropic `max_input_tokens`: the context window. */
  contextLength?: number;
  /** Anthropic `max_tokens`: the output cap. */
  maxOutputTokens?: number;
  /** Anthropic `lifecycle`: active, deprecated, retired. */
  lifecycle?: string;
  /** YYYY-MM-DD. */
  deprecatedAt?: string;
  /** YYYY-MM-DD; Anthropic `retires_at`, OpenAI `shutdown_date`. */
  retiresAt?: string;
  supportsImages?: boolean;
  supportsPdf?: boolean;
  /** Thinking types the model accepts (adaptive, enabled, ...); empty when none. */
  thinkingTypes?: string[];
}

export type ModelLookupFailure =
  "auth" | "rate-limited" | "network" | "timeout" | "unsupported" | "http";

export type ModelLookupResult =
  | { kind: "found"; facts: ProviderModelFacts }
  | { kind: "not-found"; suggestions: string[] }
  | {
      kind: "failed";
      reason: ModelLookupFailure;
      status?: number;
      /** Seconds, from `retry-after`, for a rate limit. */
      retryAfter?: number;
      detail?: string;
    };

export type LookupFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ModelLookupInput {
  provider: ModelInfoProvider;
  /** API base; the provider's own when empty. */
  apiBase?: string;
  apiKey?: string;
  model: string;
  /** Short by default: this is a side request. */
  timeoutMs?: number;
  fetchFn?: LookupFetch;
  /** The listing already fetched (Test connection), so no second listing is needed for suggestions. */
  listed?: string[];
  /** Extra headers the person configured for this provider (requestOptions.headers). */
  headers?: Record<string, string>;
}

export const MODEL_LOOKUP_TIMEOUT_MS = 8_000;
export const ANTHROPIC_MODELS_VERSION = "2026-10-21";
const ANTHROPIC_OLD_VERSION = "2023-06-01";

const DEFAULT_BASE: Record<ModelInfoProvider, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};

export function lookupBase(
  provider: ModelInfoProvider,
  apiBase?: string,
): string {
  return (apiBase?.trim() || DEFAULT_BASE[provider]).replace(/\/+$/, "");
}

function scrub(text: string, key?: string): string {
  let t = text.slice(0, 200);
  if (key) t = t.split(key).join("[key]");
  return t.replace(/\s+/g, " ").trim();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** An ISO date, or a Unix time in seconds, as YYYY-MM-DD. */
function day(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(v * 1000).toISOString().slice(0, 10);
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    return v.slice(0, 10);
  }
  return undefined;
}

function supported(node: unknown): boolean | undefined {
  const s = (node as { supported?: unknown } | undefined)?.supported;
  return typeof s === "boolean" ? s : undefined;
}

/** Anthropic's model object (the list item and `GET /v1/models/{id}` are the same shape). */
export function parseAnthropicModel(
  data: unknown,
): ProviderModelFacts | undefined {
  const m = data as Record<string, unknown> | undefined;
  const id = str(m?.id);
  if (!m || !id) return undefined;
  const caps = (m.capabilities ?? undefined) as
    Record<string, unknown> | undefined;
  const thinking = caps?.thinking as
    { types?: Record<string, unknown> } | undefined;
  const thinkingTypes =
    thinking?.types && typeof thinking.types === "object"
      ? Object.entries(thinking.types)
          .filter(([, v]) => supported(v) === true)
          .map(([k]) => k)
      : undefined;
  const facts: ProviderModelFacts = { id };
  const displayName = str(m.display_name);
  if (displayName) facts.displayName = displayName;
  const contextLength = positiveInt(m.max_input_tokens);
  if (contextLength) facts.contextLength = contextLength;
  const maxOutputTokens = positiveInt(m.max_tokens);
  if (maxOutputTokens) facts.maxOutputTokens = maxOutputTokens;
  const lifecycle = str(m.lifecycle);
  if (lifecycle) facts.lifecycle = lifecycle;
  const deprecatedAt = day(m.deprecated_at);
  if (deprecatedAt) facts.deprecatedAt = deprecatedAt;
  const retiresAt = day(m.retires_at);
  if (retiresAt) facts.retiresAt = retiresAt;
  const images = supported(caps?.image_input);
  if (images !== undefined) facts.supportsImages = images;
  const pdf = supported(caps?.pdf_input);
  if (pdf !== undefined) facts.supportsPdf = pdf;
  if (thinkingTypes) facts.thinkingTypes = thinkingTypes;
  return facts;
}

/** OpenAI's model object: an id, and `shutdown_date` when one is announced. */
export function parseOpenAIModel(
  data: unknown,
): ProviderModelFacts | undefined {
  const m = data as Record<string, unknown> | undefined;
  const id = str(m?.id);
  if (!m || !id) return undefined;
  const retiresAt = day(m.shutdown_date);
  return {
    id,
    ...(retiresAt ? { retiresAt, lifecycle: "deprecated" } : {}),
  };
}

function idsOf(data: unknown): string[] {
  const list = (data as { data?: unknown })?.data;
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string" && id !== "");
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      last = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Up to `limit` listed ids that look like what was typed: the same id with a
 * date or suffix added, one that contains it, or one within a few edits
 * (`claude-opus-55` -> `claude-opus-5-5`). Closest first.
 */
export function closeModelMatches(
  typed: string,
  candidates: readonly string[],
  limit = 3,
): string[] {
  const t = typed.trim().toLowerCase();
  if (!t) return [];
  const squash = (s: string) => s.replace(/[^a-z0-9]/g, "");
  const ts = squash(t);
  const scored: { id: string; score: number }[] = [];
  for (const id of new Set(candidates)) {
    const c = id.toLowerCase();
    if (c === t) continue;
    const d = editDistance(t, c);
    // Tier first (same id but for punctuation, a prefix either way, a
    // substring, a few edits), then the number of edits
    let tier: number;
    if (squash(c) === ts) tier = 0;
    else if (c.startsWith(t) || t.startsWith(c)) tier = 1;
    else if (c.includes(t) || t.includes(c)) tier = 2;
    else if (d <= Math.max(2, Math.floor(t.length * 0.3))) tier = 3;
    else continue;
    scored.push({ id, score: tier * 1000 + d });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((s) => s.id);
}

type Raw =
  | {
      ok: true;
      status: number;
      data: unknown;
    }
  | {
      ok: false;
      status: number;
      body: string;
      retryAfter?: number;
      error?: "network" | "timeout";
      detail?: string;
    };

async function get(
  input: ModelLookupInput,
  url: string,
  headers: Record<string, string>,
): Promise<Raw> {
  const fetchFn = input.fetchFn ?? (globalThis.fetch as unknown as LookupFetch);
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(),
    input.timeoutMs ?? MODEL_LOOKUP_TIMEOUT_MS,
  );
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json", ...input.headers, ...headers },
      signal: ctl.signal,
    });
    if (!res.ok) {
      const ra = Number(res.headers?.get?.("retry-after") ?? NaN);
      return {
        ok: false,
        status: res.status,
        body: await res.text().catch(() => ""),
        ...(Number.isFinite(ra) && ra >= 0 ? { retryAfter: ra } : {}),
      };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      // An HTML page from a proxy or a login portal: not a models API
      data = undefined;
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      body: "",
      error: aborted ? "timeout" : "network",
      detail: aborted
        ? undefined
        : scrub(e instanceof Error ? e.message : String(e), input.apiKey),
    };
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(
  input: ModelLookupInput,
  version: string,
): Record<string, string> {
  if (input.provider === "anthropic") {
    return {
      "x-api-key": input.apiKey ?? "",
      "anthropic-version": version,
    };
  }
  return input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {};
}

function failureOf(raw: Extract<Raw, { ok: false }>, key?: string) {
  if (raw.error) {
    return {
      kind: "failed" as const,
      reason: raw.error,
      ...(raw.detail ? { detail: raw.detail } : {}),
    };
  }
  const reason: ModelLookupFailure =
    raw.status === 401 || raw.status === 403
      ? "auth"
      : raw.status === 429
        ? "rate-limited"
        : raw.status === 405 || raw.status === 501
          ? "unsupported"
          : "http";
  const detail = scrub(raw.body, key);
  return {
    kind: "failed" as const,
    reason,
    status: raw.status,
    ...(raw.retryAfter === undefined ? {} : { retryAfter: raw.retryAfter }),
    ...(detail ? { detail } : {}),
  };
}

/** Look one model up; never throws. */
export async function lookupProviderModel(
  input: ModelLookupInput,
): Promise<ModelLookupResult> {
  const model = input.model.trim();
  if (!model) return { kind: "not-found", suggestions: [] };
  const base = lookupBase(input.provider, input.apiBase);
  const parse =
    input.provider === "anthropic" ? parseAnthropicModel : parseOpenAIModel;
  let version = ANTHROPIC_MODELS_VERSION;
  let raw = await get(
    input,
    `${base}/models/${encodeURIComponent(model)}`,
    authHeaders(input, version),
  );
  if (!raw.ok && raw.status === 400 && input.provider === "anthropic") {
    // A gateway that refuses the newer version: the older one has no
    // lifecycle fields but still answers whether the id exists
    version = ANTHROPIC_OLD_VERSION;
    raw = await get(
      input,
      `${base}/models/${encodeURIComponent(model)}`,
      authHeaders(input, version),
    );
  }
  if (raw.ok) {
    const facts = parse(raw.data);
    // A 200 that is not a model object (a proxy's page, a server that
    // answers every path with its list) says nothing about the id
    return facts
      ? { kind: "found", facts }
      : { kind: "failed", reason: "unsupported", status: raw.status };
  }
  if (raw.status !== 404) return failureOf(raw, input.apiKey);

  // 404: either no such model for this key, or no per-model route here.
  // The listing tells the two apart and gives the suggestions.
  let listed = input.listed;
  if (!listed) {
    const list = await get(
      input,
      `${base}/models${input.provider === "anthropic" ? "?limit=1000" : ""}`,
      authHeaders(input, version),
    );
    if (!list.ok) {
      return list.status === 404
        ? { kind: "failed", reason: "unsupported", status: 404 }
        : failureOf(list, input.apiKey);
    }
    listed = idsOf(list.data);
    if (listed.length === 0 && !Array.isArray((list.data as any)?.data)) {
      return { kind: "failed", reason: "unsupported", status: list.status };
    }
  }
  // A server that lists the id but has no per-model route, or an alias the
  // list shows only with its date
  const hit =
    listed.find((id) => id === model) ??
    (input.provider === "anthropic"
      ? listed.find((id) => id.startsWith(`${model}-`))
      : undefined);
  if (hit) return { kind: "found", facts: { id: hit } };
  return { kind: "not-found", suggestions: closeModelMatches(model, listed) };
}

const PROVIDER_LABEL: Record<ModelInfoProvider, string> = {
  anthropic: "Anthropic",
  openai: "The server",
};

/** One sentence for a lookup that did not find the model's facts. */
export function describeModelLookup(
  provider: ModelInfoProvider,
  model: string,
  result: Exclude<ModelLookupResult, { kind: "found" }>,
  opts: { isOpenAI?: boolean } = {},
): string {
  const who =
    provider === "openai" && opts.isOpenAI
      ? "OpenAI"
      : PROVIDER_LABEL[provider];
  if (result.kind === "not-found") {
    const tail = result.suggestions.length
      ? ` Did you mean ${result.suggestions.join(", ")}?`
      : "";
    return `${who} does not know a model "${model}" for this key (HTTP 404). Check the spelling, or whether this key's account has access to it.${tail}`;
  }
  switch (result.reason) {
    case "auth":
      return `${who} refused the key when asked about "${model}" (HTTP ${result.status}). Check the API key and its permissions; the model id was not checked.`;
    case "rate-limited":
      return `${who} is rate limiting this key (HTTP 429${result.retryAfter === undefined ? "" : `, retry after ${result.retryAfter} s`}); the model id was not checked.`;
    case "timeout":
      return `${who} did not answer in time; the model id was not checked.`;
    case "network":
      return `Could not reach the server${result.detail ? ` (${result.detail})` : ""}; the model id was not checked.`;
    case "unsupported":
      return `This endpoint does not report single models (no /models/{id}), so the model id was not checked.`;
    default:
      return `${who} answered HTTP ${result.status ?? "?"} when asked about "${model}"${result.detail ? `: ${result.detail}` : ""}; the model id was not checked.`;
  }
}

/** A short line of what the provider reported, for Test connection. */
export function describeModelFacts(facts: ProviderModelFacts): string {
  const parts: string[] = [];
  if (facts.contextLength) {
    parts.push(`${facts.contextLength.toLocaleString("en-US")}-token context`);
  }
  if (facts.maxOutputTokens) {
    parts.push(
      `${facts.maxOutputTokens.toLocaleString("en-US")} max output tokens`,
    );
  }
  const inputs = [
    facts.supportsImages ? "images" : undefined,
    facts.supportsPdf ? "PDFs" : undefined,
  ].filter(Boolean);
  if (inputs.length) parts.push(`reads ${inputs.join(" and ")}`);
  if (facts.thinkingTypes?.length) {
    parts.push(`thinking: ${facts.thinkingTypes.join(", ")}`);
  }
  if (facts.lifecycle && facts.lifecycle !== "active") {
    parts.push(
      `${facts.lifecycle}${facts.retiresAt ? `, retires ${facts.retiresAt}` : ""}`,
    );
  } else if (facts.retiresAt) {
    parts.push(`shuts down ${facts.retiresAt}`);
  }
  const name = facts.displayName
    ? `${facts.displayName} (${facts.id})`
    : facts.id;
  return parts.length ? `${name}: ${parts.join("; ")}.` : `${name} exists.`;
}

/** Test connection's verdict on the configured model id. */
export type ModelCheck =
  | {
      status: "found";
      model: string;
      facts: ProviderModelFacts;
      summary: string;
    }
  | {
      status: "not-found";
      model: string;
      suggestions: string[];
      message: string;
    }
  | {
      status: "unverified";
      model: string;
      reason: ModelLookupFailure;
      message: string;
    };

export function toModelCheck(
  provider: ModelInfoProvider,
  model: string,
  result: ModelLookupResult,
  opts: { isOpenAI?: boolean } = {},
): ModelCheck {
  if (result.kind === "found") {
    return {
      status: "found",
      model,
      facts: result.facts,
      summary: describeModelFacts(result.facts),
    };
  }
  const message = describeModelLookup(provider, model, result, opts);
  return result.kind === "not-found"
    ? {
        status: "not-found",
        model,
        suggestions: result.suggestions,
        message,
      }
    : { status: "unverified", model, reason: result.reason, message };
}
