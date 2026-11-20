import type { RequestOptions } from "../index.js";

import {
  modelInfoFetchBlocked,
  pullOpenRouterCatalog,
  readModelCatalogSettings,
  readOpenRouterCatalog,
  type ModelCatalogSettings,
} from "./modelCatalogStore.js";
import type { ModelCatalog } from "./openRouterCatalog.js";

/**
 * The background refresh of OpenRouter's public model list, for "Model
 * information updates: Automatic" (the default). It never blocks start-up or
 * a request: `start` only sets a timer, the check runs later, and a failure
 * (offline, a proxy refusing, a bad answer) is kept as status and retried
 * with backoff while the copy already on disk stays in use.
 *
 * Only openrouter.ai is contacted here. Ollama's list is never fetched by
 * this module: that stays a choice made in Ollama's own setup.
 */

/** The first check waits this long after start-up, plus up to the jitter. */
export const STARTUP_DELAY_MS = 15_000;
export const STARTUP_JITTER_MS = 45_000;
/** With updates not automatic, the setting is read again this often. */
export const SETTINGS_RECHECK_MS = 60 * 60 * 1000;
/** The longest wait between two checks, so a change on disk is noticed. */
export const MAX_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const BACKOFF_BASE_MS = 5 * 60 * 1000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const MIN_DELAY_MS = 60_000;
const JITTER_FRACTION = 0.1;

export type RefreshOutcome =
  "disabled" | "fresh" | "refreshed" | "failed" | "busy";

export interface RefreshStatus {
  /** ISO time of the last request to openrouter.ai made by this refresher. */
  lastAttemptAt?: string;
  /** The reason the last attempt failed, cleared by a success. */
  lastError?: string;
  /** Failures in a row since the last success. */
  failures: number;
  /** ISO time of the next check (a file read; a request only when stale). */
  nextCheckAt?: string;
}

export interface RefresherDeps<T = ModelCatalog> {
  settings: () => ModelCatalogSettings;
  /** The date of the copy on this computer, or undefined when there is none. */
  fetchedAt: () => string | undefined;
  /** The one request: download, validate and write the list. */
  pull: () => Promise<T>;
  /**
   * Whether the list is wanted at all right now (the community catalogue:
   * only while a selected model has no better price). Absent means always.
   */
  wanted?: () => boolean | Promise<boolean>;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onRefreshed?: (catalog: T) => void;
  log?: (message: string) => void;
}

/** Whether a copy dated `fetchedAt` is due for a refresh. */
export function isCatalogStale(
  fetchedAt: string | undefined,
  refreshHours: number,
  now = Date.now(),
): boolean {
  if (!fetchedAt) return true;
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return true;
  return now - t >= refreshHours * 60 * 60 * 1000;
}

/** `ms` moved by up to ±10%, never below a minute. */
export function withJitter(ms: number, random: () => number): number {
  const r = Math.min(1, Math.max(0, random()));
  return Math.max(
    MIN_DELAY_MS,
    Math.round(ms * (1 + JITTER_FRACTION * (2 * r - 1))),
  );
}

/** The wait after `failures` failures in a row: 5 min, 10, 20 ... 6 h. */
export function backoffDelay(failures: number, random: () => number): number {
  const raw = Math.min(
    BACKOFF_MAX_MS,
    BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
  );
  return withJitter(raw, random);
}

export class ModelCatalogRefresher<T = ModelCatalog> {
  private timer: unknown;
  private running = false;
  private inFlight = false;
  private readonly status: RefreshStatus = { failures: 0 };

  constructor(private readonly deps: RefresherDeps<T>) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private random(): number {
    return this.deps.random?.() ?? Math.random();
  }

  getStatus(): RefreshStatus {
    return { ...this.status };
  }

