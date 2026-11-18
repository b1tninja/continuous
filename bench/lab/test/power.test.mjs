import assert from "node:assert/strict";
import { test } from "node:test";

import { disjoint, wilson } from "../lib/stats.mjs";
import {
  binomialPmf,
  detectableDifference,
  exactPower,
  fisherTwoSided,
  render,
  buildTables,
  runsForDifference,
  sprtBounds,
  sprtDiscordant,
  sprtOperatingCharacteristics,
  wilsonStopping,
} from "../tools/power.mjs";

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("two-sided Fisher p matches hand-counted tables", () => {
  // 3 of 3 against 0 of 3: C(3,3)*C(3,0)/C(6,3) = 1/20 each tail.
  close(fisherTwoSided(3, 3, 0, 3), 0.1);
  // 5 of 5 against 0 of 5: 2 / C(10,5) = 2/252.
  close(fisherTwoSided(5, 5, 0, 5), 2 / 252);
  // Equal counts are never evidence of a difference.
  close(fisherTwoSided(4, 10, 4, 10), 1);
  // Symmetric in the arms.
  close(fisherTwoSided(7, 10, 2, 10), fisherTwoSided(2, 10, 7, 10));
});

test("binomial pmf sums to one and handles the ends", () => {
  close(
    binomialPmf(12, 0.7).reduce((a, b) => a + b, 0),
    1,
  );
  assert.equal(binomialPmf(4, 0)[0], 1);
  assert.equal(binomialPmf(4, 1)[4], 1);
});

test("exact power agrees with a seeded simulation", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  const n = 12;
  const draws = 20000;
  let rejected = 0;
  for (let i = 0; i < draws; i++) {
    let a = 0;
    let c = 0;
    for (let j = 0; j < n; j++) {
      if (rnd() < 0.9) a++;
      if (rnd() < 0.5) c++;
    }
    if (fisherTwoSided(a, n, c, n) <= 0.05 + 1e-9) rejected++;
  }
  assert.ok(
    Math.abs(rejected / draws - exactPower("fisher", n, 0.5, 0.9)) < 0.02,
  );
});

test("type I error stays under alpha and the Wilson rule is stricter", () => {
  for (const n of [5, 10, 20, 40]) {
    for (const p of [0.1, 0.5, 0.7, 0.9, 0.95]) {
      const f = exactPower("fisher", n, p, p);
      const w = exactPower("wilson", n, p, p);
      assert.ok(f <= 0.05 + 1e-9, `fisher n=${n} p=${p}: ${f}`);
      assert.ok(w <= f + 1e-9, `wilson n=${n} p=${p}: ${w} > ${f}`);
    }
  }
});

test("the Wilson rule is exactly disjoint(wilson, wilson)", () => {
  // 5 of 5 against 0 of 5: [0.57, 1] and [0, 0.43] are disjoint; so power 1
  // for rates 1 and 0.
  assert.equal(disjoint(wilson(5, 5), wilson(0, 5)), true);
  close(exactPower("wilson", 5, 0, 1), 1);
  // 4 of 5 against 1 of 5: [0.38, 0.96] and [0.04, 0.62] overlap.
  assert.equal(disjoint(wilson(4, 5), wilson(1, 5)), false);
});

test("detectable difference falls as n grows and stays on the grid", () => {
  for (const rule of ["fisher", "wilson"]) {
    for (const p of [1, 0.9, 0.7]) {
      let prev = Infinity;
      for (const n of [10, 20, 40, 80]) {
        const d = detectableDifference(rule, n, p);
        assert.ok(d !== null && d <= prev + 1e-12, `${rule} ${p} n=${n}`);
        prev = d;
      }
    }
  }
  // 0.3 from a ceiling baseline at the Fisher bar: pinned figures.
  assert.equal(runsForDifference("fisher", 1, 0.3), 21);
  assert.equal(runsForDifference("fisher", 0.7, 0.3), 48);
  assert.equal(runsForDifference("wilson", 0.7, 0.3), 71);
});

test("the power at the reported n really is at least 0.8, and not before", () => {
  const n = runsForDifference("fisher", 0.9, 0.3);
  assert.ok(exactPower("fisher", n, 0.6, 0.9) >= 0.8 - 1e-9);
  assert.ok(exactPower("fisher", n - 1, 0.6, 0.9) < 0.8);
});

test("SPRT bounds are Wald's and its error rates respect them", () => {
  const b = sprtBounds(0.5, 0.8, 0.05, 0.2);
  close(b.accept, Math.log(0.8 / 0.05));
  close(b.reject, Math.log(0.2 / 0.95));
  close(b.up, Math.log(0.8 / 0.5));
  close(b.down, Math.log(0.2 / 0.5));
  const h0 = sprtOperatingCharacteristics(0.5, 0.8, 0.5, 200);
  const h1 = sprtOperatingCharacteristics(0.5, 0.8, 0.8, 200);
  for (const r of [h0, h1]) {
    close(r.acceptH0 + r.acceptH1 + r.undecided, 1, 1e-9);
  }
  assert.ok(h0.acceptH1 <= 0.05 / 0.8 + 1e-9);
  assert.ok(h1.acceptH0 <= 0.2 / 0.95 + 1e-9);
  assert.ok(h1.undecided < 1e-6);
  // Fewer runs than a fixed test on average when H1 is true.
  assert.ok(h1.expectedN < 20);
});

test("SPRT refuses degenerate hypotheses", () => {
  assert.throws(() => sprtBounds(0.8, 0.5), RangeError);
  assert.throws(() => sprtBounds(0.5, 1), RangeError);
});

test("the discordant-pair SPRT is the share test at 0.5", () => {
  const d = sprtDiscordant(0.8, 80);
  assert.ok(d.underNull.acceptH1 <= 0.0625 + 1e-9);
  assert.ok(d.underAlt.acceptH1 >= 0.8 - 0.01);
});

test("Wilson stopping with one look is the fixed rule, extra looks cost type I error", () => {
  const one = wilsonStopping([20], 0.7, 0.7);
  close(
    one.treatBetter + one.controlBetter,
    exactPower("wilson", 20, 0.7, 0.7),
    1e-9,
  );
  const many = wilsonStopping([5, 10, 15, 20], 0.7, 0.7);
  assert.ok(
    many.treatBetter + many.controlBetter >=
      one.treatBetter + one.controlBetter - 1e-12,
  );
  close(many.treatBetter + many.controlBetter + many.undecided, 1, 1e-9);
  // Under a real difference it stops early on average.
  const real = wilsonStopping([10, 20, 30, 40], 0.6, 0.9);
  assert.ok(real.expectedN < 40);
});

test("the table builder renders every table", () => {
  const text = render(buildTables());
  for (const heading of [
    "Smallest difference detected at 80% power, two-sided Fisher",
    "Runs per arm for 80% power, disjoint Wilson",
    "True type I error",
    "SPRT on one arm",
    "SPRT on discordant pairs",
    "Wilson-bound stopping",
  ]) {
    assert.ok(text.includes(heading), heading);
  }
});
