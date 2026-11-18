# Toolbox default catalogue

Last updated: 2026-11-11. Status: draft for the owner, docs only. Companion to `plans/research/skills-vs-prompts-toolbox.md`, which defines the registry, shelves and file format used here.

Scope: the 23 existing cards are kept as they are in `core/util/toolboxCards.ts` (Understand 3, Diagnose 9, Decide 4, Check 3, Ask 4; ids listed in section 1). This file adds **32 new built-in entries** on seven new shelves. None of these texts has been run against a model; the style rules were taken from the existing cards and each text should be tried on one real task before it ships.

## 1. Style rules (from `toolboxCards.ts`)

- Imperative, short, concrete: what to do, what evidence to show, when to stop. No role-play opening ("You are an expert...").
- The method name is shown to the person in the card and never appears in the text sent to the model.
- `{facts}` are filled from the session by `fillToolboxCard`; a sentence whose fact is missing is dropped. Facts today: `request`, `item`, `lastCheck`, `lastError`, `changedFiles`, `assumptions`. This catalogue adds three, each flagged: `{diff}` (a read-only `git diff` summary), `{branch}`, `{lastTag}`. Entries using them are marked "new fact".
- Existing ids for reference: restate-the-problem, users-view, what-changed, reproduce-first, why-chain, cause-map, instrument-do-not-guess, bisect, baseline-first, failing-test-first, diagnose-before-environment, cross-check, widen-then-narrow, trade-offs, argue-against-yourself, blast-radius, define-done, what-did-you-verify, small-loop, what-are-you-assuming, smallest-change, what-would-you-not-do, where-stuck (23, counted from the file).
- Column "Needs": **prompt** is text only; **fact** needs a new fact reader in `toolboxFactsFromState`; **harness** needs new code (named).
- Mode: **I** insert for editing (the default when the person must add context), **S** send (self-contained).

## 2. Review

| Id                     | Title                       | Method                | Mode | Needs                                                                    |
| ---------------------- | --------------------------- | --------------------- | ---- | ------------------------------------------------------------------------ |
| review-my-diff         | Review my diff              | Code review checklist | I    | fact `{diff}`                                                            |
| review-this-pr         | Review this PR              | Code review checklist | I    | prompt (person adds the number)                                          |
| find-the-risky-line    | Find the risky line         | Pre-mortem            | S    | fact `{diff}`                                                            |
| missing-tests-for-diff | What is not tested          | Coverage gap check    | S    | fact `{diff}`                                                            |
| second-opinion         | Second opinion on this plan | Devil's advocate      | S    | harness: reviewer role (not built; the card exists in `policy-areas.md`) |

Texts:

- **review-my-diff**: `Review the changes in the working tree. Read the diff, then report only problems you can point to: a bug, a missing case, a broken contract, a risky change. One line each, with file and line. If a hunk is fine, say nothing about it. Do not rewrite code. {diff}`
- **review-this-pr**: `Review the pull request I name next. Read its description and diff. Say whether the change does what the description says, list problems you can point to with file and line, and list what you could not check. Do not post anything to the pull request.`
- **find-the-risky-line**: `Assume this change caused an incident next week. Name the three lines most likely to be the cause and the input that would trigger each. Check each against the code before you name it. {diff}`
- **missing-tests-for-diff**: `For each behaviour this diff adds or changes, name the test that covers it, or say that none does. List the uncovered ones as test names with one line of what each would assert. Write no tests yet. {diff}`
- **second-opinion**: `Ask the reviewer to read the current plan and the changes so far and list what it would challenge. Show its answer unedited.` (needs the reviewer role; hold until it exists)

## 3. Audit

| Id                 | Title                           | Method                           | Kind             | Needs                                          |
| ------------------ | ------------------------------- | -------------------------------- | ---------------- | ---------------------------------------------- |
| security-audit     | Security audit                  | Bundled skill (third-party, MIT) | skill            | harness: skill launcher and the audit skill PR |
| dependency-audit   | Dependency audit                | Supply-chain check               | prompt           | prompt                                         |
| secrets-sweep      | Look for committed secrets      | Secret scan                      | prompt           | prompt                                         |
| permissions-review | Review what this session may do | Least privilege                  | command + prompt | harness: `open-policy` (opens the page)        |

Texts:

- **security-audit**: kind skill; launches the bundled skill by name with an optional scope argument (`{scope}`, hint `a folder or leave empty for the repository`). No prompt text of ours; the skill body is sent. Hold until the parallel task's PR lands.
- **dependency-audit**: `List the direct dependencies in each manifest in this repository. For each, say what it is used for in one line, whether it is still maintained (look at the manifest and lockfile, not from memory), and whether the version is pinned. Run the audit command for the package manager if one is installed and show its output. Do not change any file.`
- **secrets-sweep**: `Search the working tree and the last twenty commits for values that look like keys, tokens, passwords or private keys. Report the file and line and the kind of value, never the value. Do not edit or delete anything.`
- **permissions-review**: `Read the current permission settings and say, in plain words, what you may do without asking, what you must ask for and what you are refused. Point out any rule that looks broader than the task I gave you. Do not change a setting.` The command half (`open-policy`) opens the policy page next to the reply.

## 4. Git

| Id                | Title                        | Method                | Mode | Needs                     |
| ----------------- | ---------------------------- | --------------------- | ---- | ------------------------- |
| commit-message    | Commit message from the diff | Summarise the why     | I    | fact `{diff}`             |
| explain-this-diff | Explain this diff            | Explain to a reviewer | S    | fact `{diff}`             |
| split-this-change | Split this into commits      | Small steps           | I    | fact `{diff}`             |
| pr-description    | Write the PR description     | Context, change, test | I    | fact `{diff}`, `{branch}` |
| undo-safely       | Undo safely                  | Reversible first      | I    | prompt                    |

Texts:

- **commit-message**: `Write a commit message for the staged changes, or the working tree if nothing is staged. First line under 72 characters, in the imperative, saying what changed and why. A body only if the reason is not obvious. Print the message; do not run git commit. {diff}`
- **explain-this-diff**: `Explain this diff to someone who has not seen the code: what it does, why it is needed, and what could go wrong. Group by purpose, not by file. {diff}`
- **split-this-change**: `Propose how to split the working tree changes into the fewest commits that each build and pass tests on their own. List each commit with its files and one-line message. Do not stage or commit. {diff}`
- **pr-description**: `Write a pull request description for branch {branch}: what changed, why, how it was tested, and what a reviewer should look at first. Use only what the diff and commit messages show. {diff}`
- **undo-safely**: `I want to undo the last change. List the ways to do it that keep the work recoverable (a new commit that reverts, a branch at the current state) and recommend one. Do not run any command that discards work.`

## 5. Tests

| Id                     | Title                             | Method                | Mode | Needs                                                                                            |
| ---------------------- | --------------------------------- | --------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| write-failing-test     | Write the failing test first      | Test-first            | I    | prompt (the existing `failing-test-first` is the diagnose variant; this one is for new features) |
| find-flaky-cause       | Find the cause of a flaky test    | Repeat, isolate, vary | I    | fact `{lastCheck}`                                                                               |
| run-the-affected-tests | Run the tests this change affects | Targeted run          | S    | fact `{changedFiles}`                                                                            |
| test-the-edges         | Test the edges                    | Boundary values       | I    | prompt                                                                                           |
| delete-a-useless-test  | Find tests that cannot fail       | Mutation thinking     | S    | prompt                                                                                           |

Texts:

- **write-failing-test**: `Before writing the feature, write the smallest test that describes the behaviour I asked for. Run it and show that it fails for the right reason. Stop there and wait for me. {request}`
- **find-flaky-cause**: `This test passes and fails without a code change. Run it twenty times and report the pass count. Then run it alone, in the full suite and in a different order, and say which change affects the rate. Look for shared state, time, randomness, ports and ordering before you propose a fix. {lastCheck}`
- **run-the-affected-tests**: `List the tests that exercise the files I changed, and run only those. Show the command, the counts and the first failure. If you cannot tell which tests apply, say so and run the whole suite once. {changedFiles}`
- **test-the-edges**: `For the function I name next, list its boundary inputs: empty, one, maximum, negative, unicode, null, repeated and concurrent where they apply. Write one test per boundary that is not already covered and report which ones fail.`
- **delete-a-useless-test**: `Look through the tests in the folder I name and list any that cannot fail: they assert nothing, repeat the implementation, or mock the thing under test. For each, say how you would break the code to prove it. Do not delete anything.`

## 6. Docs

| Id                  | Title                      | Method               | Mode | Needs  |
| ------------------- | -------------------------- | -------------------- | ---- | ------ |
| docs-match-code     | Do the docs match the code | Docs drift check     | S    | prompt |
| explain-this-module | Explain this module        | Reader's map         | I    | prompt |
| write-the-example   | Write a runnable example   | Example first        | I    | prompt |
| find-undocumented   | Find what is undocumented  | Public surface sweep | S    | prompt |

