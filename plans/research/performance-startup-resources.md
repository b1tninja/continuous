# Performance, start-up and resource use of the product itself

Research and measurement report, 2026-11-12. Code read on `origin/main` at `63e6e12` and checked against `c05057f` (the only difference is one research note). `plans/ROADMAP.md` is not edited: section 10 holds the exact row text, ids PERF1 to PERF25. The prefix `PERF` is unused on `origin/main` at `c05057f`. Releases use even minors, so "2.18.0 candidate" means the next release and "2.20.0 or later" the one after.

This note covers what the product costs the person's machine: how long the CLI takes to start, how much memory it holds, what a long chat costs in the webview, what a long session costs on disk, and which code runs on every request, keystroke or timer tick. It does not cover model latency, token cost or prompt caching (Tracks C and Z do).

Conventions: "measured" means run here on 2026-11-12 with the method in section 2; "verified by reading" names a file and line that was read; "primary" means the vendor's own documentation or source, read 2026-11-12 through a fetch tool, so quoted wording should be spot-checked before it is printed elsewhere; "unverified" means not confirmed. No model was called, no key was read and Windows Sandbox was not started.

The measurement scripts are in draft PR #780 (`bench/perf/`, branch `perf-bench-scripts`). Raw results are outside the repository in `D:\temp\perf-audit`.

## 1. Summary

1. **The CLI takes about 0.75 to 0.85 s and 246 MB to print its version.** A bare `node -e 0` takes 25 ms on the same machine. The whole 18.4 MB bundle is parsed and most of it is evaluated before any argument is looked at. Parsing and compiling the bundle is 35% of that time; the tokenizer tables, jsdom and zod add another 20%.
2. **One line cuts CLI start-up by about 30%.** With Node's compile cache (`module.enableCompileCache()` in the `cn.js` wrapper, or `NODE_COMPILE_CACHE`), `--version` drops from 740 to 511 ms and peak RSS from 246 to 192 MB. The time to the first model request drops from 859 to 618 ms. The cache is 2.7 MB on disk.
3. **`--version` starts a `git` process.** `extensions/cli/src/systemMessage.ts:48` calls `execSync("git rev-parse ...")` while the module loads, so every invocation pays for it, including `--help`. In a repository the CLI runs four blocking `git` processes before the first request (not three), none with a timeout. Warm, they cost 21 to 44 ms each here; the total was 131 ms in one profile.
4. **The clipboard poll costs about a quarter of a CPU core while the CLI waits for input on Windows.** One probe is a `powershell` process that takes 228 ms of wall time and about 250 ms of CPU time, once a second. Worse than recorded before: the effect that owns the timer depends on an inline callback, so it is torn down and run again on every render of the input, which is every keystroke.
5. **The VS Code extension ships unminified.** `vscode:prepublish` passes `--minify`, and `extensions/vscode/scripts/esbuild.js` never reads the flag. `out/extension.js` is 70.9 MB. Minified it is 46.7 MB, loads in 352 ms instead of 432 ms and holds 48 MB less heap.
6. **Long chats are the largest cost in the webview, and it is now measured.** At 1,000 messages the chat takes 3.3 to 4.2 s to mount, holds 52,702 DOM nodes and 501 TipTap editors, uses about 560 MB more heap, and one streamed chunk takes 296 to 434 ms to reach the screen (16.7 ms at 10 messages). At 300 messages a chunk takes 67 to 107 ms, which is already above the 50 ms long-task line.
7. **The cause is re-rendering, not the missing virtualisation alone.** Every message's markdown component subscribes to the whole history, the list helpers are quadratic, and each user message mounts a full editor. Virtualising would hide this; fixing the subscriptions removes it.
8. **Three of yesterday's leads are not problems by time.** Saving a 1,000-message session takes 3 ms (p95 3.7 ms) and a 5,000-message one 10 ms. The stuck check takes 1.9 ms at 1,000 messages. Counting the tokens of a 245,000-token history takes 14 ms. An audit append with `fsync` takes 0.9 ms. None of these needs work for speed.
9. **What does grow is the IDE session file.** The IDE stores the full formatted prompt of every request in the session (`promptLogs`). A synthetic 300-message session with them is 26.8 MB and takes 46 ms to save (p95 63 ms), against 0.4 MB without. The growth is quadratic in the number of requests.
10. **The webview loads 4.8 MB of JavaScript before first paint**, in 17 files. The main chunk is 3.95 MB (1.18 MB gzipped). 51 of the 63 "externalized for browser compatibility" warnings come from the Node fetch package being pulled into the browser bundle.

## 2. Method and limits

**Machine.** Windows 11 Pro 10.0.26300, AMD Ryzen 9 9950X3D (32 logical processors), 126 GB RAM, Node 25.9.0, git 2.54.0. This is a fast desktop. A laptop will be slower by a factor this note did not measure, so the absolute numbers are a floor, and the budgets in section 7 are written for this machine with a ratio beside them.

**Node version.** `.nvmrc` says 22.23.4 and the CLI's `engines` says `>=22`. Everything here ran on 25.9.0, the only Node installed. Start-up on Node 22 was not measured.

**Checkout.** A fresh clone under `M:\temp`, with `npm ci --ignore-scripts` in `packages/*`, `core`, `extensions/cli`, `gui`, `extensions/vscode` and `bench/screenshots`, and the repository's own build commands. Nothing was read from or written to the working checkout or to `~/.continuous`: the CLI ran with `CONTINUOUS_GLOBAL_DIR` set to a scratch folder.

**Timing.** Each scenario ran 12 times after two discarded warm-up runs (run A), and again 15 times later the same evening (run B). Tables give the median and the p95 (nearest rank, so with 12 samples the p95 is the maximum). Run B was noisier: three scenarios show a p95 above 1.3 s where run A shows 0.8 to 1.0 s. Both are reported; the medians differ by 2% to 14%.

**Warm, not cold.** All runs are warm starts (file cache populated). A cold start after a reboot reads 18 MB from disk first and is slower. It was not measured, because it cannot be done without flushing the system file cache.

**No model.** The `-p` scenarios talk to a stub HTTP server on 127.0.0.1 that answers every chat completion with one canned streamed reply. "Time to first request" is the time from spawning the process to the request arriving at the stub. The refused-port scenario points at a closed local port.

**Profiles.** `node --cpu-prof` on one run each of `--version` and `-p`, on a build made with `node build.mjs --no-minify` so that functions carry their module names. Samples are attributed to the nearest enclosing module. One run, 1 ms sampling: read the shares as approximate.

**Webview.** The existing screenshot harness (`bench/screenshots`): the real `<App/>`, the real redux store and `MockIdeMessenger` in headless Edge 157 through `playwright-core`. A synthetic history is dispatched with `session/newSession`; 40 chunks are dispatched with `session/streamUpdate`, each timed to the next animation frame. The harness bundle reads packages from source and is not the production bundle, so page-load times from it are not reported as the webview's. Mount, stream and scroll costs come from the same components and reducers. A real VS Code or JetBrains webview was not measured. Heap deltas include garbage not yet collected.

**Synthetic histories.** Alternating assistant messages with one tool call and tool results of 2,000 bytes cut from a real source file, so JSON escaping and tokenization do real work. Real sessions vary more.

**Not measured.** The VS Code extension's activation time in a real extension host, the JetBrains plugin, codebase indexing, MCP server start-up, macOS and Linux, and anything in Windows Sandbox. The claim that a sandbox screenshot run writes 1.4 GB of PNG is from `research/area-isolation-sandbox-gate.md` and was not re-measured.

## 3. Measurements

### 3.1 CLI start-up

Built CLI (`extensions/cli/dist/cn.js`, minified, 18.38 MB). Times in ms.

| Scenario                                  | Run A median | Run A p95 | Run B median | Run B p95 | Peak RSS | CPU time |
| ----------------------------------------- | ------------ | --------- | ------------ | --------- | -------- | -------- |
| `node -e 0` (baseline)                    | 24           | 33        | 28           | 30        | n/a      | n/a      |
| `--version`                               | 740          | 832       | 846          | 1,382     | 246 MB   | 827 ms   |
| `--help`                                  | 737          | 804       | 801          | 1,468     | 246 MB   | 812 ms   |
| `--version` with `NODE_COMPILE_CACHE`     | 511          | 526       | 551          | 564       | 192 MB   | 593 ms   |
| `-p`, stub, empty folder (no git)         | 881          | 907       | 949          | 997       | 247 MB   | 906 ms   |
| `-p`, stub, this repository (5,000 files) | 958          | 986       | 1,027        | 2,138     | 247 MB   | 953 ms   |
| `-p`, stub, synthetic 60,000-file repo    | 1,015        | 1,038     | 1,036        | 1,068     | 247 MB   | 1,039 ms |
| `-p`, stub, empty folder, compile cache   | 638          | 685       | 707          | 729       | 193 MB   | 632 ms   |
| `-p`, refused port, empty folder          | 2,219        | 2,368     | 2,233        | 2,428     | 247 MB   | 921 ms   |

