#!/usr/bin/env node
// Fails when the chat webview's build starts replacing another Node built-in
// with an empty stub.
//
// The webview is a browser build. Vite swaps each Node module our code imports
// (path, fs, os, ...) for an empty module and says so in its output:
//
//   Module "node:path" has been externalized for browser compatibility,
//   imported by "C:/repo/core/util/ideUtils.ts"
//
// Code that then calls into the stub throws at run time, in the page only:
// `path.win32.relative(...)` threw "Cannot read properties of undefined
// (reading 'relative')" and every multi_edit on Windows failed (2.38.4 and
// 2.38.5). Tests run in Node, where the module is real, and never saw it.
//
// This reads that output and compares the (module, importer) pairs from our own
// sources with scripts/ci/webview-node-imports.baseline.json. A pair that is not
// in the baseline fails. The fix is to stop importing the module in code the
// page bundles, or, if the page never calls it, to add the pair to the baseline
// in the same pull request so a reviewer sees it.
//
// Usage:
//   node scripts/ci/check-webview-node-imports.mjs            build gui, check
//   node scripts/ci/check-webview-node-imports.mjs --log F    check a saved build log
//   node scripts/ci/check-webview-node-imports.mjs --update   rewrite the baseline
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
export const BASELINE_FILE = path.join(
  HERE,
  "webview-node-imports.baseline.json",
);

const WARNING =
  /Module "([^"]+)" has been externalized for browser compatibility, imported by "([^"]+)"/g;

/** Build output without terminal colour codes. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * The importer as a path from the repository root with forward slashes.
 * `root` is the repository root of the machine that built it.
 */
export function relativeImporter(file, root) {
  const f = file.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (f.toLowerCase().startsWith(r.toLowerCase() + "/"))
    return f.slice(r.length + 1);
  return f;
}

/** Every (module, importer) pair the build reported, de-duplicated and sorted. */
export function parseStubs(log, root) {
  const seen = new Map();
  for (const m of stripAnsi(log).matchAll(WARNING)) {
    const pair = { module: m[1], importer: relativeImporter(m[2], root) };
    seen.set(`${pair.module}\u0000${pair.importer}`, pair);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.importer.localeCompare(b.importer) || a.module.localeCompare(b.module),
  );
}

/** Pairs from our own sources: not from a dependency under node_modules. */
export function ownPairs(pairs) {
  return pairs.filter((p) => !p.importer.split("/").includes("node_modules"));
}

const keyOf = (p) => `${p.module}  ${p.importer}`;

/** What is new against the baseline, and what the baseline lists that is gone. */
export function compare(found, baseline) {
  const known = new Set(baseline.map(keyOf));
  const now = new Set(found.map(keyOf));
  return {
    added: found.filter((p) => !known.has(keyOf(p))),
    removed: baseline.filter((p) => !now.has(keyOf(p))),
  };
}

export function message(added) {
  const lines = added.map((p) => `  ${p.module}  imported by  ${p.importer}`);
  return [
    "The chat webview build now replaces a Node module with an empty stub:",
    ...lines,
    "",
    "Code in the page that calls into it throws at run time, and the unit tests",
    "(which run in Node) cannot see it. Either stop importing it in code the page",
    "bundles, or, if the page never calls it, add the pair to",
    "scripts/ci/webview-node-imports.baseline.json in this pull request.",
  ].join("\n");
}

function readBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")).pairs;
}

function buildLog() {
  const out = path.join(os.tmpdir(), `webview-check-${process.pid}`);
  // Vite's own entry point (the bin its package.json declares) under the Node
  // that is running this, so no shell is involved and it behaves the same on
  // Windows and Linux. The package does not export that file for require().
  const manifest = createRequire(
    path.join(ROOT, "gui", "package.json"),
  ).resolve("vite/package.json");
  const bin = JSON.parse(fs.readFileSync(manifest, "utf8")).bin;
  const vite = path.join(
    path.dirname(manifest),
    typeof bin === "string" ? bin : bin.vite,
  );
  const r = spawnSync(
    process.execPath,
    [vite, "build", "--outDir", out, "--emptyOutDir"],
    { cwd: path.join(ROOT, "gui"), encoding: "utf8", maxBuffer: 1 << 28 },
  );
  fs.rmSync(out, { recursive: true, force: true });
  const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (r.status !== 0) {
    process.stderr.write(log.slice(-4000) + "\nThe gui build failed.\n");
    process.exit(2);
  }
  return log;
}

function main(argv) {
  const logIndex = argv.indexOf("--log");
  const log =
    logIndex >= 0 ? fs.readFileSync(argv[logIndex + 1], "utf8") : buildLog();
  const found = ownPairs(parseStubs(log, ROOT));
  if (found.length === 0) {
    console.error(
      "No stub warnings were found at all. The build output may have changed; check the pattern in this script.",
    );
    process.exit(2);
  }
  if (argv.includes("--update")) {
    fs.writeFileSync(
      BASELINE_FILE,
      JSON.stringify({ comment: COMMENT, pairs: found }, null, 2) + "\n",
    );
    console.log(
      `Wrote ${found.length} pairs to ${path.relative(ROOT, BASELINE_FILE)}.`,
    );
    return;
  }
  const { added, removed } = compare(found, readBaseline());
  if (removed.length) {
    console.log(
      `${removed.length} baseline pair(s) are gone from the build. Run with --update to drop them:`,
    );
    removed.forEach((p) => console.log(`  ${keyOf(p)}`));
  }
  if (added.length) {
    console.error(message(added));
    process.exit(1);
  }
  console.log(`webview Node stubs: ${found.length} pairs, none new.`);
}

export const COMMENT =
  "Node modules the chat webview build replaces with an empty stub, from our own sources. Existing pairs are not reviewed one by one: each is a place where the page gets an empty module, and calling into it throws there. Regenerate with --update after removing one.";

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
