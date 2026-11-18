# Supply-chain policy

Scope: what the fork adds. The existing monorepo keeps its ranges and its Dependabot configuration; this policy does not rewrite them.

## Pins

| Where                                                | Rule                                                                                                                                                                         | Enforced by                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `bench`, `bench/research`, `bench/lab`               | Zero dependencies. Plain Node and the standard library only.                                                                                                                 | `scripts/ci/check-pins.mjs` and its test                      |
| `bench/screenshots`                                  | One dependency, `playwright-core` at an exact version, `package-lock.json` committed, every lockfile entry with an `integrity` hash. Install with `npm ci --ignore-scripts`. | `check-pins.mjs` (exact version, lockfile, integrity)         |
| `@anthropic-ai/sandbox-runtime`, wherever it appears | Exact version, never a range. Install with `--omit=optional --ignore-scripts`. The lockfile carries the integrity hash. Update by pull request with the changelog read.      | `check-pins.mjs` (any `package.json` naming it must be exact) |
| GitHub Actions added by the fork                     | Full commit SHA with the tag in a comment.                                                                                                                                   | review                                                        |

For reference, `npm view @anthropic-ai/sandbox-runtime` on 2026-11-10 gave version 0.0.82 with integrity `sha512-SCPWkuhLw4ieL+06Jp72yFevltS0s2GD1kMOZdSJ6XxeuqTcoyAa1EDwiLxuONp6szNEOD7x02+vYxPa0oAWwg==`. It is a beta package, hence the exact pin. It is not a dependency yet.

Why `--ignore-scripts`: a dependency's install scripts run with the developer's or the runner's rights before anything is reviewed.

Run the checks from the repository root, no install needed:

    node scripts/ci/check-pins.mjs
    node --test scripts/ci/check-pins.test.mjs

Out of scope for now: pinning the existing actions that use tags (`actions/checkout@v7` and so on) and moving the existing ranges to exact versions. Both are separate changes with a large diff.

## dependency-review

`.github/workflows/supply-chain.yml` runs `actions/dependency-review-action` on pull requests with `fail-on-severity: high`. The repository's dependency graph is available (the SBOM endpoint answered with 6,445 packages on 2026-11-10), which the action needs. The job has only `contents: read` and no secrets, and posts no comment.

It is **not a required check**. The merge gate (`docs/ci-merge-gate.md`) evaluates only the PR Checks and CLI PR Checks workflows it calls, so a separate workflow cannot block or stall a merge. Do not add it to the gate's `needs`. A high-severity advisory on a dependency a pull request adds should be read before merge; the failure is a signal for the reviewer.

The same workflow runs `check-pins.mjs` and `check-notice.mjs` and their tests as a second job, also not required.

Limits: the action compares the manifests and lockfiles in the pull request against the base. Gradle dependencies appear only as far as `submit-github-dependency-graph.yml` has submitted them from `main`.
