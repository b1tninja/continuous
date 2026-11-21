# Memory and session history

Status: plan, 2026-11-09. Nothing built. Roadmap row: Track V. Related: compaction and context limits (Track C, F5), checkpoints (#185), Loop mode and parallel waves (Tracks N, O), the terminal tool's output limits.

## Why

A long session grows without bound: every message, every tool result, every terminal output and every reasoning block stays in the session, and everything in the session is held in memory, drawn in the chat and written to disk as one file. A loop run for hours, a long agent session or several parallel workers can run the machine out of memory long before the model's context window is the problem. The model's context is bounded by compaction and truncation; the person's scrollback and the process's memory are not.

Three things are being mixed up and need separating:

| What              | Bounded today?                             | What bounds it                                             |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------- |
| **Model context** | Yes                                        | Truncation and compaction (token based)                    |
| **Memory in use** | No, as far as read                         | Nothing found                                              |
| **Rendered UI**   | No                                         | Nothing found                                              |
| **Disk**          | Not bounded; rewritten whole on every save | `core/util/history.ts` saves the whole session as one JSON |

## What was read (2026-11-09; hypotheses until measured in V0)

- **GUI store.** `gui/src/redux/slices/sessionSlice.ts` keeps the whole `history` array in Redux, with tool call states and outputs attached to each item. A rewind or resubmit truncates it (`truncateHistoryToMessage`); nothing ages it.
- **GUI rendering.** `gui/src/pages/gui/Chat.tsx` renders the history in a plain scrolling container (`overflow-y-scroll`) with one `StepContainer` per item. No virtualisation library or windowing was found in `gui/src` or its `package.json`. Every item's markdown, code blocks and diffs are live DOM for the whole session.
- **Persistence.** `core/util/history.ts` writes the session with `JSON.stringify` over the whole object (`writeFileSync`), and the sessions list the same way. A save costs time and a transient copy proportional to the whole session, every time.
- **Terminal output.** `core/util/processTerminalStates.ts` keeps `currentOutput` per running process. The CLI caps what it returns to the model by characters and lines (`CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS`, `truncateOutput.ts`); whether the IDE path caps what it _holds_ was not checked.
- **CLI.** `ChatHistoryService` holds the full history in the process; compaction is for context size. A `ResourceMonitoringService` already samples RSS, heap, event-loop lag and file descriptors, so the CLI can see its own memory but nothing acts on it.
- **Loop and workers.** Each loop item starts a fresh context, but the loop's inbox, reports and per-item transcripts stay; parallel workers (Track N) multiply them.
- **Other holders to check:** subagent transcripts kept inside the parent session, image attachments (base64 in the message), reasoning blocks, the `state.cached` verdict maps, and the Redux store's undo or dev tooling.

None of these has a number yet. The first job is to find out where the bytes are.

## What was measured (2026-11-20; V0, first part)

Correction first: the chat is already windowed. `ChatTranscript` and `chatWindow.ts` (commit `39e9d7f73`) mount only the rows near the viewport, with spacers for the rest, so the "no windowing was found" line in "What was read" is out of date.

**Rendering and per-token cost, in a test (`chatWindowScale.measure.test.tsx`, `chatCost.measure.test.ts`).** Mounted rows and the cost of one streamed token, with the viewport faked:

| Rows   | Rows mounted | Re-render per token | `history.filter` | Window maths (stuck to end) | Whole-session JSON |
| ------ | ------------ | ------------------- | ---------------- | --------------------------- | ------------------ |
| 1,000  | 14           | 1.7 ms              | 0.03 ms          | 0.03 ms                     | 2 ms, 0.5 MB       |
| 5,000  | 14           | 1.7 ms              | 0.16 ms          | 0.13 ms                     | 10 ms, 2.5 MB      |
| 20,000 | 14           | 2.0 ms              | 0.62 ms          | 0.22 ms                     | 47 ms, 10 MB       |

So the DOM does not grow with history and the JavaScript that runs per token is small. The reducer (`streamUpdate`) touches only the last item, the tool-call selectors walk from the end and return early, `useAutoScroll` is memoised on the length, and `redux-persist` keeps a filtered subset of `session` that excludes `history`. **This does not explain a chat that gets slower over a long session.** What it could not measure is a real webview: heap size, garbage-collection pauses, and the cost of a mounted row (markdown, code blocks, diffs).

**Where the bytes are (real sessions in `~/.continuous/sessions`, `.jsonl`: 21 files, 59.5 MB; the four largest 27, 18, 7 and 3 MB).** In the largest session (5,244 items, 27 MB of item JSON):

| Share | Bytes   | What                                        |
| ----- | ------- | ------------------------------------------- |
| 52%   | 14.0 MB | `toolCallStates` (2,353 of them, 6 KB each) |
| 27%   | 7.2 MB  | `message` (text of every role)              |
| 19%   | 5.2 MB  | `promptLogs`                                |
| 1.4%  | 0.4 MB  | `appliedRules`                              |

Inside a tool-call state: the tool's own definition is 39% (2.4 KB per state), `toolCall` 20%, `parsedArgs` 17%, the output only 12%, `processedArgs` 9%. The same **13 tool definitions are stored 2,038 times** (the terminal tool's 3.5 KB schema 1,285 times), and the arguments appear three times (`toolCall`, `parsedArgs`, `processedArgs`). The other three sessions look the same (54 to 64% in tool-call state and prompt-log fields). Tool outputs are 4 to 7% of the bytes, not the main weight. The largest 1% of items hold only 8 to 12% of the bytes, so the weight is spread evenly, not in a few huge items.

