// Sample-size and sequential-stopping tables for the lab's own bars. Pure and
// dependency-free apart from the lab's own Wilson interval; no model, no
// network, nothing written.
//
//   node bench/lab/tools/power.mjs            prints the Markdown tables
//   node bench/lab/tools/power.mjs --json     the same numbers as JSON
//
// Everything is exact: the binomial outcomes of the two arms are enumerated
// (and, for sequential rules, a dynamic program walks every path), so no
// number here is a normal approximation or a simulation.
//
// The two bars of the lab (see bench/lab/README.md and lib/stats.mjs):
//   fisher  two-sided Fisher exact test on two independent arms, alpha 0.05;
//           the standard fixed-n test, used as the yardstick.
//   wilson  `disjoint(wilson(k1, n), wilson(k2, n))`: what `suggest` uses to
//           say native beats text ("only when the intervals are disjoint").
//           Two 95% intervals that do not touch is a much stricter test than
//           alpha 0.05 (its true type I error is about 0.5% to 1.5%), so it
//           needs more runs; the table says how many more.
// `compare` pairs the runs and uses McNemar's exact test on the discordant
// pairs, from 25 pairs; `sprtDiscordant` is the sequential counterpart.
import { fileURLToPath } from "node:url";

import { disjoint, wilson } from "../lib/stats.mjs";

export const ALPHA = 0.05;
export const POWER = 0.8;
const EPS = 1e-9;

const logFactTable = [0, 0];
function logFact(n) {
  for (let i = logFactTable.length; i <= n; i++) {
    logFactTable[i] = logFactTable[i - 1] + Math.log(i);
  }
  return logFactTable[n];
}
const logChoose = (n, r) => logFact(n) - logFact(r) - logFact(n - r);

/** Binomial pmf over 0..n. */
export function binomialPmf(n, p) {
  const out = new Array(n + 1).fill(0);
  if (p <= 0) return ((out[0] = 1), out);
  if (p >= 1) return ((out[n] = 1), out);
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  for (let k = 0; k <= n; k++) {
    out[k] = Math.exp(logChoose(n, k) + k * lp + (n - k) * lq);
  }
  return out;
}

/**
 * Two-sided Fisher exact p for a successes of n1 in arm 1 and c of n2 in arm
 * 2: the total probability of the tables, with the same margins, that are no
 * likelier than the one seen.
 */
export function fisherTwoSided(a, n1, c, n2) {
  const k = a + c;
  const total = n1 + n2;
  const lo = Math.max(0, k - n2);
  const hi = Math.min(n1, k);
  const lp = (x) =>
    logChoose(n1, x) + logChoose(n2, k - x) - logChoose(total, k);
  const seen = lp(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const l = lp(x);
    if (l <= seen + 1e-7) p += Math.exp(l);
  }
  return Math.min(1, p);
}

/** Rule table for n runs per arm: rejects[a][c] says the rule calls a difference. */
const ruleCache = new Map();
function rejectTable(rule, n, alpha) {
  const key = `${rule}/${n}/${alpha}`;
  const hit = ruleCache.get(key);
  if (hit) return hit;
  const intervals = rule === "wilson" ? [] : null;
  if (intervals) for (let k = 0; k <= n; k++) intervals.push(wilson(k, n));
  const table = [];
  for (let a = 0; a <= n; a++) {
    const row = new Array(n + 1);
    for (let c = 0; c <= n; c++) {
      row[c] =
        rule === "wilson"
          ? disjoint(intervals[a], intervals[c])
          : fisherTwoSided(a, n, c, n) <= alpha + EPS;
    }
    table.push(row);
  }
  ruleCache.set(key, table);
  return table;
}

/**
 * Exact power of a rule: the chance it calls a difference (either direction)
 * with n runs per arm when the true rates are p1 and p2. With p1 = p2 it is
 * the true type I error.
 */
export function exactPower(rule, n, p1, p2, alpha = ALPHA) {
  const table = rejectTable(rule, n, alpha);
  const f1 = binomialPmf(n, p1);
  const f2 = binomialPmf(n, p2);
  let power = 0;
  for (let a = 0; a <= n; a++) {
    for (let c = 0; c <= n; c++) if (table[a][c]) power += f1[a] * f2[c];
  }
  return power;
}

/**
 * Smallest absolute difference d (grid 0.01) such that the rule has
 * `power` against the pair (pHigh - d, pHigh): the better arm sits at pHigh,
 * the worse one below it, so a baseline of 1.0 means a control that never
 * fails against a treatment that sometimes does. null when even d = pHigh
 * (the other arm at 0) is not detected.
 */
