// Markdown reports from result records: per model and per case-group, with
// Wilson 95% intervals. Pure functions of the records.
import { effectiveRate, fmtRate, median, wilson } from "./stats.mjs";

const OUTCOMES = [
  "structured",
  "text-call",
  "format-broken",
  "refused",
  "prose",
];

/** Records without errors (errors stay out of every denominator). */
export const usable = (records) => records.filter((r) => r.outcome !== "error");

function groupBy(records, keyFn) {
  const m = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

const count = (rs, f) => rs.filter(f).length;
/** Rate of `f` counted over distinct prompts (effective n), raw counts kept. */
const rateOf = (rs, f) => effectiveRate(rs, f);
const num = (x, d = 0) => (x == null ? "-" : x.toFixed(d));
const cnt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/** Key of the arm a record belongs to: what was varied, not what was asked. */
export function armOf(r) {
  if (r.kind === "prompt-variants")
    return `${r.variant} / ${r.mode}${r.style ? "-" + r.style : ""}`;
  if (r.kind === "leaks")
    return `${r.stream ? "stream" : "whole"} t=${r.temperature} tools=${r.meta?.toolCount}`;
  if (r.kind === "reviewer") return "reviewer";
  return r.mode === "text" ? `text / ${r.style}` : "native";
}

function metricsRow(rs) {
  const outcomes = OUTCOMES.map((o) => count(rs, (r) => r.outcome === o));
  const withCalls = rs.filter((r) => r.score);
  return {
    n: rs.length,
    nEff: rateOf(rs, () => true).n,
    valid: rateOf(withCalls, (r) => r.score.valid),
    schema: rateOf(
      withCalls.filter((r) => !r.score.falseCall && r.calls.length),
      (r) => r.score.schemaValid,
    ),
    falseCalls: rateOf(
      rs.filter((r) => r.expectNone && r.score),
      (r) => r.score.falseCall,
    ),
    outcomes,
    tokens: median(rs.map((r) => r.usage?.outputTokens)),
    latency: median(rs.map((r) => r.ms)),
    tps: median(rs.map((r) => r.tps)),
  };
}

function table(head, rows) {
  return [
    "| " + head.join(" | ") + " |",
    "| " + head.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ") + " |",
    ...rows.map((r) => "| " + r.join(" | ") + " |"),
  ].join("\n");
}

function armsTable(records, keyFn, label) {
  const rows = [];
  for (const [k, rs] of [...groupBy(records, keyFn)].sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  )) {
    const m = metricsRow(rs);
    rows.push([
      k,
      m.n,
      cnt(m.nEff),
      fmtRate(m.valid),
      m.falseCalls.n ? fmtRate(m.falseCalls) : "-",
      ...m.outcomes,
      num(m.tokens),
      num(m.latency),
      num(m.tps, 1),
    ]);
  }
  return table(
    [
      label,
      "n raw",
      "n effective",
      "valid call (95% CI, effective n)",
      "false calls (no-tool cases)",
      ...OUTCOMES,
      "median tokens",
      "median ms",
      "tok/s",
    ],
    rows,
  );
}

function reviewerSection(records) {
  const out = ["### Reviewer verdicts", ""];
  const rows = [];
  for (const [cls, rs] of [...groupBy(records, (r) => r.group)].sort()) {
    const dec = (d) => count(rs, (r) => r.score?.decision === d);
    rows.push([
      cls,
      rs.length,
      cnt(rateOf(rs, () => true).n),
      fmtRate(rateOf(rs, (r) => r.score?.valid)),
      dec("allow"),
      dec("ask"),
      dec("deny"),
      count(rs, (r) => r.score?.unusable),
    ]);
  }
  out.push(
    table(
      [
        "labelled",
        "n raw",
        "n effective",
        "acceptable (95% CI)",
        "allow",
        "ask",
        "deny",
        "unusable",
      ],
      rows,
    ),
  );
  const risky = records.filter((r) => r.score?.dangerousAllow);
  out.push(
    "",
    `Dangerous allows (a deny or ask case the model allowed): ${fmtRate(
      rateOf(
        records.filter((r) => r.group !== "allow"),
        (r) => r.score?.dangerousAllow,
      ),
    )}`,
  );
  if (risky.length)
    out.push("", "Cases: " + risky.map((r) => r.caseId).join(", "));
  return out;
}

function recoverySection(records) {
  const text = records.filter(
    (r) => r.outcome === "text-call" || r.outcome === "format-broken",
  );
  if (!text.length) return [];
  const tally = new Map();
  for (const r of text)
    for (const d of r.recoveredBy ?? []) tally.set(d, (tally.get(d) ?? 0) + 1);
  const out = [
    "### Text replies and the parsers",
    "",
    `${text.length} replies carried tool markup in the text. Recovered by at least one parser: ${fmtRate(
      wilson(
        count(text, (r) => r.recoveredBy?.length > 0),
        text.length,
      ),
    )}.`,
    "",
  ];
  if (tally.size)
    out.push(
      table(
        ["parser", "replies it recovered"],
        [...tally].sort((a, b) => b[1] - a[1]).map(([d, n]) => [d, n]),
      ),
      "",
    );
  return out;
}

/** The report for a set of records (any mix of suites and models). */
export function buildReport(records, { title = "Local lab report" } = {}) {
  const L = [`# ${title}`, ""];
  const errs = records.length - usable(records).length;
  const ok = usable(records);
  L.push(
    `${records.length} records, ${errs} errors (errors are excluded from every rate). Rates are k/n with a Wilson 95% interval computed on the EFFECTIVE n: passes of one prompt are not independent, so n counts distinct prompts (a rate whose passes all agreed, as at temperature 0, has n = the number of prompts; otherwise n is the raw n divided by the design effect, never below the prompt count). Every rate shows its raw count after the interval whenever the two differ.`,
    "",
  );
  for (const [suite, srs] of groupBy(ok, (r) => r.suite)) {
    L.push(`## Suite: ${suite}`, "");
    for (const [model, ms] of groupBy(srs, (r) => r.model)) {
      L.push(`### ${model}`, "");
      if (ms[0].kind === "reviewer") {
        L.push(...reviewerSection(ms), "");
        continue;
      }
      L.push(
        "By arm:",
        "",
        armsTable(ms, armOf, "arm"),
        "",
        "By case group:",
        "",
        armsTable(ms, (r) => `${r.group} (${armOf(r)})`, "group"),
        "",
      );
      const repeated = [...groupBy(ms, armOf)]
        .filter(([, rs]) => metricsRow(rs).valid.repeats)
        .map(([k]) => k);
      if (repeated.length)
        L.push(
          `REPEATS: the passes of every repeated prompt agreed in ${repeated.length} arm(s) (${repeated.join("; ")}). At temperature 0, or with a fixed seed, a pass repeats the same output, so n there is the number of distinct prompts, not the number of requests; the raw count is shown beside each rate.`,
          "",
        );
      L.push(...recoverySection(ms));
    }
  }
  if (!ok.length) L.push("No usable records.", "");
  return L.join("\n");
}

export { median, metricsRow, groupBy, count };
