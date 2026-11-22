#!/usr/bin/env node
// Reports claims in plans/ROADMAP.md about a pull request's state that GitHub
// disagrees with: "PR #N open" when #N is merged or closed, "Built (#N)" when
// #N is not merged. Standard library only; the states come from one `gh pr list`.
// Usage: node scripts/ci/roadmap-state.js [--states file.json] [--no-network]
//          [--repo owner/name] [plansDir]
// Exit code is 1 when a claim is stale, 0 otherwise. Without --states the check
// needs `gh`; when gh is absent or not signed in, or with --no-network, it says
// so and exits 0, because a check that cannot ask must not report a verdict.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const NL = /\r?\n/;
const DEFAULT_REPO = "b1tninja/continuous";
const LIMIT = 5000;
// The first cell of a table row: A4, C11a, QA14, ENV1. Wider than roadmap-ids.js,
// which checks only the one-letter tracks and VA.
const ROW_ID = /^\|\s*\*{0,2}([A-Z]{1,4}\d{1,3}[a-z]?)\*{0,2}\s*\|/;

// "#1, #2 and PR #3": the numbers a claim names in one breath.
const LIST = String.raw`(?:PR )?#\d+(?:(?:, | and )(?:PR )?#\d+)*`;
const WORK = "PRs? |pull requests? ";
// A claim is tied to the number next to it and nothing further, so "after #5,
// and Q3 is open" is not read as a claim about #5.
const FORMS = [
  // PR #5 open; #5, open; #5 is open; #5 still open
  { claim: "open", re: String.raw`((?:PR )?#\d+),? (?:is |still )?open\b` },
  // open PR #5; open pull requests #5 and #6
  { claim: "open", re: String.raw`\bopen (?:${WORK})(${LIST})` },
  // in review (#5; in review, #5; in review (PR #5)
  { claim: "open", re: String.raw`\bin review[ ,(]+(${LIST})` },
  // (#5, draft); PR #5, draft
  { claim: "draft", re: String.raw`((?:PR )?#\d+),? draft\b` },
  // draft PR #5; draft #5; draft pull requests #5 and #6
  { claim: "draft", re: String.raw`\bdraft (?:${WORK})?(${LIST})` },
  // Built (#5); Shipped (#5, merged 2026-11-13); In part (#5, #6); Built in PR #5;
  // shipped as #5; fixed by #5
  {
    claim: "merged",
    re: String.raw`\b(?:built|shipped|merged|fixed|done|landed|in part)(?: \(| in | as | by )(${LIST})`,
  },
  // #5 merged; #5 is merged; (PR #5, merged 2026-11-13)
  {
    claim: "merged",
    re: String.raw`((?:PR )?#\d+),? (?:is |was |has )?merged\b`,
  },
].map((f) => ({ claim: f.claim, re: new RegExp(f.re, "gi") }));

/** Claims in the text: [{line, id, pr, claim, text}], one per line, number and claim.
 * `id` is the row id when the line is a table row that starts with one, else "-". */
function findClaims(text) {
  const out = [];
  text.split(NL).forEach((line, i) => {
    const seen = new Set();
    for (const { claim, re } of FORMS) {
      for (const m of line.matchAll(re)) {
        for (const n of m[1].matchAll(/#(\d+)/g)) {
          const key = `${n[1]} ${claim}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            line: i + 1,
            id: (ROW_ID.exec(line) || [])[1] || "-",
            pr: Number(n[1]),
            claim,
            text: m[0].trim(),
          });
        }
      }
    }
  });
  return out.sort((a, b) => a.line - b.line || a.pr - b.pr);
}

/** What GitHub says, in the words the claims use. */
function realState(pr) {
  if (pr.state === "MERGED")
    return `merged${pr.mergedAt ? " " + pr.mergedAt.slice(0, 10) : ""}`;
  if (pr.state === "CLOSED") return "closed, not merged";
  return pr.isDraft ? "open, draft" : "open";
}

/** True when the claim no longer holds. A draft is also open. */
function isStale(claim, pr) {
  if (claim === "merged") return pr.state !== "MERGED";
  if (claim === "draft") return pr.state !== "OPEN" || !pr.isDraft;
  return pr.state !== "OPEN";
}

/**
 * Compares claims with states ([{number, state, isDraft, mergedAt}]).
 *  stale:   the claim and GitHub disagree
 *  unknown: the number is not a pull request in the list (an issue, or a pull
 *           request of another repository); reported, never a failure
 */
function check(text, states) {
  const byNumber = new Map(states.map((p) => [p.number, p]));
  const stale = [];
  const unknown = [];
  const claims = findClaims(text);
  for (const c of claims) {
    const pr = byNumber.get(c.pr);
    if (!pr) unknown.push(c);
    else if (isStale(c.claim, pr)) stale.push({ ...c, real: realState(pr) });
  }
  return { claims, stale, unknown };
}

/** Every pull request's state in one call, or {skip: reason}. */
function fetchStates(repo) {
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "all",
        "--limit",
        String(LIMIT),
        "--json",
        "number,state,isDraft,mergedAt",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 << 20,
      },
    );
    const states = JSON.parse(out);
    // A full page may be a cut one, and a cut list would call a real pull request unknown.
    if (states.length >= LIMIT)
      return { skip: `gh returned ${LIMIT} pull requests, raise LIMIT` };
    return { states };
  } catch (e) {
    if (e.code === "ENOENT") return { skip: "gh is not installed" };
    const why = String(e.stderr || e.message)
      .trim()
      .split(NL)[0];
    return { skip: `gh pr list failed (${why})` };
  }
}

module.exports = { findClaims, realState, isStale, check, fetchStates };

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const statesFile = value("--states");
  const repo = value("--repo") || process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const offline = args.includes("--no-network");
  const dir =
    args.find((a) => !a.startsWith("--")) ||
    path.join(__dirname, "..", "..", "plans");

  let states;
  if (statesFile) states = JSON.parse(fs.readFileSync(statesFile, "utf8"));
  else {
    const got = offline ? { skip: "--no-network" } : fetchStates(repo);
    if (got.skip) {
      console.log(`roadmap-state: skipped, nothing was compared: ${got.skip}`);
      process.exit(0);
    }
    states = got.states;
  }
  const text = fs.readFileSync(path.join(dir, "ROADMAP.md"), "utf8");
  const { claims, stale, unknown } = check(text, states);
  for (const s of stale)
    console.log(
      `stale   ${s.id} ROADMAP.md:${s.line} "${s.text}" claims #${s.pr} ${s.claim}; it is ${s.real}`,
    );
  for (const u of unknown)
    console.log(
      `unknown ${u.id} ROADMAP.md:${u.line} "${u.text}": #${u.pr} is not a pull request`,
    );
  console.log(
    `\n${claims.length} claims, ${stale.length} stale, ${unknown.length} not a pull request`,
  );
  if (stale.length) process.exit(1);
}
