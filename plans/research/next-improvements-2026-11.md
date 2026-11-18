# Research: the next improvements nobody has asked for yet

Date: 2026-11-13. Code read at `origin/main` 71b46f7 (the 2.16.2 release merge). Docs only: nothing was built or run, and no model was called.

## What this note is

This is an independent pass over the extension (VS Code and JetBrains), the webview and the `continuous` / `cn` terminal agent. It looks for user-facing gaps that **no ROADMAP row and no open pull request already covers**. Every candidate was checked against `plans/ROADMAP.md` (2,295 lines; searched by keyword and by row id) and against the 50 open pull requests listed by `gh pr list --repo b1tninja/continuous --state open` on 2026-11-13. A candidate that is already covered is not proposed again. It is listed in section 2 with the row or PR that owns it, so the same gap is not filed twice.

Inputs:

- the code on `main`
- the research notes in `plans/research/`: product-review-controls-and-roadmap, user-journeys-and-recovery, competitive-gap-analysis, surface-parity, performance-startup-resources, test-quality-strategy and docs-audit
- the release notes `.github/release-notes/v2.14.0-vscode.md`, `v2.16.0-vscode.md`, `v2.16.1-vscode.md` and `v2.16.2-vscode.md`
- the first-party changelogs of six peers (section 4)

Evidence marks:

- **V**: I re-read the cited lines at 71b46f7.
- **R**: found by a read-only sweep, with a spot-check of the cited file.
- Line numbers can be off by a few lines.

The proposed rows use the prefix **NI** ("next improvements"). It is unused on `main` and in the open PRs I checked.

## 1. Summary

This week's two hotfixes followed the same pattern. In one, a single keystroke (Ctrl+Backspace) ended in-flight work. In the other, an edge case in a turn (a reply that held only reasoning) left a broken history, and Bedrock's empty-turn error was the result. Both were fixed in 2.16.2, and Resume was added. Reading the code for more of the same pattern finds these:

1. **Other single actions still end a running agent with no confirmation.** Ctrl+L (bound by default), New Session, opening a history entry and switching session tabs all go through `newSession`. `newSession` aborts the stream and ends every loop worker (NI1).
2. **A failed turn is not saved.** Only the success path of `streamThunkWrapper` saves the session. A failure or Stop exists only in memory until the next save (NI2).
3. **A turn that produced nothing ends without saying so.** This is the general version of the empty-turn bug: no text, no tool call and no notice (NI6).
4. **Since 2.16.2 there is no keyboard way to stop a reply in the IDE.** The docs say so in as many words (NI8).
5. **Retries are nested three deep and are silent while they wait.** The panel can look idle for minutes while a request is still being retried (NI3).
6. **An unsent draft is lost when the webview reloads** (NI5). **Editing an earlier message deletes every later turn**, with no undo or fork (NI7).

The largest gap against peers is **background sessions**. Every peer reviewed now lets one chat keep working while you look at another (VS Code 1.146 background sessions and Inbox, Claude Code agent view, Cursor, Cline, Codex). Here, looking at another chat stops the running one (NI9). Smaller gaps:

- spend over time (NI12)
- keyboard reachability of settings toggles and code-block buttons (NI14)
- a screen-reader mode for the terminal agent (NI15)
- a fault-injection harness that would have caught both of this week's bugs (NI16)

The top-10 batch is in section 5 and the ROADMAP rows in section 6.

## 2. Already covered: do not file again

These gaps are real and were found again in this pass, but a row or a PR already owns each one. The table records that they were checked.

| Gap                                                                                                                                                             | Owner                                                                  | Note from this pass                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JetBrains: 20 panel messages refused, 13 core-to-IDE requests never answered (`create_new_file` hangs on `waitForProblems`, checkpoint restore on `removeFile`) | `research/surface-parity.md` J3, PAR13, PAR15, N8, QA16; decision CO18 | Still true at 71b46f7 (V: `core/protocol/messenger/messageIde.ts:176-177,228-229`; neither name appears in `MessageTypes.kt`; `binary/src/IpcMessenger.ts:119-131` has no timeout). If any JetBrains build ships, J3's "answer unknown types with an error" alone stops the hangs, so it should come before the rest of PAR15 |
| Notification when an approval waits or a turn ends while the panel is hidden                                                                                    | UX62, GAP9, UJ26                                                       | No host notification exists yet (R). The CLI's bell and desktop notifications exist but are off by default (`extensions/cli/src/notify/attention.ts:33-38`)                                                                                                                                                                   |
| Session save failure not shown                                                                                                                                  | UJ5                                                                    | Add this evidence to UJ5: `updateSession` ignores `result.status === "error"` (V: `gui/src/redux/thunks/session.ts:79`)                                                                                                                                                                                                       |
| CLI checkpoints and `/rewind`                                                                                                                                   | GAP1, GAP2, UJ24                                                       | PR #797 open                                                                                                                                                                                                                                                                                                                  |
| Long-chat rendering, whole-session rewrite on save                                                                                                              | V3, V4, V14, PERF10 to PERF16, UX60                                    | The chat is not virtualised (`gui/src/pages/gui/Chat.tsx:522-525`)                                                                                                                                                                                                                                                            |
| Spend cap for interactive sessions                                                                                                                              | GAP25, T10                                                             |                                                                                                                                                                                                                                                                                                                               |
| Model fallback on overload                                                                                                                                      | GAP20                                                                  |                                                                                                                                                                                                                                                                                                                               |
| Worktree cleanup                                                                                                                                                | GAP22, N6, N7                                                          |                                                                                                                                                                                                                                                                                                                               |
| Context meter, price source, served tier, Bedrock quotas                                                                                                        | J0 to J14                                                              | PRs #817, #833, #836, #837, #832, #835 open                                                                                                                                                                                                                                                                                   |
| Doctor, diagnostics bundle, help centre                                                                                                                         | UJ21, UJ22, J7, UX49                                                   | Codex added a one-key diagnostic ZIP on 2026-11-13 (section 4), which supports J7's bundle                                                                                                                                                                                                                                    |
| Crash page wording and reset                                                                                                                                    | UJ33                                                                   | PR #747 open (error page wording)                                                                                                                                                                                                                                                                                             |
| Subagent list, retained transcripts                                                                                                                             | O-track                                                                | PRs #816, #820 open                                                                                                                                                                                                                                                                                                           |
| Docs: CLI reference, Loop page, pages for headline features                                                                                                     | DOC2, DOC3, DOC4, DOC7, DOC8                                           | Two items found in this pass belong in DOC4 and DOC8 (NI18)                                                                                                                                                                                                                                                                   |
| Live provider tests run by a plain `npm test`                                                                                                                   | QA4                                                                    | PR #838 open                                                                                                                                                                                                                                                                                                                  |
| Thinking display, Anthropic thinking across tool loops                                                                                                          |                                                                        | PRs #827, #839 open                                                                                                                                                                                                                                                                                                           |

