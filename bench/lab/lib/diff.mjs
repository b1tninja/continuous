// `diff`: two result files (before and after a prompt change) side by side.
import { armOf, groupBy, usable } from "./report.mjs";
import { disjoint, effectiveRate, fmtRate } from "./stats.mjs";

const validRate = (rs) => {
  const scored = rs.filter((r) => r.score);
  return effectiveRate(scored, (r) => r.score.valid);
};

/** Rows of {model, arm, a, b, delta, moved}; moved = the intervals do not overlap. */
export function diffArms(before, after) {
  const A = groupBy(usable(before), (r) => `${r.model}\u0000${armOf(r)}`);
  const B = groupBy(usable(after), (r) => `${r.model}\u0000${armOf(r)}`);
  const rows = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const [model, arm] = k.split("\u0000");
    const a = A.has(k) ? validRate(A.get(k)) : undefined;
    const b = B.has(k) ? validRate(B.get(k)) : undefined;
    rows.push({
      model,
      arm,
      a,
      b,
      delta: a && b ? b.rate - a.rate : undefined,
      moved: disjoint(a, b),
    });
  }
  return rows.sort((x, y) => (x.model + x.arm).localeCompare(y.model + y.arm));
}

/** Cases present in both whose validity changed. */
export function flips(before, after) {
  const idx = new Map(
    usable(before)
      .filter((r) => r.score)
      .map((r) => [r.key, r]),
  );
  const out = [];
  for (const r of usable(after)) {
    const o = idx.get(r.key);
    if (o && r.score && o.score.valid !== r.score.valid)
      out.push({
        key: r.key,
        from: o.score.valid,
        to: r.score.valid,
        outcomeFrom: o.outcome,
        outcomeTo: r.outcome,
      });
  }
  return out;
}

export function formatDiff(before, after, labels = ["before", "after"]) {
  const rows = diffArms(before, after);
  const L = [
    `# Lab diff: ${labels[0]} vs ${labels[1]}`,
    "",
    "| model | arm | " + labels[0] + " | " + labels[1] + " | change | moved? |",
    "| --- | --- | --- | --- | ---: | --- |",
  ];
  for (const r of rows)
    L.push(
      `| ${r.model} | ${r.arm} | ${r.a ? fmtRate(r.a) : "-"} | ${r.b ? fmtRate(r.b) : "-"} | ${r.delta == null ? "-" : (r.delta >= 0 ? "+" : "") + Math.round(r.delta * 100) + " pts"} | ${r.moved ? "yes (intervals disjoint)" : "no"} |`,
    );
  const f = flips(before, after);
  L.push("", `## Cases that flipped (${f.length})`, "");
  for (const x of f)
    L.push(
      `- ${x.key}: ${x.from ? "valid" : "invalid"} (${x.outcomeFrom}) -> ${x.to ? "valid" : "invalid"} (${x.outcomeTo})`,
    );
  if (!f.length) L.push("None.");
  L.push(
    "",
    '"moved" means the two 95% Wilson intervals do not overlap; overlap does not mean no change, it means the sample cannot tell.',
  );
  return L.join("\n") + "\n";
}
