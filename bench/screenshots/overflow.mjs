#!/usr/bin/env node
// `npm run overflow`: what does not fit sideways in each view (or --view) at
// sidebar widths, compared with overflow-baseline.json. Exits 1 on a finding
// the baseline does not have. `--update` rewrites the baseline from this run;
// `--report` prints every finding. Dev-only; see README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHarness, playwrightDir } from "./src/build.mjs";
import {
  collapse,
  diffBaseline,
  mergeBaseline,
  OVERFLOW_WIDTHS,
  readBaseline,
  SLACK,
  TOLERANCE,
  writeBaseline,
} from "./src/overflow.mjs";
import { shoot } from "./src/shoot.mjs";
import { parseViews, parseWidths, planJobs } from "./src/views.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, "overflow-baseline.json");
const USAGE = `Usage: npm run overflow -- [--view <names|all>] [--width ${OVERFLOW_WIDTHS.join(",")}]
                  [--browser auto|chromium|edge|chrome] [--update] [--report]
                  [--out <dir>] [--dist <dir>]
Exits 1 when a view has a finding that overflow-baseline.json does not list.
  --report   print every finding, not only the new ones
  --update   rewrite the baseline from this run (with --view or --width: those only)
  --out      keep the pictures and overflow.json (every finding with its box) there
  --dist     use an already built harness`;

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
}

const line = (e, f) =>
  `${e.view}  ${e.width}  ${f.kind}${f.side ? ` ${f.side}` : ""}  ${f.px} px  ${f.selector}${f.widest ? `  (widest inside: ${f.widest})` : ""}${f.text ? `  "${f.text}"` : ""}`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) return console.log(USAGE);
  const views = parseViews(arg(argv, "view"));
  const widths = parseWidths(arg(argv, "width", OVERFLOW_WIDTHS.join(",")));
  // One theme: a theme changes colours, not sizes
  const jobs = planJobs({ views, widths, themes: ["dark"], height: 700 });
  const keep = arg(argv, "out");
  const out = keep
    ? path.resolve(keep)
    : fs.mkdtempSync(
        path.join(
          process.env.TMPDIR ?? process.env.TEMP ?? "/tmp",
          "overflow-",
        ),
      );
  const given = arg(argv, "dist");
  const dist = given ? path.resolve(given) : buildHarness();
  let manifest;
  try {
    manifest = await shoot({
      dist,
      out,
      jobs,
      playwrightDir: playwrightDir(),
      browser: arg(argv, "browser", "auto"),
      overflow: true,
    });
  } finally {
    if (!given) fs.rmSync(dist, { recursive: true, force: true });
  }
  const broken = manifest.entries.filter(
    (e) => !e.overflow || e.errors.some((m) => m.startsWith("harness:")),
  );
  if (keep) {
    fs.writeFileSync(
      path.join(out, "overflow.json"),
      JSON.stringify(
        manifest.entries.map((e) => ({
          view: e.view,
          width: e.width,
          findings: e.overflow ?? [],
        })),
        null,
        2,
      ) + "\n",
    );
  } else {
    fs.rmSync(out, { recursive: true, force: true });
  }
  if (broken.length) {
    console.error(
      `${broken.length} pages were not measured, first: ${broken[0].name}: ${broken[0].errors.find((m) => /^(harness|overflow):/.test(m)) ?? "no result"}`,
    );
    process.exit(2);
  }
  const current = collapse(manifest.entries);
  if (argv.includes("--report")) {
    for (const e of manifest.entries) {
      for (const f of e.overflow) console.log(line(e, f));
    }
  }
  const baseline = readBaseline(BASELINE);
  if (argv.includes("--update")) {
    // A whole run replaces the file, so a view that is gone leaves it too
    const whole = !argv.includes("--view") && !argv.includes("--width");
    writeBaseline(
      BASELINE,
      whole ? current : mergeBaseline(baseline, current),
      {
        tool: "bench/screenshots overflow.mjs",
        note: `Known findings per view and width: "<kind> <element>" -> CSS pixels (outside: beyond the viewport edge; clipped, scroll-x, squeezed: content wider than the box). A finding is new when it is not listed or is more than ${SLACK} px larger; amounts up to ${TOLERANCE} px are ignored. Taken with Windows fonts. Fix and tighten with --update; never add by hand.`,
      },
    );
    return console.error(`baseline written: ${BASELINE}`);
  }
  const { added, improved } = diffBaseline(current, baseline);
  for (const i of improved)
    console.error(
      `improved  ${i.view}  ${i.width}  ${i.key}  ${i.was} -> ${i.px} px`,
    );
  for (const a of added)
    console.error(
      `NEW       ${a.view}  ${a.width}  ${a.key}  ${a.was} -> ${a.px} px`,
    );
  const total = manifest.entries.reduce((n, e) => n + e.overflow.length, 0);
  console.error(
    `${added.length} new, ${improved.length} improved, ${total} findings on ${manifest.entries.length} pages`,
  );
  process.exitCode = added.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(2);
});
