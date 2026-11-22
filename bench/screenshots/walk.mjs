#!/usr/bin/env node
// `npm run walk`: how hard three Settings journeys are (reach the MCP server
// list, add an MCP server, add a chat model), walked in the real page at 300
// and 800 px and counted: steps, scroll, controls passed, files opened, dead
// ends. `--check` compares with walk-baseline.json and exits 1 when a journey
// got worse (`--check-only` on the named numbers only); `--update` rewrites
// the baseline. Dev-only; see README.md, Walks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHarness, playwrightDir } from "./src/build.mjs";
import {
  CHECK_METRICS,
  compareAll,
  formatTable,
  JOURNEYS,
  parseCheckOnly,
  readWalkBaseline,
  SCROLL_TOLERANCE,
  WALK_HEIGHT,
  WALK_WIDTHS,
  writeWalkBaseline,
} from "./src/walk.mjs";
import { LAYOUT } from "./src/walkLayout.mjs";
import { walk } from "./src/walkRun.mjs";
import { parseWidths } from "./src/views.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, "walk-baseline.json");
const USAGE = `Usage: npm run walk -- [--journey <ids>] [--width ${WALK_WIDTHS.join(",")}]
                  [--browser auto|chromium|edge|chrome] [--check] [--update]
                  [--check-only <metrics>] [--out <dir>] [--dist <dir>]
Journeys: ${JOURNEYS.map((j) => j.id).join(", ")}. The panel is ${WALK_HEIGHT} px high.
  --check    compare with walk-baseline.json; exit 1 when a journey got worse
  --check-only <list>  --check on these only, of ${CHECK_METRICS.join(",")}.
             Scroll depends on the machine's fonts; the others do not.
  --update   rewrite the baseline from this run (every journey and both widths)
  --out      where walk.json (the numbers and each journey's trace) goes;
             a new folder in the temp directory when left out
  --dist     use an already built harness`;

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) return console.log(USAGE);
  const ids = arg(argv, "journey");
  const journeys = ids
    ? ids.split(",").map((id) => {
        const j = JOURNEYS.find((x) => x.id === id.trim());
        if (!j) throw new Error(`Unknown journey: ${id}`);
        return j;
      })
    : JOURNEYS;
  const widths = parseWidths(arg(argv, "width", WALK_WIDTHS.join(",")));
  // Read before the walk: a misspelt metric should not cost a whole run
  const only = argv.includes("--check-only")
    ? parseCheckOnly(arg(argv, "check-only"))
    : CHECK_METRICS;
  const keep = arg(argv, "out");
  const out = keep
    ? path.resolve(keep)
    : fs.mkdtempSync(path.join(os.tmpdir(), "walk-"));
  fs.mkdirSync(out, { recursive: true });
  const given = arg(argv, "dist");
  const dist = given ? path.resolve(given) : buildHarness();
  let run;
  try {
    run = await walk({
      dist,
      playwrightDir: playwrightDir(),
      browser: arg(argv, "browser", "auto"),
      journeys,
      layout: LAYOUT,
      widths,
    });
  } finally {
    if (!given) fs.rmSync(dist, { recursive: true, force: true });
  }
  const { results } = run;
  const file = path.join(out, "walk.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        tool: "bench/screenshots walk.mjs",
        layout: LAYOUT.name,
        viewportHeight: WALK_HEIGHT,
        browser: run.browser,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(formatTable(results));
  for (const r of results) {
    for (const d of r.deadEnds) {
      console.log(`dead end  ${r.journey}  ${r.width}  ${d.kind}: ${d.detail}`);
    }
  }
  console.error(`written: ${file}`);

  const failed = results.filter((r) => r.endsIn === "failed");
  for (const f of failed) console.error(`FAILED    ${f.width}  ${f.error}`);
  if (argv.includes("--update")) {
    if (failed.length || ids || argv.includes("--width")) {
      console.error(
        "baseline not written: it takes a whole run in which every journey could be walked",
      );
      process.exit(2);
    }
    writeWalkBaseline(BASELINE, results, {
      tool: "bench/screenshots walk.mjs",
      note: `Per journey and panel width (${WALK_HEIGHT} px high): steps (deliberate actions), scrollPx (scrolled to bring each control into view, added up), goalY (the goal control's top edge on its unscrolled page), controlsPassed (Tab stops before it; controlsInPanel: those in its tab panel), filesOpened, endsIn (page, or file when the person is left in an editor file of fileBytes characters), deadEnds. --check fails on more steps, more than ${SCROLL_TOLERANCE} px more scroll, more controls passed, more files opened or a worse end. Taken with Windows fonts. Rewrite with --update; never edit by hand.`,
      layout: LAYOUT.name,
    });
    return console.error(`baseline written: ${BASELINE}`);
  }
  if (argv.includes("--check") || argv.includes("--check-only")) {
    const { rows, failed: worse } = compareAll(
      results,
      readWalkBaseline(BASELINE),
      { only },
    );
    for (const r of rows) {
      for (const b of r.better) {
        console.error(`improved  ${r.journey}  ${r.width}  ${b}`);
      }
      for (const w of r.worse) {
        console.error(`WORSE     ${r.journey}  ${r.width}  ${w}`);
      }
      if (r.verdict === "new") {
        console.error(
          `new       ${r.journey}  ${r.width}  not in the baseline`,
        );
      }
    }
    const count = (v) => rows.filter((r) => r.verdict === v).length;
    console.error(
      `${count("worse")} worse, ${count("better")} improved, ${count("same")} the same`,
    );
    if (only.length < CHECK_METRICS.length) {
      console.error(`compared: ${only.join(", ")}`);
    }
    // A journey that could not be walked is not "the same" as anything
    process.exitCode = worse ? 1 : failed.length ? 2 : 0;
    return;
  }
  process.exitCode = failed.length ? 2 : 0;
}

main().catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(2);
});
