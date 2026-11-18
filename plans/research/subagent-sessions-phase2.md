# Subagent sessions, phase 2: retained transcripts, messages, resume

Date: 2026-11-13. Code read at `origin/main` 62277ea78 (merge of #813) in a fresh clone. Line numbers are at that commit. Lines in files that #816 changes (`AgentsList.tsx`, `SubagentCard.tsx`, `agentsPanelModel.ts`) are given at the head of #816 and marked so. Claude Code behaviour comes from its first-party docs, fetched on 2026-11-13; each claim carries its URL. Nothing was built or run for this note.

Phase 1 is draft PR #816 and its note, `plans/research/subagent-sessions-panel.md`. Phase 1 groups the agents panel into Active, Done and Archived and opens a read-only record of an agent. The owner wants more: click into a subagent, see what it is doing, talk to it, and switch back to the parent. This note designs that.

Owner decisions are marked **PD** (phase 2 decision), so they do not clash with #816's OD numbers.

## Summary

- **Retained transcripts do not have to wait for V4.** A subagent's conversation can go in a sidecar file of its own: one JSON line per item, next to the parent session's file. The parent file keeps its format. This is the subagent half of V7 ("transcripts by reference"). It needs neither V4 (the parent's append-only log) nor N0 (the CLI loop worker). Loop workers stay on V7 proper.
- **The drive loop already takes a conversation as input.** `driveSubagent` gets `local: LocalSession` ("newLocalSession for a fresh one", `gui/src/util/subagents/runSubagent.ts:233-234`). Resume is mostly a matter of building that object from the sidecar. The new work is deciding where the resumed run's answer goes.
- **The message channel copies steering, which already exists twice.** The GUI puts steered messages after the tool results (`gui/src/redux/thunks/streamResponseAfterToolCall.ts:96-111`). The CLI has an `onToolBoundary` callback (`extensions/cli/src/stream/steering.ts:22-45`). A per-run queue drained at the same boundary in `driveSubagent` gives the same behaviour inside a subagent.
- **The full transcript view needs a history source, not a new renderer.** `Chat.tsx`'s `renderChatHistoryItem` (`gui/src/pages/gui/Chat.tsx:411-536`) and its children read `state.session.history` directly. A React context that supplies the history and a `readOnly` flag lets the same components render a subagent's conversation.
- **Approval from the record (#816 OD-3):** recommend **yes, but only in the full transcript view**, where the person sees the context, and never from a list row or a peek. This matches Claude Code: a reply from peek does not answer a dialog, and attaching does.
- **ROADMAP conflict:** O15 says "pause, resume and steer stay out" (`plans/ROADMAP.md:743`). Phase 2 brings resume and steer in. Changing that scope is an owner decision (PD-1). This note does not edit the ROADMAP.

## 1. Where things stand (file:line)

| Fact                                            | Where                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The run's conversation is a closure variable    | `runSubagent.ts:690` `let local = newLocalSession(args.prompt)`; replaced by `outcome.local` at `:798`, read once by `finish` (`:692-711`), then dropped                                                                                                                                                               |
| The drive loop takes and returns a conversation | `SubagentDriveInput.local` (`runSubagent.ts:233-234`), `SubagentDriveResult.local` (`:267-268`)                                                                                                                                                                                                                        |
| The drive loop's structure                      | `driveSubagent` `for (let turn = 1; ; turn++)` (`runSubagent.ts:350-437`): request (`:356-410`), "no calls means done" (`:413-414`), calls (`:415-425`), tool messages (`:429-435`)                                                                                                                                    |
| What is saved with the parent                   | `SubagentRunState` on the parent's tool call (`core/index.d.ts:1374`, `:1381-1409`): prompt, call names with a masked summary, text, usage. "Never the subagent's tool output" (`:1378-1379`)                                                                                                                          |
| What the parent model reads                     | `subagentResultItem(run)` (`gui/src/util/subagents/interrupt.ts:10-23`), set as the tool output at `runSubagent.ts:817`                                                                                                                                                                                                |
| Live-only handles                               | `runs` and `approvals` maps (`gui/src/util/subagents/registry.ts:13-14`); Stop (`:52-57`); approvals (`:67-93`)                                                                                                                                                                                                        |
| A reload interrupts                             | `interruptSubagentRuns` (`interrupt.ts:31-51`)                                                                                                                                                                                                                                                                         |
| Concurrency and the prefix gate                 | `MAX_CONCURRENT_SUBAGENTS = 3` (`core/subagents/scheduling.ts:7`); the gate on turn 1 only (`runSubagent.ts:369-375`); prefix key = model, system prompt, tool names (`:114-124`)                                                                                                                                      |
| Cache lifetime of a subagent                    | A fresh cache state, so "auto" starts at 5 minutes (`runSubagent.ts:603-608`, `:632-641`)                                                                                                                                                                                                                              |
| Main chat steering (GUI)                        | `queuedMessages` with a `steer` flag (`gui/src/redux/slices/sessionSlice.ts:299`, reducers `:689-724`); drained after tool results (`streamResponseAfterToolCall.ts:96-111`)                                                                                                                                           |
| CLI subagent                                    | `executeSubAgent` runs one at a time (`extensions/cli/src/subagent/executor.ts:112`, `:159-198`). It swaps the shared services (`:374-391`). History is a local array (`:393-401`). Esc aborts it (`:403-406`). `persistSession: false` (`:450`). A SubagentStop hook pushes a user message between turns (`:457-481`) |
| CLI steering                                    | `MessageQueue` steering (`extensions/cli/src/stream/messageQueue.ts:18-22`, `:281`); `onToolBoundary` (`streamChatResponse.types.ts:50`, `steering.ts:22-45`)                                                                                                                                                          |
| CLI agent map                                   | `agentRegistry`, in-process, capped at 500 nodes, never persisted (`core/agents/registry.ts:5-46`); fed by `extensions/cli/src/agents/feed.ts:15-41`                                                                                                                                                                   |
| `cn serve` agents                               | `GET /agents`, an allow-list projection (`extensions/cli/src/commands/serve.agents.ts:16-47`); `POST /message` with `steer` (`serve.messages.ts:211-272`); `POST /pause` (`:275-300`)                                                                                                                                  |
| Session storage                                 | One `<id>.json` per session (`core/util/paths.ts:274-276`) in a 0700 folder (`:250-256`), written atomically with mode 0600 under a lock (`core/util/history.ts:27-29`, `:148-183`); `delete` unlinks the one file (`:307-318`); the list is rebuilt from `*.json` (`:210-224`)                                        |
| Renderers coupled to the main session           | `Chat.tsx:151` (`state.session.history`), `StepContainer.tsx:34-36` (the next item), `ResponseActions.tsx:58-62`, `ToolTruncateHistoryIcon.tsx:16`, `ToolCallDiv` by `historyIndex`                                                                                                                                    |
| Roadmap                                         | O15 (`plans/ROADMAP.md:743`), O18 (`:746`), V4 (`:1231`), V7 (`:1234`), V11 (`:1241`), V13 (`:1243`), D18 (`:416`)                                                                                                                                                                                                     |

What V4 and V7 actually say:

- **V4:** "Append-only session log with an offset index, large bodies as files, a loader for the old format, migration on first open." Its done-when is "a save writes one item; a 20k-item session opens in constant time; old sessions still open" (`plans/memory-and-history.md:84`).
  - The research defers it (L): it changes the format that `/import`, `/resume`, ACP `session/list` and `secrets scan --history` read (`plans/research/area-budgets-stuck-memory.md:214-218`).
- **V7:** "Loop and workers: transcripts by reference, a retained-transcript budget, worker output spilled to files." Its done-when is "a 2-hour loop run in the harness holds a flat memory profile" (`memory-and-history.md:87`).
  - The design rule behind it: "Subagent and loop-item transcripts are stored by reference, not inside the parent's history" (`memory-and-history.md:72`).
  - Loop mode gets "a budget of its own for retained transcripts" (`:74`).
  - V7 depends on V4 and N0. N0 is the CLI loop worker (`ROADMAP.md:701`).

**Why the subagent part can go ahead.** V7's dependency on V4 is about the _parent's_ format: a reference has to point into something. A sidecar file per run makes that reference a file name, so the parent's format does not change. The dependency on N0 concerns Loop workers only.

## 2. Peer reference: Claude Code

| Behaviour             | Claude Code (docs)                                                                                                                                                                                                                                                                                                                                                                                           | URL                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Transcript storage    | One file per subagent, `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`, plus `agent-{agentId}.meta.json`. Main-conversation compaction does not touch them. They are deleted after `cleanupPeriodDays` (30 by default).                                                                                                                                                           | https://code.claude.com/docs/en/sub-agents                                   |
| Resume                | "Resumed subagents retain their full conversation history, including all previous tool calls, results, and reasoning." The parent resumes one with `SendMessage` (`to` = agent ID or name). A completed subagent "resumes in the background without a new `Agent` invocation". Resume works after a restart by resuming the session.                                                                         | https://code.claude.com/docs/en/sub-agents                                   |
| Stopped by the person | It does not auto-resume. A `SendMessage` to it is refused, and Claude is told the agent was cancelled. While its row is still in the panel, the person can type into its transcript to resume it.                                                                                                                                                                                                            | https://code.claude.com/docs/en/sub-agents                                   |
| Open and talk         | In the panel below the prompt, `Enter` opens the transcript and sends it follow-up messages, and `Esc` returns focus to the prompt. With a transcript open, follow-ups go to that agent. `/compact`, `/clear` and `/rewind` act on the main conversation and ask for confirmation. `/model` does not run there.                                                                                              | https://code.claude.com/docs/en/sub-agents (Observe and steer running forks) |
| Interrupt semantics   | `Ctrl+Enter` makes the viewed agent read the message before the work it is waiting on finishes. A backgroundable shell or subagent moves to the background. While the agent is writing a response, it keeps going and reads the message after that.                                                                                                                                                          | https://code.claude.com/docs/en/sub-agents                                   |
| Background approvals  | A background subagent's permission prompts appear in the main session, naming the subagent. Esc denies that one call without stopping the agent. A session-long grant applies to the whole session. "No message from any agent counts as your approval."                                                                                                                                                     | https://code.claude.com/docs/en/sub-agents                                   |
| Agent view (sessions) | Peek (`Space`) shows recent output or the pending question, and a reply typed there is queued. A reply does not answer a permission dialog: "To answer the dialog, attach with `→`". `Enter` or `→` attaches, `←` detaches, and detaching never stops the session. An idle, unattached session's process stops after about an hour, its conversation stays on disk, and it resumes when you attach or reply. | https://code.claude.com/docs/en/agent-view                                   |
| Background tasks      | `Ctrl+B` backgrounds Bash commands and agents. `/tasks` lists shells and subagents. `Ctrl+X Ctrl+K` stops all background subagents. `/btw` answers from the open subagent transcript.                                                                                                                                                                                                                        | https://code.claude.com/docs/en/interactive-mode                             |

What to take, and what not:

- **Take:**
  - per-run transcript files in a directory named after the session;
  - resume with full history;
  - "a stopped agent is not resumed by the model, only by the person";
  - typing into an open transcript goes to that agent;
  - peek can queue but cannot approve, while attach can approve;
  - the main conversation's commands stay with the main conversation.
- **Do not take (yet):**
  - background subagents that outlive the parent's turn (a supervisor process);
  - model-initiated forks;
  - per-subagent auto-compaction. Our runs are capped at 30 model calls (`core/subagents/definitions.ts:40`). Resume makes this matter later (risk R5).

## 3. Architecture

```
            parent session (unchanged format)                     sidecar (new)
 sessions/<sessionId>.json                            sessions/<sessionId>.agents/
   history[i].toolCallStates[j].subagent  ──ref──►      <runId>.jsonl     one line per item
     { ..., transcript: { runId, items, bytes } }       <runId>.meta.json model, prefix hash, status
                                                        <runId>.blobs/    bodies > 64 KB

  GUI webview                          extension host (core)
  ┌──────────────────────────┐  msg   ┌────────────────────────────┐
  │ driveSubagent            │ ─────► │ subagentTranscript/append  │──► append + fsync line
  │  local (LocalSession)    │        │ subagentTranscript/load    │◄── read lines, blobs lazily
  │  inbox (per run queue) ◄─┼── UI   │ subagentTranscript/delete  │
  │  onItemCommitted ────────┼──►     └────────────────────────────┘
  └──────────────────────────┘
        ▲            │
        │ send/stop  │ live items (redux: subagentLive[runId], capped)
  ┌─────┴────────────▼─────────────────────────────────────────────┐
  │ AgentsList (#816) ─open─► SubagentSessionView                  │
  │   header + toolbar (Stop, Resume, Back)                        │
  │   TranscriptHistoryProvider { history, readOnly } ─► Chat item │
  │   renderers (StepContainer, ToolCallDiv, ThinkingBlockPeek)    │
  │   input box ─► sendToSubagent(runId, text, {steer})            │
  └────────────────────────────────────────────────────────────────┘
```

Four new pieces, each small on its own:

1. **Transcript store** (core): append, load and delete per run, using the session folder's rules.
2. **Inbox** (GUI registry, CLI executor): a per-run message queue that the drive loop drains at the tool boundary and before it would finish.
3. **Resume entry** (`resumeSubagentRun`): rebuild `LocalSession` from the store, check the prefix, drive again, and deliver the answer to the parent.
4. **History source** (GUI): a context that lets the main chat renderers draw any history read-only.

## 4. Data model

### 4.1 Persisting a subagent's conversation by reference

**Location.**

- The store is `sessions/<sessionId>.agents/<runId>.jsonl`. It is a folder next to the session file, and the folder name does not end in `.json`.
- `rebuildSessionsList` only takes `*.json` files (`history.ts:210-224`), so the list never sees it.
- The sessions folder is already created 0700 (`paths.ts:250-256`). Files are written 0600, as `writeAtomic` does (`history.ts:27-29`).
- `runId` is the parent's tool call id in the GUI, which is already the run's key (`registry.ts:41-49`, `approvalScope`). In the CLI it is the `agent-<uuid>` from `executor.ts:165`.
- The name is a hash-safe file name. The caller does not supply a path: core builds it from ids it validates against `[A-Za-z0-9_-]`.

**Format: JSON lines.** This follows the D1 recommendation in `memory-and-history.md`, so the sidecar becomes V4's first user and V4 can adopt the same writer.

```jsonc
// line 1: header
{ "v": 1, "kind": "header", "runId": "call_abc", "sessionId": "...", "parentToolCallId": "call_abc",
  "agent": "explore", "model": "Haiku", "prefix": "sha256:<model|system|tool names>", "startedAt": 1731500000000 }
// one line per committed history item; the item is ChatHistoryItem minus editorState
{ "kind": "item", "seq": 0, "item": { "message": { "role": "user", "content": "find foo" }, "contextItems": [] } }
{ "kind": "item", "seq": 1, "item": { "message": { "role": "assistant", ... }, "toolCallStates": [ ... ] } }
// a context item body over 64 KB is replaced by a reference
{ "kind": "item", "seq": 2, "item": { ..., "contextItems": [ { "name": "...", "content": { "$blob": "2-0.txt", "bytes": 812345, "head": "...", "tail": "..." } } ] } }
// events that are not history
{ "kind": "event", "at": 1731500005000, "event": "message-from-person", "seq": 7 }
{ "kind": "event", "at": 1731500009000, "event": "ended", "status": "cancelled", "error": "Stopped by the user" }
{ "kind": "event", "at": 1731500100000, "event": "resumed", "fromSeq": 9 }
```

**When a line is written.** Lines are written on commit, not while text streams:

- after the request of a turn ends (`runSubagent.ts:411`);
- after each tool call settles (`succeed` and `fail`, `:455-473`);
- when a queued message is added.

The stream itself stays in memory, as today. A crash loses at most the turn in flight, and that turn is what `interruptSubagentRuns` already reports as interrupted.

**The reference on the parent.** `SubagentRunState` gains one optional field:

```ts
transcript?: {
  runId: string;     // file stem
  items: number;     // committed lines (for "N items" and resume checks)
  bytes: number;     // on disk, blobs included
  truncated?: "budget" | "cap"; // the store stopped writing; resume is off
};
```

- `SubagentRunState` stays free of tool output. That property is asserted today (`core/index.d.ts:1378-1379`), and the projection allow-list still holds: `fromRuns.ts` reads names, states and numbers, and `items` and `bytes` are numbers.
- **The prompt bytes do not change.** The parent model reads `subagentResultItem(run)`, which does not include `transcript`. Add a test that the parent's next request is byte-identical with retention on and off.

**Size limits.** These are starting values, to be tuned in V0.

| Limit                          | Value                                                  | What happens at it                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| One context item body inline   | 64 KB                                                  | Spilled to `<runId>.blobs/<seq>-<n>.txt`, with head and tail (2 KB each) kept inline, as the terminal ring buffer in `memory-and-history.md` proposes |
| One transcript                 | 32 MB (`history.subagentTranscriptMb`)                 | Writing stops, `truncated: "cap"` is set, the view says so, and Resume is disabled with that reason                                                   |
| Retained per session           | 256 MB or 200 runs (V7's retained-transcript budget)   | The oldest _ended_ runs lose their sidecar (lines and blobs) first, and their record falls back to today's card. A live run is never evicted          |
| In memory while a view is open | the last 200 items hot (D2 in `memory-and-history.md`) | Earlier items load on "Load earlier"; blobs load on expand                                                                                            |

**Lifecycle.**

| Event                                                        | What happens to the sidecar                                                                         |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `HistoryManager.delete`                                      | Also removes `<id>.agents/` (`history.ts:307-318`; today it unlinks one file)                       |
| `clearAll`                                                   | Already removes the whole folder (`history.ts:320-322`)                                             |
| V11 `history.retentionDays`, `sessions prune`                | Same age rule, same folder                                                                          |
| `secrets scan --history`                                     | Must walk `*.agents/` too. Today it reads session JSON only (`area-budgets-stuck-memory.md:218`)    |
| `/export`, `history/share`                                   | Off by default. An "include subagent transcripts" option scrubs with `scrubDeep` as V13 proposes    |
| Rewind or edit of the parent before the subagent's tool call | The sidecar is orphaned. A sweep on session load deletes `*.jsonl` whose `runId` is in no tool call |
| Retention off (`history.subagentTranscripts: false`)         | Nothing is written, and today's behaviour is unchanged                                              |

**Raw or scrubbed.**

- The session file is unscrubbed so that it can round-trip (V11, `ROADMAP.md:1241`). The sidecar must also be raw, for the same reason: resume sends it back to the model. Scrubbing on write would change what the model reads.
- Display masking stays: the view runs `maskCommandForDisplay` on what it shows, as the card does.
- This is a privacy change (risk R1) and an owner decision (PD-2).

### 4.2 Message channel into a running run

**GUI registry** (`gui/src/util/subagents/registry.ts`). Add a third live map, next to `runs` and `approvals`:

```ts
interface InboxMessage {
  id: string;
  text: string;
  steer: boolean;
  at: number;
  from: "person" | "parent-model";
}
const inboxes = new Map<string, InboxMessage[]>(); // runId -> queue
export function sendToSubagent(
  runId: string,
  text: string,
  opts: { steer: boolean; from: InboxMessage["from"] },
): "queued" | "not-live";
export function takeInbox(
  runId: string,
  which: "steer" | "all",
): InboxMessage[];
export function inboxLength(runId: string): number; // for the view's "2 queued" chip
```

**Drive loop changes.** In `driveSubagent` (`runSubagent.ts:350-437`):

1. **Tool boundary.** After the tool messages are appended (`:429-435`) and before the next turn's `constructMessages` (`:356`), drain `takeInbox(runId, "steer")`. Merge the messages with the same `mergeQueuedMessages` the GUI uses and append one user message. The order is then assistant(tool_calls), tool..., user, which `steering.ts:8-20` documents as valid for both OpenAI-style APIs and Anthropic/Bedrock.
2. **Would finish.** At "no calls means done" (`:413-414`), if `inboxLength(runId) > 0`, drain _all_ (steered or not), append them as a user message and `continue` the loop instead of returning. This is the same shape as the CLI's SubagentStop continuation (`executor.ts:457-481`), and it counts against `maxTurns`.
3. **Framing.** The subagent's system prompt tells it that the parent "sees only your final message" and that it "cannot ask the person questions" (`runSubagent.ts:132-133`). A message from the person is therefore wrapped as `<message from="person">…</message>`, and the system prompt gains one sentence: "The person may send you messages; follow them as you would the task." The tag is escaped in subagent _output_ by `neutralizeHarnessTags` (`extensions/cli/src/subagent/transcript.ts:46-56`, and `core/subagents/result.ts:78`), so the subagent cannot forge one.
   - **Cache effect.** That sentence changes the system prompt, and therefore the prefix key (`runSubagent.ts:114-124`), once for every run. Add it unconditionally, so siblings still share a prefix. Do not add it only when a message arrives.

**Interrupt semantics.** Three levels, matching what exists for the main chat:

| Action           | Effect on the run                                                                                                                                                                                                                                                                    | Existing analogue                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Send (queue)     | Delivered when the run would otherwise finish, or at the next boundary if the person later presses Send now                                                                                                                                                                          | GUI `queuedMessages` without `steer`                                        |
| Send now (steer) | Delivered at the next tool boundary. If the model is streaming a reply with no tool calls, it lands at "would finish" (step 2), so the run does not end with the message unread                                                                                                      | `steer: true` (`streamResponseAfterToolCall.ts:96-111`), CLI `requestSteer` |
| Interrupt        | Abort the current request or tool call _without ending the run_: a per-turn `AbortController` child of the run controller. The partial assistant text is kept, a call in flight is cancelled (`cancelToolCall`, as at `:570-580`), and the inbox is drained as the next user message | Claude Code's `Ctrl+Enter` (section 2); our Stop ends the run instead       |
| Stop             | Unchanged: ends the run (`registry.ts:52-57`)                                                                                                                                                                                                                                        | Card Stop                                                                   |

**Interrupt is new plumbing.** Today one controller serves both the stream and the system-tool framework (`runSubagent.ts:231-232`, `:384`). A per-turn controller is a contained change inside `driveSubagent`. Interrupt is a separate slice (P2c) because it is the riskiest of the four.

**Approval pending.** A message sent while the run waits on `waitForSubagentApproval` (`registry.ts:67-82`) is queued. It does not answer the approval, as in Claude Code's peek (section 2).

**Loop workers.** `runLoopItemSubagent.ts` drives through the same `driveSubagent`, so it gets the inbox for free. Whether a person may message a worker is PD-6. The loop already routes answers to an item as a steered message (`gui/src/redux/thunks/loop.ts:558-583`).

**CLI** (`executor.ts`).

- Give the subagent's `StreamCallbacks` (`:409-436`) an `onToolBoundary` that drains a per-agent queue keyed by `agentId`. `injectSteeringMessage` already falls back to the local array when `chatHistory.isReady()` is false (`steering.ts:34-44`), and the executor forces that (`:389-391`).
- **Verify first.** `injectSteeringMessage` returns a _new_ array (`steering.ts:43`). Check that `streamChatResponse` writes it back into the executor's `chatHistory` (`executor.ts:393`); otherwise the transcript misses the message. This was not confirmed by reading.
- Use the same "would finish" continuation as the SubagentStop loop (`:457-481`).
- **In the TUI, the parent is blocked during a subagent.** Runs are serial and synchronous to the parent's tool call (`:112`, `:159-198`), so "switch back to the parent" means _viewing_ the parent. The parent cannot run meanwhile. Text typed while a subagent's view is open goes to that subagent's queue. Text typed on the main view goes to the parent's `messageQueue` as today.

### 4.3 Resume of a stopped or interrupted run

**Entry point.** `resumeSubagentRun(runId, { by: "person" | "parent-model", message? })` in `runSubagent.ts`, next to `runSubagentTool`:

1. Load the sidecar through core and rebuild `LocalSession` (`newLocalSession` shape, `runSubagent.ts:215-225`). Repair the tail:
   - an assistant message whose tool calls have no results gets them as `cancelled` (the same rule as `interruptSubagentRuns`, `interrupt.ts:40-49`);
   - a trailing assistant message with tool calls gets the empty tool messages (`runSubagent.ts:429-435`), so the next request is well-formed.
2. Check the prefix against the header's `prefix` hash (model, system prompt, tool names; `prefixKey` at `:114-124`). If it differs (the definition was edited, the tools changed with the mode, or the model is gone):
   - **refuse** when a tool that appears in the history is no longer available, because the model would reissue calls it cannot make;
   - **warn** when the model or system prompt changed. Resume is allowed, and the view says the cached prefix is lost (risk R3).
3. Append the person's message, or the parent model's message, as a user message. A resume with no message is refused: Claude Code also only resumes on a message (section 2).
4. Register a fresh controller (`registerSubagentRun`), take slots (`acquireSubagentSlots`, `:278-307`), and call `driveSubagent` with the rebuilt `local` and `maxTurns` = the definition's limit counted from the resume, not from the start.
5. Write `resumed` and then `ended` events to the sidecar, and patch `SubagentRunState` (`status` back to `running`, then the new terminal status).

**Where the answer goes.** This is the real design question. The parent's tool call already has an output that the model read.

| Who resumed                                                                        | Delivery                                                                                                                                                                                                                                                                                                                             | Rationale                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent model, via a new `message_subagent` tool (`{ to: runId \| name, message }`) | That tool call's output is the resumed run's `subagentResultItem`, exactly like a fresh run. The original tool call is untouched.                                                                                                                                                                                                    | Same as Claude Code's `SendMessage`. History stays append-only, and the parent's cached prefix survives                                      |
| The person, from the view                                                          | A **report item** is queued for the parent as a steered context message (`<subagent_report agent=… run=…>`, neutralised), delivered at the parent's next boundary or turn. If the parent is idle, it is not auto-sent: the parent's input shows "1 report from explore", and the person sends it, or sends a message that carries it | Never rewrites the parent's earlier tool output (the #816 Delete reasoning applies), and never starts a parent turn behind the person's back |

**Rules.**

- **A run the person stopped is not resumed by the parent model.** `message_subagent` returns "the person stopped this agent", as Claude Code does (section 2).
- **An `interrupted` run (reload) may be resumed by either.**
- **A `completed` run** may be resumed by either. This is the follow-up-question case.
- **A `failed` run** may be resumed by the person only.
- **Model identity.** The `message_subagent` tool is a new tool in the parent's tool list, so it changes the parent's tools prefix (risk R3). Ship it behind the same setting as retention, and add it in the same release for every mode that has `subagent`, so the prefix changes once.

### 4.4 The full transcript view, reusing the main chat renderers

**The coupling.** Every component that renders a history item reads the live main session:

- `Chat.tsx:151` (the list);
- `StepContainer.tsx:34-36` (`state.session.history[props.index + 1]`) and its `deleteMessage(index)` (`:62`);
- `ResponseActions.tsx:58-62` (turn ids);
- `ToolTruncateHistoryIcon.tsx:16`;
- `ToolCallDiv` and its function-specific children (by `historyIndex`; `CreateFile.tsx`, `EditFile.tsx`, `FindAndReplace.tsx`, `PlanCard.tsx`, `SimpleToolCallUI.tsx` and `ToolCallDisplay.tsx` take it).

**Plan.**

1. **`HistorySourceContext`** with `{ history, readOnly, kind: "main" | "subagent", runId? }`. The default provider reads `state.session.history`, so the main chat does not change. Replace the direct `useAppSelector(state => state.session.history…)` reads in the five or so places above with `useHistorySource()`. This is a mechanical change with a test that the main chat renders byte-identical DOM for a fixture.
2. **Lift `renderChatHistoryItem`** out of `Chat.tsx:411-536` into `ChatHistoryItemView`, taking `item`, `index`, and `sendInput` (absent when read-only). In read-only mode, user messages render as static text, not `ContinueInputBox`, because edit-and-resend on a subagent's prompt would be a rewind (out of scope).
3. **Gate actions in `readOnly`**: delete message, apply and insert code blocks (allowed? decide per button: **copy yes, apply no**), accept and reject tool calls (approval is handled separately, 4.5), and checkpoints and rewind.
4. **`SubagentSessionView`** replaces #816's record pane when a transcript exists, and keeps the record when not (retention off, evicted, Loop worker):
   - Header: breadcrumb `Session › explore`, state chip, model, tokens, and "N queued".
   - Toolbar: Stop, Interrupt, Resume, "Show in conversation" and Back (#816's `AgentsList.tsx` toolbar, extended).
   - Body: the windowed list over the hot items, with "Load earlier".
   - Footer: an input (plain text and @-file mentions only; no slash commands in the first slice), with **Send** and **Send now**.
5. **Live data.** While the run is live, `driveSubagent` dispatches `subagentLiveItems({ runId, items })` into a small redux slice keyed by `runId`, holding the last 200 items and only while a view is open for that run (subscribe on open, drop on Back). When it ends, the view reads from the sidecar. A closed view costs no memory beyond today.

**Placement.**

- In the panel above the input (#816) the view is cramped: #816 caps the record at 50vh.
- The full transcript wants the chat area. Recommendation (PD-4): **open the transcript in place of the parent chat**, with the breadcrumb as the only way back, the way Claude Code's attach replaces agent view.
- The parent keeps running underneath. Its NeedsYou tray and its own approvals stay visible as a one-line banner ("Session needs you: Back"), so a parent approval is never hidden behind a subagent view.

### 4.5 Approval from the record (#816 OD-3)

**Today.** Allow and Reject exist only on the card (`SubagentCard.tsx:207-252` at main). #816's read-only record shows "Answer in the conversation" instead (`SubagentCard.tsx:243-253` at #816).

**Mechanics are safe.** `answerSubagentApproval` resolves at most once (`registry.ts:85-93`: the resolver deletes itself, and a second call returns `false`), so two buttons cannot double-answer.

**The risks are about understanding, not races.**

| Risk                                                                                 | Mitigation                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The person approves from a list row or peek with less context than the card shows    | Never offer approval on a row or in the compact record. Only the full transcript view gets it, and it shows the pending call in context (the preceding assistant message and the call's display value) |
| Two places show the same prompt and drift apart (one updated, one stale)             | One component, `SubagentApprovalBlock`, used by the card and the view, fed by the same `run.pendingApproval`. A test that answering in either clears both                                              |
| The person thinks they are answering the parent                                      | The block names the agent ("explore wants to run …"), as Claude Code names the asking subagent                                                                                                         |
| A message typed in the view is read as an approval (or a subagent's text claims one) | Messages never answer approvals (4.2), and only the buttons call `answerSubagentApproval`. This matches "no message from any agent counts as your approval" (sub-agents doc)                           |
| O18's rule, "one approval path" (`ROADMAP.md:746`)                                   | Restate it as "one approval _component_": the path is the same function and the same props. Record this in O18 when it lands                                                                           |

**Recommendation (PD-3):** yes, in the full transcript view only, through the shared component. Rows and the compact record keep #816's link.

### 4.6 CLI `/agents` over the in-process `agentRegistry`

**Shape.** It copies `/jobs`: `extensions/cli/src/commands/commands.ts:96-99` and `ui/JobsSelector.tsx`, with list, detail, cancel, and `b` or Esc to go back.

| Piece           | Design                                                                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source          | `agentRegistry.list()` (`core/agents/registry.ts:20-22`) through `projectAgents` (`core/agents/project.ts`), the same allow-list as `GET /agents`. The registry is in-process, so `/agents` needs no server                                                                                         |
| List            | Groups as in #816 (Active, Done), one line per agent, with `↑/↓`, `Enter` to open, `x` to stop, and Esc to go back                                                                                                                                                                                  |
| Stop            | Today Esc aborts the _running_ subagent (`executor.ts:403-406`). `x` needs a map from `agentId` to its `AbortController`, which `executeSubAgent` has (`options.abortController`) but does not register. Add `registerCliSubagent(agentId, controller)` next to `emitAgent`                         |
| Open (P2 slice) | With retention on, the detail view renders the sidecar through the TUI's existing message renderer, and the input routes to that agent's queue (4.2). Without retention, it shows the `SubAgentTranscript.render()` text (`transcript.ts:119-127`), which already lives on the tool call's progress |
| Switch back     | Esc or `b`. Because CLI subagents block the parent, the parent view shows the subagent's progress line, as today                                                                                                                                                                                    |
| Name            | `/agents` (#816 OD-6)                                                                                                                                                                                                                                                                               |

**Sidecar writer in the CLI.** `executor.ts` passes `persistSession: false` (`:450`) so the child does not overwrite the parent. The sidecar is a different file, so the writer appends to `<sessionId>.agents/<agentId>.jsonl` from the executor's callbacks, using the same core module as the GUI.

### 4.7 `cn serve` parity

`GET /agents` stays the allow-list (`serve.agents.ts:9-15`; its canary test is `commands/canary.test.ts`). New routes go behind the same Host, Origin and token guards (`serve.ts:212-215`).

| Route                                     | Returns or does                                                                                                          | Data class                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /agents/:id`                         | One `AgentView` plus `{ transcript: { items, bytes } \| null, queued: n }`                                               | Allow-list (numbers only). The canary test is extended                                                                                                        |
| `POST /agents/:id/message`                | `{ message, steer? }` → `{ queued, position, steered }`, the same shape as `POST /message` (`serve.messages.ts:211-272`) | Input                                                                                                                                                         |
| `POST /agents/:id/stop`                   | Stop                                                                                                                     | Control                                                                                                                                                       |
| `POST /agents/:id/resume`                 | `{ message }`, with the rules of 4.3                                                                                     | Control                                                                                                                                                       |
| `GET /agents/:id/transcript?from=&limit=` | Transcript lines (blobs as references, plus `GET …/blob/:name`)                                                          | **Full content**, the same class as `GET /state`, which already returns the whole session (`serve.agents.ts:11-12`). PD-5 decides whether to expose it at all |

`POST /permission` already answers the pending permission by `requestId` (`serve.ts:232-263`). A subagent's request in the CLI goes through the same prompts (`executor.ts:427-435`), so serve parity for approvals exists already. Add only an `agentId` field to the pending-permission snapshot, so a client can say which agent asks.

## 5. Phased plan with sizes

| #   | Slice                                                                                                                                                                                                                          | Size      | Depends on                        | Done when                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2a | **Transcript store** in core (append, load paged, delete, sweep, budget) and protocol messages; `HistoryManager.delete` removes the sidecar; GUI and CLI writers behind `history.subagentTranscripts` (default off until PD-2) | M         | #816 merged; PD-2                 | A run's sidecar round-trips to an identical `LocalSession`; the parent's request bytes are identical with retention on and off; eviction keeps live runs; 0600 checked on POSIX   |
| P2b | **Inbox**: `sendToSubagent` and `takeInbox`; drain at the boundary and at "would finish"; the system-prompt sentence; CLI `onToolBoundary` for subagents (with the array write-back verified)                                  | S-M       | none (works without P2a)          | A scripted-model test: a message sent during tool calls lands after the tool results; one sent during a final reply continues the run; `maxTurns` counts it                       |
| P2c | **Interrupt** (per-turn controller), separate from Stop                                                                                                                                                                        | S         | P2b                               | Interrupt during a stream keeps the partial text and continues with the queued message; during a tool call it cancels the call and kills a terminal process                       |
| P2d | **History source and the transcript view**: context, lifted item renderer, read-only gates, `SubagentSessionView` with input and live items                                                                                    | M         | P2a for ended runs, P2b for input | The main chat DOM is unchanged on fixtures; a live subagent renders with the main components; Back restores focus (#816 behaviour); axe has no new violations                     |
| P2e | **Resume**: `resumeSubagentRun`, tail repair, prefix check, person-resume with a report item to the parent                                                                                                                     | M         | P2a, P2d                          | A stopped run resumes with full history; a changed tool set refuses with a reason; the parent's earlier tool output is untouched; the report arrives only at a boundary or a send |
| P2f | **`message_subagent` tool** for the parent model                                                                                                                                                                               | S-M       | P2e; PD-7                         | The parent resumes a completed run by name; a person-stopped run is refused; the tool is added once for every subagent-capable mode                                               |
| P2g | **Approval in the transcript view** via the shared `SubagentApprovalBlock`                                                                                                                                                     | S         | P2d; PD-3                         | Answering in either place clears both; rows never show Allow                                                                                                                      |
| P2h | **CLI `/agents`**: list, stop by id, detail (record), and then transcript and input once P2a and P2b are in the CLI                                                                                                            | S, then M | #816's OD-6                       | The `/jobs`-style flow tests pass; the allow-list canary holds on rows                                                                                                            |
| P2i | **`cn serve` routes** of 4.7 (the transcript route only after PD-5)                                                                                                                                                            | S         | P2b, P2e                          | Route tests, with the canary extended to `GET /agents/:id`                                                                                                                        |
| P2j | **Loop workers** onto the store (V7 proper: retained budget for workers)                                                                                                                                                       | M         | P2a, N0 for CLI workers           | V7's done-when: a 2-hour loop run holds a flat memory profile                                                                                                                     |

Order: P2b first, because it is useful without retention: a person can steer a running subagent from the #816 record, through an input under the card. Then P2a, P2d, P2e, P2g, P2h and P2i. P2c and P2f come when their decisions are made. The total for the IDE is about two M-sized PRs plus three S-sized ones. The CLI and serve add about one M.

## 6. Risks

| #   | Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Mitigation                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | **Privacy: subagent tool output reaches disk for the first time.** Today it exists only in memory and is "never" saved (`core/index.d.ts:1378-1379`). Subagents read files, run commands and fetch pages, so secrets in that output now persist in a second place                                                                                                                                                                                    | The setting starts off (PD-2). Files are 0600 in the 0700 folder. The sidecar is deleted with the session and swept by V11. `secrets scan --history` covers the sidecar. Export is scrubbed by default (V13). The privacy docs gain a line. D18's "masked JSONL" never points at the sidecar                                                                 |
| R2  | **Memory.** A live `LocalSession` is already in memory, so retention adds nothing there. The transcript view adds the rendered items, and the live-items slice could duplicate them                                                                                                                                                                                                                                                                  | Live items exist only while a view is open, capped at 200. Blobs are lazy. Retention writes and frees: no growth in redux. V0's harness gets a "10 subagents × 30 turns" case                                                                                                                                                                                |
| R3  | **Prompt cache effects of resuming.** (a) A subagent's cache is 5 minutes by default (`runSubagent.ts:603-608`), so resuming after that pays a full write of the whole transcript at the cache-write price. (b) A changed definition, tool set or model breaks the prefix. (c) A new `message_subagent` tool changes the parent's tool block once. (d) A person's message in the _parent_ is appended, so the parent's prefix survives a report item | (a) The Resume button shows "resending N tokens (cache cold)" when more than 5 minutes have passed, using the same estimate the cost counter uses. (b) The prefix hash in the header is checked: refuse when a needed tool is gone, warn otherwise. (c) Ship it in one release with the setting, not per session. (d) Never rewrite the original tool output |
| R4  | **Injection through resumed history.** Tool output in the transcript was flagged once (`flagToolOutput`, `runSubagent.ts:590`). Reloaded, it must keep its flags, or a resumed run reads it as trusted                                                                                                                                                                                                                                               | Store context items as flagged (the flags are fields on the item), and a round-trip test asserts them. Report items to the parent go through `neutralizeHarnessTags`                                                                                                                                                                                         |
| R5  | **Turn limit and context growth.** Resume and messages let a run go far past 30 calls of context, and subagents have no compaction                                                                                                                                                                                                                                                                                                                   | `maxTurns` counts per resume. The view shows context use. Subagent compaction (Claude Code has it, section 2) is a later item and is not built here                                                                                                                                                                                                          |
| R6  | **Approval confusion** (4.5)                                                                                                                                                                                                                                                                                                                                                                                                                         | Approval only in the full view, through a shared component, naming the agent                                                                                                                                                                                                                                                                                 |
| R7  | **Concurrency.** A resumed run takes one of three slots (`scheduling.ts:7`) and may queue behind fresh runs. On a one-slot local server it also evicts the parent's cache                                                                                                                                                                                                                                                                            | A queued resume shows "waiting for a free slot" (#816 row phrase). Resume uses `subagentServerSlots`, as runs do                                                                                                                                                                                                                                             |
| R8  | **CLI services swap.** A resumed CLI subagent runs inside the parent's next tool call or turn, swapping the shared services (`executor.ts:374-391`). Resuming from `/agents` while the parent is idle has no tool call to run in                                                                                                                                                                                                                     | In the CLI, person-resume runs as a synthetic turn of the parent (the `message_subagent` tool path), never on its own. Ship the CLI after the IDE                                                                                                                                                                                                            |
| R9  | **Orphans and drift** after a parent rewind or edit                                                                                                                                                                                                                                                                                                                                                                                                  | A sweep on load deletes sidecars that no tool call references                                                                                                                                                                                                                                                                                                |
| R10 | **Webview disposal.** A run lives in the webview, so closing the panel kills it, as today, and it becomes `interrupted` on reload                                                                                                                                                                                                                                                                                                                    | Resume after a reload is exactly what P2e enables. Running subagents outside the webview (`parallel-agents.md` question 1) stays out of scope                                                                                                                                                                                                                |

## 7. Owner decisions

| Id   | Question                                                                                      | Recommendation                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PD-1 | O15 says "pause, resume and steer stay out". Bring resume and steer for subagents into scope? | Yes for subagents (P2a to P2i). Loop workers stay with V7 and N0. Update O15's row when the first slice lands (not in this PR)                                                                                        |
| PD-2 | Retain subagent transcripts on disk, raw, next to the session (R1)?                           | Yes, as an opt-in setting `history.subagentTranscripts` (default off) for one release, then default on with the 256 MB and 30-day budget. Raw, because resume must round-trip; masked for display; scrubbed on export |
| PD-3 | #816 OD-3: approve from the record?                                                           | Yes in the full transcript view only, through one shared component. No on rows and in the compact record                                                                                                              |
| PD-4 | Where the full transcript opens                                                               | In place of the parent chat, with a breadcrumb and a parent "needs you" banner. #816's compact record stays for quick looks (peek)                                                                                    |
| PD-5 | Expose transcripts over `cn serve` (`GET /agents/:id/transcript`)?                            | Yes, under the existing guards, because `GET /state` already returns the whole session. Keep `GET /agents` and `/agents/:id` on the allow-list                                                                        |
| PD-6 | May the person message a Loop worker?                                                         | Not in phase 2. The loop's own steer route (`loop.ts:558-583`) is the path. Revisit with O18                                                                                                                          |
| PD-7 | Give the parent model a `message_subagent` tool (Claude Code's `SendMessage`)?                | Yes, after person-resume ships, and behind the same setting. It is the cache-friendly way to ask a follow-up                                                                                                          |
| PD-8 | Where a person-resumed run's answer goes                                                      | As a report item delivered at the parent's next boundary or send, never by rewriting the original tool output and never by starting a parent turn on its own                                                          |

## 8. Out of scope

- Subagents that outlive the webview or the parent process (a supervisor, as Claude Code's agent view has).
- Subagent compaction.
- Rewind or edit inside a subagent's transcript.
- Nested subagents in the IDE (#816 follow-up 10).
- ACP `session/list` and resume (O24, O28, O30). These still need per-session history for the _parent_, which is V4.
