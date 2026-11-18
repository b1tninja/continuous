// Interval maths for the reports. Pure. Own copy of the Wilson interval so the
// lab needs nothing from the product (the product keeps its own in
// core/llm/toolDialects/capture/stats.ts and bench/src/wilson.mjs).
export const Z95 = 1.959963984540054;

/** Wilson score interval for k successes in n trials; whole range when n is 0. */
export function wilson(k, n, z = Z95) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || k > n)
    throw new RangeError(`wilson needs integers 0 <= k <= n, got ${k}/${n}`);
  if (n === 0) return { k, n, rate: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    k,
    n,
    rate: p,
    lo: Math.max(0, centre - margin),
    hi: Math.min(1, centre + margin),
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const cnt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/**
 * "2/8 = 25% [7%, 59%]"; "0/0 = n/a" with no trials. An effective rate (see
 * `effectiveRate`) also says the raw count it was reduced from:
 * "6/8 = 75% [41%, 93%] (raw 18/24, 8 prompts)".
 */
export function fmtRate(r) {
  if (!r || r.n === 0) return "0/0 = n/a";
  const base = `${cnt(r.k)}/${cnt(r.n)} = ${pct(r.rate)} [${pct(r.lo)}, ${pct(r.hi)}]`;
  if (r.rawN === undefined || (r.rawN === r.n && r.units === r.n)) return base;
  return `${base} (raw ${r.rawK}/${r.rawN}, ${r.units} prompt${r.units === 1 ? "" : "s"})`;
}

/** Wilson interval for a proportion p over a real-valued n (an effective n). */
export function wilsonP(p, n, z = Z95) {
  if (n <= 0) return { lo: 0, hi: 1 };
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

/**
 * Effective sample size of a rate from clustered binary results.
 * `units` is one { m, s } per distinct prompt: m requests made, s successes.
 * Passes of one prompt are not independent: at temperature 0 (or a fixed
 * seed) they repeat the same output, and at temperature above 0 they share
 * the prompt's difficulty. The design effect 1 + (mbar - 1) * rho, with rho the
 * one-way ANOVA intraclass correlation of the passes within a prompt, turns
 * the raw n into n_eff = n / deff, never below the number of prompts and never
 * above the raw n. When no prompt's passes ever disagree rho is 1 and n_eff is
 * the number of prompts: the 8 prompts x 3 passes at temperature 0 case. `agreed`
 * says that is why (no disagreement seen), as opposed to too few prompts to
 * estimate rho (one prompt), where rho is taken as 1 as the safe side.
 */
export function effectiveCounts(units) {
  const u = units.length;
  const N = units.reduce((a, x) => a + x.m, 0);
  const S = units.reduce((a, x) => a + x.s, 0);
  if (N === 0)
    return { n: 0, rawN: 0, rawK: 0, units: 0, rho: 0, deff: 1, agreed: false };
  let rho = 0;
  let agreed = false;
  if (N > u) {
    // some prompt was asked more than once
    const p = S / N;
    const dfW = N - u;
    const msw = units.reduce((a, x) => a + x.s * (1 - x.s / x.m), 0) / dfW;
    agreed = msw === 0;
    if (u < 2 || msw === 0) rho = 1;
    else {
      const msb =
        units.reduce((a, x) => a + x.m * (x.s / x.m - p) ** 2, 0) / (u - 1);
      const m0 = (N - units.reduce((a, x) => a + x.m * x.m, 0) / N) / (u - 1);
      rho = Math.min(1, Math.max(0, (msb - msw) / (msb + (m0 - 1) * msw)));
    }
  }
  const deff = 1 + (N / u - 1) * rho;
  const n = Math.min(N, Math.max(u, N / deff));
  return { n, rawN: N, rawK: S, units: u, rho, deff, agreed };
}

/**
 * The rate of `pred` over `records`, counting distinct prompts (`unit(r)`,
 * default the case id) rather than requests: { k, n, rate, lo, hi } where n is
 * the effective n, plus rawK, rawN, units, rho and `repeats` (true when the
 * passes of every repeated prompt agreed, so n_eff is the prompt count).
 */
export function effectiveRate(records, pred, unit = (r) => r.caseId ?? r.key) {
  const by = new Map();
  let anon = 0;
  for (const r of records) {
    // a record with no prompt identity is its own unit
    const k = unit(r) ?? `anonymous record #${anon++}`;
    const x = by.get(k) ?? { m: 0, s: 0 };
    x.m++;
    if (pred(r)) x.s++;
    by.set(k, x);
  }
  const e = effectiveCounts([...by.values()]);
  if (e.rawN === 0) return { ...wilson(0, 0), ...e, repeats: false };
  const rate = e.rawK / e.rawN;
  return {
    k: rate * e.n,
    n: e.n,
    rate,
    ...wilsonP(rate, e.n),
    rawK: e.rawK,
    rawN: e.rawN,
    units: e.units,
    rho: e.rho,
    repeats: e.rawN > e.units && e.agreed,
  };
}

/** Whether two intervals are disjoint: the cheap "this moved" test. */
export function disjoint(a, b) {
  if (!a || !b || a.n === 0 || b.n === 0) return false;
  return a.hi < b.lo || b.hi < a.lo;
}

export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export const rate = (k, n) => wilson(k, n);
