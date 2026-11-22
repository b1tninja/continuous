import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  check,
  lockfileVersionFor,
  pinnedMajor,
  run,
} from "./check-npm-pin.mjs";

test("pinnedMajor reads an exact npm version only", () => {
  assert.equal(pinnedMajor("npm@10.9.9"), 10);
  assert.equal(pinnedMajor("npm@11.0.0+sha512.abc=="), 11);
  for (const s of [undefined, "", "npm", "npm@10", "npm@^10.9.9", "pnpm@9.0.0"])
    assert.equal(pinnedMajor(s), undefined, String(s));
});

test("lockfileVersionFor follows the npm defaults", () => {
  assert.deepEqual(
    [6, 7, 8, 9, 10, 11].map(lockfileVersionFor),
    [1, 2, 2, 3, 3, 3],
  );
});

const ok = {
  packageManager: "npm@10.9.9",
  npmVersion: "10.8.2",
  lockfiles: [{ file: "package-lock.json", lockfileVersion: 3 }],
};

test("the same major and the expected lockfileVersion pass", () => {
  assert.deepEqual(check(ok), []);
});

test("a missing or loose pin fails", () => {
  assert.match(check({ ...ok, packageManager: undefined })[0], /undefined/);
  assert.match(check({ ...ok, packageManager: "npm@10" })[0], /exact/);
});

test("another npm major on the path fails with both versions named", () => {
  const [p, ...rest] = check({ ...ok, npmVersion: "11.12.1" });
  assert.deepEqual(rest, []);
  assert.match(p, /11\.12\.1/);
  assert.match(p, /npm@10\.9\.9/);
});

test("a lockfile of another lockfileVersion fails with its writer named", () => {
  const [p, ...rest] = check({
    ...ok,
    lockfiles: [
      { file: "package-lock.json", lockfileVersion: 3 },
      { file: "gui/package-lock.json", lockfileVersion: 2 },
    ],
  });
  assert.deepEqual(rest, []);
  assert.match(p, /^gui\/package-lock\.json: lockfileVersion 2/);
  assert.match(p, /npm 7 or 8/);
  assert.match(p, /npm@10\.9\.9 writes 3/);
});

// What the check cannot see: npm 11 also writes lockfileVersion 3.
test("a lockfile written by npm 11 passes under an npm 10 pin", () => {
  assert.equal(lockfileVersionFor(11), lockfileVersionFor(10));
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "npm-pin-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(body));
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

test("run reads the pin and every committed lockfile", () => {
  const good = repo({
    "package.json": { packageManager: "npm@10.9.9" },
    "package-lock.json": { lockfileVersion: 3 },
    "core/package-lock.json": { lockfileVersion: 3 },
    "core/package.json": {},
  });
  // an untracked lockfile, as inside node_modules, is not read
  mkdirSync(join(good, "node_modules/x"), { recursive: true });
  writeFileSync(join(good, "node_modules/x/package-lock.json"), "{}");
  const bad = repo({
    "package.json": { packageManager: "npm@10.9.9" },
    "docs/package-lock.json": { lockfileVersion: 1 },
  });
  try {
    const r = run(good, "10.9.9");
    assert.deepEqual(r.problems, []);
    assert.equal(r.lockfiles.length, 2);
    assert.equal(run(bad, "10.9.9").problems.length, 1);
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});