export function detectableDifference(rule, n, pHigh, power = POWER) {
  for (let step = 1; step <= Math.round(pHigh * 100); step++) {
    const d = step / 100;
    if (exactPower(rule, n, pHigh - d, pHigh) >= power - EPS) return d;
  }
  return null;
}

/**
 * Runs per arm for 80% power against the pair (pHigh - d, pHigh): the first n
 * from which the power stays at or above the target up to `maxN` (the exact
 * power curve is a sawtooth, so the first n that reaches it is not enough).
 * null when `maxN` does not reach it.
 */
export function runsForDifference(rule, pHigh, d, power = POWER, maxN = 200) {
  const lowRate = Math.max(0, pHigh - d);
  let lastBelow = 0;
  let reached = false;
  for (let n = 2; n <= maxN; n++) {
    if (exactPower(rule, n, lowRate, pHigh) < power - EPS) lastBelow = n;
    else reached = true;
  }
  return reached && lastBelow < maxN ? lastBelow + 1 : null;
}

/** Wald's SPRT boundaries on the log likelihood ratio of H1 (p1) to H0 (p0). */
export function sprtBounds(p0, p1, alpha = ALPHA, beta = 1 - POWER) {
  if (!(p0 > 0 && p1 < 1 && p0 < p1)) {
    throw new RangeError("sprt needs 0 < p0 < p1 < 1");
  }
  return {
    accept: Math.log((1 - beta) / alpha),
    reject: Math.log(beta / (1 - alpha)),
    up: Math.log(p1 / p0),
    down: Math.log((1 - p1) / (1 - p0)),
  };
}

/**
 * Exact operating characteristics of the SPRT truncated at `maxN` Bernoulli
 * observations when the true rate is p: the chance it accepts H1, accepts H0
 * or is still undecided at maxN, and the expected number of observations.
 * (Wald's untruncated bounds are alpha/(1-beta) and beta/(1-alpha); the
 * truncation only removes the tail, so the undecided mass is reported, not
 * hidden.)
 */
export function sprtOperatingCharacteristics(
  p0,
  p1,
  p,
  maxN,
  alpha = ALPHA,
  beta = 1 - POWER,
) {
  const b = sprtBounds(p0, p1, alpha, beta);
  // state: successes so far; the log ratio is s*up + (t - s)*down at step t.
  let live = new Map([[0, 1]]);
  let h1 = 0;
  let h0 = 0;
  let expectedN = 0;
  for (let t = 1; t <= maxN; t++) {
    const next = new Map();
    for (const [s, mass] of live) {
      for (const win of [true, false]) {
        const m = mass * (win ? p : 1 - p);
        if (m === 0) continue;
        const s2 = s + (win ? 1 : 0);
        const llr = s2 * b.up + (t - s2) * b.down;
        if (llr >= b.accept - EPS) {
          h1 += m;
          expectedN += m * t;
        } else if (llr <= b.reject + EPS) {
          h0 += m;
          expectedN += m * t;
        } else next.set(s2, (next.get(s2) ?? 0) + m);
      }
    }
    live = next;
  }
  let undecided = 0;
  for (const m of live.values()) undecided += m;
  expectedN += undecided * maxN;
  return { acceptH1: h1, acceptH0: h0, undecided, expectedN };
}

/**
 * The SPRT on discordant pairs, the sequential counterpart of McNemar's exact
 * test that `compare` runs: among pairs where exactly one arm succeeded, the
 * share q that favours arm A is 0.5 under no difference. `qAlt` is the share
 * worth detecting (0.8 is 4 discordant pairs to 1). One-sided: A better.
 */
export function sprtDiscordant(qAlt = 0.8, maxN = 60, alpha = ALPHA) {
  const b = sprtBounds(0.5, qAlt, alpha);
  const under = sprtOperatingCharacteristics(0.5, qAlt, 0.5, maxN, alpha);
  const alt = sprtOperatingCharacteristics(0.5, qAlt, qAlt, maxN, alpha);
  return { bounds: b, underNull: under, underAlt: alt };
}

/**
 * Wilson-bound stopping for two arms that run side by side: after each look
 * (n runs in each arm) call "treatment better" or "control better" as soon as
 * the Wilson intervals of the two arms are disjoint, and stop at the last
 * look with no call. Exact: a dynamic program over (a, c) successes. A look
 * is a count of runs per arm; with a single look it is the fixed-n rule.
 */
