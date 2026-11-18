// `compare`: two result sets (two engines, or two configurations of one
// engine) paired by case id and pass index. Pure functions of the records.
//
// Each case is a paired binary outcome (valid call or not), so the test is
// McNemar's exact test on the discordant pairs: under no difference a
// discordant pair is equally likely to favour either arm, so the smaller of
// the two discordant counts is Binomial(b + c, 1/2). Concordant pairs carry
// no information about which arm is better and are only counted.
// Under MIN_PAIRS pairs the report refuses a verdict (bench/README.md sample
// size section: about 25 runs per arm for a 0.3 difference).
//
// The unit of the pairing matters. At temperature 0 (or with a fixed seed) the
// passes of one prompt repeat the same output, so 8 prompts x 3 passes is 8
// independent pairs, not 24. `compare` therefore pairs at two levels and says
// both: the PASS level (one pair per prompt and pass, the raw n) and the
// PROMPT level (one pair per distinct prompt, the effective n at temperature
// 0). `unit: "prompt" | "pass" | "auto"` picks which one the verdict and the
// headline rates use; "auto" is "prompt" when the records show passes made at
// temperature 0, and "pass" otherwise. The interval for the difference always
// resamples whole prompts (a cluster bootstrap), never single passes.
import { armOf } from "./report.mjs";
import { effectiveCounts, fmtRate, wilson, wilsonP } from "./stats.mjs";

export const MIN_PAIRS = 25;
export const UNITS = ["auto", "prompt", "pass"];

export class CompareError extends Error {}

/** log of n choose k, by summation (n is small: the discordant count). */
const logChoose = (n, k) => {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
};

/** Two-sided exact McNemar p-value for discordant counts b and c. */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  let p = 0;
  for (let k = 0; k <= lo; k++) p += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

/** Small seeded PRNG (mulberry32): the bootstrap interval is reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile interval for (rate B - rate A), resampling PAIRS so the pairing
 * is kept. `diffs` is +1 (B only valid), -1 (A only valid) or 0 per pair.
 */
export function pairedBootstrap(diffs, { reps = 2000, seed = 1 } = {}) {
  return clusterBootstrap(
    diffs.map((d) => [d]),
    { reps, seed },
  );
}

/**
 * The same interval resampling whole clusters: `groups` is one array of pair
 * differences per prompt, so the passes of a prompt stay together and the
 * interval is as wide as the number of prompts allows, not the number of
 * passes.
 */
export function clusterBootstrap(groups, { reps = 2000, seed = 1 } = {}) {
  const g = groups.length;
  if (g === 0) return undefined;
  const rnd = prng(seed);
  const means = [];
  for (let r = 0; r < reps; r++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < g; i++) {
      const grp = groups[Math.floor(rnd() * g)];
      for (const d of grp) s += d;
      n += grp.length;
    }
    means.push(n ? s / n : 0);
  }
  means.sort((x, y) => x - y);
  return {
    lo: means[Math.floor(0.025 * reps)],
    hi: means[Math.min(reps - 1, Math.ceil(0.975 * reps) - 1)],
  };
}

/** The pairing key: what was asked, not who answered. */
export const pairKey = (r) =>
  [r.suite, armOf(r), r.caseId ?? r.key, r.pass ?? 1].join("\u0000");

/** The prompt a record belongs to: the pairing key without the pass. */
export const promptKey = (r) =>
  [r.suite, armOf(r), r.caseId ?? r.key].join("\u0000");

/** The temperature a record was sent with: 0, a number, or "inherited". */
export const tempOf = (r) =>
  r.sampling?.temperature ?? r.cfg?.temperature ?? r.temperature;

/** Records for the comparison: not the cache suite, one model. */
function side(records, model, label) {
  const scored = records.filter((r) => r.kind !== "cache");
  const models = [...new Set(scored.map((r) => r.model))];
  if (model) {
    const keep = scored.filter((r) => r.model === model);
    if (!keep.length)
      throw new CompareError(
        `${label}: no records for model ${model} (have ${models.join(", ") || "none"})`,
      );
    return { all: keep, models: [model] };
  }
  if (models.length > 1)
    throw new CompareError(
      `${label} holds ${models.length} models (${models.join(", ")}); pick one with --model-${label.toLowerCase()}`,
    );
  return { all: scored, models };
}

