#!/usr/bin/env node
// Affected-only unit tests (CI44, plans/research/ci-pipeline-redesign.md 3.1; docs/ci-merge-gate.md
// section 9). Plain Node, no install.
//
//   node scripts/ci/affected-tests.mjs --suite core-vitest        # plan, then run (cwd: repo root)
//   node scripts/ci/affected-tests.mjs --suite core-vitest --plan # print the plan as JSON, run nothing
//
// Environment:
//   EVENT_NAME      the triggering event; only `pull_request` is ever narrowed
//   CHANGED_FILES   JSON array of repo-relative paths from the merge gate's `changes` job (empty: unknown)
//   AFFECTED_TESTS  `on` runs the narrowed selection; anything else (the default, unset) is SHADOW
//                   mode: the selection is computed and written to the step summary, and the FULL
//                   suite runs. The research note asks for two weeks of shadow mode without an escape
//                   (a failing test outside the selection) before selection is switched on, with the
//                   repository variable CI_AFFECTED_TESTS=on.
//
// Rule of thumb, as in changed-areas.mjs: when in doubt run the FULL suite. A suite is narrowed only
// when every changed file that can affect it is a plain JS/TS module inside the suite's own directory,
// never for config, lockfiles, test setup, test helpers, fixtures, snapshots, goldens or mocks. A smoke
// set (smoke-tests.json) always runs with the related tests. Full suites still run nightly and on every
// push to main (post-merge-check.yml).
//
// No shell on Linux: the command runs as an argv array, and every path is checked against a plain
// character set and passed as ./<path>, so a file name in a PR cannot inject an option or a command.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isDocsPath } from "./changed-areas.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// More changed files than this and the change is a refactor or a merge: run everything.
export const MAX_CHANGED_FILES = 150;
// More related inputs than this and the related run is close to the full one anyway.
export const MAX_RELATED_FILES = 60;

// Directories that are their own area. A changed file in an area that a suite does not consume is
// irrelevant to it; a file in no area at all (the repo root, scripts/, .github/, ...) is unknown and
// forces the full suite.
export const AREA_DIRS = [
  "packages/",
  "core/",
  "gui/",
  "binary/",
  "extensions/vscode/",
  "extensions/cli/",
  "extensions/intellij/",
  "bench/",
];

export const SMOKE = JSON.parse(
  readFileSync(path.join(here, "smoke-tests.json"), "utf8"),
);

const vitestRelated = (files) => [
  "npx",
  "vitest",
  "related",
  "--run",
  "--passWithNoTests",
  ...files,
];

// Only the suites the research note selects at level 2 (core vitest, gui, CLI). Core's jest suite
// (about 40 s) and the VS Code vitest suite (about 20 s) always run in full.
//
// `consumes`: directories the suite depends on across a `file:` link or a built dist/. Whether vitest
// follows a change through such a link into this suite's tests is unverified (research note 3.1), so a
// change there runs the full suite: a directory-level decision, made by changed-areas.mjs.
export const SUITES = {
  "core-vitest": {
    dir: "core",
    consumes: ["packages/"],
    full: ["npm", "run", "vitest"],
    related: vitestRelated,
  },
  gui: {
    dir: "gui",
    consumes: ["packages/", "core/"],
    full: ["npm", "test"],
    related: vitestRelated,
  },
  cli: {
    dir: "extensions/cli",
    consumes: ["packages/", "core/"],
    full: ["npm", "test"],
    related: vitestRelated,
  },
};

