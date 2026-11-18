# Performance measurements

Dev-only scripts that measure the product's own start-up, memory and long-session cost (not model latency). The method and the first results are in `plans/research/performance-startup-resources.md`.

Nothing in `core/`, `gui/`, `extensions/`, `binary/` or `packages/` imports this folder, and it is wired into no workflow. No script calls a model or reads a key. Every script takes `--out` and refuses a path inside the repository.

| Script              | Measures                                                                                                                                             | Needs                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `cli-startup.mjs`   | CLI wall time, time to the first request, peak RSS and CPU for `--version`, `--help` and `-p` against a local stub, with and without a compile cache | a built CLI (`extensions/cli/dist/cn.js`)                                        |
| `bundle-report.mjs` | Bytes per package in a bundle, from an esbuild metafile (`--meta`) or a chunk and its source map (`--map`)                                           | a build of the CLI, the VS Code extension or the gui                             |
| `history-cost.mts`  | Session save and load, the stuck check and the whole-history token count at 10 to 5,000 messages                                                     | `npm ci` in `core/` and `extensions/cli/`; run with `tsx` from `extensions/cli`  |
| `webview-chat.mjs`  | Chat mount time, DOM nodes, heap, time per streamed chunk and per scroll step at 10 to 1,000 messages                                                | `npm ci` in `gui/` and `bench/screenshots/`; Edge, Chrome or Playwright Chromium |

```sh
node bench/perf/cli-startup.mjs --out "$TMPDIR/perf"
node bench/perf/bundle-report.mjs --meta extensions/cli/dist/meta.json
node bench/perf/bundle-report.mjs --map gui/dist/assets/index.js
(cd extensions/cli && npx tsx ../../bench/perf/history-cost.mts --out "$TMPDIR/perf")
node bench/perf/webview-chat.mjs --out "$TMPDIR/perf/webview-chat.json" --browser edge
node --test "bench/perf/test/*.test.mjs"
```

## Reading the numbers

- Wall times are from one machine and move with the disk cache, antivirus and other load. Compare a change against a run of the base commit on the same machine in the same hour, and compare medians. Sizes (bundle bytes, DOM nodes, file bytes) do not have that problem and are the figures to gate on.
- `cli-startup.mjs` drops two warm-up runs, so it reports warm start. A cold start after a reboot is slower and is not measured.
- `-p refused port` includes the operating system's own delay before it reports a refused connection.
- `webview-chat.mjs` uses the harness build, which reads packages from source. Its load time is not the webview's; mount, stream and scroll costs come from the same components.
- `history-cost.mts` writes real session files to a scratch global folder under `--out`.
