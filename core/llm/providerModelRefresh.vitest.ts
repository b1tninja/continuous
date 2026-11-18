import { describe, expect, it, vi } from "vitest";
import type { ModelLookupResult } from "../util/providerModelLookup.js";
import type { ModelCatalogSettings } from "./modelCatalogStore.js";
import {
  SELECT_DELAY_MS,
  SELECT_JITTER_MS,
  SelectedModelRefresher,
  type RefreshTarget,
} from "./providerModelRefresh.js";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-13T12:00:00Z");

const opus: RefreshTarget = {
  provider: "anthropic",
  apiKey: "sk-ant-SECRET",
  model: "claude-opus-5-5",
};

function harness(
  answers: ModelLookupResult[],
  opts: {
    settings?: ModelCatalogSettings;
    fetchedAt?: string;
  } = {},
) {
  let now = T0;
  let settings: ModelCatalogSettings = opts.settings ?? {
    policy: "automatic",
    refreshHours: 24,
  };
  let fetchedAt = opts.fetchedAt;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const lookups: RefreshTarget[] = [];
  const saved: unknown[] = [];
  const updated: unknown[] = [];
  const logs: string[] = [];
  const r = new SelectedModelRefresher({
    settings: () => settings,
    fetchedAt: () => fetchedAt,
    lookup: async (t) => {
      lookups.push(t);
      return answers.shift() ?? { kind: "failed", reason: "network" };
    },
    save: (_t, facts) => {
      saved.push(facts);
      fetchedAt = new Date(now).toISOString();
    },
    onUpdated: (_t, facts) => updated.push(facts),
    now: () => now,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    log: (m) => logs.push(m),
  });
  const pending = () => timers.filter((t) => !t.cleared);
  /** Run the newest live timer and let its check finish. */
  async function fire() {
    const t = pending().at(-1);
    if (!t) throw new Error("no timer");
    t.cleared = true;
    now += t.ms;
    t.fn();
    await vi.waitFor(() => {
      if (r["inFlight"]) throw new Error("busy");
    });
    await new Promise((res) => setTimeout(res, 0));
  }
  return {
    r,
    timers,
    pending,
    fire,
    lookups,
    saved,
    updated,
    logs,
    set settings(s: ModelCatalogSettings) {
      settings = s;
    },
  };
}

const found: ModelLookupResult = {
  kind: "found",
  facts: { id: "claude-opus-5-5", contextLength: 1_000_000 },
};

describe("SelectedModelRefresher", () => {
  it("selecting only sets a timer; the lookup runs a few seconds later", async () => {
    const h = harness([found]);
    h.r.select(opus);
    expect(h.lookups).toHaveLength(0);
    expect(h.pending()).toHaveLength(1);
    const ms = h.pending()[0].ms;
    expect(ms).toBeGreaterThanOrEqual(SELECT_DELAY_MS);
    expect(ms).toBeLessThan(SELECT_DELAY_MS + SELECT_JITTER_MS);
    await h.fire();
    expect(h.lookups).toEqual([opus]);
    expect(h.saved).toHaveLength(1);
    expect(h.updated).toHaveLength(1);
    // Next check at about the interval
    expect(h.pending()[0].ms).toBeGreaterThan(20 * HOUR);
  });

  it.each(["ask", "never", "off"] as const)(
    "makes no request when updates are %s",
    async (policy) => {
      const h = harness([found], { settings: { policy, refreshHours: 24 } });
      h.r.select(opus);
      await h.fire();
      expect(h.lookups).toHaveLength(0);
    },
  );

  it("a fresh copy is not fetched again", async () => {
    const h = harness([found], {
      fetchedAt: new Date(T0 - HOUR).toISOString(),
    });
    h.r.select(opus);
    await h.fire();
    expect(h.lookups).toHaveLength(0);
    expect(h.pending()[0].ms).toBeGreaterThan(20 * HOUR);
  });

  it("only the selected Anthropic or OpenAI model is refreshed; deselecting stops", () => {
    const h = harness([found]);
    h.r.select(opus);
    h.r.select(undefined);
    expect(h.pending()).toHaveLength(0);
  });

  it("selecting the same model again does not restart the timer", () => {
    const h = harness([found]);
    h.r.select(opus);
    h.r.select({ ...opus });
    expect(h.timers).toHaveLength(1);
    h.r.select({ ...opus, model: "claude-sonnet-5-5" });
    expect(h.timers[0].cleared).toBe(true);
    expect(h.pending()).toHaveLength(1);
  });

  it("an unknown id is logged once and checked again at the interval", async () => {
    const h = harness([
      { kind: "not-found", suggestions: ["claude-opus-5-5"] },
      { kind: "not-found", suggestions: ["claude-opus-5-5"] },
    ]);
    h.r.select({ ...opus, model: "claude-opus-55" });
    await h.fire();
    expect(h.saved).toHaveLength(0);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("did you mean claude-opus-5-5");
    expect(h.pending()[0].ms).toBeGreaterThan(20 * HOUR);
    await h.fire();
    expect(h.logs).toHaveLength(1);
  });

  it("a refused key waits for the interval, without the key in the log", async () => {
    const h = harness([{ kind: "failed", reason: "auth", status: 401 }]);
    h.r.select(opus);
    await h.fire();
    expect(h.pending()[0].ms).toBeGreaterThan(20 * HOUR);
    expect(h.logs.join("\n")).not.toContain("SECRET");
  });

  it("an endpoint without a models API is not asked again", async () => {
    const h = harness([{ kind: "failed", reason: "unsupported", status: 404 }]);
    const proxy = { ...opus, apiBase: "https://proxy.example/v1" };
    h.r.select(proxy);
    await h.fire();
    expect(h.pending()).toHaveLength(0);
    h.r.select(undefined);
    h.r.select(proxy);
    expect(h.pending()).toHaveLength(0);
  });

  it("network failures and rate limits back off, honouring retry-after", async () => {
    const h = harness([
      { kind: "failed", reason: "network" },
      { kind: "failed", reason: "rate-limited", status: 429, retryAfter: 7200 },
      { kind: "failed", reason: "timeout" },
    ]);
    h.r.select(opus);
    await h.fire();
    const first = h.pending()[0].ms;
    expect(first).toBeGreaterThanOrEqual(4 * 60_000);
    expect(first).toBeLessThan(6 * 60_000);
    await h.fire();
    expect(h.pending()[0].ms).toBeGreaterThanOrEqual(7200 * 1000);
    await h.fire();
    expect(h.lookups).toHaveLength(3);
  });

  it("one request at a time", async () => {
    let release!: (r: ModelLookupResult) => void;
    const lookup = vi.fn(
      () => new Promise<ModelLookupResult>((res) => (release = res)),
    );
    const r = new SelectedModelRefresher({
      settings: () => ({ policy: "automatic", refreshHours: 24 }),
      fetchedAt: () => undefined,
      lookup,
      save: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });
    r.select(opus);
    const a = r.check();
    expect(await r.check()).toBe("busy");
    release(found);
    expect(await a).toBe("refreshed");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("a lookup that throws is a failure, not a crash", async () => {
    const r = new SelectedModelRefresher({
      settings: () => ({ policy: "automatic", refreshHours: 24 }),
      fetchedAt: () => undefined,
      lookup: async () => {
        throw new Error("boom");
      },
      save: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });
    r.select(opus);
    expect(await r.check()).toBe("failed");
  });
});
