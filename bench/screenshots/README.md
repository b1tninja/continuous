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
the CLI publishes an explicit `files` list. One part runs in a workflow: the
production render check (below) is a step of the gui job.

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
`settings-tools` (Settings, Tools, from the top: the built-in tools), `settings-tools-mcp` (Settings, MCP servers, at a server with its tools listed; the list was on the Tools tab before),
`permissions-levels` (Settings, Permissions, the Levels view: preset, five levels, "Plans and questions" folded), `permissions-protections` and `permissions-protections-open` (the Protections view: the locks and four folds, closed with their one-line state, and with "Commands and secrets" open),
`settings-models-connections` and `settings-models-accounts` (Settings, Models, with three provider connections under "In use" and the folds' one-line states; the second with the Accounts fold open), `settings-general` and `settings-general-index` (Settings, General, with "Codebase index and docs" folded, and opened through the old `?tab=indexing` link),
`settings-mcp` (Settings, MCP servers: servers saved for all projects and for the workspace, one that failed to start, one read-only), `settings-mcp-untrusted` (the same with the notice for a folder that is not trusted), `settings-mcp-empty` (no server), `mcp-dialog` (Add MCP server, the basic part), `mcp-dialog-advanced` and `mcp-dialog-url` (Advanced open, for a command and for a URL), `mcp-dialog-confirm-run` (asking before the command runs) and `mcp-dialog-failed-test` (after a Test that did not find the command),
`permissions-editor` (Settings, Permissions, with the add-rule form open on a
rule that allows every command: the typed confirmation, diff and verdict). `audit-list` and `audit-inbox` (Settings, Permissions, the Recent calls and Inbox views, with fake audit answers). The
policy chips are in every chat view, below the input. `catalogue` is OpenRouter provider setup with the one-time "Pull the latest model information" card.

"Add a model", the setup flow: `setup-start-found` and `setup-start-none` (its
start screen, "What do you have?", in the app dialog, with two servers found on
this computer and with none), `setup-models-local` (the models step of a found
server: context, price and tools, with a long model id), `setup-use-for` (what
the new model is used for, with what each role uses now) and `setup-test-failed`
(the connection step after a test that got no answer). The same flow in the
first-run card: `onboarding-local-chooser` (the start screen with two servers
found), `onboarding-local` ("Nothing yet") and `onboarding-local-server` ("A
server on my network", with More open).

Views made for narrow panels: `setup-long-model` (the provider setup form in the
onboarding card, at its model list, with long model ids) and `setup-dialog` (the
same list in the app dialog), `history` (a few sessions with long titles, and
the search box), `message-error` (a reply whose render throws: the error
boundary's text, stack and Restart; it logs that one error), `context-60` (a
reply at 62% context, so "Compact conversation" is spelled out under it),
`thinking-menu` (a reasoning model with a long name and the Thinking menu),
`long-prompt` (forty lines in the input; drawn with scrollbars, which every
other view hides) and `zoom-150`.

The model's Configure dialog: `model-overview-cloud` (its Overview tab for a
cloud model through an account, with a role the person set and a timeout from
the account), `model-overview-catalog` (a catalog model's variant: values from
the catalog model, the variant and the account), `model-overview-ollama` (a
local model whose server reported its window), `model-overview-assumed` (a
local server that reports nothing: 32,768 assumed, no output cap sent) and
`model-config-generation` (the Generation tab, each field saying "Set by you"
or what "Not set" does). The dialog is at most 600 px wide, so its 800 px
picture shows the four-column table and its 300 px picture the stacked list.

`crowded-stack` is a short panel's worst case: an approval waiting, the task
list open with three tasks and two queued messages, above the prompt. Shoot it
with `--height 400`. It is also measured (`src/stack.mjs`): its manifest entry
gets `stack`, the height of the chat, the prompt, each approval button and the
first question's answer controls and how much of each shows, and a `stack:`
error when under 96 px of the chat shows, when the prompt, the first approval's
buttons or those answer controls are cut, or when no whole line of what the
first approval asks for (its command, arguments, paths or fields) shows above
its buttons.

Three more views are measured the same way. `approval` (three calls) and
`tall-question` (a plan's three long decisions in the Questions panel, after a
conversation) pass at 300 by 400. `loop-tall-question` (Loop mode after a
conversation, one long question in the Needs you tray) passes from 300 by 440:
below that the tray keeps a line of the question and its choices, and the chat
has what is left (61 px at 400).

`zoom-150` is `status-row` at a zoom of 1.5. VS Code's window zoom is the
browser's page zoom: the panel keeps its size on screen and the webview gets
fewer CSS pixels across it, 1.2 times fewer per zoom level. So the view is
drawn with a device scale factor of 1.5 in a viewport of the width divided by
1.5 (`--width 300` is 200 CSS pixels; the picture is still 300 wide). CSS
`zoom` on the page would not do: it leaves the viewport width, and so every
breakpoint, as it was. 1.5 lies between zoom levels 2 (1.44) and 3 (1.73).

### In your own browser

```sh
node bench/screenshots/screenshot.mjs --serve                 # every view; --view a,b limits the list, --port fixes the port
```

Builds the harness, serves it on 127.0.0.1 and prints one address per view
(`?fixture=<fixture>&theme=dark|light|hc`). Open one, narrow the window or use
the developer tools' device toolbar, and inspect. Ctrl+C stops it.

### Overflow

```sh
cd bench/screenshots && npm run overflow -- --browser edge    # every view at 200, 250, 300 and 340 px
npm run overflow -- --view history --report                   # one view, every finding
npm run overflow -- --report --out "$TMPDIR/overflow"         # keep the pictures and overflow.json (each finding with its box)
npm run overflow -- --update                                  # rewrite overflow-baseline.json from this run
```

Measures, after `window.__shotReady`, what does not fit sideways
(`src/overflow.mjs`; the page reports facts, the rules run in Node and have
tests). All amounts are CSS pixels. A finding is one of:

- `outside left|right|both`: the element's box ends outside the viewport. Only
  the outermost such element is named; its children would repeat it.
- `clipped`: `overflow-x: hidden` or `clip`, and content wider than the box.
- `scroll-x`: content wider than the box in an element that scrolls sideways
  to show it, such as a dialog or a list that was meant to fit.
- `squeezed`: text that truncates with an ellipsis and has under 16 px left,
  so it shows the ellipsis alone or nothing.

`clipped` and `scroll-x` also name the child that reaches furthest past the
box ("widest inside").

Not findings:

- Text cut on purpose, with `text-overflow: ellipsis` or a line clamp, while it
  still has room, and anything inside such an element.
- Visually hidden elements (`sr-only`: a clipped box of 1 px out of the flow),
  and anything with `display: none` or `visibility: hidden`. Opacity 0 is
  measured: controls shown on hover must still fit.
- What a sideways scroller can reach. A scroller reaches what lies after the
  start of its content; a right-aligned or centred row that sticks out before
  it cannot be scrolled to, and is reported as `outside`.
- `pre`, `code` and `table` elements that scroll sideways: long lines and wide
  tables are given a scrollbar on purpose.
- `input`, `textarea` and `select`: they scroll their own text.
- A pixel or less.

`overflow-baseline.json` holds the known findings per view and width, as
`"<kind> <element>": pixels`. `npm run overflow` exits 1 on a finding that is
not listed or is more than 2 px larger than listed, and prints what went away
or shrank so the baseline can be tightened with `--update` (with `--view` or
`--width`, only those are rewritten). An element is named by its `data-testid`,
`id` or `aria-label`, else by its tag and utility classes under the nearest
named ancestor, so renaming a class renames the finding. The amounts depend on
the fonts: the baseline was taken on Windows.

The pass checks one state per view at four widths. It does not see overlap
(two controls drawn over each other inside the viewport), height, or anything
that needs a hover or a click the fixture does not make.

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

### Walks

```sh
cd bench/screenshots && npm run walk -- --browser edge     # three journeys at 300 and 800 px: a table, and walk.json in a temp folder
npm run walk -- --check                                     # compare with walk-baseline.json; exit 1 when a journey got worse
npm run walk -- --check --check-only steps,files,ends,tabstops   # the same without scroll px, as CI runs it
npm run walk -- --update                                    # rewrite walk-baseline.json from this run
npm run walk -- --journey add-chat-model --width 800 --out "$TMPDIR/walk"
```

How hard three Settings journeys are, as numbers that can be compared before
and after a layout change. Each journey starts on the chat page (fixture
`walk-start`) in a fresh page and is done with real clicks and typing in the
real `<App/>`; the panel is always 700 px high.

| Journey          | From the chat page to                                                                |
| ---------------- | ------------------------------------------------------------------------------------ |
| `reach-mcp-list` | the list of MCP servers in view                                                      |
| `add-mcp-server` | `npx -y @modelcontextprotocol/server-filesystem /tmp` added and listed in the page   |
| `add-chat-model` | a model added with an API key (not a real one; the mock answers) and picked for Chat |

What is reported per journey and width:

- **steps**: deliberate actions: a click, a field filled, a paste, a
  selection, a box ticked, a key that commits. Opening Settings is one (the
  gear is the editor's, so the script sends the message the gear sends).
  Looking at something is not a step, and neither is a box that is already
  ticked. A picker that takes a click to open and a click to choose is two. A
  paste is a `paste` event on the field carrying the text, not the system
  clipboard: a walk must not replace what the person has copied.
- **scroll px**: before each action the control is scrolled into view by the
  least distance (`scrollIntoView` with `nearest`); what every scrolling box
  moved is added up over the journey. It is the least a person must scroll,
  not what they do scroll while looking.
- **goal y**: the top edge of the journey's goal control on its page as a tall
  picture would show it. The goal is the MCP list's heading, the control that
  starts adding a server, and the control that starts adding a model.
- **tab stops before (in panel)**: how many Tab stops come before the goal in
  document order (visible, enabled, `tabindex` 0 or more, a radio group once;
  inside its dialog when it is in a `role="dialog"`), and how many of them are
  in the same tab panel. This is what `--check` compares as "controls passed".
- **pointer-only before**: things before the goal that take a click but not
  the Tab key, guessed from the pointer cursor on an element that neither is
  nor holds a focusable one (the switches of `ToggleSwitch` are such). Reported,
  not compared.
- **files**: how many times a message left the page for an editor file
  (`harness/walkMock.ts` lists those messages). `config/addLocalWorkspaceBlock`
  is one: core writes a template and opens it. `openFile` is another: the
  "Edit the file" links of the MCP dialog and of a server's menu post it.
- **ends in**: `page` when the last intent was done in the page; `file` when
  the journey stops in an editor file the person must edit by hand, with the
  size of the template core writes (read from core, not copied); `failed` when
  the layout could not do an intent.
- **dead ends**: a placeholder the person must replace (`<your-mcp-server>`,
  `YOUR_API_KEY`, `CHANGEME`) in the file or in a field the journey fills; a
  field the journey fills that has no label; and an end with nothing new in
  the page to confirm it.

What it cannot see: whether a label is understood, what a person has to know
to pick a value, reading and thinking time, anything done in the editor after
a file opens (writing the YAML, saving it, the folder trust question, approving
the server's tools), a real provider or MCP server, and a control that is
clickable without showing the pointer cursor. A journey that ends in a file is
therefore shorter in steps than it is for a person, which is why a better end
counts as better whatever the step count says.

`--check` exits 1 when a journey at a width has more steps, more scroll (by
more than 24 px), more controls passed or more files opened than
`walk-baseline.json`, or a worse end (page, then file, then failed), and 2
when a journey could not be walked and nothing else was worse. It prints
`improved` lines when a number fell; tighten the baseline with `--update`.
`--check-only <list>` compares only the named ones of `ends`, `steps`,
`scroll`, `tabstops` and `files`.

The `gui-checks` job of `.github/workflows/pr-checks.yaml` runs
`npm run walk -- --check --check-only steps,files,ends,tabstops --browser chrome`
after the production render check, and it blocks. Scroll px is left out there:
the baseline is taken with Windows fonts, and one line that wraps differently
on the Linux runner moves everything under it (goal y, which depends on fonts
in the same way, is reported and never compared). On Windows the whole walk
takes about 30 s with the build, and repeated runs (Edge, and Chrome once)
gave the same numbers and the same trace.

#### Before and after the Settings rebuild

Each cell is before / after. Before: MCP servers were at the end of the Tools
tab and "+" wrote a YAML template. After: MCP servers is a tab of its own with
an Add dialog, and "Add a model" asks what you have. Both taken with Edge on
Windows, the panel 700 px high.

| Journey          | Width | Steps   | Scroll px  | Goal y    | Tab stops before the goal (in panel) | Files opened | Ends in                 | Dead ends |
| ---------------- | ----- | ------- | ---------- | --------- | ------------------------------------ | ------------ | ----------------------- | --------- |
| `reach-mcp-list` | 300   | 2 / 2   | 3383 / 0   | 4063 / 58 | 32 (30) / 2 (0)                      | 0 / 0        | page / page             | 0 / 0     |
| `reach-mcp-list` | 800   | 2 / 2   | 1913 / 0   | 2593 / 16 | 32 (30) / 2 (0)                      | 0 / 0        | page / page             | 0 / 0     |
| `add-mcp-server` | 300   | 3 / 7   | 3381 / 341 | 4065 / 91 | 32 (30) / 2 (0)                      | 1 / 0        | file (160 chars) / page | 2 / 0     |
| `add-mcp-server` | 800   | 3 / 7   | 1911 / 156 | 2595 / 39 | 32 (30) / 2 (0)                      | 1 / 0        | file (160 chars) / page | 2 / 0     |
| `add-chat-model` | 300   | 10 / 10 | 180 / 212  | 62 / 62   | 2 (0) / 2 (0)                        | 0 / 0        | page / page             | 0 / 0     |
| `add-chat-model` | 800   | 10 / 10 | 123 / 91   | 20 / 20   | 2 (0) / 2 (0)                        | 0 / 0        | page / page             | 0 / 0     |

`--check` of the new layout against the old baseline said 5 improved and 1
worse: `add-chat-model` at 300 px scrolls 212 px where it scrolled 180, which
is 8 px over the tolerance. All of it is the way down the model checklist to
the journey's model, the third in the list.

How each journey goes now:

- **`reach-mcp-list`**: the gear, then the MCP servers tab (the second tab).
  The list's heading is at the top of the page; before, it was under the
  built-in tools, 4063 px down at 300 px.
- **`add-mcp-server`**: the gear, the MCP servers tab, "+", paste the command
  line into the box (the form fills itself; typing the line instead costs one
  more click, on "Fill in the form"), choose "For all my projects" (nothing is
  chosen to start with, and Save refuses without it), Save, "Save and start"
  (a command for all projects starts at once, so the dialog shows what will
  run and asks), and the server is in the list under "Saved filesystem to
  ...". Seven steps that end with the server listed; before, three steps ended
  in a YAML template with `<your-mcp-server>` to replace by hand. "For this
  workspace only" needs no "Save and start", but the server does not start
  until the editor's question about the folder is answered, outside the page.
  The scroll is from the paste box down to "Where to save it".
- **`add-chat-model`**: the gear (Settings opens on Models the first time, and
  whenever no chat model is selected; someone who last used another tab has
  one click more), "+", "An API key", paste the key (the test runs by itself),
  Next, Next, Review, Save, then the Chat picker and the model: ten steps, as
  before. The "Use for" step has Chat ticked and puts the first of the added
  models to use. Three are ticked to start with and the journey's model,
  Claude Sonnet 5.5, is the third, so it still takes the picker (or two boxes
  unticked before the save, which costs the same). With no particular model
  in mind the journey is done at Save, in eight steps. Gone: the click on the
  Models tab and the one on "Test connection". New: "An API key" and the Next
  of "Use for".

What the mock answers (`harness/walkMock.ts`): `mcp/parsePaste` with core's own
parser (`parseMcpPaste`), `mcp/analyzeLaunch` with core's own check
(`analyzeLaunch`, as on Windows), `mcp/scopes` and `mcp/list` as the dialog's
pictures have them, and `mcp/save` and `config/saveProviderModels` by doing
what the request says: the server or the models are in the config the page is
sent next, with the roles and the selection the request named. Nothing is run
and nothing is written.

**When the layout changes.** A journey (`JOURNEYS` in `src/walk.mjs`) is a list
of intents such as "go to where MCP servers are"; `src/walkLayout.mjs` maps
each intent to the actions that do it today. A walk that cannot do an intent
says which one and why (`add-chat-model: cannot "start adding a model": no
button "Manage models" in the page`) instead of timing out. Then change only
the map: point the intent at the new control, by `data-testid` or role and
name; map it to `[]` when the new layout needs nothing there, or to `null` when
it cannot be done in the page. An action the new layout needs and no intent
names goes in the list of the closest intent. Leave the journeys as they are,
or the numbers stop being comparable. A layout that sends a message the mock
has no answer for needs one in `harness/walkMock.ts`; `walk.json` lists them
as `unanswered`. Then `--update`, and say in the pull request what moved.

### Production render check

```sh
cd bench/screenshots && npm run render -- --browser edge      # --doc tables,math limits it
```

Fixed markdown is drawn as a reply in the real chat and the page is asked what
came out. It exists because the harness has React's **production** build
(`vite build`, and `vite.config.mjs` fixes `process.env.NODE_ENV`) and every
unit test runs the development one. Production elements have no `_owner` or
`_store`, which is how `hast-to-hyperscript` (under `react-remark`) decides it
is talking to React. Without the fixes in
`gui/src/components/StyledMarkdownPreview` a string `style` reached React (error
62: a table, and later any formula, replaced the reply with the error boundary)
and `className` arrived as `class` (no language on a code block, a mermaid fence
drawn as text). The check reads `window.__reactBuild` first and exits 2 if the
page has a development build, because then it would pass whatever the pipeline
does.

One page load per document (`DOCS` in `src/render.mjs`), so one crash does not
hide the rest:

| Document  | What must be on the page                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tables`  | two `<table>`s; the plain one has no `text-align`, the aligned one has left, center, right as `style.textAlign` and as computed style                                                             |
| `math`    | `$a^2+b^2$` and two display formulas as KaTeX; every `style` attribute inside `.katex` parsed into properties; the formula in backslash parentheses still there (this pipeline leaves it as text) |
| `code`    | `<pre><code>` with the class `language-ts`, highlighted, and `ts` in the code block toolbar                                                                                                       |
| `mermaid` | a diagram (`.mermaid svg`) with both nodes, and no plain `<code>`                                                                                                                                 |
| `html`    | nothing from the raw HTML: `remark-rehype` runs without `allowDangerousHtml`, so an inline tag is dropped and its text stays, and a block of HTML is dropped whole                                |
| `misc`    | a link with `target` and `rel`; a `javascript:` link without `href`; a task list as a plain list (no GFM here); nested lists; a remote image behind its "Load Image" button                       |

A document fails on a `pageerror`, on a console error in React's format
(`Minified React error`, or `...Error: ` as a caught error is logged), on a
request to any host but the harness, or when the content is not as in the
table. The mock IDE logs the names of messages it has no answer for
(`history/load`) as errors; those are printed with a failure and do not cause
one. About 12 s with the build (6 pages of about 1.6 s) with Edge on the machine
it was written on. `--dist` reuses a built harness; `--timeout` is how long a
document may take to come out right (20000 ms; the diagram is drawn after a
debounce).

What it catches, measured by removing each fix and running it (2026-11-21):

- without the `createElement` shim (`utils/rehypeCreateElement.ts`), `code` and
  `mermaid` fail;
- without the shim and `rehypeTableCellAlign` (pull request 300), `tables` fails
  with error 62;
- without the shim and `rehypeElementStyleObjects` (pull request 989), `math`
  fails with error 62;
- with the shim in place, removing either plugin alone changes nothing on the
  page and nothing fails: the shim makes `hast-to-hyperscript` parse the style
  strings itself, so the two plugins are a second line behind it.

In CI it is the last step of `gui-checks` (`.github/workflows/pr-checks.yaml`),
with the runner's Chrome, and it blocks. A change under `bench/screenshots/`
runs that job (`scripts/ci/changed-areas.mjs`).

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
| `src/overflow.mjs`, `overflow.mjs`     | The overflow pass: the measurement, the rules, the baseline, and its command.           |
| `src/sandbox.mjs`, `sandbox-entry.mjs` | The Windows Sandbox route.                                                              |
| `src/walk.mjs`, `src/walkLayout.mjs`   | The journeys, what is counted and compared; where each intent is done today.            |
| `src/walkRun.mjs`, `walk.mjs`          | Drives the journeys in the browser; the command.                                        |
| `harness/walkMock.ts`                  | The message record and the IDE answers the journeys need.                               |

To add a view: add a fixture in `harness/fixtures.ts`, add it to `src/views.mjs`
(a test checks the two agree).

## Known limits

- It is the webview only, not VS Code around it, and not a real IDE host: the
  IDE answers are the mock's, plus a few seeded in `seedMessenger`.
- Settings > Permissions > Protections reads `process.platform` in `core/util/scrubEnvironment.ts`
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
path check, the browser choice, the overflow rules and baseline comparison, the
height rule of the measured views, the render check's documents and its filter
for console errors, and the walk's step count, placeholder detection and
comparison rule.
