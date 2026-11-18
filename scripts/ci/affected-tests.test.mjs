import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_CHANGED_FILES,
  MAX_RELATED_FILES,
  SMOKE,
  SUITES,
  fallbackReason,
  plan,
} from "./affected-tests.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pr = (suite, files, exists) =>
  plan({ suite, event: "pull_request", files, exists });

test("a source change inside core runs the related core tests plus smoke", () => {
  const p = pr("core-vitest", [
    "core/autocomplete/util/AutocompleteLruCache.ts",
  ]);
  assert.equal(p.mode, "related");
  assert.deepEqual(p.related, ["./autocomplete/util/AutocompleteLruCache.ts"]);
  assert.deepEqual(p.argv.slice(0, 5), [
    "npx",
    "vitest",
    "related",
    "--run",
    "--passWithNoTests",
  ]);
  assert.ok(
    p.argv.includes("./config/yaml/loadYaml.vitest.ts"),
    "smoke test included",
  );
});

test("only core vitest, gui and cli are selectable; jest and vscode are not suites here", () => {
  assert.deepEqual(Object.keys(SUITES).sort(), ["cli", "core-vitest", "gui"]);
  assert.throws(() => pr("core-jest", ["core/a.ts"]), /unknown suite/);
  assert.throws(
    () => pr("vscode", ["extensions/vscode/a.ts"]),
    /unknown suite/,
  );
});

test("only pull_request events narrow; push, schedule, merge_group and dispatch run full", () => {
  for (const event of [
    "push",
    "schedule",
    "merge_group",
    "workflow_dispatch",
    "",
    undefined,
  ]) {
    const p = plan({ suite: "gui", event, files: ["gui/src/App.tsx"] });
    assert.equal(p.mode, "full", String(event));
    assert.deepEqual(p.argv, SUITES.gui.full);
  }
});

test("an unknown, empty or oversized file list runs full", () => {
  assert.equal(pr("gui", null).mode, "full");
  assert.equal(pr("gui", []).mode, "full");
  assert.equal(pr("gui", ["", "  "]).mode, "full");
  const many = Array.from(
    { length: MAX_CHANGED_FILES + 1 },
    (_, i) => `gui/src/f${i}.ts`,
  );
  assert.match(pr("gui", many).reason, /more than 150/);
  const own = Array.from(
    { length: MAX_RELATED_FILES + 1 },
    (_, i) => `gui/src/f${i}.ts`,
  );
  assert.equal(pr("gui", own).mode, "full");
});

test("config, manifests, lockfiles, tsconfig and test-runner config run full", () => {
  for (const f of [
    "core/package.json",
    "core/package-lock.json",
    "core/tsconfig.json",
    "core/tsconfig.npm.json",
    "core/vitest.config.ts",
    "core/jest.config.js",
    "gui/vite.config.ts",
    "extensions/cli/vitest.e2e.config.ts",
    "extensions/cli/vitest.setup.ts",
    "extensions/cli/vitest.global-dir-setup.ts",
    "core/test/vitest.global-setup.ts",
    "gui/src/util/test/setupTests.ts",
  ]) {
    const suite = f.startsWith("gui")
      ? "gui"
      : f.startsWith("extensions/cli")
        ? "cli"
        : "core-vitest";
    assert.equal(pr(suite, [f]).mode, "full", f);
  }
});

test("test helpers, fixtures, snapshots, golden files and mocks run full", () => {
  for (const f of [
    "core/autocomplete/context/root-path-context/test/files/python/classes.py",
    "core/test/testDir.ts",
    "core/x/__fixtures__/b.ts",
    "core/x/fixtures/a.ts",
    "core/x/__snapshots__/a.test.ts.snap",
    "core/edit/golden/case1.ts",
    "core/x/__mocks__/fs.ts",
    "core/testdata/a.ts",
  ]) {
    assert.equal(pr("core-vitest", [f]).mode, "full", f);
  }
});

