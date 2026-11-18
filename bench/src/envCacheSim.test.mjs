// node --test bench/src/envCacheSim.test.mjs
// The placement simulation of
// plans/research/env-workspace-context-and-cache-placement.md section 4.3.
// No network, no model: the cache model and the ordering of placements.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLACEMENTS,
  PRICES,
  makeSession,
  prng,
  simulate,
  table,
} from "./envCacheSim.mjs";

test("the generator is deterministic for a seed", () => {
  const a = prng(42);
  const b = prng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  assert.deepEqual(makeSession({ seed: 3 }), makeSession({ seed: 3 }));
  assert.notDeepEqual(makeSession({ seed: 3 }), makeSession({ seed: 4 }));
});

test("the default session is 30 user turns with tool loops", () => {
  const s = makeSession();
  assert.equal(s.filter((r) => r.first).length, 30);
  assert.ok(s.length > 60 && s.length < 180, `requests: ${s.length}`);
});

test("every placement and price runs and reports consistent totals", () => {
  const session = makeSession();
  for (const price of Object.keys(PRICES)) {
    for (const name of Object.keys(PLACEMENTS)) {
      const r = simulate(name, session, price);
      assert.ok(r.requests >= session.length, `${name} ${price}`);
      assert.ok(r.readShare >= 0 && r.readShare <= 1);
      assert.ok(r.cost > 0);
      assert.ok(r.staleShare >= 0 && r.staleShare <= 1);
    }
  }
});

test("a static session reads almost everything from the cache", () => {
  const session = makeSession().map((r) => ({
    ...r,
    state: { active: 0, sel: 0, diag: 0, git: 0, tabs: 0, minute: 0 },
  }));
  const r = simulate("A-system-live", session, "anthropic-1h");
  assert.ok(r.readShare > 0.95, `read share ${r.readShare}`);
});

test("re-rendering state before the history costs far more than any append-only placement", () => {
  for (const price of ["anthropic-5m", "anthropic-1h", "openai-56-30m"]) {
    const rows = Object.fromEntries(table(price).map((r) => [r.placement, r]));
    for (const live of ["A-system-live", "B-first-user-live"]) {
      for (const safe of [
        "C-frozen-every",
        "C-float-tail",
        "D-delta",
        "F-hybrid",
      ]) {
        assert.ok(
          rows[live].cost > 2 * rows[safe].cost,
          `${price}: ${live} ${rows[live].cost} vs ${safe} ${rows[safe].cost}`,
        );
      }
    }
  }
});

test("append-only placements never rewrite the prefix", () => {
  const session = makeSession();
  const base = simulate("A0-snapshot", session, "anthropic-5m");
  for (const name of [
    "C-frozen-every",
    "C-frozen-user",
    "D-delta",
    "F-hybrid",
  ]) {
    const r = simulate(name, session, "anthropic-5m");
    // Extra writes are bounded by what the placement added, not by the prefix.
    assert.ok(
      r.writeTokens - base.writeTokens <= r.envTokens * 2,
      `${name}: writes ${r.writeTokens} vs base ${base.writeTokens}, env ${r.envTokens}`,
    );
  }
});

test("the floating tail is never written to the cache", () => {
  const r = simulate("C-float-tail", makeSession(), "anthropic-5m");
  assert.ok(r.uncachedTokens >= r.envTokens);
});

test("fresh placements show no stale state; snapshot and pull-only do", () => {
  const rows = Object.fromEntries(
    table("anthropic-5m").map((r) => [r.placement, r]),
  );
  for (const fresh of [
    "A-system-live",
    "B-first-user-live",
    "C-frozen-every",
    "C-float-tail",
    "D-delta",
  ]) {
    assert.equal(rows[fresh].staleShare, 0, fresh);
  }
  assert.ok(rows["A0-snapshot"].staleShare > 0.5);
  assert.ok(rows["E-pull"].staleShare > rows["F-hybrid"].staleShare);
});

test("the hybrid stays within 5 percent of today's snapshot", () => {
  for (const price of Object.keys(PRICES)) {
    const f = table(price).find((r) => r.placement === "F-hybrid");
    assert.ok(f.relCost < 1.05, `${price}: ${f.relCost}`);
  }
});

test("compaction runs and keeps the ordering", () => {
  const rows = table("anthropic-5m", { compactAt: 40000 });
  const by = Object.fromEntries(rows.map((r) => [r.placement, r]));
  assert.ok(rows.every((r) => r.compactions > 0));
  assert.ok(by["A-system-live"].cost > 2 * by["D-delta"].cost);
});

test("the Gemini 4 rule re-processes small additions at the standard rate", () => {
  const session = makeSession();
  const gemini = simulate("A0-snapshot", session, "gemini4-implicit");
  const legacy = simulate("A0-snapshot", session, "openai-legacy");
  assert.ok(gemini.uncachedTokens > legacy.uncachedTokens);
});
