# Research: usability and responsiveness of the chat UI

Date: 2026-11-21. Code read at `01dc47fce` (branch `fix/open-issues-981-982-988`, working tree as found). Nothing here was built. The note is evidence and proposed rows.

## What this note is

An audit of the chat UI in `gui/` for two meanings of "responsive":

- **Layout.** Does it adapt to a 250 to 350 px sidebar, a short panel and a zoomed window.
- **Speed.** Does it stay fast while a reply streams and in a long session, and what does it load at start.

It also covers what a person can do when something fails, keyboard access, theme fallbacks, and how a developer checks layout work.

Two fixes made earlier today are not repeated here: the model setup form that overflowed at 300 px (`ProviderSetupFlow.tsx`, a flex item with no `min-w-0`) and the lost `className` in `StyledMarkdownPreview/index.tsx`.

## Inputs and limits

Inputs:

- `gui/src` (348 non-test `.tsx` files), `core/` where the GUI calls it, `bench/screenshots`, `bench/perf`.
- `plans/ROADMAP.md` (tracks UX, PERF, UJ, NI, V) and the research notes on UX surfaces, performance, the status row, user journeys and throughput display, read first so that tracked work is not reported as new.
- Five upstream reports: continuedev/continue 13483, 13219, 13217, 13267, 13424 (titles and bodies read with `gh`).

Limits:

- **No browser was used.** Every layout finding comes from reading class names and CSS. Widths in pixels are estimates from font sizes and paddings, not measurements. `bench/screenshots` could have measured them, but its dependencies are not installed in this checkout and installing was out of scope.
- **Speed numbers come from Node and jsdom**, not a webview. They are lower bounds for script time and say nothing about layout, paint or garbage collection.
- **The built `gui/dist` is from 2026-11-01**, so its sizes are three weeks old.
- Three throwaway scripts walked the JSX with the TypeScript parser. They find candidates by class name, so they miss styled-components and classes built at run time.

Evidence marks:

- **V**: read in the exact code, or produced by running something.
- **R**: inferred. The cause is in the code, the effect on screen was not seen.

## 1. Summary

| #   | Finding                                                                                               | Evidence     | Tracked?                        |
| --- | ----------------------------------------------------------------------------------------------------- | ------------ | ------------------------------- |
| 1   | Horizontal overflow is clipped, never scrollable, and nothing checks for it                           | V            | No                              |
| 2   | Two always-mounted notices recompute the whole request's size on every streamed batch                 | V (measured) | No                              |
| 3   | The streaming message is parsed from the start on every batch                                         | V (measured) | PERF13                          |
| 4   | The actions row under a reply cannot wrap and gains a text label at 60% context                       | R            | No                              |
| 5   | The Thinking menu cannot shrink inside a group sized for 48 px                                        | R            | No                              |
| 6   | Copy and Insert on a code block are hidden below 250 px, which zoom reaches                           | V            | Partly (UX61, NI14)             |
| 7   | A message that fails to render shows a raw stack and a "Restart" that leaves the conversation         | V            | No (UJ33 is the route page)     |
| 8   | Keyboard focus has no visible indicator outside high-contrast themes                                  | V            | No                              |
| 9   | 69 click targets are not reachable by keyboard, among them the recovery links                         | V            | NI14 (order not set)            |
| 10  | Rows scrolled out of the window lose their open or closed state and are parsed again on return        | R            | No                              |
| 11  | Sending with no chat model does nothing and says nothing                                              | R            | No                              |
| 12  | The bottom stack has no total height limit                                                            | R            | No                              |
| 13  | PERF11, PERF12, PERF16 and UX60 describe the chat before it was windowed                              | V            | Rows exist, text is out of date |
| 14  | The layout harness exists but has no overflow check, no width under 300 and no view of the setup form | V            | Partly (UX36, UX61)             |

Checked and found in good order: the input status row (width steps with tests), the tool-approval row, the Settings shell and its tables, the onboarding tabs, markdown tables and `pre` (each scrolls on its own), dialogs (`w-[92%] max-w-[600px]`), and persistence (the stored subset is small and has no history).

## 2. Layout findings, ranked by how likely a person is to hit them at 300 px

### 2.1 Overflow is hidden, not scrolled (V)

