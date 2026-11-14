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

## 5. Questions for the owner

1. Is Balanced the right default, or should the default stay "Keep
   everything" until the replay (step 6) has numbers?
2. Should automatic compaction ask first while the prompt cache is warm (a
   rebuild costs a full uncached read), or only show the row afterwards?
3. Should the summary use the conversation's model (Roo's choice, better with
   tool calls) or a cheaper one the person picks?
