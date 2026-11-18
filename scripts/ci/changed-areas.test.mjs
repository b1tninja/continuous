import assert from "node:assert/strict";
import { test } from "node:test";
import { allAreas, classify, isDocsPath, jobCount } from "./changed-areas.mjs";

const on = (c) =>
  Object.keys(c)
    .filter((k) => c[k] === true && k !== "code" && k !== "docsOnly")
    .sort();

test("docs-only change turns nothing on", () => {
  const c = classify([
    "docs/a.mdx",
    "plans/ROADMAP.md",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(c.code, false);
  assert.equal(c.docsOnly, true);
  assert.deepEqual(on(c), []);
  assert.equal(jobCount(c), 2);
});

test("markdown anywhere in the tree counts as docs, as paths-ignore did", () => {
  assert.equal(isDocsPath("extensions/cli/README.md"), true);
  assert.equal(isDocsPath(".github/release-notes/UNRELEASED.md"), true);
  assert.equal(isDocsPath("docs.json"), false);
  assert.equal(isDocsPath("sub/LICENSE"), false);
});

test("a rename out of docs into code counts as code", () => {
  assert.equal(classify(["docs/x.md", "core/x.ts"]).code, true);
});

test("gui-only", () => {
  const c = classify(["gui/src/App.tsx"]);
  assert.deepEqual(on(c).sort(), [
    "e2e",
    "gui",
    "jetbrains",
    "prettier",
    "vscode",
  ]);
  assert.equal(c.core, false);
  assert.equal(c.cli, false);
});

test("core change feeds every consumer but not the packages legs", () => {
  const c = classify(["core/llm/index.ts"]);
  assert.equal(c.packages, false);
  for (const a of [
    "core",
    "gui",
    "binary",
    "vscode",
    "e2e",
    "jetbrains",
    "cli",
    "prettier",
  ])
    assert.equal(c[a], true, a);
});

test("packages change feeds everything", () => {
  const c = classify(["packages/config-yaml/src/a.ts"]);
  assert.deepEqual(
    on(c).sort(),
    [
      "binary",
      "cli",
      "core",
      "e2e",
      "gui",
      "jetbrains",
      "packages",
      "prettier",
      "vscode",
    ].sort(),
  );
});

test("cli-only and intellij-only", () => {
  assert.deepEqual(on(classify(["extensions/cli/src/index.ts"])).sort(), [
    "cli",
    "prettier",
  ]);
  assert.deepEqual(
    on(classify(["extensions/intellij/build.gradle.kts"])).sort(),
    ["jetbrains", "prettier"],
  );
});

test("bench-only needs prettier only", () => {
  const c = classify(["bench/screenshots/src/views.mjs", "bench/runner.mjs"]);
  assert.deepEqual(on(c), ["prettier"]);
  assert.equal(jobCount(c), 2 + 1 + 2);
});

test("unknown paths and workflow files turn everything on", () => {
  for (const f of [
    ".github/workflows/pr-checks.yaml",
    "package.json",
    "scripts/build-packages.js",
    "something-new/x.ts",
  ]) {
    const c = classify([f]);
    for (const a of [
      "prettier",
      "core",
      "gui",
      "binary",
      "vscode",
      "packages",
      "e2e",
      "jetbrains",
      "cli",
    ])
      assert.equal(c[a], true, `${f} ${a}`);
  }
});

test("an empty list fails safe", () => {
  assert.deepEqual(classify([]), { ...allAreas(), docsOnly: false });
  assert.deepEqual(classify(["", "  "]), classify([]));
});

test("job count of a full code push", () => {
  assert.equal(
    jobCount(allAreas()),
    2 + 1 + 1 + 1 + 1 + 1 + 1 + 11 + 1 + 3 + 2,
  );
});
