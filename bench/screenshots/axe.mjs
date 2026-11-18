#!/usr/bin/env node
// `npm run axe`: axe-core over every view (or --view), compared with
// axe-baseline.json. Exits 1 on a violation the baseline does not have.
// `--update` rewrites the baseline from this run; `--report` prints every
// violation with targets. Dev-only; see README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AXE_TAGS,
  collapseByView,
  diffBaseline,
  readBaseline,
  writeBaseline,
} from "./src/axe.mjs";
import { buildHarness, playwrightDir } from "./src/build.mjs";
import { shoot } from "./src/shoot.mjs";
import {
  parseThemes,
  parseViews,
  parseWidths,
  planJobs,
} from "./src/views.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, "axe-baseline.json");
const USAGE = `Usage: npm run axe -- [--view <names|all>] [--width 300,800] [--theme both]
                  [--browser auto|chromium|edge|chrome] [--update] [--report]
Exits 1 when a view has a violation that axe-baseline.json does not list.`;

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) return console.log(USAGE);
  const views = parseViews(arg(argv, "view"));
  const jobs = planJobs({
    views,
    widths: parseWidths(arg(argv, "width")),
    themes: parseThemes(arg(argv, "theme")),
    height: 700,
  });
  const out = fs.mkdtempSync(
    path.join(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp", "axe-"),
  );
  const dist = buildHarness();
  let manifest;
  try {
    manifest = await shoot({
      dist,
      out,
      jobs,
      playwrightDir: playwrightDir(),
      browser: arg(argv, "browser", "auto"),
      axe: true,
    });
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
  const broken = manifest.entries.filter((e) =>
    e.errors.some((m) => m.startsWith("axe:")),
  );
  if (broken.length) {
    console.error(
      `axe did not run on ${broken.length} pictures, first: ${broken[0].errors[0]}`,
    );
    process.exit(2);
  }
  const current = collapseByView(manifest.entries);
  if (argv.includes("--report")) {
    for (const e of manifest.entries) {
      for (const v of e.axe)
        console.log(
          `${e.name}  ${v.id} (${v.impact}) x${v.count}  ${v.targets[0] ?? ""}`,
        );
    }
  }
  if (argv.includes("--update")) {
    const base = argv.includes("--view")
      ? { ...readBaseline(BASELINE), ...current }
      : current;
    writeBaseline(BASELINE, base, {
      tool: "bench/screenshots axe.mjs",
      axeTags: AXE_TAGS,
      note: "Known violations per view: rule -> most nodes seen at any width or theme. Fix and tighten with --update; never add by hand.",
    });
    return console.error(`baseline written: ${BASELINE}`);
  }
  const { added, improved } = diffBaseline(
    current,
    Object.fromEntries(
      Object.entries(readBaseline(BASELINE)).filter(([v]) => views.includes(v)),
    ),
  );
  for (const i of improved)
    console.error(`improved  ${i.view}  ${i.rule}  ${i.was} -> ${i.count}`);
  for (const a of added)
    console.error(`NEW       ${a.view}  ${a.rule}  ${a.was} -> ${a.count}`);
  console.error(
    `${added.length} new, ${improved.length} improved, ${manifest.entries.length} pages checked`,
  );
  process.exitCode = added.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(2);
});
