#!/usr/bin/env node
// Decides which CI areas a change touches (docs/ci-merge-gate.md). Plain Node, no install.
//
// Input: changed file names, one per line, on stdin (include a renamed file's old AND new name).
// Output: `name=true|false` lines, written to $GITHUB_OUTPUT by the `changes` job in merge-gate.yml.
//
// Rule of thumb: when in doubt run MORE. A path this script does not know turns every area on, and an
// empty list (which a real change never produces) does too. Skipping an area is only allowed for the
// explicit prefixes below, each of which has a reason in a comment.
import { pathToFileURL } from "node:url";

export const AREAS = [
  "prettier",
  "core",
  "gui",
  "binary",
  "vscode",
  "packages",
  "e2e",
  "jetbrains",
  "cli",
];

// Same list as `paths-ignore` had in the PR workflows: a change made only of these files has no
// code checks (exactly the old behaviour, so nothing that was checked before is dropped).
export function isDocsPath(f) {
  return (
    f.startsWith("docs/") ||
    f.startsWith("docs-site/") ||
    f.startsWith("plans/") ||
    f.endsWith(".md") ||
    f.endsWith(".mdx") ||
    f === "LICENSE"
  );
}

// What each directory feeds into. `touches` lists every area whose checks consume that directory.
//  - packages/ is built first by every other component, so it feeds all of them.
//  - core/ is imported by gui, binary, the VS Code extension, the CLI and the JetBrains plugin
//    (which bundles core and gui); nothing in core imports them back, so it feeds no `packages` leg.
//  - gui/ is bundled into the VS Code extension (and so into the e2e tests) and into the plugin.
//  - binary/ is bundled into the plugin.
//  - extensions/vscode, extensions/cli, extensions/intellij feed only themselves.
//  - bench/ feeds nothing here but prettier (see its rule).
const EVERYTHING = [...AREAS];
const RULES = [
  { prefix: "packages/", touches: EVERYTHING },
  {
    prefix: "core/",
    touches: ["core", "gui", "binary", "vscode", "e2e", "jetbrains", "cli"],
  },
  { prefix: "gui/", touches: ["gui", "vscode", "e2e", "jetbrains"] },
  { prefix: "binary/", touches: ["binary", "jetbrains"] },
  { prefix: "extensions/vscode/", touches: ["vscode", "e2e"] },
  { prefix: "extensions/cli/", touches: ["cli"] },
  { prefix: "extensions/intellij/", touches: ["jetbrains"] },
  // bench/ consumes the product; nothing in the PR or CLI checks builds or tests it (its own tests run
  // in Supply Chain, which has its own trigger). Prettier still covers its source.
  { prefix: "bench/", touches: ["prettier"] },
];

export function classify(files) {
  const list = files.map((f) => f.trim()).filter(Boolean);
  const out = Object.fromEntries(AREAS.map((a) => [a, false]));
  const code = list.filter((f) => !isDocsPath(f));
  const all = list.length === 0; // fail safe: no list means no knowledge, run everything
  if (all) code.push("(empty file list)");
  for (const f of code) {
    const rule = RULES.find((r) => f.startsWith(r.prefix));
    for (const a of rule ? rule.touches : EVERYTHING) out[a] = true;
  }
  const any = code.length > 0;
  // Prettier checks js/ts/json/css/md anywhere in the tree, so it runs whenever any code file changed.
  out.prettier = any;
  return { code: any, docsOnly: !any, ...out };
}

export function allAreas() {
  return {
    code: true,
    docsOnly: false,
    ...Object.fromEntries(AREAS.map((a) => [a, true])),
  };
}

// Jobs this change starts in PR Checks, CLI PR Checks and the gate, for the doc's table.
// Keep in step with pr-checks.yaml and cli-pr-checks.yml.
export function jobCount(c) {
  let n = 2; // changes + merge-gate
  if (!c.code) return n;
  if (c.prettier) n += 1;
  if (c.core) n += 1;
  if (c.gui) n += 1;
  if (c.binary) n += 1;
  if (c.vscode) n += 1;
  if (c.packages) n += 1; // one job tests the six packages
  if (c.e2e) n += 1 + 10; // linux package (also lists the e2e files), 10 e2e legs
  if (c.jetbrains) n += 1;
  if (c.cli) n += 3; // lint, test, smoke-api
  n += 2; // Supply Chain (own workflow, runs for every non-docs change)
  return n;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = process.argv.includes("--all")
    ? allAreas()
    : classify((await readStdin()).split(/\r?\n/));
  for (const [k, v] of Object.entries(result)) console.log(`${k}=${v}`);
}