## 3. Findings

Each item gives evidence, user impact, size (S, M or L), risk, and whether the owner has to decide something first.

### 3.1 Reliability, stuck states and lost work

#### NI1. One keystroke still ends a running agent

- **Evidence (V).** Every route that opens a different session dispatches `newSession`, and `newSession` aborts the running stream and ends the loop workers with the reason "The session changed" (`gui/src/redux/slices/sessionSlice.ts:964-974`). The routes are:

  - the default Ctrl+L / Cmd+L binding, `continuous.focusContinuousInput` (`extensions/vscode/package.json:516-519`). With the chat input focused and a non-empty history, it sends `focusContinueInputWithNewSession` (`extensions/vscode/src/commands.ts:318-327`). Layout handles that with `saveCurrentSession({ openNewSession: true })` (`gui/src/components/Layout.tsx:92-106`), which calls `newSession()` (`gui/src/redux/thunks/session.ts:198-199`)
  - the New Session button
  - opening an entry in History (`loadSession`, `session.ts:96-108`)
  - switching session tabs (`components/TabBar/TabBar.tsx:161-198`)

  Nothing checks `isStreaming`, pending approvals or a running loop first.

- **Impact.** This is the Ctrl+Backspace class again. Ctrl+L is a reflex for "clear the terminal", and in other editors' chats it means "focus the chat". Pressed while the agent is working, it stops the agent mid-tool-loop and stops a Loop wave. The work can be resumed (2.16.2), but only after the person notices, and a wave's worker worktrees are already gone.
- **Proposal.**
  - While a turn is streaming, a tool call is pending or a loop is running, any session switch asks once: "The agent is still working in this chat. Stop it and open a new chat? Stop and open / Keep working". There is a "don't ask again" setting.
  - With NI9 the answer can become "keep it running in the background".
  - Ctrl+L itself, from a focused chat input with history, is the riskiest route. Consider making it focus the input only, and leave "new session" to its own command.
- **Size** S. **Risk** low; the cost is one more dialog. **Owner decision:** yes, on whether Ctrl+L should stop clearing the chat by default. That is a behaviour change people may rely on.

#### NI2. A failed or stopped turn is not saved until something else saves

- **Evidence (V).** `gui/src/redux/thunks/streamThunkWrapper.tsx` saves the session only after `runStream()` succeeds (lines 33-43). The error branch (83-89) runs `cancelStream({ loop: "error" })` and shows the dialog, but does not save. Stop goes through `cancelStream` (`thunks/cancelStream.ts`), which marks the turn `stopped` or `failed` for Resume (lines 55-64) and does not save either. Mid-turn autosave exists only for queued messages (`gui/src/hooks/ParallelListeners.tsx:64-83`, R).
- **Impact.** 2.16.2's Resume promises to work "including when you reopen that session from history". That holds only if a later save happened. A partial answer, the failure marker and any tool results from the failed turn are lost if any of these comes first:
  - a reload (the "Developer: Reload Window" habit)
  - a crash of the extension host
  - VS Code closing
- **Proposal.** Save in a `finally` path for both outcomes, and after `cancelStream` on Stop, with the same `generateTitle: false` save the queue uses. Add a unit test: a turn fails, the next save is never dispatched, and the session is reloaded from `history/load`, so the turn carries `failed` and its partial text.
- **Size** S. **Risk** low; one extra write per failure. **Owner decision:** no.

#### NI3. Three nested retry layers, silent while they wait

- **Evidence (V).** There are three layers:

  1. The fetch layer retries 429, 503 and 529 up to 5 tries and 90 s in total (`core/llm/utils/retryPolicy.ts:27-34`, called from `core/llm/index.ts:651-656`). It reports only through `console.log` (`core/util/withExponentialBackoff.ts:32-35`).
  2. `core/llm/utils/streamRetry.ts` retries a dropped connection before the first chunk (1 s, then 3 s).
  3. The webview then reruns the whole stream 3 more times on any message containing "overloaded" or "529" (`streamThunkWrapper.tsx:7-14,67-82`). Between tries it calls `cancelStream`, and `cancelStream` calls `setInactive()` (`cancelStream.ts:29`), so the panel shows as idle during the 2, 4 and 8 s waits.

  The StreamError dialog's countdown (`gui/src/pages/gui/StreamError.tsx:36-96`) appears only after all of this has failed. The status sets also differ by surface: the terminal agent retries 502 and 504 (`research/user-journeys-and-recovery.md` section 8.1), and the IDE does not.

