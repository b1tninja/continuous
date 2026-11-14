// Scoring for env-shell-tasks results: per (model, arm) rates with Wilson
// intervals, and paired comparisons of every arm against a baseline arm over
// the same (task, rep) pairs, using the lab's exact McNemar test and paired
// bootstrap (lib/compare.mjs). Pure over an array of run records.
import { clusterBootstrap, mcnemarExact } from "../lib/compare.mjs";
import { fmtRate, median, wilson } from "../lib/stats.mjs";

const key = (r) => `${r.task}\u0000${r.rep}`;

/** Group records by model and arm. */
export function groupRuns(records) {
  const m = new Map();
  for (const r of records) {
    const k = `${r.model}\u0000${r.arm}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Metrics for one set of runs (one model, one arm). Rates are over runs;
 * `firstTryFail` is over runs that issued at least one command. Cost needs
 * prices in USD per million tokens, `{ in, out }`.
 */
export function metrics(runs, price) {
  const n = runs.length;
  const solved = runs.filter((r) => r.pass);
  const withCmd = runs.filter((r) => r.firstTryFailed !== null);
  const tokens = (r) => r.usage.promptTokens + r.usage.completionTokens;
  const cost = price
    ? sum(
        runs.map(
          (r) =>
            (r.usage.promptTokens * price.in +
              r.usage.completionTokens * price.out) /
            1e6,
        ),
      )
    : null;
  const classes = {};
  for (const r of runs)
    for (const [c, k] of Object.entries(r.classes ?? {}))
      classes[c] = (classes[c] ?? 0) + k;
  return {
    n,
    success: wilson(solved.length, n),
    firstTryFail: wilson(
      withCmd.filter((r) => r.firstTryFailed).length,
      withCmd.length,
    ),
    anyFail: wilson(runs.filter((r) => r.failedCommands > 0).length, n),
    medianTurns: median(runs.map((r) => r.turns)),
    medianExtraCommands: median(runs.map((r) => r.extraCommands)),
    tokensPerSolved: solved.length
      ? sum(runs.map(tokens)) / solved.length
      : null,
    costPerSolved: cost !== null && solved.length ? cost / solved.length : null,
    translationRetriesPerRun: n
      ? sum(runs.map((r) => r.translationRetries)) / n
      : 0,
    oscillation: wilson(runs.filter((r) => r.familyFlips >= 2).length, n),
    rejectedPerRun: n ? sum(runs.map((r) => r.rejected)) / n : 0,
    hintedPerRun: n ? sum(runs.map((r) => r.hinted)) / n : 0,
    hangs: classes.hang ?? 0,
    classes,
  };
}

/**
 * Paired comparison of arm B against arm A for one model: pairs are
 * (task, rep). Returns the discordant counts, the exact McNemar p, and a
 * bootstrap interval for the success-rate difference, for success and for
 * "first command failed" (where lower is better, so the sign is flipped to
 * keep "positive = B better" for both).
 */
export function pairedCompare(runsA, runsB) {
  const a = new Map(runsA.map((r) => [key(r), r]));
  const pairs = [];
  for (const rb of runsB) {
    const ra = a.get(key(rb));
    if (ra) pairs.push([ra, rb]);
  }
  const one = (okA, okB) => {
    let b = 0; // only B ok
    let c = 0; // only A ok
    const diffs = [];
    const byTask = new Map();
    for (const [ra, rb] of pairs) {
      const x = okA(ra);
      const y = okB(rb);
      if (x === null || y === null) continue;
      if (y && !x) b++;
      if (x && !y) c++;
      diffs.push(Number(y) - Number(x));
      if (!byTask.has(ra.task)) byTask.set(ra.task, []);
      byTask.get(ra.task).push(Number(y) - Number(x));
    }
    return {
      pairs: diffs.length,
      onlyB: b,
      onlyA: c,
      p: mcnemarExact(b, c),
      diff: diffs.length ? sum(diffs) / diffs.length : 0,
      // resample whole tasks: the reps of a task are not independent draws
      ci: clusterBootstrap([...byTask.values()]),
    };
  };
  return {
    pairs: pairs.length,
    success: one(
      (r) => r.pass,
      (r) => r.pass,
    ),
    firstTry: one(
      (r) => (r.firstTryFailed === null ? null : !r.firstTryFailed),
      (r) => (r.firstTryFailed === null ? null : !r.firstTryFailed),
    ),
  };
}

/**
 * Exact power of the McNemar test for `n` pairs when a fraction `onlyB` of
 * pairs are solved by B only and `onlyA` by A only (discordant probabilities).
 */
export function pairedPower(n, onlyA, onlyB, alpha = 0.05) {
  const q = onlyA + onlyB;
  if (q <= 0) return 0;
  const pb = onlyB / q;
  const lf = [0];
  for (let i = 1; i <= n; i++) lf.push(lf[i - 1] + Math.log(i));
  const lc = (nn, k) => lf[nn] - lf[k] - lf[nn - k];
  let power = 0;
  for (let d = 1; d <= n; d++) {
    const pd = Math.exp(lc(n, d) + d * Math.log(q) + (n - d) * Math.log(1 - q));
    if (pd < 1e-14) continue;
    let rej = 0;
    for (let b = 0; b <= d; b++) {
      if (mcnemarExact(b, d - b) < alpha)
        rej += Math.exp(
          lc(d, b) +
            (b ? b * Math.log(pb) : 0) +
            (d - b ? (d - b) * Math.log(1 - pb) : 0),
        );
    }
    power += pd * rej;
  }
  return power;
}

const f1 = (x) => (x === null || x === undefined ? "n/a" : x.toFixed(1));
const f3 = (x) => (x === null ? "n/a" : x.toFixed(3));

/** Markdown report. `baseline` is the arm id to compare every other arm to. */
export function formatReport(records, { baseline = "A0", price } = {}) {
  const groups = groupRuns(records);
  const models = [...new Set(records.map((r) => r.model))];
  const out = [];
  for (const model of models) {
    out.push(`## ${model}`, "");
    out.push(
      "| arm | n | success | first command failed | any failed | median turns | tokens per solved | cost per solved (USD) | translation retries per run | oscillating runs | hangs |",
    );
    out.push(
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    const arms = [
      ...new Set(records.filter((r) => r.model === model).map((r) => r.arm)),
    ].sort();
    for (const arm of arms) {
      const m = metrics(groups.get(`${model}\u0000${arm}`), price);
      out.push(
        `| ${arm} | ${m.n} | ${fmtRate(m.success)} | ${fmtRate(m.firstTryFail)} | ${fmtRate(m.anyFail)} | ${f1(m.medianTurns)} | ${m.tokensPerSolved === null ? "n/a" : Math.round(m.tokensPerSolved)} | ${f3(m.costPerSolved)} | ${m.translationRetriesPerRun.toFixed(2)} | ${fmtRate(m.oscillation)} | ${m.hangs} |`,
      );
    }
    out.push("");
    const base = groups.get(`${model}\u0000${baseline}`);
    if (base) {
      out.push(
        `Paired against ${baseline} (positive = the arm is better; pairs are task x rep):`,
        "",
      );
      out.push(
        "| arm | pairs | success: only arm / only " +
          baseline +
          " | diff [95% bootstrap over tasks] | exact McNemar p | first command ok: only arm / only " +
          baseline +
          " | diff [95%] | p |",
      );
      out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const arm of arms.filter((a) => a !== baseline)) {
        const c = pairedCompare(base, groups.get(`${model}\u0000${arm}`));
        const ci = (x) =>
          x.ci
            ? `${x.diff >= 0 ? "+" : ""}${x.diff.toFixed(2)} [${x.ci.lo.toFixed(2)}, ${x.ci.hi.toFixed(2)}]`
            : "n/a";
        const caution = c.pairs < 25 ? " (screening: under 25 pairs)" : "";
        out.push(
          `| ${arm} | ${c.pairs}${caution} | ${c.success.onlyB} / ${c.success.onlyA} | ${ci(c.success)} | ${c.success.p.toFixed(3)} | ${c.firstTry.onlyB} / ${c.firstTry.onlyA} | ${ci(c.firstTry)} | ${c.firstTry.p.toFixed(3)} |`,
        );
      }
      out.push("");
    }
    const classes = {};
    for (const r of records.filter((x) => x.model === model))
      for (const [cl, k] of Object.entries(r.classes ?? {})) {
        classes[r.arm] ??= {};
        classes[r.arm][cl] = (classes[r.arm][cl] ?? 0) + k;
      }
    out.push("Failed commands by class (counts):", "");
    const all = [
      ...new Set(Object.values(classes).flatMap((c) => Object.keys(c))),
    ].sort();
    out.push(
      `| arm | ${all.join(" | ") || "none"} |`,
      `| --- | ${all.map(() => "---").join(" | ") || "---"} |`,
    );
    for (const arm of arms)
      out.push(
        `| ${arm} | ${all.map((c) => classes[arm]?.[c] ?? 0).join(" | ")} |`,
      );
    out.push("");
  }
  return out.join("\n");
}
