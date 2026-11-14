# Context policy: one setting for how a session keeps its context

Written 2026-11-14. Builds on [`memory-ageing.md`](./memory-ageing.md) (masking
first, summarising as the fallback, never silent),
[`context-visibility.md`](./context-visibility.md) (the breakdown) and the
history ageing page (`docs/ide-extensions/agent/history-ageing.mdx`).

## 1. Problem

A session has four ways to shrink its context, and nothing ties them together:

| Mechanism                                                                     | What it does                                                                     | How it is switched                             | Default     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- | ----------- |
| Pruning (`compileChatMessages`)                                               | drops the oldest history to fit the context length                               | always on                                      | on          |
| History ageing (`core/util/contextAgeing.ts`)                                 | masks old tool results with a placeholder and a recall tool                      | `CONTINUE_HISTORY_AGEING=1` in the environment | off         |
| Compact now (`core/util/conversationCompaction.ts`)                           | summarises the conversation up to a message; history before it is no longer sent | a button in the context meter                  | manual only |
| Choose what to keep (`SelectiveCompactDialog`, `core/util/contextRemoval.ts`) | marks turns, tool results and context items as removed; stubs are sent           | a dialog                                       | manual only |

What a person cannot say today:

- "Keep everything; I want one long, bloated session" (pruning still drops the
  oldest history without saying so).
- "Compact for me when the context is 70% full" (there is no automatic
  compaction).
- "Never drop this" (a file, a decision, a tool result): there is no hold.
- "Summarise like this" (the compaction prompt is fixed).

Found while writing this (fixed in `965040da3`): "Compact now" failed silently.
Core's handler caught every error and returned success; the GUI never checked
the result and reloaded the unchanged session. The likeliest failure is a
conversation already too long for the model: the summary request carries the
whole conversation. "Choose what to keep" does work (constructMessages reads
`removedByUser`), but the context meter shows the size of the last request
sent, so neither control moves it until the next message.

## 2. What other agent tools offer

Checked against their documentation on 2026-11-14:

- **Roo Code** ([Intelligent Context Condensing](https://docs.roocode.com/features/intelligent-context-condensing)):
  automatic condensing on by default, a threshold slider (default 100%), a
  custom condensing prompt, a manual Condense button by the context bar; shows
  tokens before and after, the cost of the summary call and the summary itself;
  on a context-window error it cuts the context by 25% and retries
  automatically; reserves 30% of the window (20% output, 10% safety); counts
  with the provider's token-count endpoint where there is one; condenses with
  the conversation's own model ("a different model degrades summaries of tool
  calls").
- **Claude Code** ([prompt caching](https://code.claude.com/docs/en/prompt-caching),
  [costs](https://code.claude.com/docs/en/costs)): `/compact` (optionally with
  instructions for what to keep) and `/clear`; automatic compaction near the
  limit; clears old tool results from context; counts compaction and clearing
  as expected cache rebuilds, not misses; `/usage` recommends "Compact before
  you step away" while the cache would expire anyway.

From product knowledge, not re-checked today (verify before relying on it):

- **Cline**: a context-window bar; auto-condense near the limit; a `new_task`
  handoff that starts a fresh task carrying a summary.
- **Aider**: `/drop` and `/add` per file, read-only files, `/tokens` showing
  what each file costs; summarises old chat history with a weaker model.
- **Gemini CLI**: `/compress`; a configurable compression threshold
  (fraction of the window).
- **OpenAI Codex CLI**: `/compact` and automatic compaction.
- **Cursor**: summarises long chats; pinned context through rules and @-mentions.

Common ground: (1) automatic compaction with a threshold the person can move,
(2) a manual compact with optional instructions, (3) something that is never
dropped (files, rules, pins), (4) showing what was summarised and what it
cost, (5) recovering from a context-window error by itself.

## 3. Design

### 3.1 One policy, three presets

`contextPolicy` in config.yaml (per model and per mode, like other completion
options), also on the context meter as a picker:

| Preset                 | Pruning                                | Ageing old tool results | Automatic compaction | Overflow error                       |
| ---------------------- | -------------------------------------- | ----------------------- | -------------------- | ------------------------------------ |
| **Keep everything**    | only to fit the window, and it says so | off                     | off                  | explain, offer compact / new session |
| **Balanced** (default) | to fit                                 | on, from 50% full       | at 85% full          | learn the correction, retry once     |
| **Lean**               | to fit                                 | on, from 30% full       | at 60% full          | learn the correction, retry once     |

Each value can be overridden:

```yaml
contextPolicy:
  preset: balanced
  autoCompactAt: 0.85 # fraction of the context window; off to disable
  ageToolResultsAt: 0.5 # fraction; off to disable
  keepRecentTurns: 4 # never summarised or masked
  compactPrompt: "Keep every file path, error and decision." # appended
```

`CONTINUE_HISTORY_AGEING` stays as an override for one release, then goes.

### 3.2 Hold

A held item is never masked, summarised or pruned:

- a turn (a message and its tool calls), from the message's menu: "Hold";
- a context item or tool result, from Choose what to keep: a third state
  beside Keep and Remove;
- a rule or file the person marks always-on already holds (no change).

Stored like `removedByUser`: `heldByUser` on the history item. Pruning and
compaction treat held items as part of the fixed budget, like the system
message. If the held items alone pass the budget, say so before sending
("Held items take 92% of the context; release some or start a new session").

### 3.3 Automatic compaction

After a response, when the reported prompt size (the provider's own count,
not our estimate) is above `autoCompactAt`, compact before the next request:

- summarise everything except the last `keepRecentTurns` turns and held items;
- while the prompt cache is warm, send the conversation's own request plus the
  summary prompt (already built, C25) so the summary request reads the cache;
- show a row in the conversation: "Compacted: 820k → 46k tokens, $0.41", with
  the summary expandable and an Undo (the history is kept; only what is sent
  changes);
- record it in the cache ledger as an expected rebuild (as C31 does).

If the summary request itself would not fit, summarise in two halves, or mask
first (ageing), then summarise.

### 3.4 Making the controls visible

- After Compact now or Choose what to keep, the context meter shows the size
  the next request will be (an estimate, marked as such) next to the last one.
- A failed compaction says why (done in `965040da3`).
- The overflow error offers Compact (when the conversation fits a summary) or
  New session, and the next request learns the token correction (done in
  `62389a4c9`).

### 3.5 Token counting

The estimate is a GPT tokenizer times a family factor (1.23 for Claude).
Calibrate it from the provider's reported prompt size on every successful
response, not only after an overflow, and use the provider's count-tokens
endpoint (Anthropic, Bedrock) before automatic compaction when it is cheap.

## 4. Build order

1. `contextPolicy` in config-yaml and core, resolved per model and mode; the
   presets as data; `CONTINUE_HISTORY_AGEING` mapped onto it. Tests only.
2. Calibration from reported prompt sizes (§3.5), reusing `contextOverflow.ts`.
3. Automatic compaction (§3.3) with the conversation row and Undo.
4. Hold (§3.2): `heldByUser`, the message menu, the third state in Choose
   what to keep, and pruning and compaction honouring it.
5. The preset picker on the context meter, the "next request" size (§3.4).
6. Replay recorded sessions (`npm run replay:ageing`) to compare presets on
   tokens, cache reads and cost before choosing the Balanced numbers.

## 5. Decisions (2026-11-14)

### 5.1 What compaction costs, by strategy

Claude Sonnet 5.5 on a Bedrock regional profile, per million tokens: input
$2.20, output $11, cache read $0.11, 5-minute cache write $2.75. A session at
800k tokens of context, with system prompt and tools of 40k:

| Strategy                                                                        | One-off cost                                                                           | Each later request                                                                      | Notes                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| Do nothing, below the limit                                                     | none                                                                                   | 800k read: **$0.088**                                                                   | grows every turn                             |
| Do nothing, at the limit (pruning drops the oldest)                             | none                                                                                   | prefix changes at the start every request: a full rewrite, about 1M x $2.75 = **$2.75** | the worst case, and the default today        |
| Compact while the cache is warm (summary request reuses the cached prefix, C25) | 800k read $0.088 + ~8k output $0.088 + new 50k prefix written $0.14 = **~$0.32**       | 50k read: **$0.0055**                                                                   | pays back in 4 requests                      |
| Compact with a cold cache                                                       | 800k uncached $1.76 + output $0.09 + write $0.14 = **~$2.00**                          | $0.0055                                                                                 | 6 times the warm cost                        |
| Mask old tool results (no model call)                                           | the history after the first masked result is rewritten, e.g. 300k x $2.75 = **~$0.83** | smaller reads                                                                           | keeps the reasoning; each batch is a rebuild |

What follows from it:

1. **Pruning at the limit is the expensive default.** Dropping the oldest
   message changes the start of the prompt, so every request near the limit
   is a full cache rewrite. A long session that keeps going past the limit
   pays about 30 times the warm read cost per request.
2. **When matters more than how.** The same compaction costs about $0.32 right
   after a response (cache warm) and about $2 after an idle break (cache cold).
   Automatic compaction should run only while the cache is warm.
3. **Masking is not free** on a cached provider: it is a rebuild from the first
   masked result. It is cheap only in rare, large batches, or with no cache
   (local models, providers without caching), where it costs nothing.
4. **Local models are different.** With a local prefix cache (llama.cpp,
   Ollama) there is no per-token bill: the cost is time to re-read. There,
   masking and pruning cost only re-processing, and a summary costs a
   generation. Default to masking first on local models.

### 5.2 The defaults

- **Automatic compaction on, at 80% of the context window**, triggered by the
  provider's reported prompt size after a response, and run straight away while
  the cache is warm. No question asked: the row in the conversation shows what
  happened, what it cost and an Undo. If the threshold is first crossed with a
  cold cache (a resumed session), ask, with both costs shown.
- **The summary uses the conversation's own model**, with the cached prefix.
  A cheaper model is an option, but it cannot reuse the conversation's cache,
  so it is usually not cheaper on a cached provider.
- **Keep everything** stays available for a long session, and now says so
  when pruning starts, with the per-request cost of carrying on.
- **Local models**: mask old tool results first, at 60%, then compact at 80%.

### 5.3 Choose what to keep: calls and results

- A call and its result stay paired on every provider. A removed result is
  sent as a one-line stub with the same `toolCallId` (contextRemoval.ts), so
  Bedrock's "tool_use without tool_result" rule holds. Turns are removed only
  from the start, so a pair is never split. Keep it that way.
- **A result without its call is not offered and should not be.** The model
  would see output with nothing saying what produced it.
- **A call without its result is useful**: the call says what was done ("read
  config.ts", "ran npm test") and the stub says how big the output was, which
  is usually enough to continue. That is what removing a result does today.
- **Add: remove a call's large input.** The biggest items in an agent session
  are often edit and create_new_file arguments (whole files). Once applied,
  the file is on disk. Replace each large string argument with
  "[removed: 12k tokens]", keeping the call's JSON valid.
- **Add: remove a step.** Turns start at the person's messages, and the latest
  turn is never offered. An agent session is often one or two messages with
  hundreds of tool calls, so the turn list is nearly empty and the dialog seems
  to insist on keeping one. Offer the older steps of the current turn (an
  assistant message with its calls and results) as one unit, removed together
  so no pair is split.

### 5.4 Guidance and control over the summary

Today the prompt is fixed (COMPACTION_PROMPT), the model is the chat model,
Compact now summarises up to the latest message, and a message's own Compact
button summarises up to that message. Add:

- **Instructions**: an optional text field on Compact now ("keep every file
  path and error"), and `compactPrompt` in the policy for every compaction.
- **Keep the recent turns verbatim** (`keepRecentTurns`, default 4 steps).
- **Held items** stay verbatim (section 3.2).
- **Preview**: the summary is shown before it replaces anything, with Accept,
  Edit and Discard. Automatic compaction skips the preview and offers Undo.