- **Impact.** On an overloaded provider, someone can wait minutes with no sign of life, see an idle panel, type again, and race a retry still in flight. The `"529"` substring match also classes any error that quotes that number as overloaded (R).
- **Proposal.**
  - One retry owner per request: the core policy, with the webview layer removed or limited to the overload event that arrives inside a 200 stream, which core cannot see.
  - The policy's `onRetry` sends a `llm/retrying` message, and the status row under the prompt shows "Waiting for Anthropic (overloaded): try 2 of 5 in 8 s". Stop works during the wait. It reuses the dialog's countdown component.
  - One status set for both surfaces.
  - A unit test that counts the attempts against a stub that always answers 529.
- **Size** M. **Risk** medium: retry behaviour changes which failures reach the person. **Owner decision:** no, apart from confirming the status set.

#### NI4. Requests from the panel to the extension have no deadline

- **Evidence (V).** `gui/src/context/IdeMessenger.tsx:148-162`: `request()` resolves only when a reply with the same id arrives. `streamRequest` polls every 50 ms with no end condition other than `done` (lines 220-230, R). `binary/src/IpcMessenger.ts:119-131` has the same shape for the JetBrains binary.
- **Impact.** If the extension host restarts, or a handler throws before it replies, the panel waits forever and shows "generating". The only way out is reloading the window, which, before NI2 and NI5, loses the failed turn and the draft. The JetBrains hangs in section 2 are one case of this. This is the general one, and it applies to VS Code too.
- **Proposal.**
  - A per-type deadline (short for reads, none for model streams but a heartbeat instead), after which `request()` resolves with `{ status: "error", error: "No reply from the extension" }`.
  - A banner that says the extension stopped answering and offers Reload, which keeps state.
  - A test with a messenger that never replies.
- **Size** M. **Risk** medium: a deadline that is too short turns slow handlers into errors, so start with long deadlines and log them. **Owner decision:** no.

#### NI5. An unsent draft is lost when the webview reloads

- **Evidence (V).** The persisted part of the session store is `id`, `lastSessionId`, `title` and `mode` (`gui/src/redux/store.ts:39-50`). The editor's content is not persisted anywhere; the only "draft" in `gui/src` is the Loop limits editor. Hiding the panel is safe (`retainContextWhenHidden`, `extensions/vscode/src/extension/VsCodeExtension.ts:264`), but Reload Window, an extension update or a crash discards a long prompt that has not been sent yet. The same applies to an edit of an earlier message that is in progress.
- **Impact.** Lost typing, often a long and carefully written prompt. Peers restore it (Claude Code restores the prompt after a crash; Codex keeps side chats across a restart, section 4).
- **Proposal.** Save the TipTap JSON per session id to webview state (`vscode.setState`, falling back to the redux-persist filter), debounced to 500 ms, and clear it on send. Restore it on load with a one-line notice: "Your unsent message was restored". Context items are restored by reference only, and an image chip is dropped with a note.
- **Size** S. **Risk** low. Privacy: the draft stays in the webview's local state, which already holds the session. **Owner decision:** no.

#### NI6. A turn that produced nothing ends without a word

- **Evidence (V).** `gui/src/redux/thunks/streamNormalInput.ts:540-558`: when the reply has no tool calls, the code tries the leaked-tool-call nudge (H13) and otherwise calls `setInactive()`. If the reply also has no text, the person sees an empty assistant bubble or nothing at all, with no reason given. There is no "returned nothing" string anywhere in `gui/src` (searched).
  - K2 covers one cause: `max_tokens` reached during reasoning.
  - Track RF covers another: refusals and `content_filter`.
  - Nothing covers the general case: an empty `end_turn`, a guardrail with no text, a proxy that answers with an empty stream, or a Bedrock turn that converts to nothing (the 2.16.2 bug).
- **Impact.** This is the visible half of this week's empty-turn bug. When a turn produces nothing, people assume the product is broken, retype, and pay again.
- **Proposal.**
  - A shared check at the end of a turn: no text, no tool call and no reasoning shown. It produces one line in the chat: "The model returned nothing (stop reason: `<reason>`, provider `<name>`)", with Resume (2.16.2) and Change model.
  - In the CLI, the same sentence as a system line.
  - The stop reason the adapters already report (see the turn-prompt eval rows) is shown verbatim.
  - The event is counted in `session.usage` (J6).
- **Size** S. **Risk** low. **Owner decision:** no.

#### NI7. Editing an earlier message deletes every later turn

- **Evidence (V).** `gui/src/redux/slices/sessionSlice.ts:505-526`: resubmitting at index _i_ truncates the history to _i_ + 1 and starts a new empty reply. The later turns are gone from the session, and nothing keeps them. The CLI has `/fork` (`extensions/cli/src/commands/commands.ts`), but the IDE does not use it. No ROADMAP row mentions resubmission or editing an earlier message (searched).
- **Impact.** Someone who edits message 3 of 40 to fix a typo loses 37 turns, including tool results that cost money to produce. Code checkpoints do not help, because this is the conversation, not the files.
- **Proposal.** Before truncating, save the current session as "`<title>` (before edit)", or ask with "Edit here / Edit in a copy". Add an undo line for the next 10 seconds. This lines up with GAP2's one rewind picker: "restore conversation" is the same operation run backwards.
- **Size** S to M. **Risk** low. **Owner decision:** yes, on whether a copy is the default (which keeps the history but adds sessions) or a question.

#### NI8. No keyboard way to stop a reply in the IDE

- **Evidence (V).** 2.16.2 removed Ctrl+Backspace (release notes, Behaviour changes). `docs/ide-extensions/agent/accessibility.mdx:29` now says: "There is no keyboard shortcut for this." Stop is reachable only as the toolbar button (`gui/src/components/mainInput/Lump/LumpToolbar/LumpToolbar.tsx:190-196`), and no declared command stops a reply (the 41 entries in `package.json` contributes.commands).
- **Impact.** Keyboard and screen-reader users have no fast stop. Mouse users who relied on the old key now reach for the mouse. The accident was fixed, but the need it served was not.
- **Proposal.**
  - Declare "Continuous: Stop response" and "Continuous: Resume response" as commands. Default key: none, or a deliberate chord the owner picks (Esc on an empty chat input while streaming is the peer convention: Claude Code, Cursor).
  - Set `aria-keyshortcuts` on the Stop button.
  - Document both on the accessibility page.