export function wilsonStopping(looks, pControl, pTreat) {
  const sorted = [...looks].sort((x, y) => x - y);
  const last = sorted[sorted.length - 1];
  const intervals = [];
  for (let k = 0; k <= last; k++) intervals.push(null);
  const ci = (k, n) => wilson(k, n);
  let mass = new Map([["0,0", 1]]);
  let treatBetter = 0;
  let controlBetter = 0;
  let expectedN = 0;
  for (let n = 1; n <= last; n++) {
    const next = new Map();
    for (const [key, m] of mass) {
      const [a, c] = key.split(",").map(Number);
      for (const [da, pa] of [
        [1, pTreat],
        [0, 1 - pTreat],
      ]) {
        for (const [dc, pc] of [
          [1, pControl],
          [0, 1 - pControl],
        ]) {
          const w = m * pa * pc;
          if (w === 0) continue;
          const k = `${a + da},${c + dc}`;
          next.set(k, (next.get(k) ?? 0) + w);
        }
      }
    }
    mass = next;
    if (!sorted.includes(n)) continue;
    for (const [key, m] of [...mass]) {
      const [a, c] = key.split(",").map(Number);
      const A = ci(a, n);
      const C = ci(c, n);
      if (disjoint(A, C)) {
        if (A.lo > C.hi) treatBetter += m;
        else controlBetter += m;
        expectedN += m * n;
        mass.delete(key);
      }
    }
  }
  let undecided = 0;
  for (const m of mass.values()) undecided += m;
  expectedN += undecided * last;
  return { treatBetter, controlBetter, undecided, expectedN };
}

const fmt = (x, d = 2) => x.toFixed(d);
const cell = (v) => (v === null ? "none" : String(v));

