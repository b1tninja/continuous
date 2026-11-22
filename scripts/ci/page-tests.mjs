#!/usr/bin/env node
// Runs core's "page" test project and fails on a failure that is not in
// scripts/ci/page-tests.baseline.json.
//
// The chat webview bundles about 200 files of core/. In the built page every
// Node built-in is an empty module and there is no `process` or `Buffer`, so
// code that uses one throws there and nowhere else: the unit tests run in
// Node. This runs the vitest suites that sit beside the bundled files a second
// time, with those files changed to what the page has
// (core/vitest.page.config.ts, core/test/page/pagePlugin.ts). The list of
// bundled files is read from a build of the webview.
//
// Some bundled files hold functions only core's Node side calls, and their
// tests fail here without a bug. The baseline names each such place with the
// reason the page does not reach it. A failure anywhere else fails this check.
// The fix is to stop using Node in code the page bundles, or, if the page
// never runs it, to add the place to the baseline in the same pull request so
// a reviewer sees it.
//
// Usage (needs the dependencies of core and gui):
//   node scripts/ci/page-tests.mjs               run, compare with the baseline
//   node scripts/ci/page-tests.mjs util/uri      only suites matching a filter
//   node scripts/ci/page-tests.mjs --report F    compare a saved vitest JSON report
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pageCoreFiles, siblingSuites } from "./webview-page-graph.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CORE = path.join(ROOT, "core");
export const BASELINE_FILE = path.join(HERE, "page-tests.baseline.json");

const slash = (p) => p.replace(/\\/g, "/");

/** A file as a path from the repository root, or undefined when outside it. */
export function relativeTo(file, root) {
  const f = slash(file);
  const r = slash(root).replace(/\/+$/, "");
  return f.toLowerCase().startsWith(r.toLowerCase() + "/")
    ? f.slice(r.length + 1)
    : undefined;
}

const FRAME =
  /^\s*at (?:(?:async )?(\S+) \()?(?:file:\/\/\/?)?(.+?):\d+:\d+\)?$/;

/**
 * The innermost stack frame in a bundled file, as "core/a/b.ts#function" (or
 * "core/a/b.ts" for code outside a function). Undefined when the failure did
 * not pass through one, as for a failed assertion in the test itself.
 */
export function thrownAt(failureMessage, root, pageFiles) {
  for (const line of String(failureMessage).split("\n")) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const file = relativeTo(m[2], root);
    if (!file || !pageFiles.has(file)) continue;
    const name = m[1] && !m[1].includes("<") ? m[1].replace(/^.*\./, "") : "";
    return name ? `${file}#${name}` : file;
  }
  return undefined;
}

/**
 * Every failure in a vitest JSON report: `{ suite, test, where, message }`.
 * A suite that failed before any test ran is one failure with no `test`.
 */
export function failures(report, root, pageFiles) {
  const out = [];
  for (const result of report.testResults ?? []) {
    const suite = relativeTo(result.name, root) ?? slash(result.name);
    const failed = (result.assertionResults ?? []).filter(
      (a) => a.status === "failed",
    );
    for (const a of failed) {
      const text = (a.failureMessages ?? []).join("\n");
      out.push({
        suite,
        test: a.fullName,
        where: thrownAt(text, root, pageFiles),
        message: text.split("\n")[0],
      });
    }
    if (result.status === "failed" && failed.length === 0) {
      out.push({
        suite,
        where: undefined,
        message: String(result.message ?? "").split("\n")[0],
      });
    }
  }
  return out;
}

/**
 * True when a baseline entry covers a failure. An entry names a place
 * (`where`: any test that throws there), one test (`suite` and `test`), or a
 * whole suite (`suite` alone).
 */
export function covers(entry, failure) {
  if (entry.where) return entry.where === failure.where;
  if (entry.suite !== failure.suite) return false;
  return entry.test === undefined || entry.test === failure.test;
}

