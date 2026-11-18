# GUI screenshots

Pictures of the webview (`gui/`) in named states, light and dark, narrow and
wide, with an optional before/after comparison. For UI work and for pull
requests that change how something looks.

It renders the real `<App/>` with the repository's `MockIdeMessenger` and the
real redux store, puts the store into a named state (a fixture), and drives a
browser through `playwright-core`. No model, no network, no key, no IDE.

Dev-only. Nothing in `core/`, `gui/`, `extensions/`, `binary/` or `packages/`
imports this folder; it is not a workspace, it is not in any `tsconfig`
`include`, the VS Code `.vscodeignore` is relative to `extensions/vscode`, and
the CLI publishes an explicit `files` list. It is wired into no workflow.

## Set up once

```sh
cd gui && npm ci                      # the harness is built with gui's vite and plugins
cd ../bench/screenshots && npm ci --ignore-scripts        # playwright-core 1.64.0 (pinned, lockfile), 14 MB
```

`playwright-core` has no install script that downloads a browser. If you have
no Chromium, use Edge or Chrome (`--browser edge`), or fetch Playwright's own
once with `npx playwright-core install chromium-headless-shell`. An existing
`ms-playwright` cache is reused when it holds the revision 1.64.0 wants (1248).

The workspace packages (`@continuedev/*`) are read from `packages/*/src`, and
`core` from source, so a stale `dist` cannot change what is drawn. Their own
dependencies must be installed (`npm ci` in `packages/*`, as for the gui).

## Use

```sh
node bench/screenshots/screenshot.mjs --list
node bench/screenshots/screenshot.mjs --view chat --width 300 --theme dark --out "$TMPDIR/shots/after"
node bench/screenshots/screenshot.mjs --out "$TMPDIR/shots/after"       # every view, 300 and 800, dark and light
```

