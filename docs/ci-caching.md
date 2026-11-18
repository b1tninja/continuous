# CI caching

What CI caches, how the keys are built, who may write each cache, and why release builds use none of the
build-input caches. The composite actions that implement it are `setup-packages`, `setup-component`,
`build-vscode-extension`, `run-vscode-e2e-test` and `run-jetbrains-tests` under `.github/actions/`.

## Rules

1. **Key.** Every cache key has the runner OS, the node version (the `node-version` output of
   `actions/setup-node`) where the content depends on it, and the hash of the lockfile or sources the content
   is built from. Nothing volatile (a run id, a date, a hash over `node_modules`) goes in a key.
2. **Clean state.** `node_modules` is saved with `actions/cache/save` straight after a clean `npm ci`, before
   a test, a prepackage step or `npm i vectordb` touches it. A job that mutates `node_modules` restores the
   clean copy and never saves one. (The old `actions/cache` post-step saved whatever the job left behind, and
   only when the job passed.)
3. **Exact hit skips the install.** `npm ci` is skipped only on an exact key hit (`cache-hit == 'true'`). A
   restore-key match (`cache-hit == 'false'`) is used for the npm download cache only, never for
   `node_modules`.
4. **Who saves.** Small, exact-key entries (`node_modules`, the built packages) may be saved by any run. The
   large ones (the npm download caches, the VS Code download for e2e, the Gradle wrapper) are saved from
   `main` only (`github.ref == 'refs/heads/main'`: pushes to main and the nightly schedules). Pull requests
   restore them. The repository held 13.8 GB of caches against a 10 GB limit when this was written, mostly
   per-pull-request copies of the same 700 MB e2e download and 300-480 MB npm caches, so the entries that
   mattered were evicted.
5. **Release builds restore nothing they ship.** See the next section.
6. **Pins.** The `actions/cache` restore and save steps are pinned to the commit of `v6.1.0`
   (`55cc8345863c7cc4c66a329aec7e433d2d1c52a9`), as the policy in `docs/supply-chain.md` asks for actions the
   fork adds.
7. **Report.** Every composite writes a "Cache report" to the job summary (`.github/actions/cache-report`):
   hit, partial (restore-key) or miss per cache. Read it on the first runs to see whether a cache works.

## Security

GitHub scopes caches by ref. A run can restore caches written for its own ref or for the default branch; a
pull request run can also restore its base branch's. It cannot restore a sibling branch's or another pull
request's, and a run on `main` or on a tag cannot restore anything a pull request wrote. So a pull request can
poison only its own later runs. No workflow here uses `pull_request_target` or `workflow_run` (checked), so
there is no run that has secrets and restores a cache a pull request chose.

What remains is `main`'s own caches: they are written by runs of code that was merged, and restored by the
release runs. A poisoned `node_modules` is a way into the VSIX (a restored module is not re-hashed by npm).
So:

- `build-vscode-extension`, `setup-packages` and `setup-component` take a `cache` input, and the release
  builds pass `"false"`: `main.yaml` (the `build` matrix and the `cli` job) and `preview.yaml` (the pre-release
  `build` matrix). With it, nothing is restored: packages build cold, every `npm ci` runs, the sqlite3 prebuilt
  is downloaded.
- `jetbrains-release.yaml` had `node_modules` caches that were restored and then deleted by the `npm ci` steps
  after them. They are removed. Its Gradle setup and Plugin Verifier IDE cache are unchanged: Gradle's cache is
  read-only outside the default branch, and the verifier IDEs are not part of the plugin.
- The npm download cache is the exception inside the release builds that still use it (`setup-node`'s
  `cache: npm` in the `cli` release job): `npm ci` checks every tarball it reads against the lockfile's
  integrity hash, so a poisoned entry fails the install instead of shipping.
- The e2e and JetBrains test jobs and the docs-screenshots job are not release builds and use the caches.

## What is cached

| Cache                                              | Key (after the OS)                                                                 | Saved by                      | Notes                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| Built packages (`packages/*/dist`, `node_modules`) | `packages-built-node<v>-<hash of package.json, lock, tsconfig, src, build script>` | any run, exact key            | Replaces `build-packages.js` on a hit                             |
| `node_modules` per component and root              | `<component>-node-modules-node<v>-<lock hash>`                                     | any run, right after `npm ci` | Shared by setup-component, e2e, JetBrains and the extension build |
| npm download cache                                 | `npm-cache-<family>-<lock hash>`, restore-key on the prefix                        | main only                     | Used only when an install has to run                              |
| VS Code + chromedriver for e2e                     | `vscode-storage-<hash of vscode package.json and lock>`                            | main only                     | 712 MB                                                            |
| Marketplace extensions for e2e                     | `vscode-test-extensions-<hash of install-e2e-extensions.js>`                       | main only                     | Was the constant key `CONSTANT`                                   |
| sqlite3 prebuilt                                   | `sqlite3-prebuilt-v5.1.7[-<target>]`                                               | any run                       | Bump with `SQLITE_VERSION`                                        |
| Gradle wrapper distribution                        | hash of `gradle-wrapper.properties`                                                | main only, after the test run | `setup-gradle` keeps its own dependency cache                     |
| CLI `node_modules`                                 | `node<v>-cli-modules-<lock hash>`                                                  | main only                     | Exact hit skips `npm ci --include=optional`                       |

## Removed, because they never helped

- `packages/*/node_modules` restored by `setup-packages`, `setup-component` and the extension build:
  `build-packages.js` runs `npm ci` in every package, which deletes it first.
- The extension build restored `node_modules` for the extension, core and gui and then ran `npm ci` in each,
  and used the key prefix `-node-` where every other job used `-<component>-node-modules-`, so the entries
  never matched the ones `main` saves. Its npm cache was keyed on `**/package-lock.json` (481 MB).
- The JetBrains `vscode-prepackage` cache: its key hashed `extensions/vscode/**/*.ts`, which walks
  `node_modules` (5.5 s a run), and the path it saved did not exist (`Path Validation Error`), so it never
  hit. The prepackage step always ran.
- The prettier job's gui `node_modules` shared a key with the gui checks although it is installed with
  `--ignore-scripts`; it has its own key now.

## Not cached, on purpose

- **FFmpeg** (`AnimMouse/setup-ffmpeg`): its download step fails in 0.3 s on every run (`xz: (stdin): File
format not recognized`), so its cache is never saved and "Cache not found" is correct. The step is
  `continue-on-error`, so nothing is lost today. A cache cannot fix a download that fails.
- **`tsc --noEmit` and ESLint**: an incremental build info file or `--cache` needs a change to the commands the
  jobs run, for 10-20 s a job, and a stale-result risk. Not done here.
- **onnxruntime-node and the other native downloads**: `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` is already set;
  the `node_modules` cache covers the rest.
- **Playwright / Chromium, pip, Mintlify**: nothing in CI uses them. The docs build already uses
  `setup-node`'s `cache: npm`.
- **Windows and macOS `node_modules`**: restoring it costs more than `npm ci` with a warm download cache.