**What this does not show.** These are bytes on disk. In the running webview the `tool` objects probably share one reference with the config's tool list, so memory may be much less than the file; after a session is reloaded from disk they are separate copies. That needs a heap measurement in a live webview before any change is justified. It also does not show which of the heavy fields the screen reads. In the GUI, `tool` is read for `readonly`, `uri`, `group`, `displayTitle` and `function.parameters`, so it cannot simply be dropped.

## Design

### Three tiers

| Tier     | Where it lives    | Holds                                                                                                       | Used for                                          |
| -------- | ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Hot**  | Memory, rendered  | The visible window and what the model is about to be sent                                                   | Drawing, editing, the next request                |
| **Warm** | Memory, as a stub | A header per item (role, time, tool name, size, first and last lines of an output) and a handle to the body | Scrolling, search by header, the context builder  |
| **Cold** | Disk only         | The full body (a long tool output, a base64 image, a reasoning block, an old message)                       | Fetched on demand: expand, search, export, rewind |

The rule that keeps this safe: **anything that can still go to the model stays recoverable by the request builder.** Aging out scrollback must not change what the next request contains. Items that compaction or truncation has already dropped from the context are the first to go cold; items inside the context window are warm at worst, and the builder loads a body when it needs it (or refuses to age an item that is inside the window).

### Storage

Replace "rewrite one JSON file" with an append-only log per session (a JSON line per item, plus an index of offsets), so a save appends one item, an old range can be read without parsing the rest, and a crash loses at most the last line. Large bodies (tool output over a size, images) are written as separate files and referenced from the item, which also removes base64 from the in-memory history. SQLite is the alternative (the extension already ships it for the index): better for search and range queries, more to migrate. Decision D1.

Old sessions are read through a loader that understands both formats; the one-time migration happens on first open, never in bulk.

### The UI

- **Windowed list.** Render the last N items and the ones near the viewport; the rest are a spacer. "Load earlier" (or scrolling up) loads the previous range from the log. A long tool output is collapsed to its header and a size, and expands from disk.
- **Aging policy.** By count (keep the last N items hot), by bytes (a per-session budget for hot and warm bodies), and by age, whichever bites first. A running item and the item being edited are never aged.
- **A person can see and control it.** A memory panel and a "Free memory" action (below).

### Statistics and the panel

Local only, nothing leaves the machine (the fork collects no telemetry).

