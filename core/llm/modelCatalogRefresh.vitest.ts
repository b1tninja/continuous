import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  ModelCatalogRefresher,
  STARTUP_DELAY_MS,
  STARTUP_JITTER_MS,
  backoffDelay,
  createOpenRouterRefresher,
  isCatalogStale,
  underTestRunner,
  type RefresherDeps,
} from "./modelCatalogRefresh";
import type { ModelCatalogSettings } from "./modelCatalogStore";
import {
  readOpenRouterCatalog,
  writeOpenRouterCatalog,
} from "./modelCatalogStore";
import type { ModelCatalog } from "./openRouterCatalog";
import { sonnetEntry } from "./openRouterCatalogFixtures";

vi.mock("@continuedev/fetch", () => ({
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-13T12:00:00.000Z");

const catalogAt = (fetchedAt: string): ModelCatalog => ({
  schemaVersion: 1,
  source: "https://openrouter.ai/api/v1/models",
  fetchedAt,
  models: [{ id: "a/b", name: "B", supportsTools: false }],
});

/** A refresher on a fake clock, timers and cache, with a counting pull. */
function harness(
  opts: {
    policy?: ModelCatalogSettings["policy"];
    refreshHours?: number;
    fetchedAt?: string;
    fail?: () => boolean;
  } = {},
) {
  const state = {
    now: NOW,
    settings: {
      policy: opts.policy ?? "automatic",
      refreshHours: opts.refreshHours ?? 24,
    } as ModelCatalogSettings,
    fetchedAt: opts.fetchedAt,
    pulls: 0,
    timers: [] as { fn: () => void; ms: number }[],
  };
  const deps: RefresherDeps = {
    settings: () => state.settings,
    fetchedAt: () => state.fetchedAt,
    pull: async () => {
      state.pulls += 1;
      if (opts.fail?.()) throw new Error("getaddrinfo ENOTFOUND openrouter.ai");
      state.fetchedAt = new Date(state.now).toISOString();
      return catalogAt(state.fetchedAt);
    },
    now: () => state.now,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      state.timers.push({ fn, ms });
      return state.timers.length;
    },
    clearTimer: () => {},
  };
  const refresher = new ModelCatalogRefresher(deps);
  /** Run the last timer set, moving the clock forward by its delay. */
  const fire = async () => {
    const t = state.timers.pop();
    if (!t) throw new Error("no timer set");
    state.now += t.ms;
    t.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return t.ms;
  };
  return { state, refresher, fire };
}

describe("isCatalogStale", () => {
  it("is stale without a copy, with a bad date, or at the interval", () => {
    expect(isCatalogStale(undefined, 24, NOW)).toBe(true);
    expect(isCatalogStale("not a date", 24, NOW)).toBe(true);
    expect(
      isCatalogStale(new Date(NOW - 24 * HOUR).toISOString(), 24, NOW),
    ).toBe(true);
    expect(
      isCatalogStale(new Date(NOW - 23 * HOUR).toISOString(), 24, NOW),
    ).toBe(false);
  });
});

describe("ModelCatalogRefresher: the setting", () => {
  it("automatic: fetches when the copy is stale", async () => {
    const h = harness({
      fetchedAt: new Date(NOW - 25 * HOUR).toISOString(),
    });
    expect(await h.refresher.check()).toBe("refreshed");
    expect(h.state.pulls).toBe(1);
  });

  it("automatic: fetches when there is no copy at all", async () => {
    const h = harness();
    expect(await h.refresher.check()).toBe("refreshed");
    expect(h.state.pulls).toBe(1);
  });

  it("automatic: does not fetch when the copy is fresh", async () => {
    const h = harness({ fetchedAt: new Date(NOW - 2 * HOUR).toISOString() });
    expect(await h.refresher.check()).toBe("fresh");
    expect(h.state.pulls).toBe(0);
  });

  it("honours a configured interval", async () => {
    const fetchedAt = new Date(NOW - 7 * HOUR).toISOString();
    expect(
      await harness({ fetchedAt, refreshHours: 6 }).refresher.check(),
    ).toBe("refreshed");
    expect(
      await harness({ fetchedAt, refreshHours: 8 }).refresher.check(),
    ).toBe("fresh");
  });

  it.each(["ask", "never", "off"] as const)(
    "%s: never fetches automatically, however old the copy",
    async (policy) => {
      const h = harness({ policy });
      h.refresher.start();
      for (let i = 0; i < 20; i++) await h.fire();
      expect(h.state.pulls).toBe(0);
    },
  );

  it("picks up a change of setting at the next check", async () => {
    const h = harness({ policy: "off" });
    h.refresher.start();
    await h.fire();
    expect(h.state.pulls).toBe(0);
    h.state.settings = { policy: "automatic", refreshHours: 24 };
    const waited = await h.fire();
    expect(waited).toBeLessThanOrEqual(1.1 * HOUR);
    expect(h.state.pulls).toBe(1);
  });
});

describe("ModelCatalogRefresher: timing", () => {
  it("start only sets a timer: no read, no request, until it fires", () => {
    const h = harness();
    const settings = vi.spyOn(h.state, "settings", "get");
    h.refresher.start();
    expect(h.state.pulls).toBe(0);
    expect(settings).not.toHaveBeenCalled();
    expect(h.state.timers).toHaveLength(1);
    const first = h.state.timers[0].ms;
    expect(first).toBeGreaterThanOrEqual(STARTUP_DELAY_MS);
    expect(first).toBeLessThan(STARTUP_DELAY_MS + STARTUP_JITTER_MS);
  });

  it("refreshes again one interval later, with jitter, while running", async () => {
    const h = harness();
    h.refresher.start();
    await h.fire();
    expect(h.state.pulls).toBe(1);
    // Next check is capped at 6 h: a file read that finds the copy fresh
    let elapsed = 0;
    while (h.state.pulls === 1) elapsed += await h.fire();
    expect(h.state.pulls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(24 * HOUR * 0.9);
    expect(elapsed).toBeLessThanOrEqual(24 * HOUR * 1.1 + HOUR);
  });

  it("does not fetch when another window refreshed the file meanwhile", async () => {
    const h = harness({ fetchedAt: new Date(NOW - 25 * HOUR).toISOString() });
    h.state.fetchedAt = new Date(NOW).toISOString();
    expect(await h.refresher.check()).toBe("fresh");
    expect(h.state.pulls).toBe(0);
  });

  it("stop clears the schedule", async () => {
    const h = harness();
    h.refresher.start();
    h.refresher.stop();
    await h.fire();
    expect(h.state.pulls).toBe(0);
    expect(h.state.timers).toHaveLength(0);
  });
});

describe("ModelCatalogRefresher: offline and backoff", () => {
  it("never throws when offline, keeps the status, and backs off exponentially", async () => {
    const h = harness({ fail: () => true });
    expect(await h.refresher.check()).toBe("failed");
    expect(h.refresher.getStatus()).toMatchObject({
      failures: 1,
      lastError: expect.stringMatching(/ENOTFOUND/),
    });
    h.refresher.start();
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) waits.push(await h.fire());
    // first wait is the start-up delay; then 10, 20, 40 ... minutes, capped
    expect(waits[1]).toBe(backoffDelay(2, () => 0.5));
    expect(waits[2]).toBe(2 * waits[1]);
    expect(Math.max(...waits.slice(1))).toBeLessThanOrEqual(
      BACKOFF_MAX_MS * 1.1,
    );
    expect(h.state.pulls).toBe(9);
  });

  it("resets the backoff after a success", async () => {
    let failing = true;
    const h = harness({ fail: () => failing });
    await h.refresher.check();
    await h.refresher.check();
    expect(h.refresher.getStatus().failures).toBe(2);
    failing = false;
    expect(await h.refresher.check()).toBe("refreshed");
    expect(h.refresher.getStatus()).toMatchObject({ failures: 0 });
    expect(h.refresher.getStatus().lastError).toBeUndefined();
  });

  it("backoff starts at 5 minutes and stays within ±10% jitter", () => {
    expect(backoffDelay(1, () => 0.5)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(1, () => 0)).toBe(BACKOFF_BASE_MS * 0.9);
    expect(backoffDelay(1, () => 1)).toBe(BACKOFF_BASE_MS * 1.1);
    expect(backoffDelay(50, () => 0.5)).toBe(BACKOFF_MAX_MS);
  });

  it("runs one request at a time", async () => {
    let release!: () => void;
    const deps: RefresherDeps = {
      settings: () => ({ policy: "automatic", refreshHours: 24 }),
      fetchedAt: () => undefined,
      pull: () =>
        new Promise((resolve) => {
          release = () => resolve(catalogAt(new Date(NOW).toISOString()));
        }),
    };
    const r = new ModelCatalogRefresher(deps);
    const first = r.check();
    expect(await r.check()).toBe("busy");
    release();
    expect(await first).toBe("refreshed");
  });
});

describe("createOpenRouterRefresher (real cache file, mocked network)", () => {
  let dir: string;
  let urls: string[];
  let inits: any[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-refresh-"));
    urls = [];
    inits = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        urls.push(String(url));
        inits.push(init);
        return new Response(JSON.stringify({ data: [sonnetEntry] }));
      }),
    );
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("at start-up and on the periodic timer, contacts only openrouter.ai, never ollama.com, with no key", async () => {
    const file = path.join(dir, "model-catalog", "openrouter.json");
    const r = createOpenRouterRefresher({
      file,
      settings: () => ({ policy: "automatic", refreshHours: 24 }),
      requestOptions: () => ({
        headers: { Authorization: "Bearer gateway-secret" },
      }),
    });
    r.start();
    expect(urls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + STARTUP_JITTER_MS);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/models"]);
    expect(readOpenRouterCatalog(file)?.models.length).toBeGreaterThan(0);
    // Three days of the periodic timer
    await vi.advanceTimersByTimeAsync(72 * HOUR);
    r.stop();
    expect(urls.length).toBeGreaterThanOrEqual(3);
    expect(urls.length).toBeLessThanOrEqual(4);
    for (const u of urls) {
      expect(new URL(u).host).toBe("openrouter.ai");
      expect(u).not.toMatch(/ollama/);
    }
    for (const init of inits) {
      expect(JSON.stringify(init.headers)).not.toMatch(
        /authorization|gateway-secret/i,
      );
      expect(init.body).toBeUndefined();
    }
  });

  it("with a fresh copy on disk, start-up makes no request", async () => {
    const file = path.join(dir, "openrouter.json");
    writeOpenRouterCatalog(catalogAt(new Date(NOW - HOUR).toISOString()), file);
    const r = createOpenRouterRefresher({
      file,
      settings: () => ({ policy: "automatic", refreshHours: 24 }),
    });
    r.start();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + STARTUP_JITTER_MS);
    r.stop();
    expect(urls).toHaveLength(0);
  });

  it.each(["ask", "never", "off"] as const)(
    "%s: a week of timers makes no request",
    async (policy) => {
      const r = createOpenRouterRefresher({
        file: path.join(dir, "openrouter.json"),
        settings: () => ({ policy, refreshHours: 24 }),
      });
      r.start();
      await vi.advanceTimersByTimeAsync(7 * 24 * HOUR);
      r.stop();
      expect(urls).toHaveLength(0);
    },
  );

  it("offline: the old copy stays and nothing is thrown", async () => {
    const file = path.join(dir, "openrouter.json");
    const old = catalogAt(new Date(NOW - 48 * HOUR).toISOString());
    writeOpenRouterCatalog(old, file);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND openrouter.ai");
      }),
    );
    const r = createOpenRouterRefresher({
      file,
      settings: () => ({ policy: "automatic", refreshHours: 24 }),
    });
    expect(await r.check()).toBe("failed");
    expect(readOpenRouterCatalog(file)).toEqual(old);
    expect(fs.readdirSync(dir)).toEqual(["openrouter.json"]);
  });
});