  /** Set the first check's timer; returns at once. */
  start(opts: { delayMs?: number; jitterMs?: number } = {}): void {
    if (this.running) return;
    this.running = true;
    const delay = opts.delayMs ?? STARTUP_DELAY_MS;
    const jitter = opts.jitterMs ?? STARTUP_JITTER_MS;
    this.schedule(delay + Math.floor(this.random() * jitter));
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      (this.deps.clearTimer ?? ((h) => clearTimeout(h as any)))(this.timer);
      this.timer = undefined;
    }
    this.status.nextCheckAt = undefined;
  }

  /**
   * One check: read the setting and the copy's date, and download only when
   * updates are automatic and the copy is missing or older than the interval.
   * Never throws.
   */
  async check(): Promise<RefreshOutcome> {
    if (this.inFlight) return "busy";
    let settings: ModelCatalogSettings;
    try {
      settings = this.deps.settings();
    } catch {
      return "disabled";
    }
    if (settings.policy !== "automatic") {
      this.status.failures = 0;
      return "disabled";
    }
    if (this.deps.wanted) {
      // Held across the await, so two checks cannot both pass it
      this.inFlight = true;
      let wanted = false;
      try {
        wanted = await this.deps.wanted();
      } catch {
        wanted = false;
      } finally {
        this.inFlight = false;
      }
      if (!wanted) return "disabled";
    }
    let fetchedAt: string | undefined;
    try {
      fetchedAt = this.deps.fetchedAt();
    } catch {
      fetchedAt = undefined;
    }
    if (!isCatalogStale(fetchedAt, settings.refreshHours, this.now())) {
      return "fresh";
    }
    this.inFlight = true;
    this.status.lastAttemptAt = new Date(this.now()).toISOString();
    try {
      const catalog = await this.deps.pull();
      this.status.failures = 0;
      this.status.lastError = undefined;
      try {
        this.deps.onRefreshed?.(catalog);
      } catch {
        // a listener's problem is not a failed download
      }
      return "refreshed";
    } catch (e) {
      this.status.failures += 1;
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.deps.log?.(
        `Model information update failed (${this.status.lastError}); the list on this computer stays in use`,
      );
      return "failed";
    } finally {
      this.inFlight = false;
    }
  }

  /** The wait before the next check, after a check that ended in `outcome`. */
  nextDelay(outcome: RefreshOutcome): number {
    if (outcome === "failed") {
      return backoffDelay(this.status.failures, () => this.random());
    }
    if (outcome === "disabled" || outcome === "busy") {
      return withJitter(SETTINGS_RECHECK_MS, () => this.random());
    }
    let settings: ModelCatalogSettings | undefined;
    let fetchedAt: string | undefined;
    try {
      settings = this.deps.settings();
      fetchedAt = this.deps.fetchedAt();
    } catch {
      // fall back to the longest wait
    }
    const t = fetchedAt ? Date.parse(fetchedAt) : NaN;
    const due =
      settings && Number.isFinite(t)
        ? t + settings.refreshHours * 60 * 60 * 1000 - this.now()
        : MAX_CHECK_INTERVAL_MS;
    return withJitter(
      Math.min(MAX_CHECK_INTERVAL_MS, Math.max(MIN_DELAY_MS, due)),
      () => this.random(),
    );
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.status.nextCheckAt = new Date(this.now() + ms).toISOString();
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
    if (!this.running) return;
    const outcome = await this.check();
    if (!this.running) return;
    this.schedule(this.nextDelay(outcome));
  }
}

/**
 * The refresher wired to the real cache file and the network, as the IDE
 * core and the terminal agent use it. `requestOptions` supplies the user's
 * proxy and CA settings (never their headers). Not started under a test
 * runner, so no suite reaches openrouter.ai by accident.
 */
export function createOpenRouterRefresher(
  opts: {
    requestOptions?: () =>
      Promise<RequestOptions | undefined> | RequestOptions | undefined;
    onRefreshed?: (catalog: ModelCatalog) => void;
    log?: (message: string) => void;
    /** Tests: the cache file and the setting, instead of the global folder. */
    file?: string;
    settings?: () => ModelCatalogSettings;
  } = {},
): ModelCatalogRefresher {
  const settings = opts.settings ?? (() => readModelCatalogSettings());
  return new ModelCatalogRefresher({
    settings,
    fetchedAt: () => readOpenRouterCatalog(opts.file)?.fetchedAt,
    pull: async () => {
      // Read again at the moment of the request: the setting may have
      // changed to off since the check
      const blocked = modelInfoFetchBlocked(settings());
      if (blocked) throw new Error(blocked);
      return pullOpenRouterCatalog(await opts.requestOptions?.(), {
        file: opts.file,
      });
    },
    onRefreshed: opts.onRefreshed,
    log: opts.log,
  });
}

/** Whether this process is a test run, where the refresher is not started. */
export function underTestRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === "test" ||
    !!env.VITEST ||
    !!env.JEST_WORKER_ID ||
    env.CONTINUE_CLI_TEST === "true"
  );
}