Writes `<view>-<width>-<theme>.png` and `manifest.json` (browser, timings, a
sha256 and the page's console errors per picture). Write outside the
repository.

Views: `chat` (empty chat with the input and toolbar), `conversation`,
`streaming`, `tool-call` (a terminal command waiting for approval),
`approval` (three calls waiting: a long command, a path outside the workspace, an MCP tool), `tool-call-done`, `status-row`, `usage-open` and `context-open` (the row under the prompt after a reply: context meter, cost, reasoning, prompt cache; its usage breakdown open; and what the context holds, opened from the meter), `loop` (plan card, per-item budgets, loop controls), `loop-plan-tile`, `loop-plan-running`, `loop-plan-waiting`, `loop-plan-failed` and `loop-plan-finished` (the plan tile and its tree in each state; shoot them with `--height 1500` so the chat above the loop panel is visible),
`settings-tools` (Settings, Tools, scrolled to "Commands and secrets"),
`permissions-editor` (Settings, Permissions, with the add-rule form open on a
rule that allows every command: the typed confirmation, diff and verdict). `audit-list` and `audit-inbox` (Settings, Permissions, the Recent calls and Inbox views, with fake audit answers). The
policy chips are in every chat view, below the input. `catalogue` is OpenRouter provider setup with the one-time "Pull the latest model information" card.

### Accessibility (axe-core)

```sh
cd bench/screenshots && npm run axe -- --browser edge      # every view, 300 and 800, dark and light; --theme hc adds a high-contrast look (for --report; the baseline is dark and light)
npm run axe -- --view settings-permissions --report         # one view, every violation with a target
npm run axe -- --update                                     # rewrite axe-baseline.json from this run
```

One `AxeBuilder({ page })` call per page, after `window.__shotReady` and before
the picture (`src/axe.mjs`, tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa;
`@axe-core/playwright` 4.14.0 and `axe-core` 4.14.0 are pinned exactly and work with
the vendored `playwright-core`, which is its peer). `axe-baseline.json` holds the
known violations per view: rule, then the most nodes seen at any width or theme.
`npm run axe` exits 1 when a view has a rule the baseline does not list, or more
nodes of one than it allows; it prints improvements so the baseline can be tightened
with `--update`. Pictures (`screenshot.mjs`) and axe are separate runs.

### Before and after

```sh
git switch main            && node bench/screenshots/screenshot.mjs --out "$TMPDIR/shots/before"
git switch my-ui-branch    && node bench/screenshots/screenshot.mjs --out "$TMPDIR/shots/after" --diff "$TMPDIR/shots/before"
```

Prints one line per picture; for each that differs more than `--tolerance`
(share of pixels, default 0.001) it writes `diff-<name>.png` (changed pixels in
magenta over a dimmed copy of the old picture) and the script exits 1. A pixel
counts as changed above `--threshold` (colour distance 0 to 1, default 0.1).
The comparison runs in the browser (canvas), so it needs no PNG library. A
picture present in only one run is reported, and counts as a change. The same
build in the same browser gave 0 changed pixels across runs.

### In Windows Sandbox

```sh
node bench/screenshots/screenshot.mjs --sandbox --out "$TMPDIR/shots/sbx"
```

Builds on the host, copies the build, `playwright-core` and the scripts into a
fresh sandbox (network off, host Node mapped read-only), takes the pictures with
the sandbox's own Microsoft Edge as its logged-on user, copies them back and
stops the sandbox. About 30 s. What you get: a machine with none of your state
(no fonts, settings or extensions of yours), the same on every PC.

Two things differ from `extensions/cli/scripts/sandboxRun.ts`, and both are
needed:

- Edge exits at once when run as System (the runner's only mode), so the
  pictures are taken as the sandbox's user. That user exists only after
  `wsb connect`, which **opens the Windows Sandbox window on your screen** for
  the duration (a few seconds). Nothing in the window needs touching.
- Smart App Control inside the sandbox blocks unsigned programs, so
  Playwright's own Chromium cannot run there. Edge is signed and preinstalled.

Needs Windows 11 Pro 24H2 or newer with Windows Sandbox enabled, and no
sandbox already running. A connected VPN client can stop the sandbox from
starting; disconnect it.

## How it is built

| File                                   | Role                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `harness/main.tsx`                     | Mounts `<App/>`; applies a VS Code theme; applies a fixture; sets `window.__shotReady`. |
| `harness/fixtures.ts`                  | The states, built with the same redux actions the gui tests use. Add a fixture here.    |
| `harness/themes.ts`                    | The `--vscode-*` variables of a dark and a light theme.                                 |
| `vite.config.mjs`                      | Builds the harness with gui's vite; maps `core` and `@continuedev/*` to source.         |
| `src/views.mjs`, `src/args.mjs`        | The view list and the command line.                                                     |
| `src/shoot.mjs`                        | Serves the build on 127.0.0.1, drives the browser, writes pictures, compares two runs.  |
| `src/diff.mjs`                         | The pure parts of the comparison.                                                       |
| `src/sandbox.mjs`, `sandbox-entry.mjs` | The Windows Sandbox route.                                                              |

To add a view: add a fixture in `harness/fixtures.ts`, add it to `src/views.mjs`
(a test checks the two agree).

## Known limits

- It is the webview only, not VS Code around it, and not a real IDE host: the
  IDE answers are the mock's, plus a few seeded in `seedMessenger`.
- Settings > Tools reads `process.platform` in `core/util/scrubEnvironment.ts`
  and a webview has no `process`. The harness shims it (`?noProcessShim=1` in
  the page URL turns the shim off) so the page can be drawn at all.
- Fonts are the machine's: Segoe UI and Consolas on Windows. Pictures from
  different operating systems will differ; compare like with like (or use
  `--sandbox`).
- The `loop` fixture uses the real clock, so elapsed-time text can change by a
  minute between runs.

## Tests

```sh
cd bench/screenshots && npm test
```

Offline: the command line, the view list, the pixel counting, the file server's
path check and the browser choice.