| Figure                    | Source                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process memory            | Extension host and CLI `process.memoryUsage()` (RSS, heap used, external, array buffers); the webview's JS heap and, where available, `performance.measureUserAgentSpecificMemory()` |
| History size by category  | Bytes held for messages, tool inputs, tool outputs, reasoning, images, per session, counted when an item is added                                                                    |
| Hot, warm and cold counts | Items and bytes in each tier                                                                                                                                                         |
| Rendered DOM              | Node count of the chat container (the cheapest warning that the list is not windowed)                                                                                                |
| Save cost                 | Time and bytes of the last save                                                                                                                                                      |
| Pressure                  | Heap or RSS against a configurable ceiling, and system free memory (the CLI already reads it)                                                                                        |

Shown as a small panel in the IDE (a toolbar entry next to the cache tips, with a dot when pressure is high) and as `/memory` and a status-line segment in the CLI. Actions: **Free memory** (age out everything outside the hot window now), **Export and trim** (write the full transcript to a file and keep a summary), and **Open session file**.

### Other holders

- **Terminal output** is a ring buffer with spill to a file: the process keeps the last N kilobytes, the rest goes to disk, and the tool result carries the head, the tail and the path.
- **Subagent and loop-item transcripts** are stored by reference, not inside the parent's history.
- **Images** are written to files and referenced; thumbnails are what the UI holds.
- **Loop mode** gets a budget of its own for retained transcripts, so a long run keeps the last items' detail and the rest as reports.

## Build order

| #   | Scope                                                                                                                                                                                                                   | Done when                                                                                                                   | State       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| V0  | Measure: a harness that builds a synthetic long session (thousands of items, large tool outputs, images) and records heap, retained size by category, DOM nodes, render time and save time in the GUI, the CLI and core | A table of where the bytes and the time go at 1k, 5k and 20k items; the guesses above are confirmed or dropped              | Not started |
| V1  | The statistics: byte counters by category, process figures and a memory panel in the IDE, `/memory` and a status segment in the CLI                                                                                     | A person can see which category grows and the pressure level                                                                | Not started |
| V2  | Cheap wins found by V0: cap what the IDE terminal path holds, ring buffer with spill, externalise images, drop duplicate copies                                                                                         | V0's table shows the drop at the same session sizes                                                                         | Not started |
| V3  | Windowed rendering in the chat and collapsed long outputs                                                                                                                                                               | Chat DOM node count stays flat as history grows; scroll position holds on load-earlier                                      | Not started |
| V4  | Append-only session log with an offset index, large bodies as separate files, a loader for the old format, migration on first open                                                                                      | A save writes one item; a 20k-item session opens in constant time; old sessions still open                                  | Not started |
| V5  | The tiers: warm stubs and cold bodies with on-demand load, the aging policy (count, bytes, age), and the rule that the request builder can always recover an item inside the context window                             | A 20k-item session stays under a memory ceiling in the harness and the next request is byte-identical with aging on and off | Not started |
| V6  | "Free memory" and "Export and trim" actions; pressure warning; settings (`history.hotItems`, `history.memoryBudgetMb`)                                                                                                  | The warning fires on the harness at the ceiling and the action brings the heap back under it                                | Not started |
| V7  | Loop and workers: transcripts by reference, a retained-transcript budget, worker output spilled to files                                                                                                                | A 2-hour loop run in the harness holds a flat memory profile                                                                | Not started |
| V8  | Search over cold history (an index of headers, then bodies on demand) and rewind to a cold item                                                                                                                         | Search finds text in an aged-out item and a rewind to it works                                                              | Not started |

## Decisions for the owner

| #   | Decision                           | Options and a recommendation                                                                                                                                                                       |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Disk format                        | An append-only JSON-lines log with an offset index (recommended: simple, crash-safe, readable by hand), or SQLite for search and range queries. Pick after V0 shows whether search is the pressure |
| D2  | Defaults                           | Hot window of the last 200 items and a 256 MB budget per session, tuned in V0 (recommended as a starting point). The numbers are guesses until the harness runs                                    |
| D3  | Aging inside the context window    | Never (recommended): an item the model will see stays warm or hot. If that alone is too much, compaction is the answer, not aging                                                                  |
| D4  | Does "Free memory" delete anything | No. It moves bodies to disk. Deleting history is a separate, explicit action                                                                                                                       |

## Out of scope

- Reducing the model's context cost (Track C and compaction).
- Memory of the model providers or of the language servers and indexers (watch them in the panel, fix them separately).
- Syncing sessions between machines.
