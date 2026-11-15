/**
 * "Test connection" for the Anthropic API, which is not OpenAI-compatible:
 * `GET {base}/models` with `x-api-key` and an `anthropic-version` header, read
 * `lifecycle`, `deprecated_at` and `retires_at` for the configured models and
 * report them (core/util/modelRetirement.ts), then `GET {base}/models/{id}`
 * for each configured model to say whether this key reaches that id
 * (core/util/providerModelLookup.ts). Read-only requests, no model call.
 * The listing may use the newer API version safely (it changes no
 * request shape); if the service refuses that version it is retried with
 * 2023-06-01, which may omit the lifecycle fields. The key goes only in the
 * header, is never returned, and is scrubbed from error text. The sender is
 * `fetchFn`, so tests record requests and nothing leaves the machine.
 */
import {
  hasOpenAICompatDefault,
  openAICompatDefaultBase,
} from "./openaiCompatBases.js";
import {
  type LiveLifecycle,
  type RetirementNotice,
  retirementNotice,
} from "./modelRetirement.js";
import {
  lookupProviderModel,
  type ModelCheck,
  toModelCheck,
} from "./providerModelLookup.js";

export const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com/v1";
export const ANTHROPIC_LIST_VERSION = "2026-10-21";
export const ANTHROPIC_FALLBACK_VERSION = "2023-06-01";

/** Providers the add-model form can test: the OpenAI-compatible ones and Anthropic. */
export function hasConnectionTest(provider: string): boolean {
  return provider === "anthropic" || hasOpenAICompatDefault(provider);
}

/** The base Test connection uses when none is typed. */
export function connectionTestDefaultBase(
  provider: string,
): string | undefined {
  return provider === "anthropic"
    ? ANTHROPIC_DEFAULT_BASE
    : openAICompatDefaultBase(provider);
}

export type AnthropicFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface AnthropicTestInput {
  apiKey?: string;
  apiBase?: string;
  /** The configured model(s) to report on; without one only the listing runs. */
  models?: string[];
  timeoutMs?: number;
  fetchFn?: AnthropicFetch;
  /** Today, YYYY-MM-DD. */
  now?: string;
}

export interface AnthropicListedModel extends LiveLifecycle {
  id: string;
  displayName?: string;
}

export type AnthropicTestResult =
  | {
      ok: true;
      models: string[];
      listed: AnthropicListedModel[];
      /** One notice per asked-for model that has something to say. */
      notices: RetirementNotice[];
      /** The API version that answered. */
      version: string;
      /** Per asked-for model: `GET /models/{id}`'s verdict and what it reported. */
      modelChecks: ModelCheck[];
    }
  | { ok: false; error: string };

type ListOutcome =
  | { ok: true; data: unknown }
  | { ok: false; status: number; body: string; error?: string };

function scrub(text: string, key?: string): string {
  let t = text.slice(0, 300);
  if (key) t = t.split(key).join("[key]");
  return t.replace(/\s+/g, " ").trim();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function parseModels(data: unknown): AnthropicListedModel[] {
  const list = (data as { data?: unknown })?.data;
  if (!Array.isArray(list)) return [];
  const out: AnthropicListedModel[] = [];
  for (const m of list as Record<string, unknown>[]) {
    const id = str(m?.id);
    if (!id) continue;
    out.push({
      id,
      displayName: str(m.display_name),
      lifecycle: str(m.lifecycle),
      deprecatedAt: str(m.deprecated_at),
      retiresAt: str(m.retires_at),
    });
  }
  return out;
}

async function listOnce(
  input: AnthropicTestInput,
  version: string,
): Promise<ListOutcome> {
  const fetchFn =
    input.fetchFn ?? (globalThis.fetch as unknown as AnthropicFetch);
  const base = (input.apiBase?.trim() || ANTHROPIC_DEFAULT_BASE).replace(
    /\/+$/,
    "",
  );
  const url = `${base}/models?limit=1000`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 30_000);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        "x-api-key": input.apiKey ?? "",
        "anthropic-version": version,
      },
      signal: ctl.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: await res.text().catch(() => ""),
      };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "AbortError"
        ? "timed out"
        : scrub(e instanceof Error ? e.message : String(e), input.apiKey);
    return {
      ok: false,
      status: 0,
      body: "",
      error: `Could not reach ${url.replace(/\?.*$/, "")}: ${msg}.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function failure(
  r: { status: number; body: string; error?: string },
  key?: string,
): string {
  if (r.error) return r.error;
  if (r.status === 401 || r.status === 403) {
    return `Anthropic rejected the API key (HTTP ${r.status}).`;
  }
  if (r.status === 429) {
    return "Anthropic is rate limiting this key (HTTP 429). Try again in a minute.";
  }
  const detail = scrub(r.body, key);
  return `Anthropic answered HTTP ${r.status}${detail ? `: ${detail}` : ""}.`;
}

/** Test one key; never throws. */
export async function testAnthropicConnection(
  input: AnthropicTestInput,
): Promise<AnthropicTestResult> {
  if (!input.apiKey) {
    return { ok: false, error: "Enter the Anthropic API key first." };
  }
  let version = ANTHROPIC_LIST_VERSION;
  let res = await listOnce(input, version);
  if (!res.ok && res.status === 400) {
    version = ANTHROPIC_FALLBACK_VERSION;
    res = await listOnce(input, version);
  }
  if (!res.ok) return { ok: false, error: failure(res, input.apiKey) };
  const listed = parseModels(res.data);
  const now = input.now ?? new Date().toISOString().slice(0, 10);
  const notices: RetirementNotice[] = [];
  for (const model of input.models ?? []) {
    // An alias (claude-sonnet-4-5) matches the dated id the list returns.
    const found =
      listed.find((m) => m.id === model) ??
      listed.find((m) => m.id.startsWith(`${model}-`));
    // A model the key does not list, or lists without lifecycle fields, says
    // nothing live: the table still applies.
    const live =
      found && (found.lifecycle || found.retiresAt || found.deprecatedAt)
        ? found
        : undefined;
    const n = retirementNotice({
      provider: "anthropic",
      model,
      now,
      ...(live ? { live } : {}),
    });
    if (n) notices.push(n);
  }
  // The configured id itself: does this key reach it, and what Anthropic
  // reports for it. The listing just fetched supplies the suggestions.
  const modelChecks: ModelCheck[] = [];
  for (const model of input.models ?? []) {
    const result = await lookupProviderModel({
      provider: "anthropic",
      apiBase: input.apiBase,
      apiKey: input.apiKey,
      model,
      listed: listed.map((m) => m.id),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    });
    modelChecks.push(toModelCheck("anthropic", model, result));
  }
  return {
    ok: true,
    models: listed.map((m) => m.id),
    listed,
    notices,
    version,
    modelChecks,
  };
}