Texts:

- **docs-match-code**: `Pick the documentation page I name next, or the README, and check each command, option name and path it states against the code. List each statement that is wrong or out of date with the file that shows it. Do not edit yet.`
- **explain-this-module**: `Explain the folder I name next to a new contributor: what it is for, the three files to read first, how data moves through it, and what it must not depend on. Use only what the code shows, and say where you are unsure.`
- **write-the-example**: `Write a short example that uses the feature I name next, as someone reading the docs would. Run it. If it fails, fix the example or tell me the feature is broken. Show the exact command and output.`
- **find-undocumented**: `List the commands, options and settings in this project that no documentation page mentions. One line each with where it is defined. Do not write docs yet.`

## 7. Release

| Id                | Title                         | Method                   | Mode | Needs            |
| ----------------- | ----------------------------- | ------------------------ | ---- | ---------------- |
| release-notes     | Draft the release notes       | Changes by reader impact | I    | fact `{lastTag}` |
| changelog-entry   | Add the changelog entry       | Keep a changelog         | I    | fact `{lastTag}` |
| release-checklist | Check what blocks the release | Pre-flight               | S    | prompt           |
| breaking-changes  | Find breaking changes         | Contract diff            | S    | fact `{lastTag}` |

Texts:

- **release-notes**: `Draft release notes for the commits since {lastTag}. Group them by what a user notices: new, changed, fixed, removed. One plain sentence each; skip refactors and test-only changes. Mark anything a user must act on. Print the notes; do not edit a file.`
- **changelog-entry**: `Add a changelog entry for the changes since {lastTag}, in the style of the entries already in the file. Show the diff of the file and stop.`
- **release-checklist**: `Check what stands between this branch and a release: failing or skipped checks, uncommitted changes, version fields that disagree, a missing changelog entry, open items marked for this release. List each with where you looked. Fix nothing.`
- **breaking-changes**: `Compare the public surface (exported names, command options, config keys, file formats) between {lastTag} and now. List every removal and every change of meaning, with the file. A change that needs a migration note is breaking even if the code compiles.`

## 8. Session (harness actions)

These are kind `command`: no prompt text, one click runs a harness action, and the permission engine still governs anything it does.

| Id             | Title                       | Command          | Mode | Needs                                                                         |
| -------------- | --------------------------- | ---------------- | ---- | ----------------------------------------------------------------------------- |
| compact-now    | Compact the conversation    | `compact`        | run  | existing: CLI `/compact`; GUI wiring to confirm                               |
| show-cost      | Show what this session cost | `show-cost`      | run  | harness: new; reads the cost counter (`plans/cost-counter.md`), no model call |
| run-last-check | Run the last check again    | `run-last-check` | run  | harness: new; reruns the last check command through the normal approval path  |
| fork-here      | Fork from here              | `fork-session`   | run  | existing: CLI `/fork`                                                         |
| export-session | Export this session         | `export-session` | run  | existing: CLI `/export`                                                       |

Additions that need more than a wrapper and are deferred: **plan-build** (start a plan build; follows PR 643, `continuous plan list and plan build`), **open-audit** (open the audit view; depends on the audit UI), and the shuffle and "for every item" cards named in the header of `toolboxCards.ts`.

## 9. Totals

| Shelf     | Entries | Prompt-only | Need a new fact | Need new harness code                                |
| --------- | ------- | ----------- | --------------- | ---------------------------------------------------- |
| Review    | 5       | 1           | 3               | 1 (reviewer role)                                    |
| Audit     | 4       | 2           | 0               | 2 (skill launcher and audit skill; policy page link) |
| Git       | 5       | 1           | 4               | 0                                                    |
| Tests     | 5       | 4           | 1               | 0                                                    |
| Docs      | 4       | 4           | 0               | 0                                                    |
| Release   | 4       | 1           | 3               | 0                                                    |
| Session   | 5       | 0           | 0               | 2 new, 3 existing wrappers                           |
| **Total** | **32**  | **13**      | **11**          | **5 plus 3 wrappers**                                |

Day-one set without any new code: the 13 prompt-only entries plus the existing 23 cards and the three wrapper commands. The new facts (`{diff}`, `{branch}`, `{lastTag}`) each need a small read-only reader (`git diff --stat` and a bounded diff, `git branch --show-current`, `git describe --tags --abbrev=0`) that runs under the permission engine and is truncated and masked like any tool output; until they exist, the entries still work as insert-mode prompts with the sentence dropped.