describe("cache atomicity", () => {
  it("a failed write leaves the previous file whole and no temporary file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-atomic-"));
    try {
      // The target is a non-empty directory, so the final rename fails
      const file = path.join(dir, "openrouter.json");
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, "keep"), "x");
      expect(() =>
        writeOpenRouterCatalog(catalogAt(new Date(NOW).toISOString()), file),
      ).toThrow();
      expect(fs.readdirSync(dir)).toEqual(["openrouter.json"]);
      expect(fs.readFileSync(path.join(file, "keep"), "utf8")).toBe("x");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a reader sees the old list or the new one, never a partial file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-atomic-"));
    try {
      const file = path.join(dir, "openrouter.json");
      const a = catalogAt("2026-11-01T00:00:00.000Z");
      writeOpenRouterCatalog(a, file);
      const big = {
        ...catalogAt("2026-11-02T00:00:00.000Z"),
        models: Array.from({ length: 4000 }, (_, i) => ({
          id: `p/m${i}`,
          name: `Model ${i}`,
          supportsTools: true,
        })),
      };
      writeOpenRouterCatalog(big, file);
      const read = readOpenRouterCatalog(file);
      expect(read?.fetchedAt).toBe(big.fetchedAt);
      expect(read?.models).toHaveLength(4000);
      expect(fs.readdirSync(dir)).toEqual(["openrouter.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("underTestRunner", () => {
  it("keeps the refresher off under test runners, on otherwise", () => {
    expect(underTestRunner({ NODE_ENV: "test" })).toBe(true);
    expect(underTestRunner({ VITEST: "true" })).toBe(true);
    expect(underTestRunner({ CONTINUE_CLI_TEST: "true" })).toBe(true);
    expect(underTestRunner({ NODE_ENV: "production" })).toBe(false);
  });
});
