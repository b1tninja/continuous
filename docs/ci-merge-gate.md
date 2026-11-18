# CI merge gate, nightly combination run, and serial merges

Problem this solves: PRs that were each green were merged one after another and broke `main` on the
combination (ignored `lib/` directories, a test vs a wrapper, a leak test vs new fixtures, a review
eval vs a guidance change). Causes: `main` is not branch-protected; the PR check workflows use
`paths-ignore` (docs, plans, markdown), so a docs-only PR has no checks and a required check would
never report; and a push to `main` only runs the short "Main Branch Build".

## 1. `merge-gate` (CI1)

`.github/workflows/merge-gate.yml` is one workflow with no polling. One push starts these jobs:

- `changes` (seconds): reads the live draft state from the API, lists the changed files with
  `git diff --no-renames --name-only` (a rename counts under both names) and runs
  `scripts/ci/changed-areas.mjs`, which prints one `true/false` per area: `code`, `prettier`, `core`,
  `gui`, `binary`, `vscode`, `packages`, `e2e`, `jetbrains`, `cli`.
- `pr-checks` and `cli-pr-checks`: `pr-checks.yaml` and `cli-pr-checks.yml` called as reusable workflows
  (`uses:`, `secrets: inherit`). They keep their nightly `schedule` and `workflow_dispatch` triggers and
  lose `pull_request` and `paths-ignore`. Each area is an input (`run_core`, ...), so a job whose area did
  not change is skipped inside the called workflow.
- `merge-gate` (seconds, `needs: [changes, pr-checks, cli-pr-checks]`, `if: always()`): evaluates every
  needed job explicitly and writes a table to the job summary. It uses no third party action, only `jq`.

What the gate accepts:

| Situation                                           | `pr-checks`       | `cli-pr-checks`   | Gate                   |
| --------------------------------------------------- | ----------------- | ----------------- | ---------------------- |
| `changes` did not succeed                           | not judged        | not judged        | fails (cannot tell)    |
| Draft PR (live API state)                           | must be skipped   | must be skipped   | passes, with a notice  |
| Every changed file is docs (the old `paths-ignore`) | must be skipped   | must be skipped   | passes                 |
| Code change, CLI area changed                       | must be `success` | must be `success` | passes only if both ok |
| Code change, no CLI, core or packages change        | must be `success` | must be skipped   | passes only if ok      |

In every row a `failure`, a `cancelled`, or a skip that the filter did not predict fails the gate. A job
that was meant to run and was skipped (for example because something it needed was cancelled) fails: that
is the difference from a plain job-level `if`, which would report success to branch protection.

Drafts, decision: the gate **passes** on a draft and the code jobs do not run. Actions has no "neutral"
conclusion for a job, and a skipped gate counts as success for branch protection anyway, so a passing
gate with a visible notice is the honest form of the same thing. It is safe because GitHub refuses to
merge a draft. Marking the PR ready starts a new run (`ready_for_review`) that runs the checks. The draft
state is read from the API in `changes`, not from the event payload, so re-running a run that began while
the PR was a draft sees the PR as ready and runs the checks instead of passing with nothing behind it.
Before this change the gate failed on purpose for drafts and stayed red after "ready for review".

Area rules (`scripts/ci/changed-areas.mjs`, tested by `changed-areas.test.mjs`, which runs in Supply
Chain). The rule is "when in doubt run more": a path the script does not know, and an empty file list,
turn every area on.

| Changed path                                                     | Areas it turns on                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| only `docs/`, `docs-site/`, `plans/`, `*.md`, `*.mdx`, `LICENSE` | none (the gate passes; this is the old `paths-ignore` list)   |
| `packages/**`                                                    | all                                                           |
| `core/**`                                                        | core, gui, binary, vscode, e2e, jetbrains, cli (not packages) |
| `gui/**`                                                         | gui, vscode, e2e, jetbrains                                   |
| `binary/**`                                                      | binary, jetbrains                                             |
| `extensions/vscode/**`                                           | vscode, e2e                                                   |
| `extensions/cli/**`                                              | cli                                                           |
| `extensions/intellij/**`                                         | jetbrains                                                     |
| `bench/**`                                                       | none besides prettier (nothing in the PR checks builds it)    |
| anything else (`.github/**`, root files, `scripts/**`, new dirs) | all                                                           |

