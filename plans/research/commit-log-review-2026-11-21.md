# Research: what the commit log teaches

Date: 2026-11-21. Log read at `origin/main` = `2f0924f78` (the merge of #996). Nothing was built or changed for this note. It is evidence and proposed rows.

## What this note is

A review of the fork's own history: `git log upstream/main..origin/main`, 2,621 commits from 2026-10-27 to 2026-11-21. It asks which kinds of fix keep coming back, what broke after it shipped, and which guard would have caught each class earlier. A finding the roadmap already tracks is reported with its id, not as new.

Evidence marks:

- **V**: produced by a command given here, or read in the code or the commit.
- **R**: read from commit subjects only. The cause is not confirmed.

## Inputs and limits

Inputs:

- `git log upstream/main..origin/main`: 2,621 commits, 966 merges (472 are `Merge pull request #N`), 1,655 non-merge commits. 1,519 of the non-merge commits are by the owner, 68 by Dependabot.
- 35 release tags from `v2.2.0-vscode` (11-05) to `v2.38.5-vscode` (11-20), and the notes in `.github/release-notes/`.
- The last 300 `merge-gate` runs (`gh run list --workflow merge-gate.yml --limit 300`, 11-13 to 11-21) and the failed job names of the 59 failed ones (`gh run view <id> --json jobs`).
- `plans/ROADMAP.md`, `plans/research/`, `docs/ci-merge-gate.md`, `docs/shared-worktrees.md`, `scripts/ci/`, and the workflow files.

Limits:

- **Classes are counted by a pattern on the subject line.** The patterns are given with each count. A commit that fixes a check without saying so is missed, and a subject that only mentions the word is counted. Treat the counts as lower bounds with some noise.
- **PR boundaries exist only from 11-08.** Before that, pull requests were squashed, so "commits inside a PR" covers 472 PRs from 11-08 to 11-21.
- **Commit volume is uneven.** 345 non-merge commits landed on 11-12 and 7 on 11-17. Rates by week compare a burst of parallel agents with a week of one person.
- **Gate data starts on 11-13.** Earlier runs were not read.
- **No time-to-fix per feature was measured.** The release gaps in section 6 and the two chains in sections 1 and 2 stand in for it.
- The fork had no outside bug reporter until 11-16 (`gh issue list --state all`: 9 issues not by the owner, 3 of them from the post-merge bot, 6 from two people). "Broke after it shipped" before that date means the owner found it.

## Summary

| #   | Finding                                                                                                                      | Evidence | Tracked?                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------- |
| 1   | Code that passes in Node fails in the built chat page: 9 commits in 11 days, 5 after a visible failure                       | V        | Partly: guard built in #996; `process` is I27 (Open) |
| 2   | The same React 19 production-only crash shipped twice, 15 days apart                                                         | V        | No                                                   |
| 3   | A fix for a reported bug broke every `multi_edit` on Windows in 2.38.4 and 2.38.5. The repair is on `main` and in no release | V        | No                                                   |
| 4   | 71 of 472 PRs (15%) carry a commit that only repairs a check. In the last week it is 16 of 59 (27%)                          | V        | Partly: QA13 (Open); CI47 is in a research note only |
| 5   | The VS Code type check compiles core's vitest files as CommonJS with `@types/node` 16: 12 repair commits                     | V        | No                                                   |
| 6   | A red `main` is copied into every open branch: 14 subjects repeat, 44 extra copies                                           | V        | Partly: CI15 built; branch protection not applied    |
| 7   | 35 releases in 16 days, 16 of them patches. 2.38.0 to 2.38.5 took 56 hours. No release requires a test result                | V        | CI5 (Not started), QA22 (Open)                       |
| 8   | No Windows leg runs on a pull request. 34 subjects name Windows                                                              | V        | QA6 (Open), QA3                                      |
| 9   | One e2e failure took 12 diagnostic commits and 15 gate runs to find                                                          | V        | Partly: QA23                                         |
| 10  | The roadmap says "PR #N open" for 38 pull requests. None is open                                                             | V        | No                                                   |
| 11  | Lockfiles written by another npm than CI's: 3 regenerations, 2 Dependabot syncs                                              | R        | Partly: CI34                                         |
| 12  | Flaky tests and reverts are rare in the log: about 7 and 4 commits                                                           | R        | QA10, QA11, CI25, CI27                               |

Findings 1, 2, 3 and 9 are one class: **the test environment is not the shipped artifact.** Findings 4 and 5 are a second: **a check that runs only in CI.** Finding 10 is why some of this is still open: the plan for it exists and its state is stale.

## 1. Node code in the chat page (V)

The chat page is a browser build. Vite replaces a Node module with an empty stub, and the page has no `process` and no `Buffer`. Unit tests run in Node, where all of these are real.

Count: `git log --no-merges --format='%h|%s' | grep -iE 'webview|chat page|node-only|Node module'` gives 16 subjects. Read one by one, 9 are code changed because the page lacks something from Node, plus the guard:

| Commit      | Date  | What was missing        | How it was found                                            |
| ----------- | ----- | ----------------------- | ----------------------------------------------------------- |
| `e660b3c96` | 11-10 | `process.platform`      | Settings > Tools crashed                                    |
| `d2436fcad` | 11-11 | `os.homedir`, `node:fs` | The chat input never rendered. e2e red from #607 on         |
| `298a01044` | 11-12 | `process`, `Buffer`     | Written with the feature                                    |
| `30596b712` | 11-13 | `fs`, `path`            | Written with the feature (a pure module was split out)      |
| `d406c1271` | 11-18 | the tokenizer           | The page had no input in the e2e                            |
| `d7a132644` | 11-20 | `process`               | Ctrl+L threw. Found after 12 diagnostic commits (section 8) |
| `f665f7bf3` | 11-20 | `process`               | Same PR as the next                                         |
| `a1034cb6a` | 11-20 | `node:fs`               | Not stated in the commit                                    |
| `0d94d0ea5` | 11-21 | `path.win32`            | Every `multi_edit` on Windows failed in two releases        |

Five followed a visible failure. Four are the `process` or `Buffer` globals and five are module imports.

While the chat input did not render on `main` (#607 merged 11-11 12:20, the fix #651 merged 16:32), 16 more pull requests merged (`git log --first-parent --merges --since='2026-11-11 12:20:30' --until='2026-11-11 16:32'`). The e2e was red on each and nothing required it.

Guard now: `scripts/ci/check-webview-node-imports.mjs` (#996, `1321566de`) fails the gui job on a new (module, importer) pair. Still missing:

- **The baseline accepts 25 pairs**, 11 in core. `core/util/uri.ts` is one, with `node:path` and `node:url`, and the chat page calls it. The commit says of two others (`protected.ts`, `readOnlyCommand.ts`) that whether the page runs them "is not known".
- **Globals are not covered.** The check reads Vite's module warnings. Four of the nine commits were `process` or `Buffer`. I27 asks for a test or lint rule on `process` and has been Open since 11-10; three of the four came after it was written.
- **No test runs the shared code as the page runs it.** `core/util/ideUtils.noNodePath.vitest.ts` does this for one file, with a Proxy that answers `undefined`.
- **The dev server.** The owner reports that `npm run dev` in `gui` fails in a browser on the `node:url` import in `core/util/uri.ts`. The import is there (V); I did not start the server (R).

## 2. React 19 production behaviour (V)

- `edc65d2ea` (#300, 11-06): "markdown tables crash chat replies in the production build (React #62)". `hast-to-hyperscript` recognises React by `_owner` and `_store`, which React 19 production elements do not have, so a string `style` reached React. The fix moved `align` on table cells into a style object.
- `739c0b1fb` and `25776b3c5` (#989, 11-21, issue #988 from an outside user): the same error from KaTeX's string styles. The fix converts every string `style` before `rehype-react`.

The first fix repaired one producer of string styles and left the cause. The second producer shipped in every release for 15 days. Both commit messages say the dev server and the unit tests could not see it, because they run a development build of React.

Guard now: unit tests for the two rehype plugins. They assert on the tree and still run a development React. Missing: a test that renders markdown through the production build. `grep -ciE 'production build|React #62' plans/ROADMAP.md` gives 0.

Not checked: whether other props depend on the same recognition in `hast-to-hyperscript`. The working tree has an untracked `rehypeCreateElement.ts`, so someone is on it. I did not read it.

## 3. A fix that shipped a worse bug (V)

1. Issue #954 (outside user, 11-17): a file inside the workspace was treated as outside it.
2. `afda18f42` (11-19 22:31) fixed it and added 161 lines of tests. It introduced `path.win32` in `core/util/ideUtils.ts` (`git log -S'path.win32' -- core/util/ideUtils.ts`).
3. `v2.38.4-vscode` (11-20 06:28) and `v2.38.5-vscode` (11-20 17:54) contain it (`git tag --contains afda18f42`).
4. In the page `path` is a stub, so `path.win32.relative` threw. `multi_edit` and `single_find_and_replace` run that check in the page. On Windows every call failed.
5. `d7a132644` and `a1034cb6a` (11-20) repaired two neighbours. `0d94d0ea5` (#995, 11-21) repaired this one.

`git tag --contains 0d94d0ea5` and `git tag --contains 739c0b1fb` print nothing. **The latest release, 2.38.5, has both the Windows edit failure and the KaTeX crash.**

What would have caught it: the tests of step 2 run against the page's module stubs (section 1), or one agent edit through the packaged extension on Windows before the tag.

## 4. Commits that only repair a check (V)

Subject patterns over the 1,655 non-merge commits (the patterns are shortened here):

| Pattern (case-insensitive)                                                           | Commits |
| ------------------------------------------------------------------------------------ | ------: |
| `import order`, `max-lines`, `lint limit`, `linter`, `eslint`, `lint fix`, `fix(ci)` |      39 |
| `prettier`, `format the`, `formatting`, subject starting `style` or `format`         |      43 |
| `tsc`, `typecheck`, `type fix`, `type error`, `import.meta`, subject starting `Type` |      28 |

Inside pull requests (`git log M^1..M^2` for each of the 472 merges, one combined pattern):

| Period         | PRs | With a repair commit | Repair commits |
| -------------- | --: | -------------------: | -------------: |
| 11-08 to 11-12 | 315 |             43 (14%) |             57 |
| 11-13 to 11-15 |  98 |             12 (12%) |             16 |
| 11-16 to 11-21 |  59 |             16 (27%) |             21 |
| All            | 472 |             71 (15%) |             94 |

The gate agrees. Of 300 `merge-gate` runs, 59 failed and 43 were cancelled. In the 59:

| Failed job                                   | Runs |
| -------------------------------------------- | ---: |
| `pr-checks / core-checks`                    |   15 |
| `pr-checks / prettier-check`                 |   14 |
| `cli-pr-checks / test`                       |   13 |
| `pr-checks / gui-checks`                     |   12 |
| e2e `KeyboardShortcuts`                      |   10 |
| `pr-checks / vscode-checks`                  |    9 |
| `cli-pr-checks / lint`                       |    9 |
| `pr-checks / vscode-package-extension-linux` |    6 |
| `pr-checks / jetbrains-tests`                |    6 |

Prettier or the CLI lint failed in 22 of the 59, and in 11 nothing else failed. `core-checks`, `gui-checks` and `vscode-checks` mix type check, lint and tests, so their share of static failures is not known.

Examples: `fa32831d0` "Fix the lint errors CI found in the colour and audit change"; `8ea65d3f7` "Keep the Bash working-directory check from pushing the rules file over the lint limits"; `014be3297` "Put the decision-timer imports where the CLI linter expects them"; `823caf97d` "Format the KaTeX chat helpers the way Prettier expects".

Guards now: `.husky/pre-commit` runs `lint-staged`, which runs `prettier --write` only. `docs/shared-worktrees.md` records that a new worktree has no hooks until `husky` runs in it. Missing: ESLint (import order, `max-lines`, `max-lines-per-function`) and the type check run nowhere before the push.

Tracked: QA13 (one formatter entry point, Open, "do early"). `plans/research/ci-pipeline-redesign.md` proposes CI47, a local `npm run precheck` (prettier, `tsc`, `vitest related`), but `grep -c 'CI4[2-9]' plans/ROADMAP.md` gives 0: rows CI42 to CI49 never reached the roadmap. CI47 does not include ESLint.

## 5. The VS Code project type-checks core's tests (V)

`extensions/vscode/tsconfig.json` includes `../../core/**/*.ts` and excludes `*.test.ts`, not `*.vitest.ts`. Its `module` is `commonjs` and `extensions/vscode/package.json` pins `@types/node` to `16.x` (core has `^20.19.43`). So a core vitest file that is valid for core fails `vscode-checks`.

`grep -ciE 'import\.meta|vscode tsc|VS Code (typecheck|project)|typecheckable by the VS Code|vscode tsconfig'` gives 12 subjects, 9 distinct. Examples: `0ad56891f` "drop import.meta so the VS Code typecheck accepts the renderer suite" (11-18); `96c34fdd2`, `77ae4e924`, `39f7a6a4c` (the same `import.meta` on 11-11 and 11-12); `51220d593` "do not rely on Server.closeAllConnections types (vscode tsc uses older @types/node)", five copies; `b1ee593e8` (no `util.parseArgs`).

No guard and no row. Each author learns it from a red `vscode-checks` run.

## 6. Red main, copied fixes and the release pace (V)

Repeated subjects (`sort | uniq -c`, Dependabot left out): 14 subjects, 44 extra copies.

- 24 are `ci: run checks now that the PR is ready`, an empty commit to restart the old gate, 23 of them on 11-12. The non-polling gate (`d08e99c8d`, 11-13, CI30) ended this: none since.
- 6 copies of `fix(models): register retirement-notices.json as a product state path` within one minute on 11-11, and 5 of the `closeAllConnections` fix. `main` was red and each open branch took its own copy.

Guard now: the post-merge check (CI15, built). Since 11-13 it ran 100 times and failed 4 times, and opened #921, #959 and #961. The three on 11-18 were a download in the check itself (`ba3271af3`), not the code. Missing: `gh api repos/b1tninja/continuous/branches/main/protection` answers "Branch not protected", so a red gate still does not stop a merge. Tracked as CI1 and CI16 (owner action, not applied).

Release pace: 35 tags in 16 days, 19 minor and 16 patch. 2.16.0 to 2.16.3 took 19 hours. 2.38.0 to 2.38.5 took 56 hours. The patch notes show what they fixed: 2.16.2 a stopped reply that broke every later request; 2.38.1 and 2.38.2 output caps and empty stops; 2.38.3 racing edits; 2.38.4 the Windows path compare of section 3. Tracked as CI5 (release checklist as a script, Not started) and QA22 (release gate composition, Open).

## 7. Windows (V for the gap, R for the count)

`grep -ciE 'windows|win32|backslash|crlf|8\.3|drive.letter|cmd\.exe|code page|longpaths'` gives 34 subjects. Examples: `d035b6d07` "Tests: make the Windows suite pass for real" (11-19); `67abef639` "decode Windows output in the machine's code page, not GBK"; `ef617aebb` "keep CRLF line endings when a multi-line edit matches a CRLF file"; `8352242c4` "Fold only the drive letter when a Windows path is compared".

`cli-pr-checks.yml` runs `ubuntu-latest` only for `pull_request` and `merge_group`; `pr-checks.yaml` and `post-merge-check.yml` do not name Windows at all. The owner and the outside reporters are on Windows. Tracked as QA6 (Open, target 2.18.0) and QA3. Nothing new to propose, except that section 3 is a reason to do QA6 before more features.

## 8. Debugging an e2e through CI (V)

On 11-20, 12 commits between 12:10 and 16:09 only add reporting to the Ctrl+L e2e or change how it selects text (`grep -ciE 'ctrl\+l|cmd\+l|highlighted|chat editor exists|chip throws'` on that day's subjects). Examples: `c92be40d1` "Report the chat page text when the highlighted Ctrl+L case finds no code chip"; `cc8fbf606` "Log whether Ctrl+L captured a selection and whether the chat inserted it". PR #974 had 15 gate runs: 1 passed, 8 failed, 6 were cancelled. The cause was `d7a132644`: the page has no `process`, so the handler threw.

The e2e action already uploads screenshots and `e2e.log`. What it did not show was the uncaught error in the page. QA23 covers diagnosing the `KeyboardShortcuts` failures in general.

## 9. The roadmap's own state (V)

- `grep -oiE 'PR #[0-9]+ open' plans/ROADMAP.md` names 38 distinct pull requests. `gh pr list --state all` says 35 are merged and 3 closed. None is open. QA2, QA3, QA4, QA5 and QA11 all say "PR #786 open"; #786 merged on 11-13.
- 22 of 28 Track QA rows are Open with a target of 2.18.0. The release is 2.38.5.
- CI42 to CI49 are in `ci-pipeline-redesign.md` and not in the roadmap.

`scripts/ci/roadmap-ids.js` checks ids. Nothing checks a state against GitHub.

## 10. Smaller classes (R)

- **Lockfiles.** `455046fdb`, `e5663962b`, `1aa449adf` (11-09): "Regenerate the lockfile with npm 10 (the CI version) so npm ci passes". `6f92ecf51`, `413b9ea5c`: lockfiles synced by hand after a Dependabot group bump. No `packageManager` field in the root `package.json` (V). CI34 covers the Dependabot side.
- **Product state paths.** Four files were registered in `core/util/productPaths.ts` after the locked-paths scan failed (`4aa98cd55`, `3a1489999`, `215487459`, `636455020`). The scan is a guard that works; it fires in CI and not before.
- **Flaky tests.** About 7 commits (`3e995116c`, `d409d3486`, `ed9b51d06`, `a6d49849d`, `e8a771d6f`, `7d309a453`, `39f7a6a4c`). Tracked as QA10, QA11, CI25, CI27.
- **Reverts.** 4 commits, 3 changes (`ddfeb13c8`, `c38ceff1c` for B31; `2dafc0bf7` a duplicate build fix).

## Not verified

- **Stale `node_modules` in the main checkout.** `core/node_modules/@continuedev/*` are links dated 11-21 12:06 and they resolve now. I could not see the broken state the owner found. CI18 (worktree bootstrap, Proposed) and QA25 (`doctor-dev.mjs`, Open) cover it.
- **The `gui` dev server failure.** Only the import was read.
- **Whether the page ever runs the 25 baseline pairs.**
- **The split of `core-checks`, `gui-checks` and `vscode-checks` failures** into type check, lint and tests. It needs the step results, not the job results.
- **Gate runs before 11-13.**

## Proposed rows

Ids are placeholders. "Needs" names existing rows.

| ID   | Scope                                                                                                                                                                                                                                                                | Size | Needs      | Acceptance                                                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LG1  | A "page" test project: the vitest suites of every core module the chat page imports run a second time with Node's modules replaced by the stub Vite uses and with no `process` or `Buffer`. Generalises `ideUtils.noNodePath.vitest.ts`; closes the test half of I27 | M    | I27        | With `0d94d0ea5` reverted the project fails and names `ideUtils.ts`. With the `process` guard of `d7a132644` removed it fails and names `uri.ts`. The module list is read from the build, not written by hand |
| LG2  | Burn down the webview baseline: the 11 core pairs go to 0, starting with `core/util/uri.ts`, and the globals `process` and `Buffer` get a lint rule for files in the page's import graph                                                                             | M    | LG1        | `webview-node-imports.baseline.json` has no importer under `core/`. `npm run dev` in `gui` loads the chat page in a browser with no console error. The lint rule fails on a new bare `process.`               |
| LG3  | A production render test: a fixed set of markdown (table, aligned table, inline and display math, code, raw HTML with a `style`) is rendered through the production build of the gui in a headless browser, and any React error fails it                             | M    | none       | With the plugin of #300 removed it fails on the table. With the plugin of #989 removed it fails on the math. It runs in the gui job in under 60 s                                                             |
| LG4  | One agent edit through the packaged extension on Windows: the e2e drives a scripted model to call `multi_edit` on a file in the workspace and checks the file. Nightly on `windows-latest` and in the release gate                                                   | M    | QA6, PAR1  | Fails on `v2.38.5-vscode`. Passes on `main`. The release workflow refuses a tag without a green run for that commit                                                                                           |
| LG5  | Bring CI42 to CI49 into the roadmap, and make the local pre-push check of CI47 run ESLint for the touched package as well as prettier and `tsc`. A new worktree gets its hooks from the bootstrap script                                                             | S    | QA13, CI18 | On a branch with a wrong import order and a file over `max-lines`, `npm run precheck` exits 1 and names both. Repair commits per PR (the pattern of section 4) fall below 10% over the next 50 PRs            |
| LG6  | The VS Code type check stops compiling core's vitest files, or both projects use one `@types/node`                                                                                                                                                                   | S    | none       | A core `*.vitest.ts` that uses `import.meta.url` and `Server.closeAllConnections` passes `vscode-checks` unchanged                                                                                            |
| LG7  | An uncaught error in the chat page fails the e2e with its message: the e2e reads the page's `error` and `unhandledrejection` events and prints them with the failure                                                                                                 | S    | QA23       | With the `process` guard of `d7a132644` removed, the `KeyboardShortcuts` failure text contains `process is not defined`                                                                                       |
| LG8  | A state check for the roadmap: a script lists every `PR #N open` and `Built (#N)` claim and compares it with `gh pr view`. It runs with `roadmap-ids.js`                                                                                                             | S    | none       | Today it reports 38 stale "open" claims. After the fix it reports 0, and a new stale claim fails the docs check                                                                                               |
| LG9  | A patch release for what is fixed on `main` and broken in 2.38.5 (#995, #989), and a rule that a fix for a defect in the latest release is tagged the day it merges                                                                                                  | S    | owner      | `git tag --contains 0d94d0ea5` and `git tag --contains 739c0b1fb` each name a tag                                                                                                                             |
| LG10 | Pin npm: a `packageManager` field in the root `package.json`, and CI fails when a lockfile was written by another major version                                                                                                                                      | S    | CI34       | A lockfile regenerated with another npm major fails the Supply Chain job with the two versions named                                                                                                          |

Already tracked, so not proposed again: branch protection (CI1, CI16), Windows on pull requests (QA6), the formatter entry point (QA13), flaky tests (QA10), the release checklist and gate (CI5, QA22), worktree bootstrap (CI18), the dev machine check (QA25).