Time from spawn to the first request reaching the stub, in ms:

| Scenario                    | Run A median | Run A p95 | Run B median | Run B p95 |
| --------------------------- | ------------ | --------- | ------------ | --------- |
| Empty folder (no git)       | 859          | 886       | 924          | 975       |
| This repository             | 936          | 964       | 1,006        | 2,102     |
| Synthetic 60,000-file repo  | 991          | 1,014     | 1,011        | 1,044     |
| Empty folder, compile cache | 618          | 662       | 685          | 702       |

Reading:

- `--version` costs 30 times a bare Node start. `--help` costs the same: nothing is specific to the command.
- A repository adds about 80 ms over an empty folder, and a 60,000-file one about 130 ms. That is the `git` processes plus the file index walk (section 4.1).
- A refused connection adds about 1.3 s after the request is built. The retry helper lists `ECONNREFUSED` as retryable with a 1 s initial delay (`extensions/cli/src/util/exponentialBackoff.ts:25-26`, `:42`). Which part of the 1.3 s is the operating system and which is the retry path was not separated.
- The compile cache was also tested in-process, the way the product would use it: a wrapper outside the repository that calls `module.enableCompileCache(dir)` and then imports `dist/index.js`. `--version` median 820 ms without and 548 ms with, and in a second alternating series 811 ms and 560 ms (12 runs each after two warm-ups). The gain is the same as with the environment variable.

### 3.2 Where CLI start-up goes

One CPU profile of `--version` on the unminified build, 723 ms sampled:

| Share | Time   | What                                                                                            |
| ----- | ------ | ----------------------------------------------------------------------------------------------- |
| 35.4% | 256 ms | Parsing and compiling the bundle (`compileSourceTextModule`)                                    |
| 11.4% | 83 ms  | Node internals and top-level glue not attributable to a module                                  |
| 9.4%  | 68 ms  | `gpt-tokenizer` (building the BPE tables at import)                                             |
| 6.0%  | 43 ms  | `jsdom`                                                                                         |
| 5.7%  | 41 ms  | The CLI's own modules, of which 29 ms is the `git` process started by `systemMessage.ts`        |
| 4.8%  | 35 ms  | `zod` (three copies are bundled: the CLI's, `core`'s and `openai-adapters`')                    |
| 2.6%  | 19 ms  | Garbage collection                                                                              |
| 2.4%  | 17 ms  | `string-width`                                                                                  |
| 22.3% | 161 ms | Everything else, each under 12 ms (config-yaml, core, undici, MCP SDK, yoga-layout, AWS SDK...) |

What the bundle is made of (`dist/meta.json`, 4,463 input files, 321 packages):

| Size    | Share | Package                        |
| ------- | ----- | ------------------------------ |
| 3.26 MB | 17.7% | `jsdom`                        |
| 2.82 MB | 15.3% | `gpt-tokenizer`                |
| 1.96 MB | 10.7% | `zod`                          |
| 0.78 MB | 4.2%  | `core` (first-party)           |
| 0.74 MB | 4.0%  | `undici`                       |
| 0.54 MB | 3.0%  | the CLI's own source           |
| 0.49 MB | 2.7%  | `iconv-lite`                   |
| 0.42 MB | 2.3%  | `@google/genai`                |
| 0.41 MB | 2.2%  | `openai`                       |
| 0.41 MB | 2.2%  | `ai`                           |
| 0.39 MB | 2.1%  | `react-reconciler`             |
| 7.2 MB  | 39%   | 310 other packages and sources |

The first-party code is 7% of the bundle. Three packages are 44%. `jsdom` is used to read fetched web pages and `gpt-tokenizer` to count tokens; neither is needed to print a version or to parse arguments. The existing smoke test fails above 20 MiB (`extensions/cli/smoke-test.mjs:95-127`); the bundle is at 17.53 MiB, so the gate has 12% of headroom and says nothing about start-up.

### 3.3 Child processes

Each command run 12 times through `execSync` (which starts `cmd.exe` first on Windows), warm:

| Command                                                                | Where                  | Median | p95    |
| ---------------------------------------------------------------------- | ---------------------- | ------ | ------ |
| `git rev-parse --is-inside-work-tree`                                  | empty folder           | 21 ms  | 24 ms  |
| `git rev-parse --is-inside-work-tree`                                  | this repository        | 21 ms  | 29 ms  |
| `git status --porcelain`                                               | this repository        | 31 ms  | 39 ms  |
| `git status --porcelain`                                               | 60,000-file repository | 44 ms  | 51 ms  |
| The clipboard probe (`powershell ... Get-Clipboard -Format Image ...`) | any                    | 228 ms | 243 ms |

The clipboard probe's CPU time, measured on six runs with `Start-Process` and `TotalProcessorTime`: 188, 234, 250, 250, 328 and 375 ms. At one probe per second that is about a quarter of one core for as long as the input is focused.

The `git status` figures are for a clean, warm repository on a fast disk. A cold file cache, a network drive or a repository with many untracked files would be slower by an amount not measured here, and nothing bounds the wait: none of these calls sets `timeout`.

### 3.4 Memory

| What                                                       | Figure                                          |
| ---------------------------------------------------------- | ----------------------------------------------- |
| Peak RSS of `--version`                                    | 246 MB (192 MB with the compile cache)          |
| Peak RSS of a one-request `-p` run                         | 247 MB                                          |
| `cn serve`, idle, 10 s to 60 s after start                 | 155 MB working set, 176 MB private, 263 handles |
| `cn serve`, CPU used while idle from 10 s to 60 s          | 47 ms in 50 s (under 0.1% of a core)            |
| VS Code `extension.js`, heap after `require` (no activate) | 157 MB as shipped; 109 MB minified              |
| Webview heap growth for a 1,000-message chat               | about 560 MB                                    |

The interactive terminal UI was not measured for memory, because it needs a terminal; `cn serve` is the nearest long-running process. One sample of each.

### 3.5 Session save, load, stuck check and token count

`HistoryManager.save` (`core/util/history.ts:249-321`), `JSON.parse` of the saved file, `detectStuck(stepsFromHistory(history))` and the CLI's `countChatHistoryTokens`, on synthetic histories. 15 to 40 runs after two warm-ups; ms.

| Messages | Prompt logs | File size | Save median | Save p95 | Load median | Stuck check median | Token count median |
| -------- | ----------- | --------- | ----------- | -------- | ----------- | ------------------ | ------------------ |
| 10       | no          | 0.01 MB   | 1.3         | 1.7      | 0.4         | 0.03               | 0.1                |
| 100      | no          | 0.13 MB   | 1.7         | 2.0      | 0.6         | 0.16               | 1.3                |
| 1,000    | no          | 1.31 MB   | 3.0         | 3.7      | 2.3         | 1.9                | 14.2               |
| 5,000    | no          | 6.58 MB   | 10.0        | 11.4     | 11.2        | 5.4                | 69.7               |
| 10       | yes         | 0.06 MB   | 1.2         | 1.3      | 0.4         | n/a                | n/a                |
| 100      | yes         | 3.22 MB   | 5.2         | 6.1      | 4.8         | n/a                | n/a                |
| 300      | yes         | 26.83 MB  | 46.2        | 62.5     | 51.9        | n/a                | n/a                |

Reading:

- Rewriting the whole file is not a time problem at any realistic size. About 1 ms of every save is fixed cost (the lock file, reading and rewriting `sessions.json`, the rename). With 507 sessions in `sessions.json` (76 KB) a 10-message save still took 1.2 ms.
- Pretty-printing adds about 10% to the bytes here (1.31 MB against 1.19 MB compact), because the content is long strings. It is not worth changing for speed.
- The 1,000-message history is about 245,000 tokens, more than most context windows, so compaction would have cut it long before. In practice the per-request token count is under 10 ms in the CLI.
- "Prompt logs: yes" models what the IDE saves: each request's full formatted prompt on the last history item (`gui/src/redux/slices/sessionSlice.ts:361-363`, `core/llm/index.ts:1605-1610`, type at `core/index.d.ts:1264-1271`). File size grows with the square of the number of requests. This is a model of the growth, not a capture of a real session.
- An audit-style append (open, write, close) takes 0.02 ms, and 0.9 ms with `fsync` (p95 1.1 ms, 200 appends). The audit trail's `fsync` on outcome, policy and deny records (`core/tools/permissions/audit/writer.ts:191-201`) is not a cost worth trading durability for.

### 3.6 Webview bundle

`vite build` in `gui/`: 3.1 s wall (vite reports 1.77 s).

| What                                                              | Figure                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Main chunk `assets/index.js`                                      | 3.95 MB minified, 1.18 MB gzipped                                           |
| JavaScript loaded before first paint (static graph of `index.js`) | 4.79 MB in 17 files                                                         |
| All JavaScript in `dist`                                          | 9.14 MB in 95 chunks                                                        |
| CSS                                                               | 0.17 MB (`index.css` 109 kB, `indexConsole.css` 64 kB)                      |
| Source maps                                                       | 35.4 MB (excluded from the package by `extensions/vscode/.vscodeignore:11`) |
| "Externalized for browser compatibility" warnings                 | 63                                                                          |

The 43 chunks that are not loaded up front are mostly mermaid's diagram types (mermaid splits them itself; the largest is `elk` at 1.5 MB). The application has no code splitting of its own: no `manualChunks`, no `React.lazy` (`gui/vite.config.ts:9-23`, `gui/src/App.tsx:2-12`).

The 63 warnings by importer: 37 from `packages/fetch/node_modules`, 14 from `packages/fetch/dist`, 7 from `core/tools/permissions`, 5 from `core/util`. So 51 of 63 are the Node HTTP client being reachable from the webview's import graph. It cannot run there; it is dead weight and a sign that a shared module imports it at the top level.

What the main chunk is made of (from its source map, 94% of bytes attributed):

| Size   | Share | Source                |
| ------ | ----- | --------------------- |
| 856 kB | 21.7% | `gui/src`             |
| 307 kB | 7.8%  | `core`                |
| 272 kB | 6.9%  | `zod`                 |
| 242 kB | 6.1%  | `katex`               |
| 220 kB | 5.6%  | `@heroicons/react`    |
| 187 kB | 4.7%  | `highlight.js`        |
| 138 kB | 3.5%  | `mermaid` (core part) |
| 99 kB  | 2.5%  | `prosemirror-view`    |
| 97 kB  | 2.4%  | `yaml`                |
| 96 kB  | 2.4%  | `lodash`              |
| 93 kB  | 2.3%  | `@tiptap/core`        |
| 91 kB  | 2.3%  | `@headlessui/react`   |
| 90 kB  | 2.3%  | `react-router`        |

`katex`, `highlight.js` and `mermaid` (567 kB together in this chunk, plus mermaid's eager helper chunks) are needed only when a message contains math, code or a diagram. 220 kB of icons suggests the whole icon set is reachable rather than the icons used.

### 3.7 Long chats in the webview

Headless Edge, 400 by 900 viewport. Two runs; where they differ both are given.

| Messages | Mount (ms)     | DOM nodes | TipTap editors | Heap growth | Per streamed chunk, median (ms) | Per chunk, p95 (ms) | Scroll step, median (ms) |
| -------- | -------------- | --------- | -------------- | ----------- | ------------------------------- | ------------------- | ------------------------ |
| 10       | 70             | 727       | 6              | 16 MB       | 16.7                            | 18                  | 16                       |
| 100      | 382 to 386     | 5,452     | 51             | 54 MB       | 25 to 38                        | 40 to 51            | 16                       |
| 300      | 975 to 1,045   | 15,952    | 151            | 209 MB      | 67 to 107                       | 106 to 120          | 17                       |
| 1,000    | 3,342 to 4,153 | 52,702    | 501            | 562 MB      | 296 to 434                      | 423 to 552          | 18 to 33                 |

Reading:

- A frame is 16.7 ms. At 10 messages a streamed chunk costs one frame. The cost grows linearly with the number of messages already in the chat, about 0.3 to 0.4 ms per message per chunk. Chunks arrive in batches up to 20 times a second (`gui/src/context/IdeMessenger.tsx:230`), so above roughly 150 messages the webview cannot keep up and the reply appears in bursts.
- The DOM grows by about 52 nodes per message and the heap by about 0.56 MB per message.
- One TipTap editor is mounted for every user message (501 at 1,000 messages, half of them plus the main input). That matches `gui/src/pages/gui/Chat.tsx:434`.
- Scrolling stays near one frame until 1,000 messages. Layout is not the bottleneck; script is.
- Mount time is what a person waits when opening an old session from History.

### 3.8 VS Code extension bundle

`node scripts/esbuild.js --minify` (what `vscode:prepublish` runs, `extensions/vscode/package.json:801`) took 1.9 s and wrote `out/extension.js` at 70.92 MB. The script builds its options at `extensions/vscode/scripts/esbuild.js:15-59` and never reads `--minify`; it reads only `--sourcemap`, `--watch` and `--notify`. Verified by reading and by the output size.

| Build                                           | Size     | `require` time (5 runs) | Heap after `require` |
| ----------------------------------------------- | -------- | ----------------------- | -------------------- |
| As shipped                                      | 70.92 MB | 429 to 435 ms           | 157 MB               |
| The same file passed through `esbuild --minify` | 46.67 MB | 348 to 360 ms           | 109 MB               |

`require` time is parse, compile and top-level evaluation in plain Node with a stub `vscode` module. `activate()` was not called, so this is a lower bound on what VS Code reports as activation time.

Largest packages in the shipped file: `@shikijs/langs` 8.1 MB (11.4%), `jsdom` 7.4 MB, `js-tiktoken` 5.6 MB, `wink-eng-lite-web-model` 3.9 MB, `core` 3.5 MB, `undici` 3.3 MB, `zod` 2.7 MB, `openai` 2.4 MB, `iconv-lite` 2.2 MB, `@huggingface/transformers` 1.8 MB, `@shikijs/themes` 1.4 MB, `puppeteer-core` 1.3 MB. 385 packages in all.

### 3.9 Developer loop

| Step                                           | Time                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `gui`: `tsc -p ./ --noEmit` (TypeScript 5.9.3) | 16.3 s and 18.6 s (two runs)                                                                          |
| `gui`: `vitest run`                            | 71.9 s wall; 212 files, 2,248 tests; vitest attributes 64% to import, 18% to environment, 9% to tests |
| `gui`: `vite build`                            | 3.1 s                                                                                                 |
| `extensions/vscode`: esbuild bundle            | 1.9 s                                                                                                 |
| Screenshot harness build                       | 1.8 s                                                                                                 |

Two thirds of the gui test time is importing modules, not running tests. The same wide import graph that puts 4.8 MB in front of first paint is paid 212 times in the test run.

## 4. Code review: what runs when

Every line below was read at `63e6e12` unless marked otherwise.

### 4.1 CLI: before the first request

| When                       | What                                                                                                                                 | Where                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Module load, every command | `execSync("git rev-parse --is-inside-work-tree")` inside a template literal that builds the base system message                      | `extensions/cli/src/systemMessage.ts:27-34`, `:48`                                                                           |
| Service start              | `isGitRepo()` again, to pick the walk depth                                                                                          | `extensions/cli/src/services/FileIndexService.ts:136`, `extensions/cli/src/util/git.ts:45-55`                                |
| Service start              | A walk of the working folder to depth 10 (3 outside a repository) for the `@` file picker, also in headless `-p` runs                | `FileIndexService.ts:106-108`, `:140-161`                                                                                    |
| Service start              | The walk races a 1 s timer. On timeout the result is dropped but the walk is not cancelled and keeps reading the disk                | `FileIndexService.ts:170-185`                                                                                                |
| Service start, headless    | Every MCP server is connected and awaited before the first request; one failure aborts the run                                       | `extensions/cli/src/services/MCPService.ts:99-116`                                                                           |
| First request              | `isGitRepo()` a third time, then `git status --porcelain`                                                                            | `extensions/cli/src/environmentContext.ts:17-39`                                                                             |
| Terminal UI, every resize  | Up to three `execSync` git calls (`rev-parse`, `remote get-url`, `branch --show-current`) inside `useMemo` keyed on the column count | `extensions/cli/src/ui/components/ResponsiveRepoDisplay.tsx:17-23`, `ui/hooks/useTUIChatHooks.ts:10-47`, `util/git.ts:12-55` |

The profile of a `-p` run in this repository shows the four spawns directly: 48 ms (`systemMessage.ts`), 29 ms (`performFullIndex`), 22 ms and 33 ms (`environmentContextBlock`). All use `execSync` with a command string, which on Windows starts `cmd.exe` and then `git`. None passes `timeout`. Node's documentation says that even with a timeout `execSync` "won't return until the process has completely exited" (primary, `https://nodejs.org/api/child_process.html`), so the fix is an asynchronous call with a timeout, made once.

In the terminal UI the MCP connections are not awaited (`MCPService.ts:117-119`), which is the right shape; headless mode waits by design so that a missing tool fails early.

### 4.2 CLI: per request and per round

| When                               | What                                                                                    | Where                                                                                            | Cost                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Every loop iteration               | The tool list is rebuilt and the overrides applied                                      | `extensions/cli/src/stream/streamChatResponse.ts:718-723`                                        | about 11 ms in one logged request      |
| Every loop iteration               | The whole history, system message and tools are tokenized for the auto-compaction check | `streamChatResponse.autoCompaction.ts:149`, `compaction.ts:319-322`, `util/tokenizer.ts:312-330` | 1.3 ms at 100 messages, 14 ms at 1,000 |
| Every loop iteration               | Tokenized again when a run limit is set                                                 | `streamChatResponse.ts:745-748`                                                                  | the same again                         |
| Every tool round                   | The stuck check reads the whole history                                                 | `stream/handleToolCalls.ts:169`, `stream/stuckNotes.ts:54-72`                                    | 0.16 ms at 100, 1.9 ms at 1,000        |
| Every history change               | The whole session is saved synchronously                                                | `services/ChatHistoryService.ts:67-70`, `session.ts:133-137`, `:363-381`                         | 1.7 ms at 100, 3 ms at 1,000           |
| Every history change               | A copy of the history array is pushed on an undo stack that has no limit                | `services/ChatHistoryService.ts:54-57`                                                           | memory, section 4.6                    |
| Every history change (terminal UI) | The context percentage re-tokenizes the whole history                                   | `ui/hooks/useContextPercentage.ts:24-38`                                                         | as the token count above               |

None of these is slow at realistic sizes. They are listed because each is O(history) per event and they add up to O(history squared) per session; the measured constants are small enough to leave alone. The tool list rebuild is a cache-stability question (C80 in `research/caching-context-cost.md`), not a speed question.

The terminal UI does not render per token: `onContent` is a no-op (`extensions/cli/src/ui/hooks/useChat.stream.helpers.ts:39`) and the message appears when it is complete.

### 4.3 CLI: timers and polling

| Timer                                  | Interval      | Where                                                                       | Note                                                                                                                                                                            |
| -------------------------------------- | ------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clipboard image probe                  | 1 s           | `ui/hooks/useClipboardMonitor.ts:22`, `:61-64`                              | Starts `powershell`, `osascript` or `xclip` (`util/clipboard.ts:15-50`)                                                                                                         |
| The same probe, on every render        | n/a           | `useClipboardMonitor.ts:67`, `:73`; `ui/UserInput.tsx:835-843`              | The effect depends on `onImageStatusChange`, an inline arrow function, so it re-runs each render and each run does an "initial check". Only the `isChecking` flag stops overlap |
| Resource monitor                       | 1 s           | `services/ResourceMonitoringService.ts:52-56`, `:82-84`                     | Only with `--verbose`; history capped at 300 samples (`:45`, `:217-218`). Fine                                                                                                  |
| `serve` interruption check             | 100 ms        | `commands/serve.helpers.ts:380`                                             | Not reviewed further; idle CPU of `serve` measured under 0.1% of a core                                                                                                         |
| `serve` remote state poll (TUI client) | 500 ms        | `ui/hooks/useChat.remote.helpers.ts:116`                                    | Remote mode only                                                                                                                                                                |
| Spinners and elapsed-time displays     | 150 ms and up | `ui/LoadingAnimation.tsx:85-87`, `ui/LoadingText.tsx:18`, `ui/Timer.tsx:13` | While a turn runs                                                                                                                                                               |

The clipboard probe is the only timer here with a real cost, and it is the largest steady cost in the CLI.

### 4.4 Webview: per streamed chunk

| What                                                                                                                            | Where                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Chunks are drained from a buffer every 50 ms, so at most 20 `streamUpdate` actions a second. This is the only throttle          | `gui/src/context/IdeMessenger.tsx:225-230`, `gui/src/redux/thunks/streamNormalInput.ts:270` |
| The chat list is not virtualised: the filtered history is mapped to plain `div`s. No `content-visibility` anywhere in `gui/src` | `gui/src/pages/gui/Chat.tsx:543-562`                                                        |
| `Chat` selects the whole history, so it re-renders on every batch and rebuilds its item renderer                                | `Chat.tsx:148`, `:528`                                                                      |
| Per item, per batch: `findLatestSummaryIndex(history)` and `history.slice(index + 1).some(...)`. Each is O(n), so O(n squared)  | `Chat.tsx:396-401`, `:416`                                                                  |
| Every markdown component selects the whole history, so its `memo` does not help: all of them re-render on every batch           | `gui/src/components/StyledMarkdownPreview/index.tsx:203`, `:213`                            |
| Each then recomputes `pastFileInfo` over the history. O(messages times history) per batch                                       | `StyledMarkdownPreview/index.tsx:215-236`, `gui/src/redux/thunks/updateFileSymbols.ts:7-36` |
| The streaming message's whole markdown is parsed and highlighted again on every batch (remark, math, KaTeX, highlight)          | `StyledMarkdownPreview/index.tsx:242-296`, `:398-403`                                       |
| Every user message mounts a full TipTap editor, re-rendered on every transaction                                                | `Chat.tsx:432-436`, `gui/src/components/mainInput/TipTapEditor/utils/editorConfig.ts:399`   |
| `StepContainer`, `TimelineItem` and `ToolCallDiv` are not memoised. `ContinueInputBox` is, but an inline `onEnter` defeats it   | `gui/src/components/StepContainer/StepContainer.tsx:21`, `Chat.tsx:435`                     |
| A `ResizeObserver` is attached to every child of the list and rebuilt when the history length changes                           | `gui/src/pages/gui/useAutoScroll.ts:52-72`                                                  |

The fourth and fifth rows explain the measured line in section 3.7: cost per chunk proportional to the number of messages. Earlier messages do not re-parse their markdown (their source is unchanged), so the per-message cost is a re-render and a history scan, about a third of a millisecond each.

### 4.5 Webview and IDE: per keystroke, per request, per save

Per keystroke in the input:

- The `@` search is not debounced. Each query change runs MiniSearch with `prefix: true, fuzzy: 2` across every provider's index, then maps and sorts all results before cutting to 70 (`gui/src/components/mainInput/TipTapEditor/utils/getSuggestion.ts:164-216`, `gui/src/context/SubmenuContextProviders.tsx:25-28`, `:328-397`). Not measured.
- No draft is saved and no IDE round-trip happens per keystroke (searched `gui/src/components/mainInput` for debounce, throttle, localStorage and onUpdate).
- The autocomplete debounce default is 350 ms in core (`core/util/parameters.ts:8`) and the settings page shows 250 ms when the value is unset (`gui/src/pages/config/sections/UserSettingsSection.tsx:73`). The schema has no default. The page can therefore show a number the engine does not use.

Per keystroke in a document (VS Code, `onDidChangeTextDocument`):

- The handler awaits `configHandler.loadConfig()`, reads the whole document text once per content change and again for a cache, and runs the edit-aggregation pipeline. The setting that used to gate it is commented out (`extensions/vscode/src/util/editLoggingUtils.ts:84-123`, gate at `:89`; registered at `extensions/vscode/src/extension/VsCodeExtension.ts:494-508`). Not measured. On a large file this is two full-text copies per keystroke.

Per request (IDE path):

- The history is tokenized in full by `compileChatMessages` with no per-message cache (`core/llm/countTokens.ts:554-563`, comment at `:586`), synchronously on the extension host, and the whole formatted prompt and completion are tokenized again when the request ends (`core/llm/index.ts:461-465`). The tokenizer is `js-tiktoken` or the JavaScript llama tokenizer (`countTokens.ts:75-87`), not the CLI's. Its speed was not measured; if it is like the CLI's, this is under 30 ms.
- The prompt cache key is a `JSON.stringify` and a character-loop hash of every message (`gui/src/util/cacheSafeguards.ts:259-282`, `:311`).
- A dev-data event with the full prompt and completion is scanned for secrets and appended synchronously (`core/data/log.ts:94-98`).
- Each tool call writes audit records synchronously, with `fsync` for outcomes (`core/tools/permissions/audit/writer.ts:191-201`). Measured at under 1 ms each.

Per save (IDE path):

- `history/save` runs when a stream wrapper returns (`gui/src/redux/thunks/streamThunkWrapper.tsx:33-41`). The wrappers nest through tool calls, so an auto-approved chain of N tool calls saves nothing while it runs and N + 1 times as it unwinds (read from the control flow, not run). After every save the gui lists all sessions again (`gui/src/redux/thunks/session.ts:79-80`, `:42`).
- With `promptLogs` in the history, each of those saves writes megabytes (section 3.5).
- In JetBrains, messages over 1 MB are base64-chunked through `executeJavaScript` (`extensions/intellij/src/main/kotlin/com/github/continuedev/continueintellijextension/browser/ContinueBrowser.kt:131-139`, `:210-211`), so loading or saving a large session pays an extra encode pass.

### 4.6 Things that grow without a limit

| What                                                                                                          | Where                                                                                                           | Size of the problem                                                            |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `promptLogs`: the full prompt of every request, in redux and in the session file                              | `gui/src/redux/slices/sessionSlice.ts:361-363`; only reader in `gui/src` is `components/FeedbackButtons.tsx:22` | 26.8 MB at 300 messages (modelled)                                             |
| The CLI undo stack: one array copy per history change, never trimmed                                          | `extensions/cli/src/services/ChatHistoryService.ts:54-57`                                                       | Arrays of pointers; quadratic in changes. Megabytes after thousands of changes |
| `messageAbortControllers`: entries are removed only on abort, so a stream that ends normally leaves its entry | `core/core.ts:234-241`                                                                                          | One small object per message for the life of the extension host                |
| Tool output is kept twice in redux (on the tool call state and as the tool message)                           | `gui/src/redux/slices/sessionSlice.ts:1190-1203`                                                                | Doubles the largest items in a session                                         |
| A `setInterval` is created inside a wait loop and never cleared                                               | `extensions/vscode/src/util/vscode.ts:82-86`                                                                    | One leaked 200 ms timer per loop pass                                          |

Bounded and fine: the CLI log (10 MB times 5 files, `extensions/cli/src/util/logger.ts:122-125`), the resource monitor history, the LSP caches (500 entries) and the audit `pending` list (500).

### 4.7 IDE start-up

Read, not measured.

- VS Code activation events are `onUri`, `onStartupFinished` and `onView:continueGUIView` (`extensions/vscode/package.json:57-61`). `onStartupFinished` is the event VS Code's documentation recommends for work that should not slow start-up, and the one Cline, Roo Code and Copilot Chat use (section 6). `extensionKind` is `["ui", "workspace"]` (`:10-13`).
- `activate` awaits `setupCa()` and then imports the rest (`extensions/vscode/src/extension.ts:11-13`). The constructor of `VsCodeExtension` then does everything eagerly: creates `Core`, loads the configuration twice (`VsCodeExtension.ts:286-305`), registers the inline completion provider for every file, starts three `fs.watchFile` polls at 1 s on the config files (`:443-470`) and copies the text of every open document (`:490-492`).
- `Core` starts a codebase index refresh as soon as the IDE settings resolve unless indexing is paused or disabled (`core/core.ts:345-371`), walks the workspace for rules and reloads the configuration (`:389-399`), and reloads it again when the MCP connections finish (`:287-288`). Start-up can therefore run three configuration loads, each of which notifies the webview and can rebuild its search indexes (`core/core.ts:296-336`, `gui/src/context/SubmenuContextProviders.tsx:524-542`).
- The sidebar webview is created with `retainContextWhenHidden: true` (`VsCodeExtension.ts:262-265`). VS Code's documentation says this "has high memory overhead and should only be used when other persistence techniques will not work" (primary, section 6). With the chat holding 0.56 MB of heap per message, a hidden sidebar keeps all of it.
- The webview polls the IDE every 2 s for the open files and the workspace folders, for as long as it exists (`gui/src/context/SubmenuContextProviders.tsx:204-210`).
- A battery status timer ticks every 1 s in the extension host (`extensions/vscode/src/util/battery.ts:4`, `:15`). It awaits one stored promise, so a tick does no I/O.
- JetBrains: the browser is created with off-screen rendering hard-coded on (`ContinueBrowser.kt:29`). A start-up activity polls the proxy settings every 2 s per project (`.../proxy/ProxyPoolingActivity.kt:16-24`).

## 5. Yesterday's leads, checked

| Lead                                                                                           | Verdict                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The CLI runs at least three blocking `git` processes before the first request, with no timeout | Confirmed and extended: four, and the first runs at module load for every command including `--version`. Warm cost about 100 to 130 ms; unbounded in the worst case |
| The clipboard poll starts a process every second (UX31a)                                       | Confirmed and measured: 228 ms wall and about 250 ms CPU per probe on Windows. New: the effect also re-runs on every render                                         |
| Every chat message is mounted; long-chat cost unmeasured (UX49)                                | Confirmed and measured (section 3.7). The dominant cost is re-rendering per chunk, which `content-visibility` alone does not remove                                 |
| Sessions are rewritten whole as indented JSON on every save (V14)                              | True, and not a time problem: 3 ms at 1,000 messages. The real issue is the size of what is saved in the IDE (`promptLogs`)                                         |
| `detectStuck` per-round cost unmeasured (S16)                                                  | Measured: 1.9 ms at 1,000 messages, 5.4 ms at 5,000. No work needed                                                                                                 |
| The tool list is rebuilt every request (C80)                                                   | True (`streamChatResponse.ts:718-723`); about 11 ms in one logged request. Not a speed problem; C80's reason (a stable cached prefix) stands on its own             |
| The screenshot harness writes about 1.4 GB per sandbox run                                     | Not re-measured (no sandbox was started). The harness itself builds in 1.8 s                                                                                        |
| The webview bundle has 63 externalized warnings                                                | Confirmed, and 51 of them have one cause: the Node fetch package in the webview's import graph                                                                      |
| MCP servers launched at start-up                                                               | Confirmed by reading. Awaited in headless CLI runs; in the IDE they trigger a third configuration load                                                              |
| Codebase indexing cost (Track L)                                                               | Not measured. It starts at IDE start-up unless paused (`core/core.ts:345-371`)                                                                                      |
| The extension's activation events and bundle size                                              | Activation events are the recommended ones. The bundle is 70.9 MB because minification is silently off                                                              |
| JetBrains JCEF off-screen rendering                                                            | Hard-coded on (`ContinueBrowser.kt:29`). Cost not measured; JetBrains documents no performance guidance for it (section 6)                                          |
| Autocomplete debounce 250 against 350                                                          | Confirmed: core default 350, settings page fallback 250                                                                                                             |

## 6. External sources

All read 2026-11-12. "Fetched" means the page was fetched and the statement found on it.

### 6.1 VS Code extensions

- Activation events: `onStartupFinished` "is similar to the `*` activation event, but it will not slow down VS Code startup"; `*` only when nothing else works. Since 1.74 contributed commands, views and languages need no explicit event. Fetched. <https://code.visualstudio.com/api/references/activation-events>
- Bundling: reasons given include "Loading 100 small files is much slower than loading one large file"; minification can break code that relies on `Function.prototype.name`. Fetched. <https://code.visualstudio.com/api/working-with-extensions/bundling-extension>
- Webviews: `retainContextWhenHidden` "has high memory overhead and should only be used when other persistence techniques will not work"; `getState` and `setState` are "the preferred way to persist state". Fetched. <https://code.visualstudio.com/api/extension-guides/webview>
- `extensionKind` says where an extension runs in remote set-ups. Fetched. <https://code.visualstudio.com/api/references/extension-manifest>
- Diagnostics: "Developer: Startup Performance", "Developer: Show Running Extensions" and `code --prof-startup`. Fetched. <https://github.com/microsoft/vscode/wiki/Performance-Issues>
- The activation time shown in Running Extensions is code loading time plus the `activate` call time (from the source; no documentation page says so). Fetched. <https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/extensions/browser/abstractRuntimeExtensionsEditor.ts>

### 6.2 Long lists and streaming in a web page

- `content-visibility: auto` skips rendering work for off-screen content while keeping it in the DOM, the accessibility tree and find-in-page; web.dev's example reports a 7 times faster initial render (232 ms to 30 ms). `contain-intrinsic-size` gives the placeholder size. Fetched. <https://web.dev/articles/content-visibility>
- Baseline status: MDN says newly available since September 2024 and web.dev says September 2025. The two pages disagree; both fetched. VS Code's webview is Chromium, where the property has long been supported; JCEF's Chromium version was not checked. <https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility>
- It skips layout and paint, not React rendering. That is this note's reading of the two pages above, not a quotation.
- react-virtuoso handles variable-height items without manual measurement; its chat-specific message list is a commercial product. Fetched. <https://virtuoso.dev/>
- react-window renders only visible rows; "Dynamic row heights are not as efficient as predetermined sizes". Fetched. <https://github.com/bvaughn/react-window>
- TanStack Virtual is a headless virtualiser. Fetched (introduction page only). <https://tanstack.com/virtual/latest/docs/introduction>
- VS Code's own chat list is a virtualised tree with dynamic heights and an estimated default row height of 200. Fetched (source). <https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/widget/chatListWidget.ts>
- React: `memo` helps only when props are unchanged; `useDeferredValue` lets a slow child lag behind an urgent update and needs the child wrapped in `memo`. Fetched. <https://react.dev/reference/react/memo>, <https://react.dev/reference/react/useDeferredValue>
- Thresholds: a task over 50 ms is a long task; Interaction to Next Paint is good at or under 200 ms and poor above 500 ms. Fetched. <https://web.dev/articles/optimize-long-tasks>, <https://web.dev/articles/inp>

### 6.3 Node CLI start-up

- Compile cache: `module.enableCompileCache()` added in 22.8.0; `NODE_COMPILE_CACHE` in 22.1.0; marked no longer experimental in 25.4.0. Covers CommonJS, ESM and TypeScript. "May slow down the first load of a module graph, but subsequent loads ... may get a significant speedup". Written at exit, to the temp directory by default, not reusable across Node versions, never throws. Fetched. <https://nodejs.org/api/module.html>
- Start-up snapshots (`--build-snapshot`, `v8.startupSnapshot`): need the same Node version, architecture and platform to load; in a single executable application `useSnapshot` cannot be combined with an ESM main. Fetched. <https://nodejs.org/api/v8.html>, <https://nodejs.org/api/single-executable-applications.html>
- Single executable applications: `useCodeCache` "would improve the startup performance"; stability 1.1. Fetched. Same page.
- esbuild splits code behind `import()` into separate files only for ESM output, and calls splitting a work in progress. Fetched. <https://esbuild.github.io/api/>
- `--cpu-prof` is stable since 22.4.0. Fetched. <https://nodejs.org/api/cli.html>
- `execSync` with `timeout` still "won't return until the process has completely exited". Fetched. <https://nodejs.org/api/child_process.html>
- No Node documentation page recommending lazy `import()` for start-up was found.

### 6.4 What peers do

- Claude Code: the npm package installs a native binary and "does not itself invoke Node"; changelog entries mention faster start-up from loading certificates faster and from avoiding a helper process on Windows. Fetched (setup page; first part of the changelog). No published start-up figure. <https://code.claude.com/docs/en/setup>, <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>
- Codex CLI: the move to a native binary was explained by installation without Node, native sandbox bindings and lower memory "with no runtime garbage collection". Start-up time is not among the stated reasons. Fetched. <https://github.com/openai/codex/discussions/1174>
- Gemini CLI: has a start-up profiler with named phases, and relaunches itself with a larger `--max-old-space-size` when it wants more heap. Fetched (source and PR). <https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/gemini.tsx>, <https://github.com/google-gemini/gemini-cli/pull/13638>
- opencode: a maintainer confirmed a blocking terminal query at start; users measured 1.5 to 1.8 s for `--version`. Fetched (issue; the figures are user reports). <https://github.com/anomalyco/opencode/issues/14965>
- aider: a 10 to 20 s start was traced to a dependency fetching a price table at import. Fetched. <https://github.com/Aider-AI/aider/issues/3111>
- Cline, Roo Code and Copilot Chat all activate on `onStartupFinished` and bundle with esbuild. Fetched (their `package.json`; Copilot Chat's was truncated). <https://github.com/cline/cline/blob/main/apps/vscode/package.json>, <https://github.com/RooCodeInc/Roo-Code/blob/main/src/package.json>, <https://github.com/microsoft/vscode-copilot-chat/blob/main/package.json>

The peer evidence supports two things this note recommends: measure start-up by phase (Gemini CLI), and do no blocking work or network work at import (aider, opencode). It does not supply a number to aim for.

### 6.5 JetBrains

- The JCEF page of the SDK documentation does not mention off-screen rendering or its cost. Fetched. <https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html>
- `JBCefBrowserBuilder.setOffScreenRendering(true)` means "a buffered rendering is used onto a lightweight Swing component". The registry key `ide.browser.jcef.osr.enabled` appears in `JBCefApp`. Fetched (source). <https://github.com/JetBrains/intellij-community/blob/master/platform/ui.jcef/jcef/JBCefBrowserBuilder.java>
- The performance trade-off of off-screen rendering: unverified. The issue that discusses it could not be fetched.
- Start-up: "Executing code on application startup should be avoided whenever possible because it slows down startup"; use `ProjectActivity`; `backgroundPostStartupActivity` runs with a 5 s delay. Fetched. <https://plugins.jetbrains.com/docs/intellij/plugin-components.html>

### 6.6 Checking for regressions

- hyperfine: warm-up runs, at least 10 runs by default, outlier detection for "interference from other programs and caching effects", relative comparison against the first command. Fetched. <https://github.com/sharkdp/hyperfine>
- size-limit: "a performance budget tool for JavaScript" that "throws an error if the cost exceeds the limit". Fetched. <https://github.com/ai/size-limit>
- GitHub-hosted runners for public repositories have 4 vCPU and 16 GB and each job gets a fresh machine. Scheduled workflows "can be delayed during periods of high loads" and may be dropped. Fetched. <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>, <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>
- No GitHub statement about timing variance between runners was found. "Gate on sizes and ratios, not on milliseconds" is this note's judgement, supported by run B above (a p95 60% over the median on an idle desktop).

## 7. Proposed budgets

Each budget names what is measured today, what should hold after the quick wins (2.18.0), and a later target. Milliseconds are for the machine in section 2, warm; the ratio column is what a check on another machine should use. "Today" figures are the run A medians unless stated.

| Budget                                                   | Today                                                                    | 2.18.0                                          | Later target                          | Ratio to use elsewhere                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| CLI `--version`, median                                  | 740 ms                                                                   | under 100 ms (answered before the bundle loads) | under 100 ms                          | under 4 times `node -e 0`                         |
| CLI `--help`, median                                     | 737 ms                                                                   | under 550 ms (compile cache, no git)            | under 300 ms (commands loaded lazily) | under 22 times, then 12 times, `node -e 0`        |
| CLI first request sent, headless, empty folder, median   | 859 ms                                                                   | under 650 ms                                    | under 450 ms                          | under 26 times, then 18 times, `node -e 0`        |
| CLI first request, extra cost of being in a repository   | 80 to 130 ms                                                             | under 40 ms (one async git call)                | under 40 ms                           | absolute                                          |
| CLI child processes while idle at the prompt             | 1 per second                                                             | 0                                               | 0                                     | count                                             |
| CLI peak RSS, one-request `-p` run                       | 247 MB                                                                   | under 200 MB                                    | under 150 MB                          | absolute                                          |
| `cn serve` idle working set                              | 155 MB                                                                   | under 180 MB (hold)                             | under 130 MB                          | absolute                                          |
| CLI bundle `dist/index.js`                               | 18.38 MB                                                                 | under 19.0 MB (hold)                            | under 12 MB                           | bytes                                             |
| VS Code `out/extension.js`                               | 70.92 MB                                                                 | under 50 MB (minified)                          | under 35 MB                           | bytes                                             |
| Webview JavaScript before first paint                    | 4.79 MB                                                                  | under 5.0 MB (hold)                             | under 3.0 MB                          | bytes                                             |
| Webview first paint in a real IDE                        | not measured                                                             | measure first (PERF25)                          | under 500 ms, provisional             | to be set                                         |
| Session save, p95, 1,000 messages                        | 3.7 ms                                                                   | under 10 ms (hold)                              | under 10 ms                           | absolute                                          |
| IDE session file size                                    | grows with requests squared                                              | under 2 times the compact transcript            | the same                              | ratio of file bytes to transcript bytes           |
| Chat mount, 300 messages                                 | 975 to 1,045 ms                                                          | under 600 ms                                    | under 300 ms                          | under 9 times, then 4 times, the 10-message mount |
| Chat mount, 1,000 messages                               | 3.3 to 4.2 s                                                             | under 2 s                                       | under 500 ms (needs virtualisation)   | as above                                          |
| Streamed chunk to screen, p95, 300 messages              | 106 to 120 ms                                                            | under 50 ms                                     | under 33 ms (two frames)              | under 3 times the 10-message figure               |
| Streamed chunk to screen, p95, 1,000 messages            | 423 to 552 ms                                                            | under 100 ms                                    | under 50 ms                           | under 6 times, then 3 times                       |
| DOM nodes, 1,000 messages                                | 52,702                                                                   | hold                                            | under 10,000                          | count                                             |
| Timers under 1 s while idle (webview and extension host) | none found under 1 s; six at 1 to 2 s (section 4.7 and the battery poll) | no polling where an event exists                | the same                              | count                                             |

Why these numbers:

- `--version` under 100 ms: the wrapper can read `package.json` and print before importing anything; the floor is the 25 ms of Node itself.
- `--help` and first request for 2.18.0: the compile cache was measured at 511 ms and 618 ms; removing the module-load `git` call saves another 20 to 45 ms. The budgets leave about 5% of slack over the measured figures.
- 50 ms per chunk: the long-task threshold (section 6.2), and the interval at which chunks are drained. Above it the webview falls behind the stream.
- The chat figures for 2.18.0 assume the subscription fixes of PERF11 and PERF12, which are not built, so they are estimates to be confirmed by the same script.
- Memory "later" targets need lazy loading of the tokenizer tables and jsdom and are estimates.

## 8. A regression check that fits CI

The constraint is concurrency (20 job slots; `research/area-ci-privacy-release.md`), so the check must add no job to a pull request.

1. **Sizes, in jobs that already build.** The CLI job already builds and runs `smoke-test.mjs`, which has a 20 MiB limit. Replace that one number with a small budgets file (`bench/perf/budgets.json`) and one script that reads it and checks `dist/index.js` bytes, the number of bundled packages, and that the three heaviest packages have not grown past a set share. Do the same for `gui/dist` (bytes before first paint, number of externalized warnings) in the job that builds the gui, and for `out/extension.js` in the job that packages the extension. Sizes are deterministic, so these can fail a pull request. Cost: seconds, no new job.
2. **One start-up ratio, in the same CLI step.** Run `--version` 10 times and `node -e 0` 10 times and fail if the ratio of medians is above the budget with a wide margin (for example 1.5 times the budget). A ratio on the same runner in the same minute removes most machine variance. A pull request fails only on a gross regression, such as a new blocking call at import.
3. **Timing, nightly.** Both workflows already have a cron trigger (`cli-pr-checks.yml:15-16`, `pr-checks.yaml:18-19`). Add the full `cli-startup.mjs` and `history-cost.mts` runs as steps of an existing nightly job, upload the JSON as an artifact, and compare medians with the previous night's artifact. Report, do not fail: GitHub says scheduled runs can be delayed or dropped, and shared runners are noisy.
4. **Long chat, on demand.** `webview-chat.mjs` needs a browser. Run it by hand before a release and when a pull request touches `gui/src/pages/gui` or `StyledMarkdownPreview`, and record the table in the pull request. If it is ever automated, it belongs in the nightly job, with DOM node count (deterministic) as the gate and times as a report.
5. **A phase log.** Following Gemini CLI, record four timestamps in the CLI behind a flag (process start, arguments parsed, services ready, first request sent) so a regression can be placed without a profiler.

## 9. Ranked fix list

Ranked by benefit to the person over effort. S is under an hour, M under half a day, L more.

### Quick wins

| Rank | Fix                                                                                         | Measured or expected gain                                                              | Size | Row          |
| ---- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---- | ------------ |
| 1    | Make `--minify` work in the VS Code build                                                   | 70.9 MB to 46.7 MB; 80 ms and 48 MB less at load (measured)                            | S    | PERF8        |
| 2    | Enable the compile cache in the CLI wrapper                                                 | `--version` 740 to 511 ms; first request 859 to 618 ms; 54 MB less RSS (measured)      | S    | PERF2        |
| 3    | Stop the clipboard poll (UX31a), and until then make its effect stable                      | Removes about 25% of a core while idle on Windows (measured)                           | S    | UX31a, PERF5 |
| 4    | One asynchronous `git` call with a timeout, cached for the process; none at module load     | 80 to 130 ms off the first request in a repository; removes an unbounded wait          | S    | PERF1        |
| 5    | Answer `--version` before importing the bundle                                              | 740 ms to under 100 ms (expected)                                                      | S    | PERF3        |
| 6    | Skip the file index in headless runs; cancel the walk on timeout; build it at the first `@` | Up to 50 ms here; up to 1 s and a runaway walk on slow disks                           | S    | PERF6        |
| 7    | Cache repository info instead of three `git` calls on every terminal resize                 | Removes 60 to 90 ms of blocking per resize step                                        | S    | PERF7        |
| 8    | Stop every markdown component subscribing to the whole history; fix the quadratic helpers   | Per-chunk cost no longer grows with chat length (expected; to confirm with the script) | M    | PERF11       |
| 9    | Clear the leaked interval; delete finished abort controllers; cap the undo stack            | Stops three slow leaks                                                                 | S    | PERF24       |
| 10   | Size budgets and a start-up ratio in the existing CI steps                                  | Keeps the gains                                                                        | S    | PERF21       |

### Structural

| Rank | Fix                                                                                                                                        | Why                                                                                | Size   | Row            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------ | -------------- |
| 11   | Do not store the full prompt of every request in the session                                                                               | Quadratic file and memory growth in the IDE; megabyte saves through the IDE bridge | M      | PERF10         |
| 12   | Render past user messages as text; mount an editor only when one is edited                                                                 | 501 editors at 1,000 messages                                                      | M      | PERF12         |
| 13   | Parse streaming markdown incrementally or at most once per frame                                                                           | The whole reply is re-parsed and re-highlighted 20 times a second                  | M      | PERF13         |
| 14   | Load `gpt-tokenizer`, `jsdom` and provider SDKs on first use in the CLI                                                                    | 44% of the bundle and about 15% of start-up for code most commands never run       | M      | PERF4          |
| 15   | Split the webview: math, diagrams and highlighting on demand; Settings and History as lazy routes; the Node fetch package out of the graph | 4.8 MB before first paint; 64% of gui test time is imports                         | M      | PERF14         |
| 16   | Containment, then virtualisation, for long chats (UX49)                                                                                    | DOM and heap grow without limit; mount of an old session takes seconds             | M to L | UX49, PERF16   |
| 17   | Coalesce IDE start-up: one configuration load, MCP after first paint, events instead of polls                                              | Three loads and several 1 to 2 s polls at start (read, not measured)               | M      | PERF17, PERF18 |
| 18   | Gate and slim the per-keystroke document handler in VS Code                                                                                | Two full-text copies per keystroke                                                 | S to M | PERF15         |
| 19   | Slim the extension bundle (`@shikijs/langs`, `jsdom`, tokenizer, `puppeteer-core`, `mysql2`)                                               | 47 MB even when minified                                                           | L      | PERF9          |
| 20   | Decide on `retainContextWhenHidden` after measuring                                                                                        | The documented cost is high and the chat heap is large                             | M      | PERF19         |

## 10. Proposed ROADMAP rows

To be added under a new heading `### Track PERF: start-up, memory and long-session cost` with the same columns as the other tracks. Source for every row: `research/performance-startup-resources.md`. Sizes: S under 1 h, M under half a day, L more.

| ID     | Scope                                                                                                                                                                                                                                                                                                                                                                                              | Needs            | State                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| PERF1  | CLI git facts once: one asynchronous `git` call with a timeout, cached for the process, replaces the four blocking `execSync` calls before the first request (`systemMessage.ts:48` at module load, `FileIndexService.ts:136`, `environmentContext.ts:19` and `:31`); on timeout the facts read "unknown". The prompt text does not change. Budget: under 40 ms extra in a repository              | C65 for the text | Not started (S); 2.18.0 candidate                                 |
| PERF2  | CLI compile cache: `module.enableCompileCache?.()` in the `cn.js` wrapper before the bundle is imported (`build.mjs:107-110`), cache folder per the owner's choice, off with `NODE_DISABLE_COMPILE_CACHE`. Measured: `--version` 740 to 511 ms, first request 859 to 618 ms, peak RSS 246 to 192 MB, 2.7 MB on disk                                                                                | none             | Not started (S); 2.18.0 candidate                                 |
| PERF3  | CLI `--version` (and `-v`) answered by the wrapper from `package.json` before the bundle is imported. Budget: under 100 ms                                                                                                                                                                                                                                                                         | none             | Not started (S); 2.18.0 candidate                                 |
| PERF4  | CLI lazy loading: `gpt-tokenizer`, `jsdom` and the provider SDKs imported on first use; one copy of `zod`; commands loaded on dispatch. Measured today: three packages are 44% of the 18.4 MB bundle and about 20% of start-up. Budget: `--help` under 300 ms, bundle under 12 MB                                                                                                                  | PERF21           | Not started (M); 2.20.0 or later                                  |
| PERF5  | CLI clipboard probe effect made stable until UX31a lands: the `onImageStatusChange` callback memoised or held in a ref so the effect in `useClipboardMonitor.ts:27-73` does not restart on every render (`UserInput.tsx:835-843`). UX31a remains the fix. Measured: one probe is 228 ms wall and about 250 ms CPU on Windows                                                                       | none             | Not started (S); 2.18.0 candidate; superseded when UX31a is built |
| PERF6  | CLI file index: not built in headless runs; built at the first `@`; the walk is cancelled when the 1 s timer wins (`FileIndexService.ts:140-185`)                                                                                                                                                                                                                                                  | none             | Not started (S); 2.18.0 candidate                                 |
| PERF7  | CLI status bar: repository name and branch read once (PERF1's cache) instead of up to three `execSync` calls on every terminal resize (`ResponsiveRepoDisplay.tsx:17-23`, `useTUIChatHooks.ts:10-47`)                                                                                                                                                                                              | PERF1            | Not started (S); 2.18.0 candidate                                 |
| PERF8  | VS Code build: `scripts/esbuild.js` honours `--minify` (today the flag from `vscode:prepublish` is ignored and `out/extension.js` is 70.9 MB). Measured with minification: 46.7 MB, 80 ms faster to load, 48 MB less heap. Check stack traces and any reliance on function names; a size assertion in the packaging job                                                                            | owner question 2 | Not started (S); 2.18.0 candidate                                 |
| PERF9  | VS Code bundle diet: `@shikijs/langs` (8.1 MB) to the languages used or loaded on demand; `jsdom`, `js-tiktoken`, `wink-eng-lite-web-model`, `puppeteer-core`, `mysql2` and the cloud SDKs loaded on first use. Budget: under 35 MB minified                                                                                                                                                       | PERF8, PERF21    | Not started (L); 2.20.0 or later                                  |
| PERF10 | Session size: the full prompt of every request (`promptLogs`, `sessionSlice.ts:361-363`) is no longer kept in the saved session; keep the last request's, or sizes and a hash, per the owner's choice. Modelled: 26.8 MB at 300 messages against 0.4 MB. Budget: session file under 2 times the compact transcript                                                                                 | owner question 3 | Not started (M); 2.18.0 candidate                                 |
| PERF11 | Chat re-rendering: `StyledMarkdownPreview` stops selecting the whole history (`index.tsx:213-236`); `Chat.tsx` computes the latest summary index and last user input once per render, not per item (`:396-416`); `StepContainer` and `ToolCallDiv` memoised; `onEnter` stable. Acceptance with `bench/perf/webview-chat.mjs`: streamed chunk p95 under 50 ms at 300 messages (106 to 120 ms today) | PERF22           | Not started (M); 2.18.0 candidate                                 |
| PERF12 | Past user messages rendered as static content; a TipTap editor is mounted only for the one being edited (`Chat.tsx:432-436`). Measured: 501 editors at 1,000 messages                                                                                                                                                                                                                              | PERF11           | Not started (M); 2.20.0 or later                                  |
| PERF13 | Streaming markdown: at most one parse per animation frame, and only the unfinished last block re-parsed where the pipeline allows (`StyledMarkdownPreview/index.tsx:242-296`, `:398-403`)                                                                                                                                                                                                          | PERF11           | Not started (M); 2.20.0 or later                                  |
| PERF14 | Webview bundle: math, diagrams and code highlighting loaded on first use; Settings, History and Stats as lazy routes; the Node fetch package removed from the webview's import graph (51 of the 63 externalized warnings). Budget: JavaScript before first paint under 3.0 MB (4.79 MB today), warnings under 15                                                                                   | PERF21           | Not started (M); 2.20.0 or later                                  |
| PERF15 | VS Code per-keystroke handler: restore a gate, read the document text once, and skip the configuration load on the hot path (`editLoggingUtils.ts:84-123`)                                                                                                                                                                                                                                         | none             | Not started (S to M); 2.18.0 candidate                            |
| PERF16 | Long-chat virtualisation decision after UX49's containment: measure `content-visibility` with the script, then choose between it and a virtual list (react-virtuoso or TanStack Virtual) with find-in-page, copy and scroll anchoring as the tests. Budget: under 10,000 DOM nodes and mount under 500 ms at 1,000 messages                                                                        | PERF11, UX49     | Not started (M to L); 2.20.0 or later                             |
| PERF17 | IDE start-up: one configuration load instead of three (`core/core.ts:287-288`, `:389-399`), MCP connections after the first paint, the webview's indexes rebuilt once                                                                                                                                                                                                                              | PERF25           | Not started (M); 2.20.0 or later                                  |
| PERF18 | Polling replaced by events: the three 1 s `fs.watchFile` polls (`VsCodeExtension.ts:443-470`), the 2 s open-files poll (`SubmenuContextProviders.tsx:204-210`) and the JetBrains 2 s proxy poll (`ProxyPoolingActivity.kt:16-24`)                                                                                                                                                                  | none             | Not started (S each); 2.20.0 or later                             |
| PERF19 | `retainContextWhenHidden`: measure the hidden sidebar's memory at 100 and 1,000 messages, then keep it, or restore from `getState` and the saved session                                                                                                                                                                                                                                           | PERF25           | Not started (M); owner decision; 2.20.0 or later                  |
| PERF20 | JetBrains off-screen rendering: read it from a setting or the registry key instead of hard-coding it (`ContinueBrowser.kt:29`), and measure typing latency and memory both ways                                                                                                                                                                                                                    | PERF25           | Not started (M); research first                                   |
| PERF21 | CI budgets with no new job: `bench/perf/budgets.json` and a check script run in the existing CLI, gui and extension build steps (bundle bytes, bytes before first paint, externalized warnings, a `--version` to `node -e 0` ratio); the full timing scripts as steps of the existing nightly run, reported and not gating                                                                         | PERF22           | Not started (S); 2.18.0 candidate                                 |
| PERF22 | `bench/perf/`: the measurement scripts and their pure-helper tests                                                                                                                                                                                                                                                                                                                                 | none             | Draft PR #780                                                     |
| PERF23 | A start-up phase log in the CLI behind a flag (process start, arguments parsed, services ready, first request sent), read by `bench/perf/cli-startup.mjs`                                                                                                                                                                                                                                          | PERF22           | Not started (S); 2.20.0 or later                                  |
| PERF24 | Three slow leaks: clear the interval in `extensions/vscode/src/util/vscode.ts:82-86`; delete a message's abort controller when its stream ends (`core/core.ts:234-241`); cap the CLI undo stack (`ChatHistoryService.ts:54-57`)                                                                                                                                                                    | none             | Not started (S); 2.18.0 candidate                                 |
| PERF25 | Measure what this report could not: activation and first paint in a real VS Code (Developer: Startup Performance, Running Extensions), the JetBrains plugin, a laptop-class machine, Node 22, a cold start, macOS and Linux, IDE token counting, the `@` search, codebase indexing at start                                                                                                        | PERF22           | Not started (M); research                                         |

Changes to rows proposed elsewhere (not new ids):

- **UX31a** (`research/area-ux-surfaces.md`): add the measured cost (228 ms wall and about 250 ms CPU per probe on Windows, once a second) and the re-run on every render; acceptance: no child process while the CLI is idle at the prompt.
- **UX49** (`research/area-ux-surfaces.md`): the measurement half is done (section 3.7); the baseline is 975 to 1,045 ms mount and 106 to 120 ms per chunk at 300 messages. `content-visibility` should follow PERF11, because it does not reduce React's work.
- **V14** and **S16**: record that neither is a time problem (3 ms save and 1.9 ms stuck check at 1,000 messages) so they are not scheduled for speed.
- **C80**: unchanged; note that the rebuild costs about 11 ms, so its case is cache stability only.
- **SB12**: the 1.4 GB figure was not re-measured here.

## 11. Owner questions

Each has a default marked "recommended, pending owner".

1. **Where does the CLI compile cache live?** Options: Node's default (the temp folder, shared by every Node program that enables it), or a `cache` folder under the Continuous global folder (cleaned by `continuous clean`, one place to delete). Recommended, pending owner: the global folder, with `NODE_DISABLE_COMPILE_CACHE=1` as the off switch and a line in the docs. The cache holds compiled code of our own bundle and no user data; it is 2.7 MB.
2. **Minify the VS Code extension?** It was meant to be (the script passes the flag). Minified stack traces are harder to read in bug reports unless source maps are kept beside the build. Recommended, pending owner: minify, with `keepNames` so function names survive, and keep the source map as a release asset rather than in the package.
3. **What happens to `promptLogs`?** They feed the feedback buttons (`FeedbackButtons.tsx:22`) and are useful for debugging a single bad reply. Options: drop from the saved session and keep only in memory for the last request; keep sizes and a hash; keep everything behind a debug setting. Recommended, pending owner: keep the last request's in memory, save none, and add a debug setting that saves them for people who ask.
4. **Should a pull request fail on a start-up regression?** Recommended, pending owner: fail on sizes (deterministic) and on a `--version` ratio only at 1.5 times the budget; report timings nightly without failing.
5. **Which machine are budgets for?** This report used a fast desktop. Recommended, pending owner: keep these numbers as the reference, add a second column for a laptop once PERF25 has measured one, and gate CI on ratios.
6. **Is 1,000 messages a size we design for?** It decides whether virtualisation (PERF16) is worth its cost in find-in-page and scroll behaviour. Recommended, pending owner: design for 300 messages feeling instant and 1,000 being usable, which PERF11 and PERF12 may reach without a virtual list; decide PERF16 from the numbers after they land.
7. **Headless runs wait for every MCP server.** That is deliberate (fail early). It also means the slowest server sets the start-up time. Recommended, pending owner: keep the behaviour, add the connection time per server to the phase log (PERF23), and revisit only if people report it.
8. **JetBrains off-screen rendering.** Recommended, pending owner: no change until it is measured (PERF20); the documentation gives no guidance either way.

## 12. Further research

- A real VS Code session: activation time, first paint of the sidebar, memory of a hidden sidebar, with VS Code's own tools.
- The same scripts on a laptop, on Node 22, on macOS and Linux, and after a reboot.
- The IDE's token counting with `js-tiktoken` on long histories, on the extension host.
- The `@` search on a workspace with tens of thousands of files (MiniSearch index build time and per-keystroke query time).
- Codebase indexing at start-up: CPU, disk and memory over the first minutes in a large repository (Track L has no measurement of this).
- Whether esbuild code splitting for the CLI (ESM only, "work in progress") is stable enough to load commands on dispatch, or whether hand-placed `import()` boundaries are safer.
- A Node start-up snapshot or a single executable with a code cache for the CLI: what it gains over the compile cache, and what it costs in release complexity.
- Why a refused connection takes 1.3 s to report, and whether the first-run experience with no server running should fail faster.
- The CLI terminal UI's memory and CPU over a long session, which needs a terminal harness.
- JCEF's Chromium version per supported IDE release, to know which CSS containment features are available there.