`prettier` is on whenever any non-docs file changed. The check names in the list change: a called job shows
as `pr-checks / core-checks`, `cli-pr-checks / test (ubuntu-latest, 22)` and so on; only `merge-gate` is
meant to be required. To add a check, add the job to `pr-checks.yaml` or `cli-pr-checks.yml` (it joins the
gate through the called workflow's result, nothing to list) and, if it belongs to an area, give it that
area's `inputs.run_*` condition. A new top-level directory needs a rule in `changed-areas.mjs` if it should
be allowed to skip checks; until then it runs everything.

`merge_group` is handled: `changes` diffs the group's base and head, the checks run in the queue, and
`merge-gate` evaluates them. A queue needs an organisation-owned repository (section 4), so this is
untested here. Limits: the API-key tests of `check-llm-changes` do not run for a merge group (it diffs
against a PR base), and `workflow_dispatch` of the gate runs everything, including the full CLI OS and Node
matrix, like the nightly run.

Jobs per push, before and after (a job counts when it takes a runner slot; skipped jobs do not). Before
the change nothing was filtered, so every code change started the same 33.

| Scenario (example files)                 | Before | After | Notes                                                           |
| ---------------------------------------- | -----: | ----: | --------------------------------------------------------------- |
| docs-only (`docs/x.md`)                  |      1 |     2 | before: the polling gate; after: `changes` + gate, seconds each |
| draft PR, any files                      |      1 |     2 | before the gate failed on purpose; after it passes              |
| bench-only (`bench/runner.mjs`)          |     33 |     5 | `changes`, prettier, 2 Supply Chain, gate                       |
| intellij-only (`extensions/intellij/**`) |     33 |     6 | plus prettier and JetBrains tests                               |
| cli-only (`extensions/cli/**`)           |     33 |     8 | lint, test, smoke-api                                           |
| vscode-only (`extensions/vscode/**`)     |     33 |    18 | vscode checks, the e2e matrix job, the package job, 10 e2e legs |
| gui-only (`gui/**`)                      |     33 |    20 | plus gui checks, JetBrains                                      |
| core-only (`core/**`)                    |     33 |    25 | everything but the 7 package jobs                               |
| packages-only (`packages/**`)            |     33 |    32 | everything                                                      |
| workflow-only (`.github/**`)             |     33 |    32 | everything: a workflow edit is validated by running all of it   |

For the full run of 32 the removals are the polling gate's long slot (now seconds) and the two inner
aggregate jobs (`require-all-checks-to-pass`, `require-all-checks-to-pass-cli`; they still run in the
nightly runs and are skipped when called), against the added `changes` job. No check that tests
correctness was merged or dropped. The target of 8 to 12 is reached only for CLI, JetBrains and bench
changes; everything else is dominated by the 10 e2e legs, left alone on purpose (section 7, "Not done
here").

Replay over the last 70 merged PRs (`gh api repos/b1tninja/continuous/pulls/N/files`, previous names
included): 38 were docs-only (the last 10 merged were 9 docs-only and one dependency bump) and 32 touched
code. The 70 would have started 718 jobs against 1,094 before (a docs-only PR counts 2 against 1). Try one
PR: `gh api --paginate repos/b1tninja/continuous/pulls/693/files --jq '.[] | .filename, (.previous_filename // empty)' | node scripts/ci/changed-areas.mjs`.

Uses only the preinstalled `gh`, `jq` and `node` and the built-in `GITHUB_TOKEN` (`contents: read`;
`pull-requests: read` in `changes` only). No third party action is added, so there is nothing new to pin.
The file list is classified by a script in the repository rather than by `dorny/paths-filter`, which the
repository does not use today and which would be a new pin; the script is unit tested.

## 2. Full-suite run on `main` (CI2)

Decision: nightly plus manual dispatch, not every push.

`PR Checks` and `CLI PR Checks` already have `schedule` (05:23 and 05:41 UTC) and `workflow_dispatch`
triggers, so the nightly full suite on `main` exists and needs no `workflow_call` plumbing: the
scheduled run executes the same jobs as a PR, against the tip of `main`. Run it on demand from the
Actions tab (or `gh workflow run "PR Checks" --ref main`) after a burst of merges.

Why not on every push to `main`: jobs have been queued for hours, so a per-push full run would
queue behind itself, cancel nothing useful, and report on a SHA that is already several merges old.
With serial merges (below) plus the up-to-date requirement, the combination of two PRs is tested
before it lands; the nightly run is the backstop for whatever slips through, and a failing nightly
points at a window of at most one day of merges to bisect.

## 3. Serial-merge protocol (CI3)

Hot files that several branches touch: dialect tables, enum and registry, `loadYaml.ts`,
`evaluate.ts`, `extensions/cli/src/index.ts`, `plans/ROADMAP.md`, the recovery docs page.

1. List the PRs you intend to merge and run `node scripts/ci/merge-ready.mjs 518 519 520`. It only
   reads: per PR it shows whether the head is up to date with `main`, the `merge-gate` state and
   conflicts, then the safe order and which PRs must be updated after each merge.
2. Merge ONE PR. Do not click merge on a second one yet.
3. For each remaining PR that shares files with it (the script lists them, hot files flagged), use
   "Update branch", wait for `merge-gate` to go green again on the new head, then merge it.
4. PRs that share no files can be merged in any order, but "Update branch" is still required once
   branch protection has `strict: true`.
5. Before pushing a new directory, run `node scripts/ci/check-ignored.mjs`: it lists ignored
   directories that contain source files (the `lib/` trap that hit `bench/research/lib` and
   `bench/lab/lib`). It only sees a working tree, so it cannot run in CI.

## 4. Enabling branch protection (owner action, not applied by the PR)

Run once `merge-gate` has reported green on at least one PR (a required check that has never run
cannot be selected):

```sh
gh api -X PUT repos/b1tninja/continuous/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [{ "context": "merge-gate", "app_id": 15368 }] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

The exact recipe, as settings:

- Require a pull request before merging, with **no required reviews** (approving count 0).
- Require the status check `merge-gate`, pinned to the GitHub Actions app (`app_id` 15368), so no other
  app or status can satisfy it by reporting the same name.
- Require branches to be up to date before merging (`strict: true`).
- Allow **squash merging only**: in Settings, General, Pull Requests, untick "Allow merge commits" and
  "Allow rebase merging" (a repository setting, separate from the protection API call above).
- Leave "Do not allow bypassing the above settings" off (`enforce_admins: false`), so admin bypass stays on.
- No merge queue (not available on a user-owned repository, see below). No force pushes, no deletions.

Failure modes to know before enabling it:

- A required check whose workflow is skipped by a **path filter** (`paths` or `paths-ignore` on the
  trigger) never reports, stays Pending and blocks the merge forever. `merge-gate.yml` therefore has no
  path filter and must not get one; the called workflows have no `pull_request` trigger at all.
- A job skipped by a job-level `if` reports **success** to branch protection, so a gate skipped that way
  passes silently. `merge-gate` has `if: always()` and judges each needed job itself (section 1); the
  only skips it accepts are the ones the filter or the draft state predicted.
- Enabling protection before `merge-gate.yml` is on `main` and has run once blocks every PR, because the
  check cannot report. Merge the workflow first, confirm it reported on a PR, then enable protection.
- If Actions is frozen or disabled, `merge-gate` cannot report and every merge is blocked. Admin bypass
  is the escape hatch ("Merge without waiting for requirements", or push as admin).

Risks: a stuck or never-reporting required check blocks every merge. Because `enforce_admins` is
false, the owner can still merge through the "Merge without waiting for requirements" option or by
pushing; to remove the rule entirely run
`gh api -X DELETE repos/b1tninja/continuous/branches/main/protection`. `strict: true` means every
merge needs the branch updated first, which is the point, but it multiplies runs on a slow queue.
The gate no longer waits: it starts when the jobs it needs have finished and takes seconds, so there is no
timeout to re-run.

Merge queue: it is available only for repositories owned by an organization. `b1tninja/continuous`
is user-owned (`gh api repos/b1tninja/continuous` reports owner type `User`), and
`gh api repos/b1tninja/continuous/rulesets` returns an empty list, so rulesets are readable but no
merge queue rule can be added here. If the repository moves to an organization, create a ruleset
with the `merge_queue` rule. `merge-gate.yml` already has the `merge_group` trigger and runs the real
checks for the queue entry through `needs` (section 1).

`--combine` (read-only): `node scripts/ci/merge-ready.mjs 518 519 520 --combine` first does a fresh
`git fetch origin` of `main` and every PR head into `refs/combine/*`, then prints a pairwise matrix computed with
`git merge-tree --write-tree` (git 2.38 or newer): does PR A conflict when merged after PR B, which files,
and which of the shared files are hot. Nothing is checked out and the index and working tree are not
touched; it only writes unreferenced objects. It proves textual conflicts only, not that the combined
tree builds or passes tests, so it does not replace "Update branch" plus a green `merge-gate`.

## 6. Building the merged result (CI15)

Evidence: #553 x #557 (TS2741 in core, fixed in #573) and #587 x #588 (`evaluateRules` complexity 53 > 52,
fixed in #592) each passed every check alone and broke `main` together.

What ran on a push to `main` before this section: `Main Branch Build` (`main-build.yaml`) only republishes
the VS Code artifact of the merged PR's check run, and `Publish Extension` runs on release. Neither
type-checks or lints anything. The jobs that lint and type-check core (`core-checks`: `npx tsc --noEmit`
and `npm run lint` in `core`; likewise `gui-checks`, `binary-checks`) run only on `pull_request`, on a
05:23 UTC schedule and on dispatch, so a bad combination stays red until the next night. `merge-gate`
only judges the PR head's own checks, so it cannot see the combination either.

| Option                                                          | Cost                                                                                                                                            | Catches                                                                        | Decision                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| (a) `post-merge-check.yml` on `push` to `main`                  | three small jobs (about the PR check time for tsc and lint, no tests), one issue                                                                | the break within minutes of the merge, with the commit named; does not stop it | built                       |
| (b) `strict: true` (up to date with `main`)                     | owner action; every merge needs "Update branch" and a fresh gate run, which multiplies runs on a slow queue                                     | the break before it lands, for every pair                                      | owner action, command below |
| (c) `merge-ready.mjs --trial`                                   | local, no CI cost; needs a checkout with `node_modules` to run the checks                                                                       | the break before it lands, for the PRs the person lists                        | built                       |
| (d) `merge-gate` re-run through `workflow_run` after each merge | re-runs every open PR's gate per merge and needs a token that can re-run workflows; a re-run proves nothing unless the PR head is updated first | nothing that (b) does not do better                                            | not built                   |

### (a) The post-merge check

`.github/workflows/post-merge-check.yml` runs on `push` to `main` and on dispatch (never on
`pull_request_target`). Jobs `core`, `gui` and `binary` run the same commands and local setup actions as
the PR checks (type-check and lint; no vitest, which takes longest and has not been what broke). A
`report` job keeps one open issue titled `main is red: post-merge check failed`: it comments on it when a
later run fails too, and closes it when a run is green. Permissions are `contents: read` for the
checks, plus `issues: write` in the report job only; there are no new secrets, no new actions and the
report job has no checkout. A newer push cancels the run in flight (only the latest tip matters), and a
cancelled run does not touch the issue. Not a required status: it reports after the merge, so it
shortens the time to notice, not the time to break.

### (c) The trial merge before merging

```sh
node scripts/ci/merge-ready.mjs 593 594 --trial            # plan: conflicts, projects to check
node scripts/ci/merge-ready.mjs 593 594 --trial --run      # type-check and lint the merged result
node scripts/ci/merge-ready.mjs 593 --trial --run --deps D:/code/some-checkout-with-node_modules
```

For each PR it fetches `main` and the head into `refs/combine/*`, merges them with
`git merge-tree --write-tree` (no checkout), and compares what each side changed since the merge base to
pick `core`, `gui` and `binary` (a `core` or `packages` change checks all three; docs-only checks
nothing; a head that already contains `main` needs nothing). With `--run` it creates a temporary
detached worktree of the merged commit, links `node_modules` from `--deps` (default: the current
directory) and runs the PR-check commands; afterwards it removes only the links (never the target), the
worktree and the temporary directory. It exits 1 on a conflict or a failing check. It never installs,
merges, pushes or touches the working tree or index. Run it for the PR you are about to merge after the
previous one landed, instead of waiting for "Update branch" and a full gate.

### (b) Strict mode, owner action (not applied by the PR)

Run after the commands in section 4 are decided. It replaces only the required status checks of the
protection that section 4 creates, so apply section 4 first; `strict` is already `true` there.

Recommendation: keep `strict: true`. `main` broke twice from two individually green PRs merging (#573,
#592), and the post-merge check in (a) only detects that after the fact.

Consequence: merges are serial. Each queued PR whose base has moved needs its branch updated before it
can merge: `gh pr update-branch <n> --repo b1tninja/continuous` (or a small script or loop over the open
PRs), then wait for `merge-gate` on the new head. Auto-merge does not do this. GitHub's documentation
on auto-merge does not say that it updates the branch, so a PR whose base moved stalls until someone or
something updates it. "Always suggest updating pull request branches" only shows the "Update branch"
button; it does not update anything automatically.

Alternative: leave `strict` off (`strict=false` in the command below) and rely on the post-merge check
in (a). Merges then do not need an update step, but a bad combination is found only after it lands.

Merge queue: since CI30 the gate runs the real checks on `merge_group` (section 1), so a queue would test the
combination. It is still unavailable for a user-owned repository (section 4) and the `merge_group` path has
not been exercised.

Sources: GitHub Docs, "Automatically merging a pull request"
(https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request),
"Managing suggestions to update pull request branches"
(https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-suggestions-to-update-pull-request-branches),
"About protected branches"
(https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

```sh
gh api -X PATCH repos/b1tninja/continuous/branches/main/protection/required_status_checks \
  -F strict=true -f 'checks[][context]=merge-gate' -F 'checks[][app_id]=15368'
```

Do not add `post-merge-check` to `contexts`: it only runs on `main`, so a required check by that name
would block every PR.

## 7. Rollout, observation and rollback of the non-polling gate (CI30)

Starting point, checked with `gh api repos/b1tninja/continuous/branches/main/protection` (HTTP 404, "Branch
not protected"): nothing requires `merge-gate` today, so merging the change cannot block a pull request.
What does depend on the name `merge-gate` is `scripts/ci/merge-ready.mjs` and whatever watchers read the
check, and the name is kept.

Why not a literal `merge-gate-v2` next to the old gate: the old gate polls for check runs named
`require-all-checks-to-pass` and `require-all-checks-to-pass-cli`. Run side by side, the old workflows would
keep their `pull_request` triggers (every code push starts the suites twice, which fills the 20-job cap this
change exists to relieve), and the called jobs report under new names (`pr-checks / ...`), so the old
poller would never find its checks and would hold a slot until its timeout. A parallel period is therefore
not cheap and not safe. The same observation is available more cheaply because nothing is protected yet.

Stages:

1. **Draft pull request** (this one). The branch's workflow files are the ones that run for its own
   `pull_request` events. While it is a draft: `changes` and `merge-gate` run (two jobs), the gate passes
   with the draft notice, and no code job starts. `pr-checks.yaml` and `cli-pr-checks.yml` no longer have a
   `pull_request` trigger, so nothing runs twice. Read the job summary of `merge-gate` and `changes`
   (changed files, area flags, the expectation table).
2. **Mark it ready** (owner action). This pull request changes `.github/**`, which turns every area on, so
   the run that follows is the full test of the new wiring: 32 jobs, the called workflows, `secrets: inherit`,
   the concurrency groups, the inputs. Expect `merge-gate` green after the last job ends and no job named
   `merge-gate` waiting while the others run. If a called workflow cannot start (a syntax or permission
   problem the static checks missed), the run fails at start-up and `merge-gate` reports red or not at all;
   nothing is protected, so the cost is a revert (below).
3. **Observe five or so ordinary pull requests** after merging, and tick the acceptance list: a docs-only PR
   reports `merge-gate` in under two minutes with no code jobs; a code PR runs only its areas and the gate
   turns green when the last one finishes; a draft passes; marking a draft ready starts a run that runs the
   checks; a PR with a failing job turns the gate red; "Re-run failed jobs" on a red run turns it green;
   no `sleep`-poll loop exists in any workflow (`grep -rn "sleep" .github/workflows`); the number of
   running `merge-gate` jobs is zero while real jobs queue.
4. **Only then enable protection** (section 4), as before: merge the workflow, confirm `merge-gate`
   reported on a PR, then protect. Branch protection stays an owner action and this change touches no
   repository setting.

If the owner still wants a literal second name for a while, the cheapest form is to merge with the aggregate
job named `merge-gate-v2` (one line: `name: merge-gate-v2` on the `merge-gate` job), observe, and rename it
back in a second small change. During that window nothing reports `merge-gate`, so `merge-ready.mjs` shows
no gate; because nothing is protected, that costs only the script's gate column.

Rollback: revert the merge commit (`git revert -m 1 <sha>` for a merge, or the squash commit). It restores
the polling `merge-gate.yml` and the `pull_request` triggers and `paths-ignore` of the two workflows in one
commit, and the check name stays `merge-gate`, so a protection rule created in the meantime keeps working
(the old gate then waits for the old aggregates again). No setting needs to change. If the gate is red
because of a GitHub incident and protection is on, `enforce_admins: false` is the escape hatch of section 4;
to remove the rule, `gh api -X DELETE repos/b1tninja/continuous/branches/main/protection`.

Not done here (each needs a measurement or a scratch run first):

- Merging the 10 e2e legs into two jobs (one per command). The legs share `CONTINUE_GLOBAL_DIR`
  (`e2e/test-continue`), the VS Code storage and the installed test extensions; run in one job, one file can
  leave state for the next, and that cannot be tested without a runner. Measure first (section 3.3 of
  `plans/research/area-ci-privacy-release.md`, CI33).
- Merging the 6 package legs into one job and `binary-checks` or the CLI lint into another job. Small
  gain, since these skip when their area did not change.
- Running prettier for docs-only changes. It does not run for them today either (the old `paths-ignore`),
  so a badly formatted markdown file passes. Running it costs one job per docs PR.
- Letting more tooling directories (`scripts/ci/**`, `eval/`, `skills/`, `sync/`) skip the code checks. Each
  needs a look at what consumes it; until a rule exists they run everything.
- A timeout on every job (CI37) is left to pull request #734, which edits the same two workflow files.
  This change adds `timeout-minutes` only to its own new jobs (`changes` and `merge-gate`, 5 minutes each)
  and does not touch the lines #734 adds; see the pull request body for the overlap.

## 8. Measured job costs (2026-11-13)

Source: the last 100 completed `pull_request` runs of PR Checks and of CLI PR Checks, and 60 of Supply Chain,
from the REST API (`actions/workflows/<file>/runs`, then `runs/<id>/jobs?filter=latest`), all from before the
non-polling gate. Only jobs that concluded `success` or `failure` are counted (cancelled runs are most of the
100: a newer push supersedes them). The 100 PR Checks runs span 2026-11-13 02:07 to 14:50 UTC; 47 of them
reached the test jobs. Duration is `completed_at - started_at`; queue is `started_at - created_at`. The split
uses the step timings of each job: fixed (set up job, checkout, setup-node, cache restore and save, post
steps), install/build (`Setup packages`, `Setup <component>`, installs, `Build core`, building the extension),
tests (type check, lint, test steps). "Mixed" is a composite action whose steps the jobs API does not split;
for those a job log was read (one successful run of each).

| workflow  | job                            | n   | median min | p90 min | queue median min | queue p90 min | fixed % | install/build % |        tests % (mixed) |
| --------- | ------------------------------ | --- | ---------: | ------: | ---------------: | ------------: | ------: | --------------: | ---------------------: |
| PR Checks | vscode e2e (10 legs, per leg)  | 440 |        2.0 |     2.9 |             41.9 |         192.6 |       5 |    about 38 (a) |           about 57 (a) |
| PR Checks | jetbrains-tests                | 47  |        8.3 |     9.4 |             31.2 |         158.8 |      25 |    about 36 (b) |           about 47 (b) |
| PR Checks | core-checks                    | 47  |        6.8 |     8.2 |             33.7 |         127.7 |       5 |              11 |                     83 |
| CLI       | test (ubuntu, Node 22)         | 55  |        5.2 |     6.1 |             13.4 |         125.0 |       4 |              25 |                     70 |
| PR Checks | gui-checks                     | 47  |        5.5 |     6.0 |             32.3 |         140.5 |       2 |              18 |                     79 |
| PR Checks | packages-checks (6 legs, each) | 267 |        0.9 |     1.3 |             35.2 |         170.4 |      39 |              48 | 8 (c), mostly `npm ci` |
| PR Checks | vscode-package-extension-linux | 46  |        3.5 |     4.0 |             24.2 |         155.4 |      24 |              75 |                      0 |
| CLI       | lint                           | 54  |        1.9 |     2.2 |             12.6 |         121.7 |      10 |              67 |                     21 |
| CLI       | smoke-api                      | 54  |        1.6 |     1.8 |             11.5 |         127.9 |      11 |              85 |                      1 |
| PR Checks | vscode-checks                  | 49  |        1.7 |     2.0 |             25.4 |         130.0 |       9 |              49 |                     38 |
| PR Checks | binary-checks                  | 49  |        1.2 |     1.4 |             19.9 |         122.1 |      10 |              72 |                     14 |
| PR Checks | vscode-get-test-file-matrix    | 48  |        1.1 |     1.2 |             30.0 |         137.1 |      40 |              56 |                      0 |
| PR Checks | prettier-check                 | 46  |        1.0 |     1.2 |             32.0 |         129.9 |      20 |               1 |                     75 |
| Supply    | pins-and-notice                | 36  |        0.2 |     0.3 |             17.2 |         114.1 |      58 |               0 |                     18 |
| Supply    | dependency-review              | 36  |        0.1 |     0.2 |             16.3 |          93.5 |      60 |               0 |                     10 |
| PR Checks | get-packages-matrix            | 46  |        0.1 |     0.2 |             25.5 |         145.1 |      63 |               0 |                      0 |

(a) One leg's log: about 57 s of setup (four cache restores 23 s, `build-packages.js` 18 s, compile and
extension install 4 s) and 94 s of test. (b) One log: `Free disk space` 86 s (median 104 s), then 3.3 min building packages, gui, the
extension prepackage and binary before Gradle, and Gradle 4.3 min. (c) `Test and check <package>` is `npm ci` plus the tests; the
tests themselves take 2 to 17 s.

A full PR Checks run costs a median of 55 runner-minutes (p90 58), a CLI PR Checks run 8.4.

The five largest time sinks:

1. Queue delay, not run time. Every job waited a median of 12 to 42 minutes for a runner (p90 two to
   three hours) against run times of 0.1 to 8 minutes. In this window the pool (20 concurrent jobs) was
   mostly held by the polling gate, which section 7 removes; what is left is driven by the number of jobs
   per push, so removing jobs matters more than shortening them.
2. The e2e legs: 10 per push, 2 minutes each, about 40 % of it setup that every leg repeats.
3. `core-checks`: `npm run vitest` alone takes about 5.3 minutes (469 files) and jest 43 s; the type check
   and lint 48 s.
4. `jetbrains-tests`: 8.3 minutes, of which about 1.5 is freeing disk and 3.3 rebuilding packages,
   gui, the extension and binary before Gradle starts.
5. Repeated setup: `build-packages.js` (installs and builds all six packages) runs in about 25 jobs per
   push at 18 to 29 s each (about 10 runner-minutes); the six package legs spend 87 % of their time on it
   to run 2 to 17 s of tests each; the CLI builds core three times (20 s each).

## 9. Affected-only tests, folded jobs and the e2e file list

Each part follows section 8's measurements and the phases of `plans/research/ci-pipeline-redesign.md`
(PR #805), and keeps the rule of section 7: when in doubt, run more. `merge-gate` stays the only check to
require. The shared build of the packages is not here: PR #650 caches the built packages
(`packages/*/{node_modules,dist}`, keyed on their sources and lockfiles) in every job that needs them,
which the research note adopts as is (its section 3.2) and which needs no extra stage on the critical path.

### (a) Affected-only unit tests, shadow mode first (CI44)

`scripts/ci/affected-tests.mjs` (pure planning functions, tested by `affected-tests.test.mjs` under
`node --test`, run in Supply Chain) plans one of the three suites the research note selects at file level:
`core-vitest`, `gui` and `cli`. Core's jest suite (about 40 s) and the VS Code vitest suite always run in
full. On a `pull_request` event the selection is `vitest related --run --passWithNoTests` on the changed
modules of the suite's own directory plus the smoke set in `scripts/ci/smoke-tests.json` (a proposal: the
owner chooses the final list). The suite runs in full when:

- the event is anything but `pull_request` (`merge_group`, nightly, dispatch, push);
- the changed-file list is missing, empty or longer than 150 files (`changes` then passes no list), or
  more than 60 of the files are in the suite's directory;
- any relevant file is a manifest or lockfile, a `tsconfig*.json`, a vitest, vite, jest or babel config,
  `.npmrc` or `.nvmrc`, a test setup or global-setup file, anything under a `test/` directory, a fixture
  (`fixtures/`, `__fixtures__/`, `testdata/`), a snapshot, a golden file or a `__mocks__/` file;
- a file in the suite's directory is not a JS/TS module (JSON, YAML, `.scm`, CSS: read from disk or by
  a bundler, not seen by the module graph), was deleted or renamed away, or has unusual characters;
- a file is in an area the suite consumes across a `file:` link or a built `dist/` (`packages/` for all
  three, `core/` for gui and cli). Whether vitest follows such a change into the consumer's tests is
  unverified (research note 3.1), so that stays a directory-level decision;
- a file is outside every known area (root, `scripts/`, `.github/`, `eval/`, ...);
- planning itself throws.

Files in areas the suite does not consume are ignored (an intellij change does not widen the core tests).
The command runs as an argv array with no shell on Linux, and each path is passed as `./<path>` after a
character check, so a file name cannot inject an option or a command.

**Shadow mode is the default.** Unless the repository variable `CI_AFFECTED_TESTS` is `on`, the job writes
the plan (mode, reason, selection inputs) to the step summary and runs the full suite. The research note
asks for two weeks of shadow runs with no escape (a failing test the selection would not have run) before
the variable is set; after that, a post-merge or nightly failure in a test a pull request skipped counts as
an escape, and two in a month turn selection off again (unset the variable). Setting or unsetting it is a
repository setting, an owner action that this change does not take.

Safety nets once it is on: the post-merge check now runs the core (jest and vitest), gui and CLI unit
suites in full after every push to `main` (CI24 extended), and the nightly PR Checks and CLI PR Checks runs
stay full. Type checks, lint, the CLI smoke and e2e tests, the package tests and the VS Code e2e tests are
never narrowed.

Known limits: `vitest related` follows static imports and `import()` with a literal path, not
`import(variable)`; 189 test files use `vi.mock` and 115 core test files read files from disk (research
note 3.1). The deny list catches fixtures by location only; a test that reads a file elsewhere is the case
shadow mode is there to measure.

### (b) The six package legs are one job

`packages-checks` runs `npm test` in each of the six packages in one job (each in its own log group;
every package runs after one fails, and the job fails if any did). It replaces `get-packages-matrix` and
the six legs, 7 jobs to 1, and drops each leg's second `npm ci` (setup-packages has just installed and
built the same lockfiles). It is the first step of the research note's `unit` job (phase 2 b), which
will also take the gui, VS Code and binary tests.

Not folded here, because the research note gives them a different home: `pins-and-notice` and
`prettier-check` go into the `static` job of phase 2 a (prettier is part of the required gate, Supply
Chain is advisory, so merging them is a policy choice for that step), and `dependency-review` is to run
only when a manifest, a lockfile or a workflow changed.

### (c) The VS Code e2e tests

When they run is unchanged: only for a non-draft pull request whose change touches `core/`, `gui/`,
`extensions/vscode/` or `packages/` (or a path outside every known area), which is the `e2e` area of
`changed-areas.mjs`; drafts run no code checks at all (section 7). `packages/` stays in the condition
because the packages are bundled into the extension (the `e2e:ci:run-yaml` legs exercise config-yaml).

The list of test files is now computed by `vscode-package-extension-linux` from the source tree
(`e2e/tests/X.test.ts` becomes `e2e/_output/tests/X.test.js`), as the research note's `vsix-linux` job
does, and `vscode-get-test-file-matrix` is gone: it installed, built and compiled everything for 1.1
minutes only to list five files. The listing step runs first and stops the run if a test file is named
in a way the mapping does not cover; each leg still compiles the tests, so a compile error fails the run.
Same 10 legs, same names.

The 10 legs stay separate jobs. Two jobs (one per command, research note phase 2 d) would save about
8 x 57 s of repeated setup and 8 queue slots per e2e push, but the five files of a command share one
`CONTINUE_GLOBAL_DIR` (`e2e/test-continue` or `e2e/test-continue-yaml`), `e2e/storage` and the installed
test extensions, so one file could leave state for the next. The research note asks for one trial run on
a branch first; that needs a runner and is not part of this change.