test("a non-module file in the suite's directory runs full (read from disk, not imported)", () => {
  for (const f of [
    "core/llm/templates/a.json",
    "core/tag-qry/tree-sitter-python-tags.scm",
    "gui/src/x.css",
  ]) {
    const suite = f.startsWith("gui") ? "gui" : "core-vitest";
    assert.match(pr(suite, [f]).reason, /not a JS\/TS module/, f);
  }
});

test("a deleted or renamed-away file runs full", () => {
  const p = pr(
    "core-vitest",
    ["core/old.ts", "core/new.ts"],
    (f) => f !== "core/old.ts",
  );
  assert.equal(p.mode, "full");
  assert.match(p.reason, /deleted or renamed/);
});

test("an upstream area consumed across a file: link or build runs full", () => {
  assert.match(
    pr("core-vitest", ["packages/config-yaml/src/x.ts"]).reason,
    /upstream packages\//,
  );
  assert.match(pr("gui", ["core/config/util.ts"]).reason, /upstream core\//);
  assert.match(pr("cli", ["core/index.d.ts"]).reason, /upstream core\//);
});

test("an area the suite does not consume is ignored", () => {
  const p = pr("core-vitest", [
    "core/util/a.ts",
    "gui/src/App.tsx",
    "extensions/intellij/build.gradle.kts",
    "extensions/vscode/package.json",
    "bench/x.ts",
    "docs/a.md",
  ]);
  assert.equal(p.mode, "related");
  assert.deepEqual(p.related, ["./util/a.ts"]);
});

test("a file outside every area (root, scripts/, .github/) runs full", () => {
  for (const f of [
    "package.json",
    ".github/workflows/pr-checks.yaml",
    "scripts/build-packages.js",
    "eval/x.ts",
    ".nvmrc",
  ]) {
    assert.equal(pr("core-vitest", ["core/a.ts", f]).mode, "full", f);
  }
});

test("only smoke tests run when the suite's own directory has no change", () => {
  const p = pr("core-vitest", ["extensions/intellij/src/A.kt"]);
  assert.equal(p.mode, "related");
  assert.deepEqual(p.related, []);
  assert.match(p.reason, /smoke tests only/);
  assert.ok(p.argv.includes("./config/ConfigHandler.vitest.ts"));
});

test("paths with unusual characters are never passed to a runner", () => {
  for (const f of [
    "core/$(id).ts",
    "core/a b.ts",
    "core/a;rm.ts",
    "core/`x`.ts",
  ]) {
    assert.equal(pr("core-vitest", [f]).mode, "full", f);
  }
  // every related argument starts with ./ and so cannot be read as an option
  const p = pr("core-vitest", ["core/-rf.ts"]);
  assert.ok(p.argv.includes("./-rf.ts"));
});

test("markdown inside the suite is ignored like docs", () => {
  const p = pr("gui", ["gui/README.md", "gui/src/a.ts"]);
  assert.deepEqual(p.related, ["./src/a.ts"]);
});

test("fallbackReason leaves ordinary source and test files alone", () => {
  assert.equal(fallbackReason("core/llm/llms/OpenAI.ts"), null);
  assert.equal(fallbackReason("gui/src/components/Foo.test.tsx"), null);
  assert.equal(
    fallbackReason("gui/src/components/ProviderSetup/providerSetupUtils.ts"),
    null,
  );
});

test("every smoke test exists, belongs to a suite, and does not itself force full", () => {
  for (const [name, files] of Object.entries(SMOKE)) {
    if (name.startsWith("$")) continue;
    const s = SUITES[name];
    assert.ok(s, `smoke-tests.json: unknown suite ${name}`);
    assert.ok(files.length > 0, name);
    for (const f of files) {
      assert.ok(
        existsSync(path.join(root, s.dir, f)),
        `${name}: ${s.dir}/${f}`,
      );
      assert.equal(fallbackReason(`${s.dir}/${f}`), null, `${name}: ${f}`);
    }
  }
  for (const name of Object.keys(SUITES)) assert.ok(SMOKE[name], name);
});