- **Size** S. **Risk** low with no default key; with Esc, check that Esc still closes the `@` list first. **Owner decision:** yes, the default key.

### 3.2 Multi-session and agent workflows

#### NI9. Background sessions in the IDE

- **Evidence (V).** There is one session state (`sessionSlice`) and one stream aborter, and opening any other session aborts the running one (NI1). Session tabs exist but are off by default (`gui/src/pages/config/sections/UserSettingsSection.tsx:51`, `ui.showSessionTabs`), and switching tabs still aborts. The ROADMAP has parallel agents (Track O), Loop waves (Track N) and the agents panel (#816), all of them subagents of one session. No row lets two top-level chats run at once (searched: "background session", "another session", "showSessionTabs").
- **Impact.** This is the most widely shared peer feature since mid-2026:

  - VS Code 1.146: background sessions and Inbox mode
  - Claude Code: `--bg --worktree` and agent view
  - Cursor: Projects and Inbox
  - Cline: cloud tasks
  - Codex: cloud thread attach

  People already work around it by running the CLI in a terminal beside the panel.

- **Proposal.**
  - Phase 1: keep a session that is streaming alive when you navigate away. Each session gets its own stream state and aborter, keyed by session id. The History list and the tabs show "working", "needs you" and "done" badges. An approval in a background session raises UX62's notification.
  - Phase 2: a "Start in background" action, with an optional worktree (N6, GAP22).
- **Size** L. **Risk** high:

  - the redux session slice assumes one active session
  - the cache ledger, queued messages and Loop all hang off it
  - two sessions writing to one workspace need the confused-deputy and worktree rules

  **Owner decision:** yes, on scope and on whether worktrees are required for the second session.

### 3.3 Session management

#### NI10. History list: delete without undo, actions only on hover, title-only search

- **Evidence (V).**
  - Delete on a row calls `deleteSession` at once, with no confirmation and no undo (`gui/src/components/History/HistoryTableRow.tsx:176-181`). "Clear all" does confirm (R).
  - The row's Edit, Save as Markdown and Delete buttons render only while the mouse is over the row (`HistoryTableRow.tsx:37,82-83,152`), so keyboard and screen-reader users cannot reach them.
  - Search indexes titles only (`gui/src/components/History/index.tsx:38-42`, MiniSearch `fields: ["title"]`).
- **Impact.** One misclick loses a session for good. A keyboard user cannot rename, export or delete. "Where did I ask about X last week" cannot be answered. V8 plans search over cold history after the V5 tiers, which is far off.
- **Proposal.**
  - Soft delete: move the file to `sessions/trash/`, show an undo line, and empty the trash after 7 days.
  - The row actions are always in the DOM. They are shown on hover and on `:focus-within`.
  - A core `history/search` over the last N sessions' message text, capped and run off the UI thread, with V8 replacing it later.
- **Size** S (first two parts), M (search). **Risk** low. **Owner decision:** no.

#### NI11. Terminal session picker: no search, no delete

- **Evidence (V).** `extensions/cli/src/ui/SessionSelector.tsx:94-103` handles arrows, j/k, Enter and Esc only. Deleting a session works only for the current one (`extensions/cli/src/session.ts:507-516`, R).
- **Impact.** With hundreds of sessions, `/resume` becomes scrolling. V11's `sessions prune` covers bulk age-based deletion only.
- **Proposal.** Type-to-filter on title and first message, `d` then a confirming `y` to delete, and the same trash as NI10.
- **Size** S. **Risk** low. **Owner decision:** no.

### 3.4 Cost transparency

#### NI12. Spend over time: a usage page, `/usage` and `continuous usage`

- **Evidence (V).** An upstream Stats page exists (`gui/src/pages/stats.tsx:41-90`) and shows tokens per day and per model from the dev-data SQLite (`core/data/devdataSqlite.ts:52`, `core/core.ts:1876-1883`). But:

  - the only way to it is a link in Settings, Help (`gui/src/pages/config/sections/HelpSection.tsx:198`)
  - it shows no money, no cache reads or writes, and no per-session split
  - the terminal agent has no `/usage`, `/stats` or `/cost` (the 26 slash commands in `extensions/cli/src/commands/commands.ts`)

  The ROADMAP has per-request and per-session cost (J10, #836) and caps (GAP25, T10), but nothing over days (searched: "per day", "this week", "usage history").

- **Impact.** People who pay per token cannot answer "what did this cost me this week" without the provider's console. That console lags a day and, on Bedrock, mixes in every other workload. The peers all ship this now (section 4): Claude Code `/usage` with today, week and month; Codex USD per thread; Gemini `/stats` heatmap; Antigravity breakdown; Copilot dashboards.
- **Proposal.**
  - Price the existing rows with `calculateRequestCost`, with J10's "estimate" label when a catalogue price was used and #836's price source.
  - Add cache reads and writes to the rows.
  - Link the page from the cost chip under the prompt.
  - `continuous usage [--since 7d] [--json]` and `/usage` in the TUI read the same store.
  - No egress: the data is already local.
- **Size** M. **Risk** low; the price-correctness risk is J10's and #836's. **Owner decision:** no.

### 3.5 Discoverability

#### NI13. The command palette does not reach the fork's own features

- **Evidence (V).** The 41 entries in `contributes.commands` (`extensions/vscode/package.json`) are almost all upstream's. None of these has a command:

  - the Permissions page and the audit inbox
  - Loop start and stop
  - Stop and Resume (NI8)
  - export of a session in a format other than Markdown
  - the agents panel
  - switching mode or model
  - the Stats page (NI12)
  - Test connection

  Defects in the same list:

  - `continuous.focusContinuousInput` is declared twice with two titles, "Add Highlighted Code to Context and Clear Chat" and "Focus Continuous Chat" (`package.json:309`, `:468`). The palette shows two entries that run the same code.
  - `continuous.enterEnterpriseLicenseKey` (`:474`, menu at `:654`) is an upstream leftover with no meaning in this fork.

  UX64 adds one entry ("Manage approvals"); UJ31 adds trust commands.

- **Impact.** Features buried two clicks deep in Settings are invisible to people who live in the palette, and palette entries are what keybinding users bind.
- **Proposal.**
  - One declared command per headline page or action, all routed through the existing `continuous.navigateTo`.
  - Remove the duplicate declaration and the license command.
  - A test that every declared command has a handler and every `navigateTo` route has a command.
- **Size** S. **Risk** low. **Owner decision:** no.

### 3.6 Accessibility

#### NI14. Settings toggles and code-block buttons cannot be reached by keyboard

- **Evidence (V).**
  - `gui/src/components/gui/Switch.tsx:39-47`: the switch behind every setting and policy toggle is a `div` with `onClick` and no role, `tabIndex` or key handler.
  - The code-block toolbar (Copy, Insert, Apply, Run in terminal) is rendered by `ToolbarButtonWithTooltip` as a `div` with `onClick` (`gui/src/components/StyledMarkdownPreview/StepContainerPreToolbar/ToolbarButtonWithTooltip.tsx:17-27`).
  - A sweep found about 82 `onClick` handlers on non-interactive elements in `gui/src` (R, regex), among them `components/ui/Toggle.tsx:20`, the Save and Cancel icons in `UserSetting.tsx:179,184` and the docs-index icons.
  - axe-core, which the UX36 and QA15 gates use, does not flag a click handler on a `div`, so those gates will stay green.
- **Impact.** A keyboard-only or screen-reader user cannot change a setting, cannot change a policy level from the toggles, and cannot apply or copy a code block. All of those are core flows. 2.14.0's accessibility work (live regions, named icon buttons) does not reach these components.
- **Proposal.**
  - `Switch` becomes a `button` with `role="switch"` and `aria-checked`.
  - The toolbar buttons become `button`s with `aria-label`.
  - `Toggle` becomes the disclosure pattern.
  - Enable `jsx-a11y/click-events-have-key-events` and `no-static-element-interactions` for `gui/` with a baseline file that may only shrink, which is UX36's ratchet applied to lint.
- **Size** M. **Risk** low; the visual change is none. **Owner decision:** no.

#### NI15. A screen-reader and plain-output mode for the terminal agent

- **Evidence (V).** No screen-reader, plain or reduced-motion switch exists in `extensions/cli/src` (searched; only `NO_COLOR` is read, `ui/components/loopFrame.ts:6`). The Ink UI redraws regions, spinners and the status bar in place.
- **Impact.** Screen readers re-read redrawn regions or miss them. Claude Code, Antigravity (a toggle on 2026-11-03, progress announcements on 2026-10-27) and VS Code (section 4) all treat this as current work. UX59 documents the IDE only.
- **Proposal.**
  - `--plain` and `ui.screenReader: true`, also turned on by `TERM=dumb`. In that mode: no spinner, no in-place redraw, and each event (tool call, approval request, result, cost) is one appended line with a stable prefix.
  - Approvals are answered by typing `y` or `n` and Enter, not with arrow menus.
  - This shares output code with GAP4's stream-json.
- **Size** M. **Risk** low. **Owner decision:** no.

### 3.7 Test blind spots

#### NI16. Fault injection through the product: the harness that would have caught this week's bugs

- **Evidence (V).** Both 2.16.2 bugs were turn-shape faults: Stop during reasoning, and a turn that converts to nothing on Bedrock. Unit tests now cover them (`gui/src/redux/slices/sessionSlice.stoppedTurn.test.ts`), but nothing drives a whole turn through the webview store and the core request builder against a provider that misbehaves on purpose. QA7 plans a keyless stub for one Anthropic and one OpenAI request, and PAR1 a scripted model for conformance, but neither lists fault scenarios.
- **Impact.** The next turn-shape bug will also be found by a user. NI2, NI3 and NI6 have no regression test without such a harness.
- **Proposal.** A scripted provider (on QA7's stub) that can:

  - return reasoning only
  - return an empty stream
  - send `overloaded` inside a 200 stream
  - drop the connection after the first chunk
  - write half a tool call
  - answer 529 five times

  It is combined with "Stop at phase _p_" and "reload after _p_". The assertions are on:

  - the saved session (NI2)
  - the next request's body, which must have alternating roles and no reasoning-only assistant turn
  - the visible line (NI6)
  - the retry count (NI3)

  It runs in the gui vitest suite and in the CLI's, with no network and no key.

- **Size** M. **Risk** none to users. **Owner decision:** no.

#### NI17. A feature-to-end-to-end matrix, and three missing end-to-end tests

- **Evidence (V).** `extensions/vscode/e2e/tests/` holds `GUI.test.ts` (send, edit, delete, tool approve and cancel, history reopen), `Edit.test.ts`, `KeyboardShortcuts.test.ts`, `Autocomplete.test.ts` and `PromptFile.test.ts`, plus three `.skip` files. None of the fork's own features has an end-to-end test:

  - Resume
  - checkpoint restore
  - permission levels and Always allow
  - Loop
  - model switching
  - compaction
  - reload recovery

  QA23 covers the hygiene of the existing tests, not new coverage.

- **Impact.** Every release since 2.12.0 has shipped fork features with webview and core unit tests only. The 2.16.2 fix crosses the webview, core and the provider adapter, which no unit test sees together.
- **Proposal.**
  - A table in the QA24 test guide: feature, unit, gui, e2e and harness coverage, with an owner.
  - Then three e2e tests: (1) Stop, then Resume, then reload, then Resume again; (2) an agent edit, then Restore to here, with the file content checked; (3) Always allow on a command, the rule in `permissions.yaml`, and the second call not asking.
- **Size** M. **Risk** none to users; CI time is about one minute per test per leg. **Owner decision:** no, within the 20-job cap (QA6).

### 3.8 Docs drift

#### NI18. Recovery and keyboard docs behind the code

- **Evidence (V).**
  - Resume (2.16.2) appears in the release notes but on no docs page. The only "resume" pages are about Loop (`docs/ide-extensions/agent/loop-mode.mdx:135`, `leave-and-resume-loop.mdx`).
  - `docs/reference/vscode.mdx:5` says it was taken from `package.json` "version 2.14.0" with "39 commands". `main` is 2.16.2 with 41 entries (40 ids, NI13).
  - Session tabs (`ui.showSessionTabs`) and the Stats page are not documented anywhere in `docs/` (searched).
- **Impact.** People do not find Resume when they need it, which is right after something failed.
- **Proposal.**
  - Add "Stop, Resume and recovering a turn" to DOC4's list of pages. It covers what Stop keeps, Resume, what happens on reload, and the NI8 keys.
  - Make `reference/vscode.mdx` part of DOC8's generated or checked set, so the counts cannot drift.
- **Size** S. **Risk** none. **Owner decision:** no.

## 4. Peer features shipped since mid-2026

Taken from first-party changelogs on 2026-11-13. The fetch tool returns summaries, so the descriptions are paraphrases: check the wording against the URL before quoting it. Claude Code's `CHANGELOG.md` carries no dates; the dates come from its releases page, and those marked (?) are estimated from release cadence. Roo Code's releases page showed nothing after May 2026, so it is not listed.

| Peer              | Feature                                                                                                            | When                          | Source                                                                                                | Relevant to                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Claude Code       | Recent turns kept when a session is resumed after an unclean exit                                                  | 2.1.325, Nov 13               | <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>                                    | NI2, NI5                                 |
| Claude Code       | VS Code continues the step a window reload interrupted, labelled in the chat                                       | 2.1.274 (?Sep)                | same                                                                                                  | NI2 (Continuous has Resume since 2.16.2) |
| Claude Code       | `claude --bg --worktree`: background session in its own worktree, shown in agent view                              | 2.1.321, Nov 9                | same; <https://github.com/anthropics/claude-code/releases>                                            | NI9                                      |
| Claude Code       | `/usage` spend for today, this week and this month; `/usage` warnings for large tool results and always-on context | 2.1.319, 2.1.299 (?Oct)       | same                                                                                                  | NI12                                     |
| Claude Code       | Screen reader mode (repeated fixes 2.1.319 to 2.1.323)                                                             | Nov                           | same                                                                                                  | NI15                                     |
| Claude Code       | `/rewind`, `/branch`, `/rename`, `/export`, `/stats`, `claude doctor`                                              | current                       | same                                                                                                  | NI7, NI12                                |
| Claude Code       | "Needs input" notifications for agents; MCP disconnect notification                                                | 2.1.323, 2.1.273              | same                                                                                                  | UX62                                     |
| Claude Code       | Headless: exit 1 when actions are refused; stderr line naming what it waits for                                    | 2.1.319, 2.1.295              | same                                                                                                  | UJ19, GAP4                               |
| Cursor            | Inbox of in-progress work and items needing attention; pinned chats for parallel agents                            | Jul 29                        | <https://cursor.com/changelog>                                                                        | NI9                                      |
| Cursor            | `/goal`, `/loop`, steering messages that queue instead of interrupting                                             | Aug 19                        | same                                                                                                  | (Loop exists)                            |
| Cursor            | Projects: work keeps running with the laptop closed; coordinator agent                                             | Sep 10                        | same                                                                                                  | NI9                                      |
| VS Code / Copilot | Background sessions (Ctrl+Enter starts one without opening it) and Inbox mode                                      | VS Code 1.146, Nov 11         | <https://code.visualstudio.com/updates>                                                               | NI9                                      |
| VS Code / Copilot | Audio cue when a session completes; Mark as Done; archive sessions                                                 | VS Code 1.140, Sep 30         | <https://code.visualstudio.com/updates/v1_140>                                                        | UX62, NI10                               |
| VS Code / Copilot | Notice when inactive worktrees pile up or use disk                                                                 | VS Code 1.143                 | <https://code.visualstudio.com/updates/v1_143>                                                        | GAP22                                    |
| Copilot           | Bulk archive and pin of sessions, custom views, compact on context limit                                           | Nov 6                         | <https://github.blog/changelog/2026-11-06-github-copilot-weekly-releases-november-2>                  | NI10                                     |
| Copilot           | Usage reporting covers BYOK and custom models                                                                      | Nov 3                         | <https://github.blog/changelog/2026-11-03-byok-and-enterprise-custom-models-in-the-copilot-usage-api> | NI12                                     |
| Codex CLI         | Side chats reopen after a restart; one-key diagnostic ZIP (Ctrl+S)                                                 | 0.169.0, Nov 13               | <https://github.com/openai/codex/releases>                                                            | NI5, J7                                  |
| Codex CLI         | Terminal notifications (`osc777`), token counts in completion notifications                                        | 0.168.0, Nov 13               | same                                                                                                  | GAP9                                     |
| Codex CLI         | Thread usage in USD; pinned tasks; `/copy`; `codex doctor`; managed worktrees                                      | 0.162.0, Oct 8                | same                                                                                                  | NI12                                     |
| Gemini CLI        | `/stats` daily token heatmap                                                                                       | v0.69.0-preview.0, Nov 10     | <https://github.com/google-gemini/gemini-cli/releases>                                                | NI12                                     |
| Gemini CLI        | Countdown to the end of a 429 cool-down in the loading indicator                                                   | v0.68.0, Nov 10               | same                                                                                                  | NI3                                      |
| Gemini CLI        | History rollback                                                                                                   | v0.58.0, Sep 1                | same; <https://geminicli.com/docs/changelogs/>                                                        | NI7                                      |
| Antigravity       | Screen Reader Mode toggle; screen reader announces agent progress                                                  | v2.29.0 Nov 3, v2.28.0 Oct 27 | <https://antigravity.google/changelog.md>                                                             | NI15                                     |
| Antigravity       | Notifications settings page (sound, volume)                                                                        | v2.26.0, Oct 22               | same                                                                                                  | UX62                                     |
| Antigravity       | Token usage breakdown; quota reset time in the model picker                                                        | v2.18.1, v2.14.0              | same                                                                                                  | NI12, #837                               |
| Antigravity       | Onboarding imports Claude Code, Codex and Cursor setups                                                            | v2.30.0, Nov 9                | same                                                                                                  | Track G                                  |
| Cline             | Provider errors after a stream starts are retried up to 3 times                                                    | SDK v0.0.94, Oct 16           | <https://github.com/cline/cline/releases>                                                             | NI3                                      |
| Cline             | Sessions over about 8 MB resume again; attach to a task already running elsewhere                                  | Oct 26                        | same                                                                                                  | V4, NI9                                  |

Features most shared across these peers, in order: background or detached sessions with an inbox; parallel subagents; a worktree per session; resume after a crash or reload; checkpoints and rewind; usage over time; notifications; hooks with a failure policy; plugin validation; remote control. The first and the sixth have no ROADMAP row (NI9, NI12). The rest have rows or are shipped.

## 5. Recommended next batch (top 10)

Ordered by user impact per unit of work. The first six are S and can land as one release's "reliability" theme beside 2.16.2's Resume.

| #   | Item                                                                           | Size   | Why now                                                                       |
| --- | ------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------- |
| 1   | NI1: confirm before a session switch stops a running agent (and decide Ctrl+L) | S      | Same class as the Ctrl+Backspace bug this week; Ctrl+L is bound by default    |
| 2   | NI2: save the session when a turn fails or is stopped                          | S      | Resume's promise depends on it                                                |
| 3   | NI6: one line when a turn produced nothing                                     | S      | The visible half of the Bedrock empty-turn bug                                |
| 4   | NI8: Stop and Resume as commands, with a deliberate key                        | S      | 2.16.2 left keyboard users with no stop                                       |
| 5   | NI5: keep the unsent draft across a reload                                     | S      | Lost typing is the most-felt kind of lost work                                |
| 6   | NI10 (first two parts): undo for delete, history actions on focus              | S      | One misclick deletes a session; keyboard users have no row actions            |
| 7   | NI3: one retry owner, and the wait shown                                       | M      | Minutes of silent waiting look like a hang                                    |
| 8   | NI16: fault-injection harness                                                  | M      | Regression tests for 1 to 3 and 7; would have caught both of this week's bugs |
| 9   | NI14: keyboard reach for switches and code-block buttons, with a lint ratchet  | M      | Settings and Apply are unusable by keyboard; the axe gate cannot see it       |
| 10  | NI7: editing an earlier message keeps the old turns                            | S to M | Silent loss of many turns, including paid tool results                        |

Next after these: NI4 (deadlines on panel requests), NI12 (usage over time), NI13 (palette), NI18 (docs), NI11, NI15, NI17. NI9 (background sessions) is the largest peer gap but is L and needs a decision first. Start it with a design note after the batch, not inside it.

## 6. ROADMAP rows to add

Proposed as a new track, "Track NI: next improvements (2026-11-13 review)", placed after Track GAP. It is written here as text; `plans/ROADMAP.md` is not edited by this note.

Plan: `research/next-improvements-2026-11.md`. Problem: single actions still end running work (NI1), failed turns and drafts are not kept (NI2, NI5), empty turns and retries are silent (NI6, NI3), and there is no keyboard stop (NI8). There are no background sessions (NI9) and no usage over time (NI12), and none of the fork's features has an end-to-end or fault test (NI16, NI17).

| ID   | Scope                                                                                                                                                                                                                                                                                   | Size   | Needs                   | Acceptance                                                                                                      | State                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| NI1  | A session switch (Ctrl+L with history, New Session, History open, tab switch) while a turn streams, a call is pending or a loop runs asks once, with "don't ask again"; owner decides whether Ctrl+L keeps clearing the chat                                                            | S      | owner (Ctrl+L)          | A gui test: a streaming session plus `focusContinueInputWithNewSession` asks and does not abort until confirmed | Proposed; 2.18.0                              |
| NI2  | Save the session after a failed or stopped turn (`streamThunkWrapper` error branch, `cancelStream` on Stop)                                                                                                                                                                             | S      | none                    | A test: failure, then reload from `history/load`, finds the turn marked `failed` with its partial text          | Proposed; 2.18.0                              |
| NI3  | One retry owner per request; `llm/retrying` to the status row ("try 2 of 5 in 8 s", Stop works); the webview overload rerun only for in-stream overload; one status set for IDE and CLI; no `"529"` substring match                                                                     | M      | none                    | A stub that always answers 529 sees at most `maxAttempts` requests; the row shows the countdown                 | Proposed; 2.18.0                              |
| NI4  | Deadlines on panel-to-extension requests (`IdeMessenger.request`, `IpcMessenger.request`), an error result after them, a "not responding" banner with a state-keeping reload                                                                                                            | M      | none                    | A messenger that never replies yields an error, not a hang                                                      | Proposed; 2.20.0                              |
| NI5  | The unsent draft (and an in-progress edit of an earlier message) saved per session to webview state and restored with a notice                                                                                                                                                          | S      | none                    | A gui test: type, reload the store, the text is back                                                            | Proposed; 2.18.0                              |
| NI6  | A turn with no text, no tool call and no shown reasoning ends with one line naming the stop reason and provider, with Resume and Change model; CLI the same; counted in `session.usage`                                                                                                 | S      | J6 for the count        | A fault-harness case (NI16) shows the line                                                                      | Proposed; 2.18.0                              |
| NI7  | Editing an earlier message keeps the replaced turns (a saved copy or a question) with an undo line                                                                                                                                                                                      | S to M | owner (default)         | A test: edit message 3 of 10, the 7 later turns exist in a session                                              | Proposed; 2.18.0                              |
| NI8  | "Stop response" and "Resume response" commands; `aria-keyshortcuts` on Stop; owner picks the default key (Esc on an empty input while streaming recommended)                                                                                                                            | S      | owner (key)             | The command stops a stream in an e2e test; the accessibility page lists it                                      | Proposed; 2.18.0                              |
| NI9  | Background sessions in the IDE: a running session keeps running when another is opened; badges "working", "needs you", "done"; phase 2 "Start in background" with an optional worktree                                                                                                  | L      | owner (scope), UX62, N6 | Two sessions stream at once in a gui test; an approval in the hidden one notifies                               | Proposed; design note first                   |
| NI10 | History: soft delete with undo and a 7-day trash; row actions on `:focus-within`; message-text search over recent sessions in core                                                                                                                                                      | S + M  | none                    | A keyboard-only walk deletes and restores a session; a search finds a word from a message body                  | Proposed; 2.18.0 (first two), 2.20.0 (search) |
| NI11 | CLI session picker: type to filter, delete with confirmation, same trash as NI10                                                                                                                                                                                                        | S      | NI10                    | A TUI test filters and deletes                                                                                  | Proposed; 2.20.0                              |
| NI12 | Usage over time: the Stats page priced (J10 label, #836 source), cache reads and writes added, linked from the cost chip; `/usage` and `continuous usage [--since] [--json]`                                                                                                            | M      | J10, #836               | Totals for a fixture database match `calculateRequestCost` per row                                              | Proposed; 2.20.0                              |
| NI13 | Palette commands for the Permissions page, audit inbox, Loop start and stop, Stop, Resume, agents panel, Stats, Test connection; remove the duplicate `focusContinuousInput` declaration and `enterEnterpriseLicenseKey`                                                                | S      | none                    | A test: every declared command has a handler; no duplicate ids                                                  | Proposed; 2.18.0                              |
| NI14 | `Switch` as `role="switch"` button, code-block toolbar as named buttons, `Toggle` as a disclosure; `jsx-a11y` click and static-interaction rules on `gui/` with a shrinking baseline                                                                                                    | M      | none                    | Keyboard-only walk toggles a setting and applies a code block; lint baseline committed                          | Proposed; 2.18.0                              |
| NI15 | CLI `--plain` / `ui.screenReader` (also `TERM=dumb`): no spinner or redraw, one appended line per event, typed approvals                                                                                                                                                                | M      | GAP4 (shared output)    | A snapshot of a plain session has no cursor-movement escapes                                                    | Proposed; 2.20.0                              |
| NI16 | Fault-injection provider on QA7's stub: reasoning-only, empty stream, in-stream overload, drop after first chunk, half a tool call, repeated 529; crossed with Stop and reload at each phase; asserts on the saved session, the next request body, the visible line and the retry count | M      | QA7                     | Reverting the 2.16.2 fix makes a case fail                                                                      | Proposed; 2.18.0                              |
| NI17 | Feature-to-test matrix in the QA24 guide; e2e for Stop, Resume and reload; Restore to here; Always allow                                                                                                                                                                                | M      | QA24, QA6               | The three e2e tests pass on the ubuntu leg                                                                      | Proposed; 2.20.0                              |
| NI18 | Docs: a "Stop, Resume and recovering a turn" page (into DOC4); `reference/vscode.mdx` checked by DOC8; session tabs and Stats documented or removed                                                                                                                                     | S      | DOC4, DOC8              | The page exists; DOC8's check covers the reference counts                                                       | Proposed; 2.18.0                              |

Rows to update rather than add:

- **UJ5:** add the evidence that `updateSession` ignores an error result (`gui/src/redux/thunks/session.ts:79`).
- **PAR15 / J3:** note that, if any JetBrains build is released before CO18 is settled, J3 alone (an error reply to unknown types) should ship first, because `create_new_file` hangs today.

## 7. Owner questions

1. Ctrl+L with a focused chat input and a history starts a new chat. Keep it, keep it with the NI1 confirmation, or make it focus the input only? (NI1)
2. Which key, if any, stops a reply by default now that Ctrl+Backspace no longer does? Esc on an empty input is the recommendation. (NI8)
3. Editing an earlier message: save a copy by default, or ask each time? (NI7)
4. Background sessions: is this in scope for 2.20.0, and must a second running session use its own worktree? (NI9)

## 8. Limits of this pass

- **Nothing was run.** The impact statements come from reading the code, and the stuck states in NI3 and NI4 were not reproduced.
- **The roadmap check was by keyword.** A row that describes one of these gaps in different words may exist. Search terms tried for each item are named in its evidence.
- **The peer table is not a full review.** It uses changelog pages as fetched, which are summaries. It is a supplement to `research/competitive-gap-analysis.md`, not a replacement.
- **The accessibility count is approximate.** The 82 `onClick` handlers come from a regex. The two components named in NI14 were read in full.
