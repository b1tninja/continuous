#!/usr/bin/env node
// `npm run render`: fixed markdown (tables, math, code, a mermaid fence, raw
// HTML, links, lists, a remote image) through the chat of the built harness,
// which has React's PRODUCTION build. Exits 1 on a page error, a React error
// on the console or a reply that is not as meant; 2 when it could not run.
// Dev-only; see README.md.
import fs from "node:fs";
import path from "node:path";
import { buildHarness, playwrightDir } from "./src/build.mjs";
import { DOCS, renderCheck } from "./src/render.mjs";

const USAGE = `Usage: npm run render -- [--doc ${Object.keys(DOCS).join(",")}]
                [--browser auto|chromium|edge|chrome] [--dist <dir>] [--timeout <ms>]
Exits 1 when a document fails.
  --doc      only these documents (comma list; default all)
  --dist     use an already built harness
  --timeout  how long a document may take to come out right (default 20000)`;

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) return console.log(USAGE);
  const docs = arg(argv, "doc")?.split(",") ?? Object.keys(DOCS);
  const unknown = docs.filter((d) => !Object.hasOwn(DOCS, d));
  if (unknown.length) {
    throw new Error(`Unknown document: ${unknown.join(", ")}\n\n${USAGE}`);
  }
  const timeout = Number(arg(argv, "timeout", "20000"));
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`--timeout takes a number of milliseconds\n\n${USAGE}`);
  }
  const given = arg(argv, "dist");
  const dist = given ? path.resolve(given) : buildHarness();
  let run;
  try {
    run = await renderCheck({
      dist,
      docs,
      timeout,
      playwrightDir: playwrightDir(),
      browser: arg(argv, "browser", "auto"),
    });
  } finally {
    if (!given) fs.rmSync(dist, { recursive: true, force: true });
  }
  const { build, results } = run;
  console.error(
    `React ${build?.version}, ${build?.devElement ? "development" : "production"} build, ${run.browser}`,
  );
  // On a development build every document passes whatever the pipeline does,
  // which is the blind spot this check exists for.
  if (!build || build.devElement) {
    console.error(
      "The harness page does not have React's production build (its elements carry _owner or _store), so this check proves nothing. See vite.config.mjs.",
    );
    process.exit(2);
  }
  let failed = 0;
  for (const r of results) {
    if (r.failures.length === 0) {
      console.error(`ok    ${r.name}  ${r.ms} ms`);
      continue;
    }
    failed++;
    console.error(`FAIL  ${r.name}  ${r.ms} ms`);
    for (const f of r.failures) console.error(`      ${f}`);
    const other = r.consoleErrors.filter(
      (m) => !r.failures.includes(`console: ${m}`),
    );
    if (other.length) {
      console.error(`      other console errors: ${other.join(" | ")}`);
    }
  }
  console.error(
    `${results.length - failed} of ${results.length} documents rendered as meant`,
  );
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(2);
});
