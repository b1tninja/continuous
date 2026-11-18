import type { RequestOptions } from "../index.js";
import { networkFetch } from "../util/networkFetch.js";
import {
  lookupProviderModel,
  type LookupFetch,
  type ModelLookupResult,
  type ProviderModelFacts,
} from "../util/providerModelLookup.js";

import {
  backoffDelay,
  isCatalogStale,
  SETTINGS_RECHECK_MS,
  withJitter,
} from "./modelCatalogRefresh.js";
import {
  readModelCatalogSettings,
  type ModelCatalogSettings,
} from "./modelCatalogStore.js";
import {
  accountFingerprint,
  readCachedModelFacts,
  writeCachedModelFacts,
  type ProviderModelTarget,
} from "./providerModelInfoStore.js";

/**
 * The background refresh of the selected chat model's facts from its own
 * provider (Anthropic or OpenAI, or an OpenAI-compatible server configured
 * as `openai`), with the person's own key, for "Model information updates:
 * Automatic". One model at a time, the selected one: a few seconds after it
 * is selected and again when its copy is older than the setting's interval.
 * Nothing waits for it, a request never fails because of it, and only the
 * host the person configured for that model is contacted.
 *
 * Outcomes: an answer is kept (providerModelInfoStore.ts) and applied to the
 * running model; an unknown id is logged and checked again at the next
 * interval; a refused key waits for the next interval; an endpoint without
 * a models API is not asked again until another model is selected; a rate
 * limit, timeout or network failure backs off (5 minutes up to 6 hours).
 */

/** The first check after a selection waits this long, plus up to the jitter. */
export const SELECT_DELAY_MS = 3_000;
export const SELECT_JITTER_MS = 2_000;
/** A side request: short. */
export const REFRESH_TIMEOUT_MS = 5_000;

export interface RefreshTarget extends ProviderModelTarget {
  requestOptions?: RequestOptions;
}

export type ModelRefreshOutcome =
  | "disabled"
  | "fresh"
  | "refreshed"
  | "not-found"
  | "refused"
  | "unsupported"
  | "failed"
  | "busy";

export interface ModelRefresherDeps {
  settings: () => ModelCatalogSettings;
  /** When the copy for this target was fetched, if there is one. */
  fetchedAt: (target: RefreshTarget) => string | undefined;
  lookup: (target: RefreshTarget) => Promise<ModelLookupResult>;
  save: (target: RefreshTarget, facts: ProviderModelFacts) => void;
  onUpdated?: (target: RefreshTarget, facts: ProviderModelFacts) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
}

/** Identity of a target without its key in clear. */
export function targetKey(t: ProviderModelTarget): string {
  return `${t.provider}:${accountFingerprint(t)}:${t.model}`;
}

export class SelectedModelRefresher {
  private target: RefreshTarget | undefined;
  private key: string | undefined;
  private timer: unknown;
  private inFlight = false;
  private failures = 0;
  private retryAfterMs = 0;
  /** Targets whose endpoint has no models API: not asked again this session. */
  private readonly unsupported = new Set<string>();
  /** Messages already logged, so a failure is reported once. */
  private readonly logged = new Set<string>();