/** Counts of a list of {a, b} validity pairs. */
function tally(pairs) {
  const onlyA = pairs.filter((x) => x.a && !x.b);
  const onlyB = pairs.filter((x) => !x.a && x.b);
  return {
    n: pairs.length,
    va: pairs.filter((x) => x.a).length,
    vb: pairs.filter((x) => x.b).length,
    onlyA,
    onlyB,
    both: pairs.filter((x) => x.a && x.b).length,
    neither: pairs.filter((x) => !x.a && !x.b).length,
  };
}

/**
 * Pair two record sets. Returns counts, per-arm rates, discordant counts,
 * the exact McNemar p-value, the bootstrap interval, the flipped cases and
 * the verdict, at the chosen unit (`unit`: prompt, pass or auto), plus the
 * pass-level (`raw`) and prompt-level (`prompts`) figures side by side.
 */
export function compareRuns(recsA, recsB, opts = {}) {
  const wanted = opts.unit ?? "auto";
  if (!UNITS.includes(wanted))
    throw new CompareError(`unit must be one of ${UNITS.join(", ")}`);
  const A = side(recsA, opts.modelA, "A");
  const B = side(recsB, opts.modelB, "B");
  const index = (rs) => {
    const m = new Map();
    let errors = 0;
    let duplicates = 0;
    for (const r of rs) {
      if (r.outcome === "error") {
        errors++;
        continue;
      }
      if (!r.score) continue;
      const k = pairKey(r);
      if (m.has(k)) duplicates++;
      else m.set(k, r);
    }
    return { m, errors, duplicates };
  };
  const ia = index(A.all);
  const ib = index(B.all);
  const pairs = [];
  for (const [k, ra] of ia.m) {
    const rb = ib.m.get(k);
    if (rb) pairs.push({ key: k, a: ra, b: rb });
  }
  const passPairs = pairs.map((x) => ({
    a: x.a.score.valid,
    b: x.b.score.valid,
    x,
  }));
  const raw = tally(passPairs);

  // the prompt level: one binary per prompt and side, by majority of passes
  const byPrompt = new Map();
  for (const p of pairs) {
    const k = promptKey(p.a);
    if (!byPrompt.has(k)) byPrompt.set(k, []);
    byPrompt.get(k).push(p);
  }
  const prompts = [];
  const unstable = [];
  for (const [k, ps] of byPrompt) {
    const m = ps.length;
    const va = ps.filter((p) => p.a.score.valid).length;
    const vb = ps.filter((p) => p.b.score.valid).length;
    const verdictOf = (v) => (2 * v > m ? true : 2 * v < m ? false : undefined);
    const a = verdictOf(va);
    const b = verdictOf(vb);
    const row = { key: k, first: ps[0].a, m, va, vb };
    if (a === undefined || b === undefined) unstable.push({ ...row, a, b });
    else prompts.push({ ...row, a, b });
  }
  const pr = tally(prompts);
  const promptsAll = byPrompt.size;
  const maxPasses = Math.max(0, ...[...byPrompt.values()].map((p) => p.length));
  // "auto" trusts only what the records say: passes made at temperature 0
  const t0 =
    maxPasses > 1 &&
    pairs.some((p) => tempOf(p.a) === 0 || tempOf(p.b) === 0) &&
    !pairs.some(
      (p) =>
        (typeof tempOf(p.a) === "number" && tempOf(p.a) > 0) ||
        (typeof tempOf(p.b) === "number" && tempOf(p.b) > 0),
    );
  const unit = wanted === "auto" ? (t0 ? "prompt" : "pass") : wanted;

  // effective n of the discordance indicator: how many independent pairs the
  // passes amount to (the prompt count when the passes of a prompt agree)
  const eff = effectiveCounts(
    [...byPrompt.values()].map((ps) => ({
      m: ps.length,
      s: ps.filter((p) => p.a.score.valid !== p.b.score.valid).length,
    })),
  );
  const clusterDiffs = [...byPrompt.values()].map((ps) =>
    ps.map((p) => Number(p.b.score.valid) - Number(p.a.score.valid)),
  );
  const promptDiffs = prompts.map((x) => [Number(x.b) - Number(x.a)]);

  const T = unit === "prompt" ? pr : raw;
  const flipped =
    unit === "prompt"
      ? [...pr.onlyA, ...pr.onlyB].map((x) => ({
          case: x.first.caseId ?? x.key,
          arm: armOf(x.first),
          pass: undefined,
          passes: x.m,
          from: x.a,
          to: x.b,
          outcomeA: `${x.va}/${x.m} valid`,
          outcomeB: `${x.vb}/${x.m} valid`,
        }))
      : [...raw.onlyA, ...raw.onlyB].map(({ x }) => ({
          case: x.a.caseId ?? x.key,
          arm: armOf(x.a),
          pass: x.a.pass,
          from: x.a.score.valid,
          to: x.b.score.valid,
          outcomeA: x.a.outcome,
          outcomeB: x.b.outcome,
        }));
  const p = mcnemarExact(T.onlyA.length, T.onlyB.length);
  const n = T.n;
  const enough = n >= MIN_PAIRS;
  const disc = T.onlyA.length + T.onlyB.length;
  const what = unit === "prompt" ? "prompt" : "paired result";
  let verdict;
  if (!enough)
    verdict = `NOT ENOUGH PAIRS: ${n} ${unit === "prompt" ? "prompt(s)" : "paired result(s)"}, at least ${MIN_PAIRS} are needed for a claim about a 0.3 difference (bench/README.md, sample size). Report the rates, make no statement about which arm is ahead.`;
  else if (p < 0.05)
    verdict = `${T.vb > T.va ? "B" : "A"} is better: exact McNemar p = ${p.toFixed(4)} on ${disc} discordant ${what}(s).`;
  else
    verdict = `No detectable difference: exact McNemar p = ${p.toFixed(4)} on ${disc} discordant ${what}(s). This is not evidence that the arms are equal.`;
  if (unit === "pass" && eff.n < MIN_PAIRS && raw.n >= MIN_PAIRS)
    verdict += ` CAUTION: ${raw.n} raw pairs come from ${promptsAll} distinct prompt(s) and amount to about ${eff.n.toFixed(1)} independent pairs (passes of one prompt are correlated); the p-value treats them as independent and is too small. Re-run with --unit prompt.`;
  if (unit === "pass" && t0)
    verdict += ` Passes at temperature 0 repeat the same output.`;

  // pass unit: the interval is on each side's effective n, raw counts kept
  const effSide = (key) => {
    const e = effectiveCounts(
      [...byPrompt.values()].map((ps) => ({
        m: ps.length,
        s: ps.filter((q) => q[key].score.valid).length,
      })),
    );
    if (!e.rawN) return wilson(0, 0);
    const r = e.rawK / e.rawN;
    return {
      k: r * e.n,
      n: e.n,
      rate: r,
      ...wilsonP(r, e.n),
      rawK: e.rawK,
      rawN: e.rawN,
      units: e.units,
    };
  };
  const rate = (k, nn, key) =>
    unit === "prompt" ? wilson(k, nn) : effSide(key);
  return {
    unit,
    pairs: n,
    enough,
    rateA: rate(T.va, n, "a"),
    rateB: rate(T.vb, n, "b"),
    onlyA: T.onlyA.length,
    onlyB: T.onlyB.length,
    both: T.both,
    neither: T.neither,
    p,
    delta: n ? (T.vb - T.va) / n : undefined,
    bootstrap: clusterBootstrap(
      unit === "prompt" ? promptDiffs : clusterDiffs,
      opts.bootstrap,
    ),
    flipped,
    raw: {
      pairs: raw.n,
      prompts: promptsAll,
      effectiveN: eff.n,
      rho: eff.rho,
      onlyA: raw.onlyA.length,
      onlyB: raw.onlyB.length,
      both: raw.both,
      neither: raw.neither,
      p: mcnemarExact(raw.onlyA.length, raw.onlyB.length),
      rateA: wilson(raw.va, raw.n),
      rateB: wilson(raw.vb, raw.n),
    },
    byPrompt: {
      prompts: pr.n,
      unstable: unstable.length,
      onlyA: pr.onlyA.length,
      onlyB: pr.onlyB.length,
      both: pr.both,
      neither: pr.neither,
      p: mcnemarExact(pr.onlyA.length, pr.onlyB.length),
      rateA: wilson(pr.va, pr.n),
      rateB: wilson(pr.vb, pr.n),
      bootstrap: clusterBootstrap(promptDiffs, opts.bootstrap),
      unstableCases: unstable.map((x) => x.first.caseId ?? x.key),
    },
    temperature0: t0,
    unpaired: { a: ia.m.size - pairs.length, b: ib.m.size - pairs.length },
    errors: { a: ia.errors, b: ib.errors },
    duplicates: { a: ia.duplicates, b: ib.duplicates },
    models: { a: A.models[0], b: B.models[0] },
    verdict,
  };
}