function mdTable(head, rows) {
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [
    line(head),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

export const HIGH_RATES = [1.0, 0.95, 0.9, 0.8, 0.7];
export const RUN_COUNTS = [5, 8, 10, 15, 20, 30, 40, 60, 80, 100];

/** Every table as data; `render` turns it into Markdown. */
export function buildTables() {
  const detectable = {};
  for (const rule of ["fisher", "wilson"]) {
    detectable[rule] = HIGH_RATES.map((p) => ({
      pHigh: p,
      byN: RUN_COUNTS.map((n) => detectableDifference(rule, n, p)),
    }));
  }
  const runs = {};
  for (const rule of ["fisher", "wilson"]) {
    runs[rule] = HIGH_RATES.map((p) => ({
      pHigh: p,
      byD: [0.1, 0.2, 0.3, 0.5].map((d) => runsForDifference(rule, p, d)),
    }));
  }
  const typeI = {};
  for (const rule of ["fisher", "wilson"]) {
    typeI[rule] = [5, 10, 20, 40].map((n) => ({
      n,
      worst: Math.max(
        ...[0.1, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95].map((p) =>
          exactPower(rule, n, p, p),
        ),
      ),
    }));
  }
  const sprt = [
    [0.7, 0.9],
    [0.5, 0.8],
    [0.8, 0.99],
  ].map(([p0, p1]) => {
    const maxN = 60;
    return {
      p0,
      p1: Math.round(p1 * 100) / 100,
      bounds: sprtBounds(p0, p1),
      maxN,
      atP0: sprtOperatingCharacteristics(p0, p1, p0, maxN),
      atP1: sprtOperatingCharacteristics(p0, p1, p1, maxN),
    };
  });
  const discordant = sprtDiscordant(0.8, 60);
  const designs = [
    { name: "ten-twenty-thirty-forty", looks: [10, 20, 30, 40] },
    { name: "single look at 40", looks: [40] },
    { name: "five-ten-fifteen-twenty", looks: [5, 10, 15, 20] },
  ].map((d) => ({
    ...d,
    scenarios: [
      ["none", 0.7, 0.7],
      ["0.3 lift", 0.6, 0.9],
      ["0.2 lift near ceiling", 0.8, 1.0],
    ].map(([label, pc, pt]) => ({
      label,
      pControl: pc,
      pTreat: pt,
      ...wilsonStopping(d.looks, pc, pt),
    })),
  }));
  return { detectable, runs, typeI, sprt, discordant, designs };
}

export function render(t) {
  const out = [];
  const ruleName = {
    fisher: "two-sided Fisher exact, alpha 0.05",
    wilson: "disjoint Wilson 95% intervals (what `suggest` uses)",
  };
  for (const rule of ["fisher", "wilson"]) {
    out.push(
      `### Smallest difference detected at 80% power, ${ruleName[rule]}`,
      "",
      "The better arm's true rate is in the first column; the worse arm is that rate minus the difference. `none` means even 0 against the rate is missed.",
      "",
      mdTable(
        ["Better arm", ...RUN_COUNTS.map((n) => `n=${n}`)],
        t.detectable[rule].map((r) => [
          `${Math.round(r.pHigh * 100)}%`,
          ...r.byN.map((d) => (d === null ? "none" : fmt(d))),
        ]),
      ),
      "",
    );
  }
  for (const rule of ["fisher", "wilson"]) {
    out.push(
      `### Runs per arm for 80% power, ${ruleName[rule]}`,
      "",
      mdTable(
        ["Better arm", "d=0.1", "d=0.2", "d=0.3", "d=0.5"],
        t.runs[rule].map((r) => [
          `${Math.round(r.pHigh * 100)}%`,
          ...r.byD.map(cell),
        ]),
      ),
      "",
    );
  }
  out.push(
    "### True type I error (worst case over rates 0.1 to 0.95)",
    "",
    mdTable(
      ["Rule", "n=5", "n=10", "n=20", "n=40"],
      ["fisher", "wilson"].map((rule) => [
        rule,
        ...t.typeI[rule].map((r) => fmt(r.worst, 3)),
      ]),
    ),
    "",
    "### SPRT on one arm against a bar (alpha 0.05, power 0.8, truncated at 60 runs)",
    "",
    mdTable(
      [
        "H0 rate",
        "H1 rate",
        "Success step",
        "Failure step",
        "Accept H1 at H0",
        "Accept H1 at H1",
        "Expected runs at H0",
        "Expected runs at H1",
        "Undecided at H1",
      ],
      t.sprt.map((s) => [
        fmt(s.p0),
        fmt(s.p1),
        `+${fmt(s.bounds.up, 3)}`,
        fmt(s.bounds.down, 3),
        fmt(s.atP0.acceptH1, 3),
        fmt(s.atP1.acceptH1, 3),
        fmt(s.atP0.expectedN, 1),
        fmt(s.atP1.expectedN, 1),
        fmt(s.atP1.undecided, 3),
      ]),
    ),
    "",
    `The log likelihood ratio starts at 0, adds the success step on a success and the failure step on a failure, stops for H1 at ${fmt(t.sprt[0].bounds.accept, 3)} and for H0 at ${fmt(t.sprt[0].bounds.reject, 3)}.`,
    "",
    "### SPRT on discordant pairs (the sequential McNemar), 4 to 1 in favour of A",
    "",
    mdTable(
      [
        "True share for A",
        "Calls A better",
        "Calls B better",
        "Undecided at 60",
        "Expected discordant pairs",
      ],
      [
        [
          "0.5 (no difference)",
          fmt(t.discordant.underNull.acceptH1, 3),
          fmt(t.discordant.underNull.acceptH0, 3),
          fmt(t.discordant.underNull.undecided, 3),
          fmt(t.discordant.underNull.expectedN, 1),
        ],
        [
          "0.8 (4 to 1)",
          fmt(t.discordant.underAlt.acceptH1, 3),
          fmt(t.discordant.underAlt.acceptH0, 3),
          fmt(t.discordant.underAlt.undecided, 3),
          fmt(t.discordant.underAlt.expectedN, 1),
        ],
      ],
    ),
    "",
    'Here "calls B better" means H0 (the share is at most 0.5) was accepted, which is not evidence that B is better.',
    "",
    "### Wilson-bound stopping, two arms side by side",
    "",
    "Stop as soon as the two arms' Wilson 95% intervals are disjoint; the last look stops with no call.",
    "",
  );
  for (const d of t.designs) {
    out.push(
      `Looks (runs per arm): ${d.looks.join(", ")}`,
      "",
      mdTable(
        [
          "Scenario (control to treatment)",
          "Calls treatment better",
          "Calls control better",
          "No call",
          "Expected runs per arm",
        ],
        d.scenarios.map((s) => [
          `${s.label}, ${fmt(s.pControl)} to ${fmt(s.pTreat)}`,
          fmt(s.treatBetter, 3),
          fmt(s.controlBetter, 3),
          fmt(s.undecided, 3),
          fmt(s.expectedN, 1),
        ]),
      ),
      "",
    );
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tables = buildTables();
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(tables, null, 2)
      : render(tables),
  );
}