// Only these can be followed through the module graph. Anything else in the suite's directory
// (JSON, YAML, .scm queries, .wasm, CSS, templates) may be read from disk or by a bundler at run
// time, which no related-test lookup sees.
const MODULE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// Changes that alter how tests run or what they compare against, wherever they are.
const FALLBACK_PATTERNS = [
  [/(^|\/)package(-lock)?\.json$/, "package manifest or lockfile"],
  [/(^|\/)npm-shrinkwrap\.json$/, "lockfile"],
  [/(^|\/)\.npmrc$/, "npm configuration"],
  [/(^|\/)\.nvmrc$/, "Node version"],
  [/(^|\/)tsconfig[^/]*\.json$/, "TypeScript configuration"],
  [
    /(^|\/)(vitest|vite|jest)[^/]*\.config\.[^/]+$/,
    "test runner configuration",
  ],
  [/(^|\/)babel\.config\.[^/]+$|(^|\/)\.babelrc/, "transpiler configuration"],
  // setupTests.ts, vitest.setup.ts, jest.setup-after-env.js, vitest.global-dir-setup.ts
  [/(^|\/)(setup[^/]*|[^/]*[.-]setup[^/]*)\.[cm]?[jt]sx?$/i, "test setup file"],
  [/(^|\/)[^/]*global-setup[^/]*$/i, "test global setup"],
  [/(^|\/)test\//, "test support directory"],
  [/(^|\/)__mocks__\//, "module mocks"],
  [/(^|\/)(__fixtures__|fixtures?|testdata|test-data)\//i, "test fixture"],
  [/(^|\/)__snapshots__\/|\.snap$/, "snapshot"],
  [/golden/i, "golden file"],
];

// A path we are willing to hand to a test runner as an argument.
const SAFE_PATH = /^[A-Za-z0-9._@+\-/]+$/;

function under(f, dir) {
  return f.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

export function fallbackReason(f) {
  for (const [re, why] of FALLBACK_PATTERNS)
    if (re.test(f)) return `${why}: ${f}`;
  return null;
}

// Pure: decides full vs related for one suite. `exists(path)` tells whether a repo-relative path is
// in the checkout (a deleted or renamed-away file cannot be followed and forces the full suite).
export function plan({ suite, event, files, exists = () => true }) {
  const s = SUITES[suite];
  if (!s) throw new Error(`unknown suite: ${suite}`);
  const full = (reason) => ({
    suite,
    mode: "full",
    reason,
    argv: s.full,
    related: [],
  });

  if (event !== "pull_request")
    return full(`event is '${event || "unknown"}', not pull_request`);
  if (!Array.isArray(files)) return full("no changed-file list");
  const list = files.map((f) => String(f).trim()).filter(Boolean);
  if (list.length === 0) return full("empty changed-file list");
  if (list.length > MAX_CHANGED_FILES)
    return full(
      `${list.length} changed files (more than ${MAX_CHANGED_FILES})`,
    );

  const own = [];
  for (const f of list) {
    if (isDocsPath(f)) continue;
    if (under(f, s.dir)) {
      const why = fallbackReason(f);
      if (why) return full(why);
      if (!MODULE_EXT.test(f)) return full(`not a JS/TS module: ${f}`);
      if (!SAFE_PATH.test(f)) return full(`unusual characters in path: ${f}`);
      if (!exists(f)) return full(`deleted or renamed: ${f}`);
      own.push(f);
      continue;
    }
    const upstream = s.consumes.find((d) => under(f, d));
    if (upstream) return full(`upstream ${upstream} changed: ${f}`);
    if (AREA_DIRS.some((d) => under(f, d))) continue; // an area this suite does not consume
    const why = fallbackReason(f);
    return full(why ? why : `file outside every known area: ${f}`);
  }
  if (own.length > MAX_RELATED_FILES)
    return full(
      `${own.length} changed files in ${s.dir} (more than ${MAX_RELATED_FILES})`,
    );

  // Paths relative to the suite's directory, prefixed with ./ so none can be read as an option.
  const rel = own.map((f) => `./${f.slice(s.dir.length + 1)}`);
  const smoke = (SMOKE[suite] ?? []).map((f) => `./${f}`);
  const inputs = [...new Set([...rel, ...smoke])];
  return {
    suite,
    mode: "related",
    reason: own.length
      ? `${own.length} changed module(s) in ${s.dir}, plus ${smoke.length} smoke test(s)`
      : `no module in ${s.dir} changed; smoke tests only`,
    argv: s.related(inputs),
    related: rel,
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function parseFiles(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const suite = arg("--suite");
  if (!SUITES[suite]) throw new Error(`unknown suite: ${suite}`);
  const root = path.resolve(here, "../..");
  let p;
  try {
    p = plan({
      suite,
      event: process.env.EVENT_NAME,
      files: parseFiles(process.env.CHANGED_FILES),
      exists: (f) => existsSync(path.join(root, f)),
    });
  } catch (e) {
    // The plan itself failed: never guess, run everything.
    p = {
      suite,
      mode: "full",
      reason: `planning failed: ${e.message}`,
      argv: SUITES[suite].full,
      related: [],
    };
  }
  const enforce = process.env.AFFECTED_TESTS === "on";
  const run = enforce ? p.argv : SUITES[suite].full;
  const label = enforce ? p.mode : `shadow (would be ${p.mode})`;
  console.log(`affected-tests ${suite}: ${label}: ${p.reason}`);
  summary(
    `**affected-tests ${suite}**: ${label}: ${p.reason}` +
      (p.mode === "related"
        ? `\n\nSelection inputs: \`${p.argv.slice(5).join(" ")}\`` +
          (enforce
            ? ""
            : "\n\nShadow mode ran the full suite. If it failed, a failing test that `vitest related` would not have selected from these inputs is an escape (research note 3.1, item 6).")
        : ""),
  );
  if (process.argv.includes("--plan")) {
    console.log(JSON.stringify(p));
  } else {
    const [cmd, ...args] = run;
    console.log(`> (cd ${SUITES[suite].dir} && ${run.join(" ")})`);
    // npm and npx are .cmd files on Windows (the nightly CLI matrix), which need a shell there; every
    // argument is either fixed or matched SAFE_PATH, which has no shell metacharacter.
    const r = spawnSync(cmd, args, {
      cwd: path.join(root, SUITES[suite].dir),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (r.error) throw r.error;
    process.exit(r.status ?? 1);
  }
}