const pts = (x) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)} pts`;
const intervalText = (b) =>
  b ? `, cluster bootstrap 95% interval [${pts(b.lo)}, ${pts(b.hi)}]` : "";

export function formatCompare(res, labels = ["A", "B"]) {
  const [la, lb] = labels;
  const unitName = res.unit === "prompt" ? "prompt" : "pass";
  const L = [
    `# Lab compare: ${la} vs ${lb}`,
    "",
    `**Verdict:** ${res.verdict}`,
    "",
    `Arms: A = ${la}${res.models.a ? ` (${res.models.a})` : ""}, B = ${lb}${res.models.b ? ` (${res.models.b})` : ""}. Pairs are matched on suite, arm, case id and pass index.`,
    "",
    `**Sample size.** Raw n: ${res.raw.pairs} paired result(s). Distinct prompts: ${res.raw.prompts}. Effective n: ${res.raw.effectiveN.toFixed(1)} (passes of one prompt are correlated; at temperature 0 they repeat, so the prompt count is the n). The verdict and the rates below are at the **${unitName}** unit${res.temperature0 ? " (temperature 0 seen in the records: passes repeat)" : ""}; n = ${res.pairs}.`,
    "",
    `| arm | valid-call rate on the ${unitName} pairs (Wilson 95%) |`,
    "| --- | --- |",
    `| A ${la} | ${fmtRate(res.rateA)} |`,
    `| B ${lb} | ${fmtRate(res.rateB)} |`,
    "",
  ];
  if (res.pairs) {
    L.push(
      `Difference B - A: ${pts(res.delta)}${intervalText(res.bootstrap)} (whole prompts are resampled).`,
      "",
      "| | B valid | B invalid |",
      "| --- | ---: | ---: |",
      `| **A valid** | ${res.both} | ${res.onlyA} |`,
      `| **A invalid** | ${res.onlyB} | ${res.neither} |`,
      "",
      `McNemar exact (two-sided) on the discordant ${unitName}s ${res.onlyA} and ${res.onlyB}: p = ${res.p.toFixed(4)}.`,
      "",
    );
  }
  L.push(
    "## Both levels",
    "",
    "| level | n | A valid | B valid | discordant A only / B only | McNemar exact p |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    `| per pass (raw n) | ${res.raw.pairs} | ${res.raw.rateA.k} | ${res.raw.rateB.k} | ${res.raw.onlyA} / ${res.raw.onlyB} | ${res.raw.p.toFixed(4)} |`,
    `| per prompt (effective n at temperature 0) | ${res.byPrompt.prompts} | ${res.byPrompt.rateA.k} | ${res.byPrompt.rateB.k} | ${res.byPrompt.onlyA} / ${res.byPrompt.onlyB} | ${res.byPrompt.p.toFixed(4)} |`,
    "",
  );
  if (res.byPrompt.unstable)
    L.push(
      `${res.byPrompt.unstable} prompt(s) left out of the prompt level because a side's passes split evenly (valid in half): ${res.byPrompt.unstableCases.join(", ")}.`,
      "",
    );
  L.push(
    "A prompt counts as valid on a side when more than half of its passes were valid.",
    "",
    `## Cases that flipped (${res.flipped.length})`,
    "",
    `One line per discordant ${unitName}.`,
    "",
  );
  for (const f of res.flipped)
    L.push(
      f.pass === undefined
        ? `- ${f.case} [${f.arm}] over ${f.passes} pass(es): A ${f.from ? "valid" : "invalid"} (${f.outcomeA}), B ${f.to ? "valid" : "invalid"} (${f.outcomeB})`
        : `- ${f.case} [${f.arm}] pass ${f.pass}: A ${f.from ? "valid" : "invalid"} (${f.outcomeA}), B ${f.to ? "valid" : "invalid"} (${f.outcomeB})`,
    );
  if (!res.flipped.length) L.push("None.");
  const notes = [];
  if (res.unpaired.a || res.unpaired.b)
    notes.push(
      `Not paired (present on one side only): ${res.unpaired.a} in A, ${res.unpaired.b} in B.`,
    );
  if (res.errors.a || res.errors.b)
    notes.push(
      `Errors left out of the pairs: ${res.errors.a} in A, ${res.errors.b} in B.`,
    );
  if (res.duplicates.a || res.duplicates.b)
    notes.push(
      `Duplicate keys ignored (first kept): ${res.duplicates.a} in A, ${res.duplicates.b} in B.`,
    );
  L.push(
    "",
    ...notes,
    "",
    "Both arms are measured on the same cases, so only discordant pairs say which is better. Token counts differ between engines: compare validity, not token or cache counters.",
  );
  return L.join("\n") + "\n";
}
