# Prompt logs and session storage: post-mortem and design

Research note, 2026-11-14. Code read on `origin/main` at `69bd3ccac` (release 2.20.0), plus the hotfix commit `4e85f761f` on `wip/mantle-quirks-prompt-logs`. Docs only: no code is changed here, and `plans/ROADMAP.md` is not edited (section 9 holds the row text).

Conventions: "verified by reading" names a file and line read at `69bd3ccac`; "modelled" is arithmetic from the numbers in the hotfix commit; "primary" is a vendor's own documentation or source, read 2026-11-14 through a fetch tool or `gh`. Nothing was measured on a live session for this note: the 432 MB session file was not opened.

## 1. Summary

- **What happened.** Every chat request returns a `PromptLog` whose `prompt` field is the whole formatted conversation sent to the model. The GUI appends it to the history item that answered (`gui/src/redux/slices/sessionSlice.ts:372-384`), and that history item is saved with the session. Each prompt contains everything before it, so the saved session grows with the square of the number of requests. One session reached 432 MB, of which 424 MB were old prompts (1,290 items, 445 requests; numbers from the hotfix commit), and the webview ran out of memory.
- **Who introduced it.** Upstream Continue, not this fork. `promptLogs` on `ChatHistoryItem` first appears in `core/index.d.ts` in `e1ed7ed0a` (Nate Sesti, 2023-12-14, "config.ts") as `[prompt, completion]` string pairs (paths before that move were not traced); the current `concat` reducer arrived with the redux schema rewrite `438cba450` (2024-11-27, "feat: update redux store schemas"); `PromptLog` took its current shape in `df9268ad8` (2024-08-28) and gained `modelProvider` in `3253c1182` (2025-08-13). The dispatch site is `ee269fa5d` (#8221, 2025-10-13). Every release of this fork, `v2.12.0` through `2.20.0`, shipped it.
- **Why it hit now.** This fork made long sessions normal: agent and Loop modes run hundreds of requests per session (#315, #331), prompt caching is on by default (#261) so a long session is cheap to continue, and 1M-token context windows removed the cap that compaction and pruning used to place on each prompt. A 200k-token window caps one prompt near 0.8 MB of text; a 1M window lets it reach about 4 MB.
- **It was known.** `plans/research/performance-startup-resources.md` (PR #782, 2026-11-12) found it, modelled 26.8 MB at 300 messages, and filed it as PERF10, "2.18.0 candidate". It stayed "Not started" through 2.18.0 and 2.20.0 because nothing failed: there is no size budget and no long-session test.
- **The only reader is the thumbs up/down buttons** (`gui/src/components/FeedbackButtons.tsx:22-36`), which send the prompt to dev data as `chatFeedback`. Every prompt is already written once, when it is made, as `chatInteraction` dev data (`gui/src/redux/thunks/streamNormalInput.ts:404-431`). None of the fork's newer features (context meter #833, Choose what to keep #851, Fork #856, Resume #831, the cache ledger) read `promptLogs`.
- **Recommended design.** Do not persist rendered prompts at all. Keep the newest one in memory for feedback, rebuild any other on demand from history and config, and offer an opt-in, size-capped debug prompt log outside the session. Then move the session file from a whole-file JSON rewrite to an append-only JSONL log with large tool outputs and images stored as blobs by reference, and put budgets and a 500-turn session test in CI. Section 8 has the phases.

## 2. Post-mortem

### 2.1 What a prompt log is

`PromptLog` (`core/index.d.ts:1332-1339`): `modelTitle`, `modelProvider`, `route?`, `prompt`, `completion`. The fork's type no longer carries `completionOptions` (upstream's `core/config/types.ts:385-391` still does).

The `prompt` string is built in `core/llm/index.ts:1454-1456`: after compiling and pruning the messages for the model (`compileChatMessages`, lines 1440-1450), it is `templateMessages(messages)` or `_formatChatMessages(messages)` (lines 710-730), which concatenates every message's rendered text, including the system message and each tool call's name and arguments. It is returned from `streamChat` at lines 1657-1662 with the joined completion. So one prompt log is a flat-text copy of everything the model saw on that request, system message and rules included. Images are not in it (`renderChatMessage` renders text parts); tool definitions are not in it.

### 2.2 Writers

| Writer | Where | What it writes |
| ------ | ----- | -------------- |
| `addPromptCompletionPair` reducer | `gui/src/redux/slices/sessionSlice.ts:372-384` | Appends the request's `PromptLog` to `history[last].promptLogs` with `concat`. Never trims. |
| Dispatch after each streamed request | `gui/src/redux/thunks/streamNormalInput.ts:404-405` | One call per model request, including each agent round after a tool call. |
| `chatInteraction` dev data | same file, lines 407-431; `core/data/log.ts:98` | The same `prompt` and `completion`, appended (scrubbed, `scrubDeep`) to `~/.continue/dev_data/<version>/chatInteraction.jsonl`. Always on. |
| JetBrains binary prompt log | `binary/src/index.ts:44-50`, `core/util/scrubStream.ts:12-16` | Every LLM interaction formatted to `~/.continue/logs/prompt.log`, scrubbed, truncated at process start (`flags: "w"`), unbounded within one process. |

The CLI (`extensions/cli`) has no `promptLogs` writer: a search for `promptLog` in `extensions/` finds none.

### 2.3 Readers

| Reader | Where | Needs |
| ------ | ----- | ----- |
| Thumbs up/down | `gui/src/components/FeedbackButtons.tsx:22-36` | All logs on the item, posted as `chatFeedback` dev data. In practice the item's last request. |
| Fork a session | `core/util/forkSession.ts:73` | Does not read it, but `structuredClone(parent.history.slice(0, end))` copies every prompt log into the fork, so a fork of a 432 MB session writes a second file of the same order and briefly holds two copies in memory. |
| Tests | `gui/src/redux/thunks/streamResponse*.test.ts` | Assert on `promptLogs` contents. These are the tests the hotfix breaks. |

Checked and not readers: the context meter (#833, `ContextMeter.tsx`), selective compaction (#851, `SelectiveCompactDialog.tsx`, `core/util/contextRemoval.ts`), Resume (#831, `interrupted` on the item), the cache ledger (`session.promptCache`), usage (`session.usage`), conversation compaction (`core/util/conversationCompaction.ts`), share/export (`core.ts` `history/share` maps to `msg.message` only). `grep -rn promptLogs` over `core`, `gui/src` and `extensions` finds only the files in the two tables.

### 2.4 How the session is persisted

1. **Trigger.** `streamThunkWrapper` (`gui/src/redux/thunks/streamThunkWrapper.tsx:33-41`) dispatches `saveCurrentSession` after every successful stream. In agent mode each tool round is its own stream, so the session is saved after every model request. Many other paths save too (queued messages after a delay, `ParallelListeners.tsx:79`; compaction; fork; task list; model switch; tab change).
2. **Webview to extension host.** `saveCurrentSession` (`gui/src/redux/thunks/session.ts:186-281`) takes the whole `state.session`, and `updateSession` posts it with `ideMessenger.request("history/save", session)` (line 79). The full history, prompt logs included, crosses the webview boundary on every save.
3. **Core.** `on("history/save")` (`core/core.ts:1262-1264`) calls `HistoryManager.save` (`core/util/history.ts:356-403`), which builds an ordered copy and calls `writeAtomic(path, JSON.stringify(orderedSession, undefined, 2))`: a synchronous temp-file-and-rename of the whole file (`writeFileAtomicSync`, mode 0600), on the extension host's thread. Then `sessions.json` is rewritten under a lock.
4. **Load.** `history/load` returns the whole session to the webview, which keeps it in redux. Redux-persist does **not** persist history: `gui/src/redux/store.ts:40-50` filters the `session` slice to `id`, `lastSessionId`, `title` and `mode`. So `localStorage` was not part of the failure; the webview heap was.

The CLI uses the same `HistoryManager.save` (`extensions/cli/src/session.ts:385-400`) after its own turns, without prompt logs.

### 2.5 Growth

Let request k (1 to n) carry a prompt of `s0 + k*d` bytes, where `s0` is the system message and rules and `d` is what one request adds on average (assistant text, tool calls, tool output). The prompt logs sum to about `n*s0 + d*n^2/2`.

Fitting the reported session (n = 445 requests, 424 MB of prompts) and ignoring `s0` gives `d = 2 * 424e6 / 445^2`, about **4.3 KB per request**, which is what an agent round with a file read or a command output looks like. The newest prompt in that session is then about 1.9 MB, and the history without logs about 8 MB: the logs are 53 times the conversation they record.

The cost is worse than the size because the whole file is rewritten each time. Saves after every request write about `sum(k=1..n) size_k`, which for the quadratic term is `d*n^3/6`: about **63 GB serialised, posted across the webview boundary and written to disk** over that one session (modelled). Each save near the end stringifies 430 MB synchronously on the extension host: the prior note measured 46 ms for a 26.8 MB save, which scales to roughly 0.7 s per save at 430 MB (extrapolated, not measured), during which the extension host runs nothing else. That note judged whole-file rewrites "not a time problem" (section 5, lead V14) for sessions without prompt logs, which remains true.

There is also a hard ceiling. V8 limits a string to 2^29 - 24 characters on 64-bit builds (about 536 million). A session whose JSON passes that size cannot be saved at all: `JSON.stringify` throws, and each later save fails, so the newest turns are never written. The reported session was at 80 percent of that limit.

The context window used to bound this. `compileChatMessages` prunes each prompt to the model's window, so with a 128k to 200k-token window a prompt stopped growing at roughly 0.5 to 0.8 MB, and the total grew only linearly after that. With 1M-token windows the per-prompt cap is about five times higher, and compaction runs later.

### 2.6 Other accumulations found while reading

| Accumulation | Where | Growth | Verdict |
| ------------ | ----- | ------ | ------- |
| Tool output stored twice | `toolCallStates[].output` (context items) and the `role: "tool"` message whose content is `renderContextItems(toolOutput)` (`gui/src/redux/thunks/streamResponseAfterToolCall.ts:62-71`) | linear, 2x | Real but bounded; a blob reference fixes both copies (section 4f). |
| Prompt logs copied by Fork | `core/util/forkSession.ts:73` | one full copy per fork | Fixed for free once prompts are not persisted. |
| `chatInteraction` dev data | `streamNormalInput.ts:407-431`, `core/data/log.ts:98` | quadratic per session, on disk, append-only, always on | Same problem on disk: the 424 MB also went to `chatInteraction.jsonl`. Retention exists only as `cn clean` (`core/util/cleanStores.ts:18-22`, dev_data 90 days), which nothing runs automatically. |
| JetBrains `prompt.log` | `binary/src/index.ts:44-50` | quadratic within one process | Truncated at each start; unbounded while running. |
| CLI user items | `extensions/cli/src/session.ts:317-331` sets `editorState: item.message.content` | linear, 2x for user text and images | Small unless images are pasted. |
| Images | user message parts hold data URLs; the GUI editor document (`editorState`) holds the image node too | linear, possibly 2x per image | Not measured here; the long-session test should include images. |
| Checkpoints | `core/util/checkpoints.ts:43-46` | bounded: 90,000 bytes per file, 4,000,000 characters per session, `evicted`/`too_large` markers | Good precedent: a budget with a visible marker. |
| Permission audit log | `core/tools/permissions/audit/` | append-only JSONL with an index | Good precedent for the append-only design. |
| Cache ledger, usage, task plan, loop state | `core/util/history.ts:369-394` | small, bounded by counts | Not a concern. |
| VS Code `globalState` | `extensions/vscode/src/quickEdit/HistoryQuickPick.ts:25` | small list | Not a concern; sessions are not in `globalState` or `workspaceState`. |

Subagent and Loop runs save through the same `HistoryManager`; their sessions carry prompt logs when they run in the IDE webview path, and not in the CLI path. Not measured here.

### 2.7 Why tests and CI did not catch it

- No size budget anywhere on the session path. PERF21 (CI budgets) covers bundle bytes and start-up, not session bytes.
- No long-session test. The `streamResponse*` tests run a few turns, and a few turns of quadratic growth look linear.
- The only reader is a feedback button, so nobody saw the data, and the per-save cost was hidden: `performance-startup-resources.md` measured a full save at 3 ms for 1,000 messages *without* prompt logs and 46 ms at 300 messages *with* them, both fast enough on a desktop not to notice.
- The failure mode is out-of-memory in a webview, which leaves no stack trace in the extension's logs and looks like a VS Code crash.
- PERF10 was filed with an owner question attached (`performance-startup-resources.md` section 11, question 3), and work waited on the answer.

## 3. Impact

**Versions.** Every Continue release since late 2023 stores prompt logs; every release of this fork (`v2.12.0-vscode` to `2.20.0`) does too. The fork's users are the ones exposed, because they run the long agent and Loop sessions.

**Symptoms.**

- Webview out of memory on opening or continuing a long session (the reported case). The webview holds the whole session in redux, a second copy while serialising it for `postMessage`, and the extension host a third while stringifying.
- Slow saves blocking the extension host: `writeAtomic` is synchronous, so near the end of a long session each save stalls every extension on the host for the time it takes to stringify and write hundreds of megabytes.
- Disk: each long session several hundred MB in `~/.continue/sessions`, plus the same again in `dev_data/.../chatInteraction.jsonl`, plus a copy per fork.
- History list and search: `rebuildSessionsList` reads every session file when `sessions.json` is damaged (`core/util/history.ts:210`), so one huge file slows recovery for all.

**Data risk.**

- **Sessions too big to open.** A session past the V8 string limit cannot be saved; one near it cannot be loaded into a webview with a normal heap. The conversation itself (the 8 MB) is fine and recoverable by stripping `promptLogs` from the file, which is exactly what the hotfix does on load.
- **Secrets at rest.** Session files are written owner-only (0600) but **not scrubbed** (`HistoryManager.save` has no `scrubDeep`; only dev data and logs are scrubbed, by `be1ea7f47`, X15). The conversation is stored in clear anyway, so prompt logs add little new *kind* of exposure, with one exception: the **system message** (rules, environment disclosure, memory) is not part of the history, and prompt logs persisted it, in clear, once per request. Anything the environment disclosure or a rule placed in the system message is in the session file up to 445 times. `continuous secrets scan --history` (`core/util/secretScan/historyScan.ts`) can find it after the fact.

## 4. Designs compared

What the UI needs, from section 2.3: feedback needs the newest request's prompt and completion; nothing else needs a rendered prompt. Resume (#831) needs the history saved after a failure. Fork needs the history up to a point. The context meter and selective compaction work from the history and the request-time compile, not from logs.

### (a) Do not store prompts; rebuild on demand

The prompt is a deterministic function of the history, the config (rules, system message, tools), the model's template and the pruning inputs. Store none; when someone asks to see or send a past prompt, rebuild it with the same `compileChatMessages` path.

- Memory: zero. Disk: zero. Write cost per response: zero.
- Crash safety: unaffected.
- Privacy: best; the system message is never persisted.
- Migration: strip `promptLogs` on load (the hotfix already does).
- Caveat: a rebuild is exact only if config, rules and environment disclosure are unchanged since the request. For feedback this is acceptable if the rebuilt prompt is labelled "rebuilt", or if feedback uses (b) for the newest request.

### (b) Keep the newest only (the hotfix)

`keepLatestPromptOnly` (`gui/src/redux/util/promptLogRetention.ts` on the hotfix branch) keeps the full prompt on the last request and a marker on the rest.

- Memory and disk: O(one prompt), at most a few MB with 1M windows. Write cost: one prompt per save.
- Privacy: still persists the newest system message.
- Good as a hotfix; as a target it still writes megabytes per save for no reader once feedback has been sent.

### (c) Content-addressed dedup

Hash blocks (system message, tool set, each message) and store each once; a request is a list of hashes.

- Disk O(n). Write cost per response: the new blocks only, if the store is append-only.
- Gives exact historical prompts, which (a) cannot.
- Costs: a block store, garbage collection when compaction or "Choose what to keep" removes items, and a second format to migrate and back up. Nothing in the UI needs exact historical prompts, so the complexity buys little. Worth keeping in mind for a future debug tool; not recommended now.

### (d) Append-only JSONL session with periodic compaction

Write each change (new item, item update, metadata change) as one JSON line; rebuild the session by replaying; rewrite a compact snapshot when the log is, say, twice the snapshot.

- Write cost per response: O(delta) instead of O(session). Fixes the 63 GB of writes even without prompt logs, and the synchronous whole-file stringify on the extension host.
- Crash safety: better than temp-and-rename for long sessions: a torn last line is dropped on replay, everything before it survives. Resume (#831) only needs the item and its `interrupted` marker appended.
- Webview: the deltas can be what crosses `postMessage`, so the webview stops posting the whole session.
- Migration: read old `.json`, write the first snapshot as `.jsonl`; keep the reader for old files.
- This is what VS Code's own chat now does (below).

### (e) Opt-in debug prompt log

A setting (off by default) that writes each request's full prompt to `~/.continue/logs/prompts/<session>.jsonl`, scrubbed, with a size cap per file and a retention period, and a "Copy prompt" or "Open prompt log" action that reads from it.

- Zero cost when off. Bounded when on.
- Gives developers and bug reporters the exact prompt without putting it in the session.
- Privacy: scrubbed, owner-only, aged out; same rules as dev data.

### (f) Large tool outputs and images as blobs by reference

Store tool outputs over a threshold (for example 16 KB) and images in `sessions/<id>/blobs/<sha256>`, and keep a reference plus a preview in the item.

- Session file stays small; tool output stops being stored twice; identical outputs (the same file read twice) are stored once.
- Webview memory: previews only, full content fetched when expanded.
- Requests need the full content: core reads blobs when it compiles the request, which is where `contextRemoval.ts` already substitutes stubs.
- Deleting a session deletes its blob folder; fork can hard-link or reference the parent's blobs.

### Comparison

| Design | Memory | Disk | Write per response | Crash safety | Secrets at rest | Migration | Effort |
| ------ | ------ | ---- | ------------------ | ------------ | --------------- | --------- | ------ |
| (a) rebuild on demand | none | none | none | unchanged | best | strip on load | S |
| (b) newest only | one prompt | one prompt | one prompt | unchanged | newest system message | strip on load | done (hotfix) |
| (c) content-addressed | O(n) | O(n) | new blocks | needs a store | all prompts, deduped | new format | L |
| (d) append-only JSONL | unchanged by itself | O(n) plus slack | O(delta) | best | unchanged | snapshot old files | M |
| (e) opt-in debug log | none (off) | capped | none (off) | n/a | scrubbed, aged | none | S |
| (f) blobs by reference | previews only | O(n), deduped | new blobs | same as base | same | lazy | M |

### How peers store sessions

- **Claude Code** (primary: code.claude.com/docs/en/claude-directory, "Application data"): one append-only JSONL transcript per session at `~/.claude/projects/<project>/<session>.jsonl`, holding messages, tool calls and tool results, plus "the system prompt, tool definitions, and parameters of the requests" it sent. Large tool outputs are spilled to `projects/<project>/<session>/tool-results/`, subagent transcripts go to `<session>/subagents/`. Files older than `cleanupPeriodDays` are deleted; "The default is 30 days and the minimum is 1". The page states transcripts are plaintext and "not encrypted at rest", and offers `CLAUDE_CODE_SKIP_PROMPT_HISTORY` and `--no-session-persistence` to skip writing them. So: append-only, large outputs by reference, age-based retention by default.
- **VS Code chat (Copilot)** (primary: `microsoft/vscode` `src/vs/workbench/contrib/chat/common/model/chatSessionStore.ts`): sessions live in `workspaceStorage/<workspace>/chatSessions/`. Since 1.109 ("`>=1.109 append log`") each session is a `.jsonl` operation log written with `{ append: op === 'append' }` or a full `replace`, behind the setting `chat.useLogSessionStorage`; the older flat `.json` format is still read. This is design (d), adopted by a large editor for the same reason.
- **Codex CLI** (primary: `openai/codex` `codex-rs/rollout/src/list.rs`): "`~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`", one append-only rollout file per session.
- **Cline** (primary: `cline/cline` `apps/vscode/src/core/controller/file/openDiskConversationHistory.ts`, `apps/vscode/src/sdk/legacy-state-reader.ts`): a folder per task under the extension's global storage with `api_conversation_history.json` and `ui_messages.json`, each a single JSON document (its dev tooling writes them with `JSON.stringify(messages, null, 2)`, `apps/vscode/src/dev/commands/tasks.ts`). The same whole-document pattern as Continue, and it keeps the API history and the UI history as two copies. The production write path was not read for this note.
- **Cursor**: no first-party documentation of its chat storage was found; not compared.

No peer found stores a rendered copy of every past prompt inside the session that the UI loads.

## 5. Guardrails

1. **Budgets with warnings.** Per history item: no single field over a set size (for example 256 KB for text fields other than tool output, which goes to blobs). Per session: file bytes under 2 times the compact transcript (the PERF10 budget), and a warning in the context meter when a session passes, for example, 50 MB. The checkpoint code (`core/util/checkpoints.ts:43-46`) is the pattern: a budget, a marker when it is hit, no silent drop.
2. **A long-session test in CI.** A synthetic 500-request agent session (deterministic mock model, tool outputs of 2 to 20 KB, a few images, two compactions, one fork, one interrupted turn) driven through the real reducers and `HistoryManager.save`. Assert: saved bytes grow linearly (fit the sizes at 100, 200, 300, 400, 500 requests and fail if the quadratic term is significant, or simply if `size(500) > 6 * size(100)`); the largest single save stays under budget; the redux state size measured by `JSON.stringify` length stays under budget. Runs in the existing gui test job, no new job (PERF21's rule).
3. **A field-growth lint.** A test that, for each `ChatHistoryItem` key, compares its serialized size at request 10 and request 500 of the synthetic session; any per-item field whose size depends on the request number fails. That is the property `promptLogs` violated, and it would catch the next one.
4. **Save-path performance tests.** Time `HistoryManager.save` and the replay of the append log at 1,000 items; budget the p95. Assert the extension host is not blocked longer than a set time per save.
5. **Local, telemetry-free metrics.** Show the session's file size and item count in the context meter's details, and log a line when a save is slow or large. No telemetry: the numbers stay on the machine.
6. **Review rule.** A new field on `ChatHistoryItem` or `Session` states its growth class (constant, linear in items, bounded by a budget) in its doc comment. The field-growth test enforces the claim.

## 6. Recommendation

**Target architecture.**

- Sessions are an append-only JSONL operation log with periodic snapshot compaction (d), written off the extension host's critical path, with deltas as the webview-to-core message.
- Large tool outputs and images are blobs by reference under the session folder (f), deduplicated by hash.
- No rendered prompt is persisted in the session (a). The newest request's `PromptLog` stays in webview memory only, for the feedback buttons; older ones can be rebuilt on demand and labelled as rebuilt.
- An opt-in debug prompt log (e), scrubbed, capped and aged out, is the only place exact historical prompts are kept.
- Dev data `chatInteraction` stops carrying the full prompt by default (sizes and a hash instead), or is capped and aged out automatically.
- Retention: sessions and logs aged by default, as `cn clean` already defines, but run automatically.

**Phases.**

1. **Hotfix (in flight, `4e85f761f`).** Keep the newest prompt; strip old ones on load. Finish the three failing `streamResponse*` tests. Ship as a patch release.
2. **Stop persisting prompts (S, next).** Exclude `promptLogs` from `history/save` entirely (strip in `saveCurrentSession` and in `HistoryManager.save`, so the CLI and forks are covered too); keep the newest in memory. Strip `promptLogs` in `forkSession`. Add the 500-request synthetic test and the field-growth test so the fix stays fixed.
3. **Dev data and debug log (S).** `chatInteraction` without the full prompt by default; the opt-in debug prompt log; automatic age-based cleaning at activation using `cleanStores`.
4. **Append-only sessions (M).** JSONL op log with snapshot compaction, migration on first write, old reader kept; deltas over `postMessage`; async writes.
5. **Blobs by reference (M).** Tool outputs over the threshold and images; previews in the webview.
6. **Budgets in the UI (S).** Session size in the context meter details; warnings at the session budget.

**Owner decisions.**

1. **Should feedback still send the full prompt?** Recommended: yes, for the newest request only, from memory; for an older item, rebuild it and mark it rebuilt, or send sizes and a hash.
2. **Should `chatInteraction` dev data keep the full prompt?** Recommended: no by default (sizes, hash, model, rules); the full prompt only when the debug prompt log is on.
3. **Default retention.** Recommended: sessions 30 days after last use, dev data 90, logs 14 (the values `cleanStores` already has), run automatically, configurable, with pinned sessions exempt.
4. **Scrub session files on write?** Recommended: scrub the system message out by not persisting it (phase 2); do not scrub conversation content, because Resume and Fork need it as sent. Keep `secrets scan --history` as the after-the-fact tool.
5. **Append-only format: own JSONL or follow VS Code's operation log shape?** Recommended: own JSONL (one line per item add, item patch, metadata change), because the CLI and JetBrains share it and do not run in VS Code.

## 7. Open questions

- The size of images in `editorState` versus message parts, and whether subagent sessions in the IDE carry prompt logs; both belong in the long-session test's first run.
- Whether `postMessage` from the webview is the larger memory spike or `JSON.stringify` in core; measure with the synthetic session at 100 and 300 MB before choosing what phase 4 sends.

## 8. References

- Code: `gui/src/redux/slices/sessionSlice.ts:372-384`; `gui/src/redux/thunks/streamNormalInput.ts:404-431`; `gui/src/components/FeedbackButtons.tsx:22-36`; `gui/src/redux/thunks/streamThunkWrapper.tsx:33-41`; `gui/src/redux/thunks/session.ts:79,186-281`; `core/core.ts:1262-1264`; `core/util/history.ts:356-403`; `core/llm/index.ts:710-730,1440-1462,1657-1662`; `core/util/forkSession.ts:73`; `gui/src/redux/thunks/streamResponseAfterToolCall.ts:62-71`; `core/data/log.ts:98`; `core/util/cleanStores.ts:18-22`; `core/util/checkpoints.ts:43-46`; `gui/src/redux/store.ts:40-50`; `binary/src/index.ts:44-50`; `extensions/cli/src/session.ts:317-331,385-400`.
- History: `e1ed7ed0a` (2023-12-14), `df9268ad8` (2024-08-28), `438cba450` (2024-11-27), `3253c1182` (2025-08-13), `ee269fa5d` (#8221, 2025-10-13) upstream; `be1ea7f47` (X15 scrub-on-write), `b12a9aa99` (#856 fork) and `4e85f761f` (hotfix, WIP) in the fork.
- Prior note: `plans/research/performance-startup-resources.md` sections 1 (item 9), 3.5, 5 and 11 (question 3); ROADMAP PERF10, PERF19, PERF21.
- Peers: code.claude.com/docs/en/claude-directory; `microsoft/vscode` `chatSessionStore.ts`; `openai/codex` `codex-rs/rollout/src/list.rs`; `cline/cline` `openDiskConversationHistory.ts`, `legacy-state-reader.ts`, `dev/commands/tasks.ts`.

## 9. ROADMAP rows (text only)

For the PERF track, after PERF25, or as a new track "STOR: session storage". PERF10 becomes "Done (hotfix)" when `4e85f761f` lands, with STOR1 as its follow-up.

| ID    | Scope | Depends on | Status |
| ----- | ----- | ---------- | ------ |
| STOR1 | Prompt logs out of saved sessions: `promptLogs` stripped in `saveCurrentSession`, `HistoryManager.save` and `forkSession`; the newest kept in webview memory for feedback; old sessions stripped on load | PERF10 hotfix | Not started (S) |
| STOR2 | Synthetic 500-request agent session test (tool outputs, images, compaction, fork, interrupted turn) in the gui job: linear saved size, largest save and redux size under budget | none | Not started (S) |
| STOR3 | Field-growth test: no `ChatHistoryItem` field grows with the request number; new fields declare their growth class | STOR2 | Not started (S) |
| STOR4 | `chatInteraction` dev data without the full prompt by default (sizes, hash); opt-in debug prompt log under `logs/prompts/`, scrubbed, capped per file, aged out | owner question 2 | Not started (S) |
| STOR5 | Automatic age-based cleaning of sessions, dev data and logs at activation and CLI start, using `cleanStores` defaults; pinned sessions exempt | owner question 3 | Not started (S) |
| STOR6 | Append-only JSONL session log with snapshot compaction; migration from `.json`; asynchronous writes; deltas from webview to core | STOR2 | Not started (M) |
| STOR7 | Tool outputs over 16 KB and images stored as hashed blobs under the session folder; previews in the webview; fork shares blobs | STOR6 | Not started (M) |
| STOR8 | Session size and item count in the context meter details; warning past the session budget; slow-save log line | STOR2 | Not started (S) |
