// axe-core over the same states the pictures show. One AxeBuilder call per
// page, after window.__shotReady and before the picture. The baseline file
// (axe-baseline.json) records the debt per view; `npm run axe` fails only on a
// violation that is not in it.
import fs from "node:fs";
import { createRequire } from "node:module";

export const AXE_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
];

/** Runs axe on a page and returns [{id, impact, help, count, targets}] sorted by id. */
export async function runAxe(page, require = createRequire(import.meta.url)) {
  const { AxeBuilder } = require("@axe-core/playwright");
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations
    .map((v) => ({
      id: v.id,
      impact: v.impact ?? "minor",
      help: v.help,
      count: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Folds the entries of a run into { view: { rule: maxNodeCount } }. The worst
 * case across widths and themes is what counts, so a rule seen at one width
 * only is still one the view has.
 */
export function collapseByView(entries) {
  const out = {};
  for (const e of entries) {
    const view = (out[e.view] ??= {});
    for (const v of e.axe ?? []) {
      view[v.id] = Math.max(view[v.id] ?? 0, v.count);
    }
  }
  return sortKeys(out);
}

function sortKeys(o) {
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, typeof o[k] === "object" ? sortKeys(o[k]) : o[k]]),
  );
}

/**
 * Compares a collapsed run with the baseline. A view or rule that is not in the
 * baseline, or a rule with more nodes than the baseline allows, is new.
 * Rules that went away or shrank are reported as improvements (the baseline may
 * be tightened with --update).
 */
export function diffBaseline(current, baseline) {
  const added = [];
  const improved = [];
  for (const [view, rules] of Object.entries(current)) {
    for (const [rule, count] of Object.entries(rules)) {
      const was = baseline[view]?.[rule] ?? 0;
      if (count > was) added.push({ view, rule, was, count });
    }
  }
  for (const [view, rules] of Object.entries(baseline)) {
    for (const [rule, was] of Object.entries(rules)) {
      const count = current[view]?.[rule] ?? 0;
      if (count < was) improved.push({ view, rule, was, count });
    }
  }
  return { added, improved };
}

export function readBaseline(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")).views ?? {};
}

export function writeBaseline(file, views, meta) {
  fs.writeFileSync(file, JSON.stringify({ ...meta, views }, null, 2) + "\n");
}