/** Failures no entry covers, and entries that cover no failure. */
export function compare(found, baseline) {
  return {
    added: found.filter((f) => !baseline.some((e) => covers(e, f))),
    unused: baseline.filter((e) => !found.some((f) => covers(e, f))),
  };
}

const describeEntry = (e) =>
  e.where ?? (e.test === undefined ? e.suite : `${e.suite} > ${e.test}`);

export function message(added) {
  const lines = added.flatMap((f) => [
    `  ${f.suite}${f.test ? ` > ${f.test}` : ""}`,
    `      ${f.message}`,
    `      ${f.where ? `thrown at ${f.where}` : "not thrown in a bundled file: the result differs in the page"}`,
  ]);
  return [
    "Code the chat webview bundles fails as the page runs it:",
    ...lines,
    "",
    "In the built page Node's modules are empty, `process.env` is `{}`, and there",
    "is no `process` or `Buffer`, so this throws (or answers differently) there.",
    "The unit tests run in Node and cannot see it. Either stop using Node in code",
    "the page bundles, or, if the page never runs this, add it to",
    "scripts/ci/page-tests.baseline.json with the reason in this pull request.",
    "To run one suite: cd core && npm run test:page -- <filter>",
  ].join("\n");
}

function readBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")).entries;
}

/** Runs the page project under the Node running this; returns the report. */
function runVitest(files, filters) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-tests-"));
  const graph = path.join(tmp, "graph.json");
  const out = path.join(tmp, "report.json");
  fs.writeFileSync(graph, JSON.stringify(files));
  // vitest's own entry point, as check-webview-node-imports.mjs finds vite's.
  const manifest = createRequire(path.join(CORE, "package.json")).resolve(
    "vitest/package.json",
  );
  const bin = JSON.parse(fs.readFileSync(manifest, "utf8")).bin;
  const vitest = path.join(
    path.dirname(manifest),
    typeof bin === "string" ? bin : bin.vitest,
  );
  const r = spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      "--config",
      "vitest.page.config.ts",
      "--testTimeout=20000",
      "--reporter=json",
      `--outputFile=${out}`,
      ...filters,
    ],
    {
      cwd: CORE,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      env: { ...process.env, WEBVIEW_PAGE_GRAPH: graph },
    },
  );
  let report;
  try {
    report = JSON.parse(fs.readFileSync(out, "utf8"));
  } catch {
    process.stderr.write(
      `${r.stdout ?? ""}\n${r.stderr ?? ""}`.slice(-4000) +
        "\nThe page project did not produce a report.\n",
    );
    process.exit(2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return report;
}

async function main(argv) {
  const reportIndex = argv.indexOf("--report");
  const filters = reportIndex >= 0 ? [] : argv;
  const started = Date.now();
  const files = await pageCoreFiles();
  const suites = siblingSuites(files, ROOT);
  const report =
    reportIndex >= 0
      ? JSON.parse(fs.readFileSync(argv[reportIndex + 1], "utf8"))
      : runVitest(files, filters);
  if (!report.numTotalTests) {
    console.error(
      "The page project ran no test at all. Check core/vitest.page.config.ts and the filter.",
    );
    process.exit(2);
  }
  const found = failures(report, ROOT, new Set(files));
  const { added, unused } = compare(found, readBaseline());
  // With a filter most of the baseline is not run, so "unused" says nothing.
  if (unused.length && filters.length === 0) {
    console.log(
      `${unused.length} baseline entr${unused.length === 1 ? "y covers" : "ies cover"} no failure any more. Remove from scripts/ci/page-tests.baseline.json:`,
    );
    unused.forEach((e) => console.log(`  ${describeEntry(e)}`));
  }
  if (added.length) {
    console.error(message(added));
    process.exit(1);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `page tests: ${report.testResults.length} suites (${suites.length} beside the ${files.length} core files the webview bundles), ${report.numTotalTests} tests, ${found.length} known failures, none new (${seconds} s).`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
}