Three containers clip sideways overflow: `components/Layout.tsx:35` (`overflow-x: hidden`), `pages/gui/index.tsx:6` (`w-screen ... overflow-x-hidden`) and the Settings panel, `pages/config/index.tsx:119` (`overflow-x-hidden`). So a child that is too wide does not produce a scrollbar. Its right part (or its left part, in a `justify-end` or centred row) cannot be reached at all. This is why the setup form bug read as "buttons missing".

Clipping is a fair choice for a sidebar. The cost is that every miss is silent, and there is no check: `bench/screenshots` takes pictures and runs axe, and has no test of `scrollWidth` against `clientWidth` (section 5). Each finding below is one instance of this.

### 2.2 The actions row under a reply (R)

`components/StepContainer/ResponseActions.tsx:87` is one row of up to seven controls with `justify-end`, no `flex-wrap` and no `min-w-0`. Its parent has a fixed height, `StepContainer.tsx:117` (`h-7`). On the last reply, from 60% context (`ResponseActions.tsx:57`), the first control gains the words "Compact conversation" (`:103-109`).

Estimate at a 300 px panel: about 272 px of room, and about 290 px needed (a 120 px label, six 24 px icon buttons, gaps). The row would overflow to the left by about 20 px and be clipped. Long sessions are where context passes 60%, so this is the common case, not the rare one. Not measured.

Smallest fix: show the label only from `sm` (330 px). The button keeps its name: `HeaderButtonWithToolTip.tsx:44` sets `aria-label` from the tooltip text.

### 2.3 The Thinking menu in the input row (R)

