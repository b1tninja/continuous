"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findClaims, check, isStale, realState } = require("./roadmap-state.js");

const SCRIPT = path.join(__dirname, "roadmap-state.js");
const FIXTURE = path.join(__dirname, "roadmap-state.fixture.json");
// #1 merged, #2 open, #3 open draft, #4 closed unmerged; #9 is not in the list.
const STATES = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const claimsOf = (line) => findClaims(line).map((c) => `${c.pr} ${c.claim}`);

test("finds the open and draft forms", () => {
  assert.deepStrictEqual(claimsOf("PR #2 open"), ["2 open"]);
  assert.deepStrictEqual(claimsOf("documented only (PR #2, open)"), ["2 open"]);
  assert.deepStrictEqual(claimsOf("#2 is open, not merged"), ["2 open"]);
  assert.deepStrictEqual(claimsOf("#1 merged, #2 still open"), [
    "1 merged",
    "2 open",
  ]);
  assert.deepStrictEqual(claimsOf("the open pull requests #2 and #3"), [
    "2 open",
    "3 open",
  ]);
  assert.deepStrictEqual(claimsOf("In review (PR #2)"), ["2 open"]);
  assert.deepStrictEqual(claimsOf("the logo (#3, draft)"), ["3 draft"]);
  assert.deepStrictEqual(claimsOf("parked as draft PR #3"), ["3 draft"]);
  assert.deepStrictEqual(claimsOf("draft pull requests #3, #4 and #2"), [
    "2 draft",
    "3 draft",
    "4 draft",
  ]);
});

test("finds the built and merged forms", () => {
  assert.deepStrictEqual(claimsOf("Built (#1)"), ["1 merged"]);
  assert.deepStrictEqual(claimsOf("Built (#1, merged 2026-11-13)"), [
    "1 merged",
  ]);
  assert.deepStrictEqual(claimsOf("Shipped (#1, #2 and PR #4)"), [
    "1 merged",
    "2 merged",
    "4 merged",
  ]);
  assert.deepStrictEqual(claimsOf("In part (#1); built in PR #2"), [
    "1 merged",
    "2 merged",
  ]);
  assert.deepStrictEqual(claimsOf("fixed by #1, shipped as #2"), [
    "1 merged",
    "2 merged",
  ]);
  assert.deepStrictEqual(claimsOf("#1 is merged"), ["1 merged"]);
});

test("a bare mention or a distant word is not a claim", () => {
  assert.deepStrictEqual(claimsOf("after #2, and the question is open"), []);
  assert.deepStrictEqual(claimsOf("stacked on #2; see #3 (#4)"), []);
  assert.deepStrictEqual(claimsOf("`PR #N open` is the form"), []);
  // only the list right after the word: #2 here is context, not a claim
  assert.deepStrictEqual(claimsOf("Built (#1, B3, the rest waits for #2)"), [
    "1 merged",
  ]);
});

test("stale means GitHub disagrees; a draft counts as open", () => {
  const [merged, open, draft, closed] = STATES;
  assert.ok(isStale("open", merged) && isStale("open", closed));
  assert.ok(!isStale("open", open) && !isStale("open", draft));
  assert.ok(isStale("draft", open) && !isStale("draft", draft));
  assert.ok(!isStale("merged", merged));
  assert.ok(isStale("merged", open) && isStale("merged", closed));
  assert.strictEqual(realState(merged), "merged 2026-11-13");
  assert.strictEqual(realState(draft), "open, draft");
  assert.strictEqual(realState(closed), "closed, not merged");
});

const ROADMAP = [
  "Rows implemented by PR #2 open; #9 merged.",
  "",
  "| PR   | Scope | State |",
  "| ---- | ----- | ----- |",
  "| Q1   | one   | PR #1 open |",
  "| QA14 | two   | Built (#4) |",
  "| **C11a** | three | Built (#1, merged 2026-11-13); PR #3, draft |",
].join("\n");

test("reports the row id, the line and the real state", () => {
  const { claims, stale, unknown } = check(ROADMAP, STATES);
  assert.strictEqual(claims.length, 6);
  assert.deepStrictEqual(
    stale.map((s) => [s.id, s.line, s.pr, s.claim, s.real]),
    [
      ["Q1", 5, 1, "open", "merged 2026-11-13"],
      ["QA14", 6, 4, "merged", "closed, not merged"],
    ],
  );
  // a number that is no pull request is listed and does not fail
  assert.deepStrictEqual(
    unknown.map((u) => [u.id, u.line, u.pr]),
    [["-", 1, 9]],
  );
});

function cli(text, ...args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-state-"));
  fs.writeFileSync(path.join(dir, "ROADMAP.md"), text);
  try {
    return spawnSync(process.execPath, [SCRIPT, ...args, dir], {
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("exits 1 with one line per stale claim, 0 when none", () => {
  const bad = cli(ROADMAP, "--states", FIXTURE);
  assert.strictEqual(bad.status, 1);
  assert.match(
    bad.stdout,
    /^stale {3}Q1 ROADMAP\.md:5 "PR #1 open" claims #1 open; it is merged 2026-11-13$/m,
  );
  assert.strictEqual(bad.stdout.match(/^stale /gm).length, 2);
  const good = cli(
    "| Q1 | one | PR #2 open, Built (#1) |",
    "--states",
    FIXTURE,
  );
  assert.strictEqual(good.status, 0);
  assert.match(good.stdout, /2 claims, 0 stale/);
});

test("--no-network skips with a message and exit 0", () => {
  const r = cli(ROADMAP, "--no-network");
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /skipped, nothing was compared/);
});

test("a missing or failing gh skips with exit 0", () => {
  // an empty PATH: gh cannot be found
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-state-"));
  fs.writeFileSync(path.join(dir, "ROADMAP.md"), ROADMAP);
  const r = spawnSync(process.execPath, [SCRIPT, dir], {
    encoding: "utf8",
    env: { PATH: dir, Path: dir },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /skipped, nothing was compared: gh /);
});