  constructor(private readonly deps: ModelRefresherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private random(): number {
    return this.deps.random?.() ?? Math.random();
  }

  /** The model now selected; undefined (or another provider) stops refreshing. */
  select(target: RefreshTarget | undefined): void {
    const key = target ? targetKey(target) : undefined;
    if (key === this.key) {
      // Same model and account; keep the newest request options
      this.target = target;
      return;
    }
    this.clear();
    this.target = target;
    this.key = key;
    this.failures = 0;
    this.retryAfterMs = 0;
    if (!target || !key || this.unsupported.has(key)) return;
    this.schedule(
      SELECT_DELAY_MS + Math.floor(this.random() * SELECT_JITTER_MS),
    );
  }

  stop(): void {
    this.clear();
    this.target = undefined;
    this.key = undefined;
  }

  private clear(): void {
    if (this.timer !== undefined) {
      (this.deps.clearTimer ?? ((h) => clearTimeout(h as any)))(this.timer);
      this.timer = undefined;
    }
  }

  private logOnce(message: string): void {
    if (this.logged.has(message)) return;
    this.logged.add(message);
    this.deps.log?.(message);
  }

  /** One check of the selected model. Never throws. */
  async check(): Promise<ModelRefreshOutcome> {
    const target = this.target;
    const key = this.key;
    if (!target || !key) return "disabled";
    if (this.inFlight) return "busy";
    let settings: ModelCatalogSettings;
    try {
      settings = this.deps.settings();
    } catch {
      return "disabled";
    }
    if (settings.policy !== "automatic") return "disabled";
    let fetchedAt: string | undefined;
    try {
      fetchedAt = this.deps.fetchedAt(target);
    } catch {
      fetchedAt = undefined;
    }
    if (!isCatalogStale(fetchedAt, settings.refreshHours, this.now())) {
      return "fresh";
    }
    this.inFlight = true;
    let result: ModelLookupResult;
    try {
      result = await this.deps.lookup(target);
    } catch (e) {
      result = {
        kind: "failed",
        reason: "network",
        detail: e instanceof Error ? e.message : String(e),
      };
    } finally {
      this.inFlight = false;
    }
    // Another model may have been selected meanwhile; the answer still
    // belongs to the one asked about
    const label = `${target.provider} model "${target.model}"`;
    if (result.kind === "found") {
      this.failures = 0;
      try {
        this.deps.save(target, result.facts);
        this.deps.onUpdated?.(target, result.facts);
      } catch {
        // a listener's problem is not a failed lookup
      }
      return "refreshed";
    }
    if (result.kind === "not-found") {
      this.failures = 0;
      this.logOnce(
        `Model information: the provider does not know ${label} for this key${result.suggestions.length ? ` (did you mean ${result.suggestions.join(", ")}?)` : ""}`,
      );
      return "not-found";
    }
    switch (result.reason) {
      case "auth":
        this.failures = 0;
        this.logOnce(
          `Model information: the provider refused the key when asked about ${label} (HTTP ${result.status}); bundled model data stays in use`,
        );
        return "refused";
      case "unsupported":
        this.unsupported.add(key);
        this.logOnce(
          `Model information: the endpoint for ${label} has no models API; bundled model data stays in use`,
        );
        return "unsupported";
      default:
        this.failures += 1;
        this.retryAfterMs = (result.retryAfter ?? 0) * 1000;
        this.logOnce(
          `Model information update for ${label} failed (${result.reason}${result.status ? ` ${result.status}` : ""}); will retry later`,
        );
        return "failed";
    }
  }

  /** The wait before the next check, or undefined to stop for this target. */
  nextDelay(outcome: ModelRefreshOutcome): number | undefined {
    if (outcome === "unsupported") return undefined;
    if (outcome === "failed") {
      return Math.max(
        this.retryAfterMs,
        backoffDelay(this.failures, () => this.random()),
      );
    }
    if (outcome === "disabled" || outcome === "busy") {
      return withJitter(SETTINGS_RECHECK_MS, () => this.random());
    }
    let hours = 24;
    try {
      hours = this.deps.settings().refreshHours;
    } catch {
      // default interval
    }
    const interval = hours * 60 * 60 * 1000;
    let due = interval;
    if (outcome === "fresh" && this.target) {
      const t = Date.parse(this.deps.fetchedAt(this.target) ?? "");
      if (Number.isFinite(t)) due = t + interval - this.now();
    }
    return withJitter(Math.max(60_000, due), () => this.random());
  }

  private schedule(ms: number): void {
    const set =
      this.deps.setTimer ??
      ((fn: () => void, delay: number) => {
        const t = setTimeout(fn, delay);
        // A timer must not keep a terminal run (or a test) alive
        (t as { unref?: () => void }).unref?.();
        return t;
      });
    this.timer = set(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    const key = this.key;
    const outcome = await this.check();
    // A different selection rescheduled itself already
    if (key !== this.key || !this.key) return;
    const next = this.nextDelay(outcome);
    if (next !== undefined) this.schedule(next);
  }
}

/**
 * The refresher wired to the real cache and the network. Requests go to the
 * configured API base with the person's proxy, CA and headers
 * (`requestOptions`), and the key only as the provider's auth header.
 */
export function createSelectedModelRefresher(
  opts: {
    onUpdated?: (target: RefreshTarget, facts: ProviderModelFacts) => void;
    log?: (message: string) => void;
    settings?: () => ModelCatalogSettings;
  } = {},
): SelectedModelRefresher {
  return new SelectedModelRefresher({
    settings: opts.settings ?? (() => readModelCatalogSettings()),
    fetchedAt: (t) => readCachedModelFacts(t)?.fetchedAt,
    lookup: (t) => {
      const fetchFn: LookupFetch = (url, init) =>
        networkFetch(url, init, t.requestOptions) as ReturnType<LookupFetch>;
      return lookupProviderModel({
        provider: t.provider,
        apiBase: t.apiBase,
        apiKey: t.apiKey,
        model: t.model,
        timeoutMs: REFRESH_TIMEOUT_MS,
        headers: t.requestOptions?.headers,
        fetchFn,
      });
    },
    save: (t, facts) => {
      writeCachedModelFacts(t, facts);
    },
    onUpdated: opts.onUpdated,
    log: opts.log,
  });
}