`InputToolbar.tsx:75` gives the left group `min-w-12 flex-1 basis-12`: 48 px, the width the status-row design reserved for a truncated model name. `ThinkingEffort.tsx:112` was added to that group later (#970) as `flex shrink-0` with a `select`. It does not shrink and is not hidden in the narrow step.

The row decides whether to wrap from the 48 px basis. When 48 px plus the status group just fits, the left group gets little more than 48 px, the select takes most of it, and the model name is cut to nothing or the select draws over the status group. The width test (`InputToolbar.widthLadder.test.tsx`) runs in jsdom, which has no layout, so it cannot see this.

Smallest fix: raise the basis when the Thinking menu is shown, or let the menu shrink to an icon in the narrow step. Needs a picture at 250, 300 and 340 px first.

### 2.4 Code block actions disappear below 250 px (V)

`StyledMarkdownPreview/StepContainerPreToolbar/index.tsx:324` wraps Insert and Copy in `hidden ... xs:flex`. `xs` is 250 px (`tailwind.config.cjs:14`). Below that there is no Copy on a code block and nothing replaces it.

Zoom reaches this tier. VS Code zoom shrinks the webview's CSS width by 1.2 per level, so a 300 px sidebar is 250 CSS px at level 1 and 208 at level 2. This is the fork's share of upstream 13483: the layout adapts, by removing features.

Smallest fix: keep Copy at every width and hide only Insert below `xs`.

### 2.5 The message error fallback (V)

`pages/gui/Chat.tsx:143-144` prints `error.message` and the full `error.stack` in two `<pre>` elements with no wrapping class. A stack line is far wider than 300 px, so the text is cut at the panel edge. See 4.1 for what the button does.

Smallest fix: `whitespace-pre-wrap break-words` on both.

### 2.6 The stack above the input has no total limit (R)

`Chat.tsx:641` is `relative shrink-0` and holds eleven notices, the task list, the loop inbox, the agents list, the question panel, the queue and the input. Each part has its own cap: approvals `max-h-[50vh]` (`PendingToolCallToolbar.tsx:104`), questions `max-h-72` (`QuestionPanel.tsx:306`), tasks `max-h-48` (`TaskListPanel.tsx:385`), agents `max-h-[50vh]` (`AgentsList.tsx:494`), the input up to `70vh` (`TipTapEditor.tsx:268`). The caps add up to more than the panel. In a short panel (a bottom dock, a small JetBrains tool window, or any panel at zoom) the transcript, which is the only part that shrinks, can be left with no height.

No small fix. It needs a rule for which part gives way.

### 2.7 A light scrollbar track in the input (V)

`index.css:158-160` sets `.scroll-container::-webkit-scrollbar-track { background: #f1f1f1 }`, and the thumb is `#888`. The class is on the prompt editor (`TipTapEditor.tsx:268`). In a dark theme a long prompt gets a near-white 8 px strip on its right edge. This may be related to upstream 13267 ("white overlay on the right"); that report names no cause, so the link is a guess.

Smallest fix: `background: transparent`.

### 2.8 "Accept all" and "Reject all" lose their names below 330 px (V)

`AcceptRejectDiffButtons.tsx:70` and `:86` hide the words with `hidden sm:inline`, which is `display: none`. The tooltip does not supply a name, because `Tooltip.tsx:35-44` (`hasText`) sees the hidden text in the React tree and adds no `aria-label`. Below 330 px the two buttons are an X and a tick with no accessible name. They are not clipped, so the layout half of upstream 13219 is fixed here.

Smallest fix: `sr-only sm:not-sr-only` in place of `hidden sm:inline`.

### 2.9 Lower ranked

- **Provider accounts card (R).** `pages/config/components/ProviderInstancesCard.tsx:361` puts up to four text buttons in a `shrink-0` group beside the name. At a 300 px panel the text column is what is left of about 268 px. It truncates (`min-w-0` is set) but may show almost nothing.
- **Docs index title (R).** `pages/config/sections/docs/DocsIndexingStatus.tsx:128` is a flex item with no `min-w-0` holding a `line-clamp-1` title that falls back to the start URL (`:136`) with no `break-all`. A long URL widens the row.
- **Scan results (V).** The class scan for today's bug family (a flex item with no `min-w-0` that holds truncated text) found 9 candidates in 348 files. Seven use `line-clamp-1` with `break-all`, which can shrink. The two above are the ones left. So the family is mostly closed. A second scan found 48 rows with two or more buttons and no wrap; most are two-button dialog footers that fit.

### 2.10 The five upstream reports

| Upstream | Report                                  | State in this fork                                                                                                                                                    |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13217    | Width grows with long unwrapped text    | Fixed (V): `pages/gui/index.tsx:11` has `min-w-0` with a comment naming this cause; `pre` and tables scroll on their own (`StyledMarkdownPreview/index.tsx:70-100`)   |
| 13219    | Accept and Reject clipped when narrow   | Layout fixed (V): the approval row wraps (`PendingToolCallToolbar.tsx:84`, `:108`, `:120`); no `calc(100vw - ...)` width is left in `gui/src`. The name is lost (2.8) |
| 13483    | Overflow at zoom                        | Same family as narrow width. Zoom lands in the under-250 tier, where features are hidden (2.4). Tracked in part as UX61 (200% text); no zoom view exists              |
| 13267    | White overlay hides chat text           | Cause not known. One candidate (2.7). The doubled gutter at `Layout.tsx:224` (`scrollbarGutter: "stable both-edges"`) is another place to look. Not reproduced        |
| 13424    | Inline code unreadable in high contrast | Not reproduced. Inline code takes the sidebar foreground on the editor background (`StyledMarkdownPreview/index.tsx:81-90`) and has no high-contrast rule or border   |

## 3. Speed findings, ranked

### 3.1 The compaction estimate runs on every streamed batch, twice (V, measured)

`CompactionHoldNotice` and `CompactionPreparedNotice` are always mounted (`Chat.tsx:642-643`). Each calls `useCompactionEstimate()` before its early return (`CompactionHoldNotice.tsx:26`, `CompactionPreparedNotice.tsx:71`). The hook recomputes whenever `history` changes (`hooks/useCompactionEstimate.ts:130`, `:147-153`), which is every batch, up to 20 a second (`context/IdeMessenger.tsx:230`).

Each call sizes every item after the last summary and builds the whole chat request to size its head (`redux/thunks/prepareCompaction.ts:153-161`, `redux/util/describeChatRequest.ts:241`). Measured in vitest on synthetic agent sessions, one call:

| Items | Session JSON | Cloud model | Local model with planned compaction |
| ----- | ------------ | ----------- | ----------------------------------- |
| 100   | 0.16 MB      | 1.3 ms      | 1.9 ms                              |
| 400   | 0.63 MB      | 3.4 ms      | 6.8 ms                              |
| 1,000 | 1.57 MB      | 8.4 ms      | 15.8 ms                             |
| 4,000 | 6.30 MB      | 33.5 ms     | 62.1 ms                             |

That is about 5 to 10 ms per MB of conversation since the last summary, two calls per batch. At 1,000 items it is 17 to 32 ms of every 50 ms while a reply streams, to draw two notices that are usually hidden. The cost follows the uncompacted part of the session, so compaction resets it; a model with a large window lets it grow furthest.

The 2026-11-20 measurement (`plans/memory-and-history.md`) concluded that per-token script cost is small. It timed the filter, the window maths and an array copy. It did not include this path.

Fix: compute the estimate only while a notice is shown, and not while streaming.

### 3.2 The streaming message is parsed from the start on every batch (V, measured; tracked as PERF13)

`StyledMarkdownPreview/index.tsx:398-405` sends the whole source through remark, math, KaTeX and highlight each time it changes. Earlier messages are not re-parsed. Measured in Node with the same plugins (no React step, so a lower bound):

| Reply length | One parse, code only | One parse, code and math | All parses over the stream (code only) |
| ------------ | -------------------- | ------------------------ | -------------------------------------- |
| 2,000 chars  | 1.3 ms               | 3.1 ms                   | 22 ms                                  |
| 8,000        | 3.7 ms               | 10.0 ms                  | 242 ms                                 |
| 20,000       | 8.0 ms               | 21.1 ms                  | 1,244 ms                               |
| 50,000       | 20.7 ms              | 51.2 ms                  | 10,247 ms                              |

A normal reply stays under a frame. A long one with math passes a frame per batch from about 15,000 characters.

### 3.3 Every mounted row renders twice per batch (V by reading; tracked as PERF11)

`Chat.tsx:173` selects the whole history, so `Chat` renders on each batch and passes a new `renderItem` closure (`:619`). `StepContainer`, `TimelineItem` and `ToolCallDiv` are not memoised. Then the growing row's `ResizeObserver` calls `onHeight`, which calls `setVersion` (`ChatTranscript.tsx:107-120`), and `ChatTranscript` renders its rows again.

The window bounds this at about 14 rows, and the repository's test puts one re-render at 1.7 to 2.0 ms with simple rows (`chatWindowScale.measure.test.tsx`, run today, passes). Real rows hold markdown and tool cards, so the true figure is higher and unmeasured.

### 3.4 Seventeen components select the whole history (V)

A grep for `useAppSelector((s) => s.session.history)` finds 17 outside tests. All render on every batch. Those that also walk the history each time: `StyledMarkdownPreview/index.tsx:216-236` (once per mounted message; PERF11), `SessionAttachments.tsx:24-30`, `StepContainerPreToolbar/index.tsx:60`, `useChatAnnouncements.ts:20`, and the two in 3.1. `Chat.tsx:479` calls `findLatestSummaryIndex(history)` once per mounted row, not once per render (PERF11).

### 3.5 Windowing moved the cost to scrolling (R)

A row that leaves the window is unmounted (`ChatTranscript.tsx:156-164`). When the person scrolls back it mounts again: its markdown is parsed and highlighted again, and `useRemark` returns nothing on the first render, so the row is first measured short and then grows. `onHeight` corrects `scrollTop` (`:113-118`) with a loop over all rows above. Whether this is visible as a jump needs a browser.

### 3.6 Start-up (V on a stale build; tracked as PERF14)

`gui/dist` of 2026-11-01: `index.js` is 3.98 MB, 1.14 MB gzipped. In today's source the only lazy import is Handlebars (`TipTapEditor/utils/renderPromptv1.ts:45`). Mermaid (`MermaidBlock.tsx:9`), KaTeX (`StyledMarkdownPreview/index.tsx:4`) and highlight.js are static imports, and there is no `React.lazy` and no `manualChunks` (`gui/vite.config.ts`).

### 3.7 Not a problem

- **Persistence (V).** `redux/store.ts:40-77` stores a small subset: ids, mode, settings, tabs. History is not in it.
- **Session save (V).** At the end of a turn, not per batch (`redux/thunks/streamThunkWrapper.tsx:46`, `:104`). Size is tracked as PERF10 and V12.
- **Chunk rate (V).** One dispatch per 50 ms batch, not per token (`IdeMessenger.tsx:225-230`).
- **Window maths (V).** Under a millisecond at 20,000 rows, by the existing test.

### 3.8 Roadmap rows that are out of date (V)

The chat was windowed on 2026-11-18 (`39e9d7f73`), and V3 says so. Four rows still describe the chat before that:

- PERF11: its acceptance figure (106 to 120 ms per chunk at 300 messages) was measured with every message mounted.
- PERF12: "501 editors at 1,000 messages" no longer holds; only rows in the window mount an editor.
- PERF16: the choice it asks for has been made.
- UX60: "every message is mounted today" is no longer true.

`bench/perf/webview-chat.mjs` should be run again before any of them is scheduled.

## 4. Usability findings

### 4.1 A message that fails to render (V, not tracked)

Each message has its own error boundary (`Chat.tsx:624-631`). Its fallback (`:133-151`) says "Something went wrong:", prints the message and the stack, and offers "Restart". Restart calls `newSession()` (`:626-628`). So:

- The label does not say the conversation will be left.
- One bad message costs the view of the whole conversation, though the boundary is per message and the others still render.
- Opening the session from History renders the same message and fails the same way.
- There is no "show as plain text" and no "copy details".

The route error page (`pages/error.tsx`) was already rewritten and is honest about what its button does. UJ33 covers that page, not this fallback.

### 4.2 No visible keyboard focus in ordinary themes (V, not tracked)

`index.css:84-86` is `*:focus { outline: none }`. An outline comes back only under `forced-colors` (`:242`) and VS Code's high-contrast classes (`:253`). `gui/src` has 12 `focus-visible:` utilities in all. In a normal dark or light theme, most buttons show nothing when reached with Tab.

### 4.3 Pointer-only controls (V; NI14 covers the lint, not the order)

69 static elements (`div`, `span`, icons) have `onClick` and no role, `tabIndex` or key handler, in 54 files. The ones that matter most are the ways out of a failure:

- `components/config/FatalErrorNotice.tsx:44`, `:58`, `:67`: Help, Reload and View, shown when the config did not load and chat is disabled.
- `components/mainInput/InlineErrorMessage.tsx:44`, `:56`: Open config and Hide on the context-window error.
- `components/History/index.tsx:374`: the clear-search icon.
- `StepContainerPreToolbar/index.tsx:302`: the code block's collapse chevron.
- `pages/gui/ToolCallDiv/SimpleToolCallUI.tsx:50` and `ToolCallDisplay.tsx:41`: opening a tool call's details.

64 static elements carry a `title` as their only explanation (loop rows, model options, audit chips). A `title` does not show on keyboard focus or on touch.

### 4.4 Sending with no model (R, not tracked)

`Chat.tsx:286-288`: with no chat model, `sendInput` returns. The text stays in the box, nothing is shown, and the Send button is not disabled for this case (`InputToolbar.tsx:47-48`). A first-time user who closed the onboarding card sees an input that ignores Enter. Whether another layer shows a message was not traced.

### 4.5 Windowing resets what the person opened (R, not tracked)

Open or closed state is local component state: tool details (`SimpleToolCallUI.tsx:32`), terminal output (`UnifiedTerminal.tsx:381-382`), thinking blocks (`ThinkingBlockPeek.tsx:60`), code blocks (`StepContainerPreToolbar/index.tsx:61`). A row that leaves the window loses it. Scroll away from an expanded output and back, and it is collapsed again.

### 4.6 Theme fallbacks (V for the code, R for the effect)

- `styles/theme.ts` gives every colour a list of VS Code variables and a default from one dark palette. The defaults are chosen per colour, not per pair. If a host defines a foreground and not its background (JetBrains sets only some variables), dark text can land on the dark default.
- 90 hard-coded palette classes (`text-gray-500`, `bg-white/10` and so on) remain in 30 files, most in Settings (`RulesSection.tsx` 12, `ToolsSection.tsx` 9). They do not follow the theme.
- Mermaid is initialised once with a fixed dark palette (`MermaidBlock.tsx:17-70`), so a light theme gets dark diagrams.
- The message fallback uses the literal colour `red` (`Chat.tsx:143`).

### 4.7 Row index and history index can differ (R)

`Chat.tsx:174-176` removes `system` items before rendering, then uses the row's index as the history index: `index === history.length - 1` (`:622`), `history[index - 1]` (`:565`), `StepContainer index` (`:533`, used by Delete) and `sendInput(..., index)` (`:499`, used by editing an earlier message). If a session holds a `system` item, every later row is off by one and Delete or Edit acts on the wrong message. No code in `gui/src` adds such an item today; an imported or older session might hold one. Not confirmed.

### 4.8 In good order

The empty chat (starters, the first-run line, "Last Session"), the onboarding tabs (a `select` below 330 px), the input toolbar's Tab order and names (UX2, UX4), the approval toolbar's focus handling (UX18, UX58), and the route error page.

## 5. The developer loop

- **`npm run dev` in `gui/` (V).** It starts Vite, and the page fails in a browser because `core/util/uri.ts:2` imports `node:url`. No entry point wires `MockIdeMessenger`; only tests and fixtures import it.
- **A harness exists (V).** `bench/screenshots` builds the real `<App/>` with `MockIdeMessenger` and the real store, puts it in a named state, and drives a browser with `playwright-core`. It has 59 views, takes pictures at 300 and 800 px in dark and light, diffs before and after, and runs axe against a baseline.
- **What it lacks (V).**
  - No overflow check. Nothing compares `scrollWidth` with `clientWidth` or looks for elements outside the viewport, so a clipped control only shows if someone looks at the picture.
  - No width under 300 by default, and `deviceScaleFactor` is fixed at 1, so the under-250 tier and zoom are never drawn.
  - No view of the provider setup form (only `catalogue`), History, Stats, the message error fallback, or a reply at 60% context with the actions row.
  - No way to keep the built harness open in a browser for hand work. `src/server.mjs` already serves it; it is closed after the pictures.
  - It is wired into no workflow, and its dependencies are not installed by the root set-up.
- **Other tests (V).** `extensions/vscode/e2e` drives a real VS Code and asserts behaviour, not layout. There is no Storybook. Component tests run in jsdom, which has no layout, so a test such as `InputToolbar.widthLadder.test.tsx` checks which labels render, not whether they fit.

The smallest useful addition is an overflow pass in the existing harness: after `window.__shotReady`, list every element whose box ends outside the viewport and is not inside a scrolling ancestor, per view and width, against a baseline file as axe does. Run it at 200, 250, 300 and 340 px. Today's bug would have failed it, given a view of the form.

## 6. Quick fixes

Changes of a line or two. None was made.

| File and line                                                     | The change                                                                 | Risk                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `gui/src/index.css:159`                                           | `background: #f1f1f1` becomes `transparent`                                | Low. The thumb stays visible                                               |
| `gui/src/components/AcceptRejectDiffButtons.tsx:70`, `:86`        | `hidden sm:inline` becomes `sr-only sm:not-sr-only`                        | Low. Nothing changes on screen                                             |
| `gui/src/pages/gui/Chat.tsx:143`, `:144`                          | Add `className="whitespace-pre-wrap break-words"` to both `<pre>`          | Low                                                                        |
| `gui/src/components/StepContainer/ResponseActions.tsx:105`        | Add `hidden sm:inline` to the label's class                                | Low. The name comes from `aria-label`. Check the picture at 300 and 340 px |
| `StyledMarkdownPreview/StepContainerPreToolbar/index.tsx:324-327` | Keep `CopyButton` outside the `hidden xs:flex` group                       | Low to medium. Check the toolbar at 200 px with a file name and Apply      |
| `gui/src/components/config/FatalErrorNotice.tsx:44`, `:58`, `:67` | `div` becomes `button type="button"` with `border-none bg-transparent p-0` | Low. Three small edits, not one; tests that find the text still pass       |

Not quick, though small: the estimate hook (3.1) needs a few lines in three files, and a focus outline (4.2) changes how every control looks and needs pictures.

## 7. Proposed rows

`GU` is a placeholder prefix; no row in `plans/ROADMAP.md` uses it.

| ID   | Scope                                                                                                                                                                                                                                                 | Size | Needs        | Acceptance                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| GU1  | An overflow pass in `bench/screenshots`: elements outside the viewport and clipped scroll widths, per view, at 200, 250, 300 and 340 px, with a baseline file; a `--serve` flag that leaves the built harness open in a browser                       | M    | none         | Removing the `min-w-0` added to the setup form today makes the pass fail; the baseline is committed                     |
| GU2  | Harness views that are missing: the provider setup form with a long model id, History, the message error fallback, a reply at 60% context, a reasoning model in the input row, a long prompt in a dark theme, and one view at zoom (scale factor 1.5) | S    | GU1          | Each view is drawn at the four widths and passes GU1 or has a baseline entry with a row                                 |
| GU3  | The compaction estimate is computed only while one of its notices is shown, and not while a reply streams                                                                                                                                             | S    | none         | A test counts calls to `compactionEstimateFor` during 100 streamed batches with no notice shown: 0                      |
| GU4  | The actions row under a reply fits at 250 px: the label from 330 px only, and the row may wrap                                                                                                                                                        | S    | GU2          | The 60% view passes GU1 at 250 and 300 px                                                                               |
| GU5  | The Thinking menu and the model name share the left group without overlap at 250 to 340 px                                                                                                                                                            | S    | GU2          | The reasoning-model view passes GU1; the model name keeps at least 48 px                                                |
| GU6  | The message error fallback: one line saying which message could not be drawn, "Show as plain text", "Copy details", and no action that leaves the conversation; text wraps                                                                            | S    | UJ11 wording | A test: a message whose render throws shows its raw text on request, and the session id is unchanged after every button |
| GU7  | A visible focus indicator in every theme: a `:focus-visible` outline from `--vscode-focusBorder`, with the prompt editor exempt                                                                                                                       | S    | GU1 pictures | A keyboard walk of the input row, a reply's actions and a dialog shows an outline on each stop; axe gains no entry      |
| GU8  | Recovery controls first under NI14: the links in `FatalErrorNotice` and `InlineErrorMessage`, the History clear-search icon and the tool-call disclosure rows become buttons                                                                          | S    | NI14         | Each is reached with Tab and worked with Enter in a gui test                                                            |
| GU9  | Sending with no chat model says so and offers "Add a model"; the text is kept                                                                                                                                                                         | S    | none         | A gui test: no model, Enter, a line with the action appears                                                             |
| GU10 | Open or closed state of tool details, terminal output, thinking and code blocks is kept when a row leaves the window and comes back                                                                                                                   | M    | none         | A test: expand a row, move the window away and back, it is still expanded                                               |
| GU11 | The stack above the input has a height budget: the transcript keeps a minimum height and the stack scrolls inside itself past it                                                                                                                      | M    | GU2          | At a 300 by 400 px view with an approval, three tasks and two queued messages, at least 96 px of transcript shows       |
| GU12 | Re-measure and update PERF11, PERF12, PERF16 and UX60 now that the chat is windowed: run `bench/perf/webview-chat.mjs`, replace the figures, close what no longer applies                                                                             | S    | a browser    | The four rows state figures taken after `39e9d7f73`                                                                     |
| GU13 | Rows use the history index, not the filtered row index, for Delete, Edit and "is last"; first confirm whether a session can hold a `system` item                                                                                                      | S    | none         | A test: a history with a `system` item at position 1; Delete on the third row removes the third message                 |

Already tracked, so not proposed: parsing only the last block while streaming (PERF13), memoised rows and the markdown selector (PERF11), lazy loading of math, diagrams and highlighting (PERF14), views at 200% text size (UX61), the axe run as a check (UX36), the click and static-interaction lint (NI14), named and keyboard-reachable Copy (UX39), the route error page (UJ33).

## 8. Not verified

- Every pixel estimate in section 2. No picture was taken.
- Whether 2.2, 2.3 and 2.6 happen on screen as described.
- The cause of upstream 13267 and 13424 in this fork.
- Per-row render cost with real content, and whether scrolling back jumps (3.5).
- How large the uncompacted part of a real session gets. The 3.1 figures are for synthetic sessions, and the rate per MB is what carries over.
- Bundle sizes for today's source. The build read is three weeks old.
- JetBrains and the full editor tab. Only the code they share was read.
- Whether a session can hold a `system` item today (4.7), and whether another layer reports a send with no model (4.4).
- That Headless UI's anchored lists stay inside a 300 px viewport when their class allows `max-w-[400px]` (`components/ui/Listbox.tsx:49`). The library limits the width from memory of its source; not checked here.
