# Subagent and session panel: explore, group, archive

Date: 2026-11-13. Code read at `origin/main` 62277ea78 (merge of #813) in a fresh clone. Line numbers are at that commit and were re-read for this note. Peer behaviour comes from first-party docs fetched on 2026-11-13; each claim carries its URL.

The owner asked for two things. First, a running or finished subagent should be explorable: you can open it, see what it did, act on it and go back to the parent. Second, the panel should take less room: finished agents go into their own group, with archive, delete, stop and resume where they exist.

This note records what exists, what peers do, the design, and what the first slice (the PR that adds this file) builds. Owner decisions are marked **OD**.

## 1. What exists today

| Piece                 | Where                                                                                                                                                  | What it does                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent model           | `core/agents/types.ts:9-31`                                                                                                                            | Kinds `main`, `subagent`, `loop-worker`, `background`, `external-reserved`. States `running`, `waiting-approval`, `blocked`, `done`, `failed`, `stopped`, `over-budget`. The last four are terminal (`TERMINAL_AGENT_STATES`).                         |
| Run → node            | `core/agents/fromRuns.ts:14-22, 37-75, 83-103`                                                                                                         | Maps a subagent run status to a state, with `partial`, `cancelled` and `interrupted` all becoming `stopped`. Reads names, states and numbers only. A Loop worker is always `running`.                                                                  |
| Projection            | `core/agents/project.ts:21-58`                                                                                                                         | An allow-list (`AgentView`) with cost self and subtree, plus totals and `needsYou`.                                                                                                                                                                    |
| IDE selector          | `gui/src/redux/selectors/selectAgents.ts:21-58`                                                                                                        | Recomputes the map from `session.history` (each tool call's `subagent`) and `loop.parallel`. Nothing is stored.                                                                                                                                        |
| The panel             | `gui/src/components/BackgroundMode/AgentsList.tsx:242-321` (before this PR)                                                                            | A tree under a "Session" row. It is open by default (`listOpen` true, line 244), every node is expanded, and finished agents stay listed. Its doc comment says it is read-only, with Stop on the card (lines 235-241).                                 |
| Placement             | `gui/src/pages/gui/Chat.tsx:581-584`                                                                                                                   | Above the input, after `LoopInbox`, and before `NeedsYouTray` or `QuestionPanel`. It competes with the loop strip and the tray for the same vertical space.                                                                                            |
| Subagent record       | `core/index.d.ts:1374, 1381-1409`                                                                                                                      | `SubagentRunState` sits on the parent's tool call and is saved with the session. It holds the prompt, tool calls by name with a short summary, the answer text, any error, notices, the pending approval, times and usage. It never holds tool output. |
| Subagent conversation | `gui/src/util/subagents/runSubagent.ts:215-225, 690`                                                                                                   | The full conversation (`LocalSession`) lives in a closure while the run is going and is thrown away when it ends.                                                                                                                                      |
| Card                  | `gui/src/pages/gui/ToolCallDiv/SubagentCard.tsx:77-282`                                                                                                | The record in the parent transcript. Stop is at lines 143-155. Allow and Reject for a pending call are at lines 207-252, and they are the only place an approval is answered.                                                                          |
| Stop                  | `gui/src/util/subagents/registry.ts:13, 52-61`                                                                                                         | An abort controller per live run, kept in this window only.                                                                                                                                                                                            |
| Worker stop           | `gui/src/util/subagents/loopWorkers.ts:23-28`                                                                                                          | `stopLoopWorker(itemId)`, plus `abortLoopWorkers` for the whole loop.                                                                                                                                                                                  |
| After reload          | `gui/src/util/subagents/interrupt.ts:31-51`                                                                                                            | A run left `queued` or `running` becomes `interrupted` and is closed with what it had. There is no resume.                                                                                                                                             |
| Loop strip and tray   | `gui/src/components/loop/LoopStatusLine.tsx` (#697), `NeedsYouTray.tsx` (#700), `LoopSettingsDialog.tsx` and `LoopItemList.tsx` (#701), `PlanTree.tsx` | The loop's one status line with Stop and a jump to the plan (`jumpToPlan`, `LoopStatusLine.tsx:36-44`), the "Needs you" tray, and the plan tree.                                                                                                       |
| Session tabs          | `gui/src/components/TabBar/TabBar.tsx:184-198`, `Chat.tsx:541`                                                                                         | Optional (`ui.showSessionTabs`). Clicking a tab loads that session into the one `session` slice, so only one chat session runs in a webview at a time.                                                                                                 |
| CLI                   | `extensions/cli/src/commands/commands.ts:96-99`, `ui/JobsSelector.tsx`, `services/BackgroundJobService.ts:181`                                         | `/jobs` lists background shell jobs with a detail view and cancel. `continuous agents list` (`commands/agents.ts:1-7`) reads `GET /agents` from a running `cn serve`. The TUI has no in-session list of subagents.                                     |
| Roadmap               | `plans/ROADMAP.md:743` (O15), `:746` (O18), `:1231` (V4), `:1234` (V7)                                                                                 | O18, the Inbox, groups rows into Needs you, Working and Done and replaces the `AgentsList` stub. O15, open an agent's transcript, is parked behind V4 and V7 because transcripts are not retained.                                                     |
| Wording debt          | `plans/research/design-and-security-review.md` U9, U15                                                                                                 | "Needs you" has four phrasings across the UI. A stopped subagent reads "Cancelled" on its card and "Stopped" in the tree.                                                                                                                              |

Three facts set the boundaries of the design:

- **A subagent's full conversation is not kept.** Only the record on the card (`SubagentRunState`) survives the run.
- **A Loop worker keeps nothing.** Its node exists only while it is in `loop.parallel`.
- **Nothing can be resumed.** A reload interrupts every live run.

## 2. Peers

**Claude Code (CLI).**

- The panel below the prompt shows one row for main and one per agent. `↑/↓` selects a row, `Enter` opens that agent's transcript, `x` stops it or dismisses a finished row, and `Esc` returns to the prompt.
- While a transcript is open, text you type goes to that agent.
- A successful agent's row leaves immediately. A failed or stopped agent's row stays 30 seconds.
- A subagent resumes with its full history through `SendMessage`.

https://code.claude.com/docs/en/sub-agents

**Claude Code shortcuts.**

- `Ctrl+B` backgrounds a command or agent.
- `/tasks` lists running shells and subagents.
- `Ctrl+X Ctrl+K` stops every background agent.

https://code.claude.com/docs/en/interactive-mode

**Claude Code agent view (`claude agents`).**

- Sessions are grouped Ready for review, Needs input, Working and Completed. Completed holds finished, failed and stopped sessions.
- `Enter` attaches to a session, `←` detaches, and `Space` opens a peek panel.
- `Ctrl+X` stops a session, and pressing it twice deletes the session from the list. The transcript is still available through `--resume`.

https://code.claude.com/docs/en/agent-view

**Claude Code agent teams.**

- When more than three teammates are idle, they fold into one "N idle agents" row.

https://code.claude.com/docs/en/agent-teams

**Claude Code in VS Code.**

- `/tasks` opens an "agent map": a tree with status, elapsed time and tokens. From it you can open a subagent's read-only transcript or stop it.
- Sessions can be archived and unarchived.
- Sessions idle for 14 days auto-archive.

https://code.claude.com/docs/en/vs-code

**Claude Code retention.**

- Subagent transcripts are files, deleted after `cleanupPeriodDays` (30 by default).

https://code.claude.com/docs/en/claude-directory

**GitHub Copilot.**

- Sessions are grouped by time or workspace, and subagent chats are read-only.
- Archive or Mark as Done hides a session. Unarchive or Restore brings it back.
- Delete is permanent and also removes the harness's worktrees.

https://code.visualstudio.com/docs/copilot/chat/chat-sessions

**Cursor.**

- Shared cloud agents are read-only to view. https://cursor.com/docs/cloud-agent
- The sidebar offers Archive only, and permanent delete goes through the API. This comes from forum threads, not docs: https://forum.cursor.com/t/agents-sidebar-archive-only-no-delete-need-permanent-cleanup/163637

**Roo Code.**

- A `new_task` subtask pauses its parent, and the parent resumes with the subtask's result summary.
- You can navigate between active and paused tasks. A back-to-parent control is not documented.

https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks

**Cline.**

- The task history can be resumed and starred. Subtasks are not documented.

https://docs.cline.bot/core-workflows/task-management

**What to take from the peers:**

- Put "needs you" above "working", and fold everything finished into one group.
- Open an agent from its row, and have a clear way back.
- Treat archive as reversible and delete as permanent and confirmed.
- Keep transcript retention separate from what the list shows.

Nobody documents a "back to parent" control. Claude Code CLI is the only one that lets you message a running subagent.

## 3. States and transitions

The panel's states are the agent map's, with archived added as a view flag. Archived is a flag on how the panel shows an agent; it is not an agent state.

```
             spawn
               |
            [queued]--(slot)-->[running]<--(approved/rejected)--[waiting for you]
               |                 |   \__(asks approval)__________/
               |                 |
     stop/parent abort      ends | stop | error | turn limit | budget | reload
               v                 v
           [stopped]   [done] [stopped] [failed] [stopped*] [over-budget] [interrupted]
                 \________________________|__________________________/
                                          v
                               Done group  --archive-->  Archived group
                                          <--restore--
```

\* `partial` (turn limit) is shown as stopped.

**Resume** would take an agent from stopped or interrupted back to running. It does not exist (§1). Building it needs the subagent's conversation to be retained (V4, V7) and a way to start a run from a saved `LocalSession`.

## 4. What "explore" means

**Phase 1 (this PR): a read-only record.** Opening a row replaces the list with that agent's record. The record is the same `SubagentCard` the conversation shows, in `readOnly` mode:

- It has no Stop button of its own; the view's toolbar has one.
- It has no Allow or Reject. A pending approval shows "Answer in the conversation", which scrolls to the real card, so approvals still have exactly one path. This keeps the rule in O18.

The view also has:

- A toolbar: Stop, Resume, Archive or Restore, Delete, and "Show in conversation" (or "Show in plan" for a Loop worker).
- A "Back to Session" control. Escape does the same.

The record shows what the card already shows, masked the same way (`maskCommandForDisplay` on the prompt and summaries). The list rows keep the allow-list: names, states and numbers only, with a test that the prompt, the answer and tool summaries never reach a row.

**Phase 2: interactive.**

- Send a message to a running subagent. This needs a queue that `runSubagent`'s drive loop reads between turns, which is a new path into `local.history`.
- Answer its approval from the record. This would be a second approval path, so it is **OD-3**.
- Resume a stopped or interrupted run. This needs a retained transcript (V4, V7).
- Open the full conversation instead of the card's record. This also needs V7.

Phase 2 is not a small step from today's wiring. The conversation is a closure-local variable (`runSubagent.ts:690`), and there is no message channel into it.

**Parent jump.** "Back to Session" returns to the list and focuses the row that was opened. "Show in conversation" scrolls the parent transcript to the subagent's card. If subagents ever nest in the IDE (the CLI can already nest), the Back control names the parent node and a breadcrumb appears: `Session › reviewer › explore`.

## 5. Where it lives and how it looks

It stays where it is: one panel above the input (`Chat.tsx:582`). It collapses to its header line, the Done group is collapsed by default, and a group with nothing in it is not drawn.

Running, with finished agents folded away:

```
v AGENTS 2 running, 1 waiting for you, 5 done
  ┌──────────────────────────────────────────────────────────┐
  │ v Active (3)                                             │
  │   reviewer [Needs you] waiting for you        12s  [■]  │
  │   explore  [Running]   reading files  1.5k tok 40s  [■]  │
  │   writer   [Blocked]   waiting for a free slot      [■]  │
  │ > Done (5)                                 Archive all   │
  └──────────────────────────────────────────────────────────┘
```

After everything ended, the panel is two lines (three with the archive group):

```
v AGENTS 0 running, 5 done
  │ > Done (5)                                 Archive all   │
  │ > Archived (12)                                          │
```

An agent opened from its row:

```
v AGENTS 1 running
  ┌──────────────────────────────────────────────────────────┐
  │ ← Back to Session  explore [Done]                        │
  │ [■ Stop]* [Resume]* [Archive] [Delete]* [Show in conv.]  │
  │ ┌ Record of explore ────────────────────── (scrolls) ──┐ │
  │ │ explore  find foo  Done  Haiku  1.5k tokens          │ │
  │ │ > Prompt                                             │ │
  │ │ ✓ read_file src/a.ts                                 │ │
  │ │ v Answer                                             │ │
  │ │   ...                                                │ │
  │ └──────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────┘
  * aria-disabled, with the reason as its description; pressing it shows and reads the reason
```

**Row.** A row is one line and does not wrap. It shows the name (truncated, with the full name in a title), a state chip, the activity in a fixed phrase, tokens, elapsed time and cost when known. Then comes one icon for the row's quick action: Stop when the run is live, Archive when it has ended, Restore when it is archived.

**Order.**

- Active: waiting for you, then running, then queued. Within each, oldest first.
- Done and Archived: newest end first.

**Auto-archive.** This slice does not auto-archive; Done is simply collapsed. **OD-1**: auto-archive Done rows after N (proposal: keep the newest 10 in Done; or, as in Claude Code VS Code, by age). A Claude Code style "remove a successful row immediately" behaviour is the alternative. Collapsed-by-default already gets most of the space back.

**Keyboard and accessibility.**

| Requirement                            | How it is met                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every control is reachable             | Every control is a native button, so Tab and Shift+Tab reach it.                                                                                                                                                                     |
| Group state is exposed                 | Group toggles carry `aria-expanded` and `aria-controls`, and each group's list is labelled.                                                                                                                                          |
| Rows say what they are                 | A row's open button is named "Open explore, Running, reading files". Icon buttons are named "Stop explore", "Archive explore" and "Restore explore".                                                                                 |
| The detail view is a landmark          | The detail view is a `section` labelled by the agent's name. The toolbar has `role="toolbar"` and the label "Actions for explore". The record is a focusable `role="region"` ("Record of explore"), so it scrolls from the keyboard. |
| Focus is never lost                    | Opening an agent moves focus to Back. Back or Escape returns focus to the row that was opened.                                                                                                                                       |
| Unavailable actions explain themselves | Resume, Delete and a Stop that cannot reach the run are `aria-disabled`, not `disabled`, so they stay focusable. The reason is in `aria-describedby` and the title. Pressing one shows the reason and announces it.                  |
| Actions are announced                  | Stop, archive and restore are announced politely through the shared live region (`components/a11y/announcer.ts`).                                                                                                                    |

Arrow-key roving in the list (as in Claude Code) is a follow-up.

**OD-2**: whether the panel moves out of the input stack into its own tab or view. A second webview view in VS Code, a tool window tab in JetBrains, or a route in the GUI (`/agents`) would free the input area completely. That is a bigger change and it touches both extensions. The compact panel is the low-risk first step.

## 6. Persistence and cleanup

What is stored, and where:

- **Subagent records.** These are unchanged: they stay on the parent tool call and in the saved session (`core/index.d.ts:1374`).
- **Archived rows.** These are new and are stored outside the session, in `ui.archivedAgents` (`gui/src/redux/slices/uiSlice.ts`). The key is `${rootId}|${agentId}` and the value is when it was archived. The store is persisted with the other UI settings (`gui/src/redux/store.ts` `saveSubsetFilters`) and capped at 500 entries, dropping the oldest. Archiving changes nothing in the session file and nothing the model reads. The prompt bytes are unchanged, and a test covers it: history is untouched after Archive and Delete.

What each action means:

- **Archive** hides an ended row. Restore brings it back from the Archived group, so this slice needs no timed undo window. Only an ended agent can be archived.
- **Delete** is disabled, with a reason. A subagent's record is part of the parent conversation: the model read its result as the tool call's output. Removing it would rewrite history that the next request sends. Deleting the session deletes it. **OD-4**: if a real delete is wanted, two options exist:
  - "forget the record": drop the card's prompt, tool summaries and answer, but keep the tool output the model saw.
  - "delete with the session" only.

  Either one needs a confirmation and an undo toast with a 10-second window.

- **Stop** is available only when the run is live in this window (`isSubagentRunLive` or `isLoopWorkerLive`). It uses the same functions as the card and the loop inbox.
- **Resume** is disabled, with a reason, until V4 and V7.

## 7. Limits

- **Many agents.** Rows are one line each. The forty ended agents fold into "Done (40)", which a test checks. The Archived group is drawn only when it has entries. Past roughly 50 active rows the list should virtualise; there is no virtualised list in the GUI today, so that is a follow-up.
- **Long records.** The record view is capped at 50vh and scrolls. In read-only mode the card's own tool-list height cap (`max-h-40`) is lifted, because the region scrolls instead.
- **Memory.** The selector is memoised on `session.history` and `session.loop`, so nothing new is retained in memory. `archivedAgents` is capped at 500 entries.
- **Live updates.** A running subagent's record updates live: the card reads redux, and `updateSubagentRun` patches it. The elapsed time on rows refreshes when the history changes (`snapshot.generatedAt`), as before.

## 8. Interaction with the loop strip, the tray and the plan tree

- The loop's own controls stay in the loop strip: its status line, Stop and Stop now (#697), and the gear dialog (#701). The agents panel does not duplicate them.
- A Loop worker row has Stop (`stopLoopWorker`) and "Show in plan" (`jumpToPlan`). It has no record, and says so: worker conversations are not kept (V7).
- Questions and approvals stay in the "Needs you" tray (#700) and on the subagent card. The panel only points at them.
- **OD-5**: when a loop is running, show the wave as one group header with counts from Loop state, as O18 proposes, instead of one row per worker. The other option is to hide worker rows from the agents panel entirely, because the plan tree already shows per-item state.
- The plan tree (`PlanTree.tsx`) and the agents panel both show item progress. A later slice should link them: a worker row opens its plan item, and a plan item with a running worker shows the same state chip. This is part of O18.
- U9 and U15 wording should be settled when O18 lands. The card says "Cancelled" where the panel says "Stopped".

## 9. CLI parity

The TUI has `/jobs` for shell jobs (`JobsSelector.tsx`), with a list, a detail view, cancel, and `b` or Escape to go back. The same shape would serve subagents:

- `/agents` in the TUI, or `/tasks` to match Claude Code.
- It reads the in-process `agentRegistry` (`extensions/cli/src/agents/feed.ts`), not the `GET /agents` endpoint.
- It has the same groups (Active, Done) and the same allow-list on rows.
- Enter opens a detail view with the subagent's record as `executor.ts` keeps it, and `x` stops.

**OD-6**: the name of the command, `/agents` or `/tasks`. `/tasks` would collide with the task-list or plan vocabulary used by `TaskListPanel`.

## 10. VS Code and JetBrains

Both extensions render the same webview, so the panel is identical in each.

| Area                          | Difference to watch                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Escape                        | In JetBrains (JCEF), Escape in a tool window can move focus to the editor before the webview sees it. The view stops propagation, but whether JetBrains' handler runs first must be verified in a real IDE. Back is always available as a button. |
| Scrolling into the transcript | "Show in conversation" uses `scrollIntoView` inside the webview. It works the same in both IDEs.                                                                                                                                                  |
| A separate view (OD-2)        | VS Code would add a second webview view. JetBrains would add a tool window tab. The two take different amounts of work.                                                                                                                           |

## 11. What the first slice builds

The PR that adds this note builds:

- `gui/src/components/BackgroundMode/agentsPanelModel.ts`: grouping, ordering and per-agent action availability, all pure. Each action that does not exist carries its reason.
- `AgentsList.tsx`: the groups (Active, Done collapsed, Archived collapsed and only when non-empty), one-line rows with a quick action, and the record view with Back and Escape, focus return, a toolbar, and announcements.
- `SubagentCard.tsx`: a `readOnly` mode (no Stop, and no Allow or Reject but a link to the real card instead) with a separate test id.
- `uiSlice.ts` and `store.ts`: `archivedAgents`, with `archiveAgents` and `restoreAgents`, persisted and capped.
- Tests:
  - the grouping and order;
  - the action availability and reasons;
  - the archive cap;
  - the panel's groups and counts, archive, archive all and restore;
  - Stop on live rows only;
  - opening and going back, with focus;
  - unavailable actions explaining themselves without acting;
  - the approval link not answering;
  - a Loop worker's row;
  - 12 active and 40 done agents;
  - the allow-list on rows;
  - the card's read-only mode.

It does not change the prompt bytes, permissions or approval behaviour.

## 12. Follow-ups, in priority order

1. **OD-1, auto-archive (XS).** Keep the newest N in Done, or archive by age.
2. **Arrow-key roving and type-ahead in the list (S)**, matching Claude Code's `↑/↓`, `Enter` and `x`. Add `aria-keyshortcuts`.
3. **O18 Inbox on this panel (M).**
   - A Loop wave as a group header with counts from Loop state (OD-5).
   - Waiting rows for questions, held plans and stuck signals that jump to the existing prompt.
   - Settle the U9 and U15 wording.
4. **CLI `/agents` (or `/tasks`) in the TUI (S to M), with OD-6.** Groups, a detail view, and stop, over the in-process registry.
5. **OD-2, a separate Agents view or tool window (M), if the input stack is still too tall.**
6. **Interactive explore, phase 2 (M), with OD-3.**
   - A message queue into a running subagent's drive loop.
   - Answering its approval from the record, if the owner wants a second approval path.
7. **Resume and full transcripts (L), after V4 and V7 (O15).**
   - Retain the subagent's conversation by reference.
   - Resume a stopped or interrupted run.
   - Show the full conversation in the record view.
8. **OD-4, a real Delete (S once decided)**, with a confirmation and a 10-second undo.
9. **Virtualise the list past about 50 rows (S).** Measure first.
10. **Nested subagents in the IDE (M):** a breadcrumb for Back, and parent ids from `runSubagent` (O12 identity).

## Owner decisions

| Id   | Question                                                                        | Proposal                                                                                                     |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| OD-1 | Auto-archive Done rows: when?                                                   | Keep the newest 10 in Done and archive older ones on session load. Never archive a failed run automatically. |
| OD-2 | A separate Agents view or tool window instead of the panel above the input?     | Not yet. Measure after this slice.                                                                           |
| OD-3 | May a subagent's approval be answered from its record (a second approval path)? | No. Keep the link to the card (O18's rule).                                                                  |
| OD-4 | What does Delete mean for a subagent whose result the model read?               | "Delete with the session" only, for now.                                                                     |
| OD-5 | Loop workers in the agents panel: one row per worker, or one wave header?       | A wave header with counts, with rows on expand.                                                              |
| OD-6 | The CLI command's name: `/agents` or `/tasks`?                                  | `/agents`. `/tasks` clashes with the plan's task list.                                                       |
