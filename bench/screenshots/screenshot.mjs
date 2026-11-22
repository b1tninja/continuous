#!/usr/bin/env node
// Pictures of the webview (gui/) in named states, light and dark, narrow and
// wide, with an optional comparison against an earlier run. Dev-only; see
// README.md in this folder.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, USAGE } from "./src/args.mjs";
import { buildHarness, playwrightDir } from "./src/build.mjs";
import { serve } from "./src/server.mjs";
import { compareRuns, shoot } from "./src/shoot.mjs";
import { VIEWS } from "./src/views.mjs";

/** The address of one view on a served harness (harness/main.tsx reads the query). */
function viewUrl(base, view, theme) {
  return `${base}?fixture=${encodeURIComponent(VIEWS[view].fixture)}&theme=${theme}`;
}

/** --serve: the built harness stays up for a person's own browser until Ctrl+C. */
async function serveHarness(opts) {
  const dist = opts.dist ? path.resolve(opts.dist) : buildHarness();
  const server = await serve(dist, opts.port);
  const theme = opts.themes[0];
  console.log(`Serving the harness at ${server.url}`);
  console.log(
    `A view is a fixture: ${server.url}?fixture=<fixture>&theme=dark|light|hc (&font=<px> sets the font size).`,
  );
  console.log(
    "Size the window, or the device toolbar of the developer tools, to the panel width (200 to 340 px for a sidebar).\n",
  );
  for (const view of opts.views) {
    const zoom = VIEWS[view].zoom
      ? `  (set the browser zoom to ${VIEWS[view].zoom * 100}%)`
      : "";
    console.log(
      `${view.padEnd(26)} ${viewUrl(server.url, view, theme)}${zoom}`,
    );
  }
  console.log("\nCtrl+C stops the server.");
  await new Promise((resolve) => process.once("SIGINT", resolve));
  if (!opts.dist) fs.rmSync(dist, { recursive: true, force: true });
  // An open browser tab keeps a connection, so close() would not return
  process.exit(0);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.list) {
    for (const [name, v] of Object.entries(VIEWS)) {
      console.log(`${name.padEnd(16)} ${v.note}`);
    }
    return;
  }
  if (opts.serve) return serveHarness(opts);
  const out = path.resolve(opts.out);
  const pw = playwrightDir();
  const dist = opts.dist ? path.resolve(opts.dist) : buildHarness();

  let manifest;
  if (opts.sandbox) {
    const { shootInSandbox } = await import("./src/sandbox.mjs");
    manifest = await shootInSandbox({
      dist,
      out,
      jobs: opts.jobs,
      playwrightDir: pw,
    });
  } else {
    manifest = await shoot({
      dist,
      out,
      jobs: opts.jobs,
      playwrightDir: pw,
      browser: opts.browser,
    });
  }
  const failed = manifest.entries.filter((e) => e.errors.length);
  console.error(
    `${manifest.entries.length} pictures in ${manifest.totalMs} ms with ${manifest.browser.kind} ${manifest.browser.version} -> ${out}`,
  );
  if (failed.length) {
    console.error(
      `${failed.length} pictures logged page errors (see manifest.json)`,
    );
  }
  if (!opts.dist) fs.rmSync(dist, { recursive: true, force: true });

  if (opts.diff) {
    const summary = await compareRuns({
      out,
      diff: path.resolve(opts.diff),
      playwrightDir: pw,
      browser: opts.browser === "edge" ? "edge" : opts.browser,
      threshold: opts.threshold,
      tolerance: opts.tolerance,
    });
    console.log(summary.lines.join("\n"));
    process.exitCode = summary.anyChanged ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(2);
});
