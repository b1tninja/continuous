# Cache-friendly context trimming: why a long local session re-reads 390k tokens, and planned compaction (2026-11-15)

Status: research and design only, written against `main` at `578f54d43` (merge of #922). No code was changed. The local Strata server at `http://127.0.0.1:8086` was read with GET requests only (`/props`, `/metrics`, `/v1/models`, `/slots`, `/status`); no chat, tokenize or other POST request was sent to it. Vendor pages and the Strata repository were read live on 2026-11-15; each is cited by URL or by `path:line` at a named commit. Anything that could not be confirmed is marked **unverified**. No HTTP or IETF protocol claim is made, so no RFC is cited.

The owner saw this notice from the cache ledger (`gui/src/util/cacheLedger.ts`, #900):

> The prompt cache missed 5 times in this session. The last request read 16k of 407k tokens. Likely cause: the oldest messages were dropped to fit.

and asked:

> Do a deep dive into possible optimizations around this. I don't understand how the cache system works, but there may be an advantage to caching it in segments or chunks, so that if those pieces are evicted we still benefit from the retained cached chunks.

and later:

> Maybe if we are planning ahead on what we would evict when compaction is going to happen, we could preserve checkpoints more efficiently.

> [Planning the cut ahead] might also give us a better understanding of the Compact now cost / budget.

Rows proposed here start at **C101**: the highest Track C row in `plans/ROADMAP.md` is C100, and no other plan or open pull request uses a higher C number.

## 1. Summary

- **The cause on our side is a bug, not the design.** `compileChatMessages` already prunes in steps so that the cut stays put (`core/llm/countTokens.ts:594-614`), but the step is 10% of the room left _after_ the last turn (`countTokens.ts:600-607`, `inputTokensAvailable` from `:538-546`). The last turn's size changes on every request: a big tool result one turn, a short reply the next. So the step changes, the amount dropped changes, and the cut lands on a different message boundary. Sometimes it moves forward, sometimes back. Each move changes the prompt right after the system prompt and tools, and the server re-reads everything after that.
- **A second bug makes it start too early.** For a model called `qwen…`, `autodetectTemplateType` falls through to `"chatml"` (`core/llm/autodetect.ts:406`), so `encodingForModel` counts with the Llama 2 tokenizer (`countTokens.ts:75-87`). That tokenizer over-counts Qwen text by about 23%. Live evidence: Strata was granted `max_tokens: 15697` on a prompt it counted at 412,266 tokens. Our estimate was therefore 524,288 − 1,000 − 15,697 = 507,591, a ratio of 1.231. Pruning starts at about 424k real tokens out of 524k. The learned correction (`core/llm/contextOverflow.ts:86-128`) can only shrink the window (`MIN_CORRECTION = 1`), never give it back.
- **The live data shows the drip.** The last seven requests in `/metrics` ran at 408k to 412k tokens. Three of them reused only 16,384 tokens and re-read about 394k, each taking about 85 s (`prompt_ms` 84,407 and 85,180). The four between them reused everything but a few hundred tokens. At the owner's earlier 1,700 tokens/s, each of those re-reads is about 230 s.
- **The "segments" idea, precisely.** Reuse after a change is exact only up to the change; everything after it must be recomputed, because every token's keys and values depend on every token before it. Providers let you keep _several_ reusable prefixes (Anthropic breakpoints, Strata checkpoints), which helps when a change happens late. It does not help when the oldest messages are dropped, because that change is at the very start of the conversation. Reusing chunks _after_ a change is possible only approximately: llama.cpp `--cache-reuse` shifts positions and ignores what the chunk would have seen; CacheBlend recomputes 10-20% of tokens to repair it. No cloud provider offers it, and Strata cannot: its model keeps a recurrent state that cannot be shifted.
- **What works is the owner's second idea: plan the cut.** Decide the compaction boundary early and keep it fixed. Summarise the fixed span in the background while the cache is warm. Put the summary after the system prompt, not inside it. Pre-warm `[head][summary][tail]` while the person is idle, so the switch-over turn reads only the new message. On the owner's case, the foreground cost drops from about 85 s every two or three turns to 0 to 13 s once every few hundred turns.
- **Decisions (section 8).** Drip-drop becomes impossible by construction: a constant block size from the context length, never from the room after the last turn. Local servers learn the real token ratio from usage. Local servers prepare compaction at 70% of the real window and force it at 85%. Cloud providers prepare at 75% and force at 90%. Every compaction keeps the full history in the saved session.
- **The first slice for the next release (section 10)** is eight rows, C101 to C108, five of which can start in parallel. Everything that needs Strata-side support or touches cloud providers is later.

## 2. How prompt caching works, in plain language

**What is cached.** A language model reads a prompt one token at a time. For each token it computes two vectors per layer, a key and a value: the "KV cache". The next token's computation attends to all of them. Producing the answer needs every earlier key and value, so a server keeps them in memory. Reading a prompt from scratch is the slow part. On the owner's machine, about 395k tokens take 85 s; generating 200 tokens of answer takes 3 s.

**Why reuse is prefix-only.** Token 1,000's key and value are computed from tokens 1 to 999. They also carry token 1,000's position: rotary position encoding (RoPE) rotates each key by an angle that depends on its position. Change token 500 and every key and value from 500 on is different, even if the text after 500 is byte for byte the same. So when a new request arrives, the server compares it with what it has cached and keeps the longest shared start, the _prefix_. Everything after the first difference is read again.

**Why dropping the oldest messages is the worst case.** Our prompt is `[system][tools][message 1][message 2]…[latest]`. Dropping message 1 makes the second part of the prompt start with message 2, so the first difference is right after the tools. Every message is then re-read, even though none of them changed.

**What "segments" can and cannot do.**

| Idea                                                                | Possible?                           | How exact                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep several prefixes, so a late change falls back to the last good | Yes                                 | Exact. Anthropic and Bedrock breakpoints, Strata checkpoints. A change at position _d_ costs a re-read from the last saved point before _d_.                                                                                                                                 |
| Reuse a chunk that now sits at a different position                 | Approximately                       | llama.cpp `--cache-reuse` re-rotates the chunk's keys to the new position. The positions become exact, but each token still "remembers" the dropped text it once attended to. Quality loss is unmeasured. Unavailable for multimodal, M-RoPE and some sliding-window models. |
| Reuse a chunk and repair what it missed                             | Approximately, research             | CacheBlend and LMCache recompute the 10-20% of tokens whose values deviate most. They report quality "within 0.02" F1 and 2.2-3.3x faster first token. vLLM only.                                                                                                            |
| Reuse a chunk after the change exactly                              | No                                  | Each token's value depends on everything before it. Nothing short of recomputing restores that.                                                                                                                                                                              |
| Keep the start and recent tokens only ("attention sinks")           | Yes, as a different model behaviour | StreamingLLM keeps the first 4 tokens plus a recent window, with positions renumbered inside the cache. It gives fluent long generation, not memory: "The context window remains unchanged".                                                                                 |

So the useful form of "segments" is to make the parts that change rarely come first, and to put a saved point at each boundary. Planned compaction (section 6) does both.

## 3. Findings: how each provider and server caches

### 3.1 Anthropic (Claude API)

Source: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>, read 2026-11-15, plus the bundled `claude-api` skill reference `shared/prompt-caching.md`.

- **Breakpoints:** up to 4 `cache_control` breakpoints per request. Prefixes are hashed in the order `tools`, `system`, `messages`.
- **Lookback:** "The system checks at most 20 positions for each breakpoint, counting the breakpoint itself as the first."
- **Minimum cacheable size:** 512 tokens for the 5.x models (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.x), 1,024 for Opus 4.8, Sonnet 5 and Sonnet 4.6, 2,048 for Opus 4.7, 4,096 for Opus 4.5 and 4.6 and Haiku 4.5. Below the minimum nothing is cached and no error is returned.
- **TTL:** 5 minutes by default, refreshed free on each use; optional `"ttl": "1h"`.
- **Price:** a 5-minute write costs 1.25x base input and a 1-hour write 2x. A read costs 0.1x (0.05x on Opus 5.5 and Sonnet 5.5).
- **Pre-warm:** a `max_tokens: 0` request runs prefill, writes the cache and returns `content: []` with no output billed. It is rejected with `stream: true`, `thinking.type: "enabled"`, structured outputs, forced `tool_choice`, the top-level `compaction` parameter and in Batches. It must match the real traffic's `thinking` and `effort` settings, "a pre-warm with different settings can write a cache entry your real traffic never hits".
- **Context editing** (beta `context-management-2025-06-27`, <https://platform.claude.com/docs/en/build-with-claude/context-editing>): `clear_tool_uses_20250919` with `trigger` (default 100,000 input tokens), `keep` (default 3 tool uses), `clear_at_least`, `exclude_tools` and `clear_tool_inputs`. The docs say clearing "Invalidates cached prompt prefixes when content is cleared. To account for this, clear enough tokens to make the cache invalidation worthwhile. Use the `clear_at_least` parameter". This is the same block-drop idea as (a) below.
- **Server compaction** (`compact_20260112`, beta `compact-2026-01-12`, <https://platform.claude.com/docs/en/build-with-claude/compaction-threshold>): the default trigger is 150,000 input tokens, the minimum 50,000. With a breakpoint at the end of the system prompt, "Only the compaction summary needs to be written as a new cache entry."

### 3.2 Amazon Bedrock Converse `cachePoint`

Source: <https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html>.

- 4 checkpoints per request for Claude; allowed in `tools`, `system` and `messages`. TTL 5 minutes or 1 hour (`"ttl": "1h"`).
- The minimum "applies cumulatively to the entire prompt prefix before each checkpoint"; there is "no minimum number of tokens required between cache checkpoints". Minimums are the same as Anthropic's, except that Bedrock lists 4,096 for Opus 4.7 where Anthropic lists 2,048.
- Lookback: "about 20 content blocks before your cache checkpoint".
- A cache entry lives on one server, so requests served by another server write a new entry.
- Nova: 1K minimum, 4 checkpoints, at most 20K cached tokens.
- Whether Converse accepts a 0-token pre-warm is **unverified**; a 1-token request is the safe form.

### 3.3 OpenAI

Source: <https://developers.openai.com/api/docs/guides/prompt-caching>.

- Automatic: "Cache reuse requires the entire rendered prefix to match". The minimum is 1,024 tokens, and cached tokens are counted in steps of 128.
- `prompt_cache_key` helps routing. Retention for earlier models is `in_memory` (about 5 to 10 minutes) or `24h`; for GPT-5.6 and later, `prompt_cache_options.ttl` is `30m` or `12h`. GPT-5.6 and later also take explicit breakpoints, with at most 4 cache writes.

### 3.4 Gemini

Source: <https://aistudio.google.com/docs/caching?generate-content=true>.

- Implicit caching is on for Gemini 2.5 and newer. The minimum is 4,096 tokens for the current models and 2,048 for 2.5.
- Explicit `cachedContents` (beta) has a 1-hour default TTL and bills storage time; "Explicit caching is not supported for Gemini 4 models". Explicit-cache minimums per model are **unverified**.

### 3.5 llama.cpp server

Sources: `tools/server/README.md` and `tools/server/server-context.cpp` on `master` at <https://github.com/ggml-org/llama.cpp>, and PR #9866 ("server : reuse context chunks", merged 2024-10-13).

- `cache_prompt` (default on) reuses the longest common prefix with the slot's KV.
- `--cache-reuse N` / `n_cache_reuse` (default 0, off): after the common prefix, scan the cached tokens. Any run of at least N tokens that also appears in the new prompt is kept: the gap is removed (`seq_rm`) and the run is shifted to its new position (`seq_add`, a RoPE re-rotation). "processing for these tokens will be skipped". This is the approximate chunk reuse of section 2. It is disabled when the context cannot shift (M-RoPE models such as Qwen-VL, multimodal requests, iSWA caches unless `--swa-full`).
- `--context-shift` (default off): when the context overflows, discard half of the tokens after `n_keep` and shift the rest. It is approximate in the same way.
- `-cram, --cache-ram N` (default 8,192 MiB, PR #16391) keeps prompt caches of idle slots in host RAM. `--ctx-checkpoints` (default 32 per slot, PR #15293) saves state snapshots for models whose state cannot be truncated (SWA, recurrent). `--slot-save-path` with `POST /slots/{id}?action=save|restore` saves and restores a slot.

### 3.6 vLLM, LMCache, CacheBlend, EPIC

- **vLLM automatic prefix caching** (<https://docs.vllm.ai/en/latest/design/prefix_caching.html>): each full block's hash combines the "Parent hash value" and the block's tokens. Hashes chain from the first block, so a change early invalidates every later block. Eviction is LRU, and only full blocks are cached. The default block size of 16 is **unverified** (the page uses it as an example).
- **CacheBlend** (arXiv 2405.16444): "reuses the precomputed KV caches, regardless prefix or not" and "selectively recomputes the KV values of a small subset of tokens", 15% by default. The positional part is fixed exactly by rotating K; the remaining error is missing cross-chunk attention, which the recompute repairs.
- **LMCache** (<https://github.com/LMCache/LMCache>) implements this for vLLM, with tiers in CPU RAM, disk and Redis.
- **EPIC** (arXiv 2410.15332) is "Position-Independent Caching", claiming up to 8x faster first token "with negligible or no accuracy loss".

None of these is available on a cloud API or on Strata.

### 3.7 Attention sinks / StreamingLLM

arXiv 2309.17453 (ICLR 2024), <https://github.com/mit-han-lab/streaming-llm>. Keeping "four initial tokens as attention sinks" plus a recent window makes window attention stable to 4M+ tokens. It keeps the start and the end and discards the middle, so it is a way to generate forever, not to remember. The README says it does not "enhance their long-term memory".

### 3.8 Strata

Sources:

- the Strata repository at <https://github.com/Niko1221/Strata>, HEAD `baf163634` (2026-11-15; app 0.2.14, engine 0.1.60);
- the local server, engine 0.1.54. The features below landed between 2026-09-28 and 2026-10-15, so 0.1.54 should have them, but that was not checked against its tag (**unverified**).

**Reuse is exact-prefix, and it snaps to a checkpoint.** A prompt reuses the live session or a saved checkpoint only when it starts with exactly that checkpoint's tokens (`docs/DETAILS.md:714-720`). The model is a hybrid: Gated DeltaNet recurrent layers beside full attention. The recurrent state cannot be rewound (`docs/GDN_CONTRACT.md`), so a prompt can only restart from a saved snapshot ("checkpoint") of "the GDN recurrence, the PLE history, the QSA indexer tails" (`include/strata/program/conv_cache.hpp:4-9`).

**Where checkpoints go:**

- every `--prompt-cache-every` freshly read tokens, default 16,384 (`src/program/generate.cpp:1084`), placed at a prefill chunk end;
- at the last `<|im_start|>` (the turn boundary, `generate.cpp:19270-19277`);
- at the end of the system prompt when it is at least `--prompt-cache-root` tokens, default 2,048 (`generate.cpp:19287-19299`).

There are at most `--prompt-cache` checkpoints, default 6, at about 118 MB each (`DETAILS.md:717,1600`). The first is pinned; the rest are evicted least recently used first (`conv_cache.hpp:17-41`). This is the log's "6 checkpoints".

**Why exactly 16,384 was reused.** Our system prompt and tools are about 16k tokens. The first periodic mark at 16,384 became the pinned root. Reading 395k tokens creates about 24 more marks, of which only the newest 5 survive. Any change between 16,384 and the last 60 to 80k tokens therefore falls back to 16,384. A front drop falls back to 16,384 regardless.

**`--prompt-cache-spread`** (default off) evicts the checkpoint whose removal leaves the smallest gap, so the kept points thin out geometrically towards the start. An edit _d_ tokens back then re-reads about _d_ (`conv_cache.hpp:99-118`). Measured upstream: "resumed at 73,610 of 82,593 tokens, 10.2 s instead of 40.0 s" (`DETAILS.md:1558`). It helps late edits, not a front drop.

**Conversation cache** (`DETAILS.md:730-776`, `include/strata/core/conversation_cache.hpp:331-372`). It parks the outgoing branch (state, checkpoints, K/V pages) in host RAM before a rewind. A new prompt that starts at a parked entry's tokens or one of its checkpoints borrows it.

- `conversation_cache_min_tokens` 4,096: the smallest conversation that is parked.
- `conversation_cache_min_free_mib` 8,192: the RAM floor below which parking is skipped.
- Live state: `parks: 0, restores: 0, parked: 0` after 25 requests, so nothing was ever parked. The reason is most likely the RAM admission or floor (`generate.cpp:13200-13421`), but the server log was not read (**unverified**).
- Upstream issues: #5895 (a 260K conversation cannot be parked on 64 GB), #6002 (the server dies after a ~100K request with parking on), #5697 (evicted entries stay in the heap). These match the owner's earlier OOM at about 7 GB per parked 390k conversation.

**Request fields** (`DETAILS.md:476-511,725-729`; `serve/server.py:1640-1649,6093`):

- `"strata_prefix": {"messages": K}` (or `{"tokens": N}`, or `{"message": I, "chars": N}`) pins a checkpoint at a position the client chooses. Only one pin per engine, and it needs `--prompt-cache` of at least 3.
- `"strata_checkpoint": false` makes a one-shot request that saves no checkpoint and keeps no session.
- `return_progress` adds llama.cpp-style `prompt_progress`.

There is no `cache_prompt`, `n_keep`, `n_cache_reuse` or context shift.

**What the hybrid model rules out.** KV shifting is impossible on this model: the recurrent state has no positions to re-rotate, and the K/V arena holds one branch at a time (`conv_cache.hpp:6-10`). Approximate chunk reuse (section 2, rows 2 and 3) is therefore off the table on Strata.

**A `max_tokens: 1` request** reads the prompt, takes the usual checkpoints and stays as the live session, so a later request with the same prefix reuses it. That is inferred from the code path and **not tested**. Adding `strata_prefix` pins the boundary we choose.

**GET endpoints:** `/health`, `/v1/models`, `/props`, `/status`, `/slots`, `/metrics` (JSON, or Prometheus with `?format=prometheus`), `/api/requests` (`DETAILS.md:425-436`).

**`/metrics` fields we use:**

- `engine.context` / `max_context`: 524,288.
- `live.prefill_tok_s_mean`: 4,900.4 during a re-read.
- `requests[].prompt_tokens`, `reused`, `prompt_read`, `prompt_ms`, `decode_tok_s` (53.5 to 85.0 in the last seven requests).
- `conversation_cache.*`.

### 3.9 Other agents

Fetched 2026-11-15 from the projects' sources (copies in the session scratchpad):

| Agent                  | Trigger                                                                                                                                     | What it removes                                                                                                                    | Summary placement                                                                                 | Cache-aware                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code            | At the model's limit (about 967K on 1M models); `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (code.claude.com docs) | The whole history becomes a summary                                                                                                | After the system prompt and project context; "By design, this invalidates the conversation layer" | Yes: the summary request reads the warm cache; images are dropped "a batch … at a time"                                                                        |
| Cline (legacy v3.40.0) | `contextWindow - 27k/30k/40k`, or `max(window - 40k, 0.8 × window)` (`context-window-utils.ts:19-32`)                                       | Half, or three quarters, of the messages after the first pair, at once (`ContextManager.ts:207,254-281`)                           | n/a (truncation)                                                                                  | Implicitly, through large cuts. Current SDK: trigger at 0.9 × 0.9 of the window, target 0.7, 20k recent kept; a comment guards against "compacting every turn" |
| Roo Code               | `window × 0.9 − reserved`; `autoCondenseContextPercent` default 100 (`context-management/index.ts:24`)                                      | Condense first; otherwise hide half the visible messages (`truncateConversation(…, 0.5)`)                                          | A user message at the end; earlier ones tagged, hidden not deleted                                | Implicitly                                                                                                                                                     |
| Codex CLI              | 90% of the window (`openai_models.rs:483-486,579-590`)                                                                                      | Everything, rebuilt once                                                                                                           | Recent user messages up to 20k tokens, then the summary (`compact.rs:69,408,748-790`)             | One rebuild per compaction                                                                                                                                     |
| Aider                  | `max_chat_history_tokens = min(max(input/16, 1024), 8192)` (`models.py:358`)                                                                | Summarises the older half in a background thread, swaps it in only if history did not change meanwhile (`base_coder.py:1002-1033`) | In the `done` chunk, after system, repo map and read-only files (`chat_chunks.py`)                | Yes: breakpoints on stable chunks, and `--cache-keepalive-pings` sends `max_tokens=1` every 295 s                                                              |
| OpenHands              | 240 events, or a token limit                                                                                                                | Forgets down to half, `keep_first=2`                                                                                               | Right after the kept head                                                                         | Rolling halving                                                                                                                                                |

Every one of them triggers rarely and then removes a large share at once. None trims a little on every turn. Aider already computes the summary in the background and applies it only if the span did not change. That is the planned compaction of section 6, without the pre-warm.

## 4. Current behaviour in this fork

### 4.1 The prune in `compileChatMessages`

Every chat request in the IDE goes through `llm/compileChat` (`gui/src/redux/thunks/streamNormalInput.ts:224-245`, then `core/core.ts:1995`) into `compileChatMessages` (`core/llm/countTokens.ts:427`), with `knownContextLength = correctedContextLength(this._contextLength, model)` (`core/llm/index.ts:1158-1179`).

1. The context length comes from `/v1/models` `meta.n_ctx` or `/props` `default_generation_settings.n_ctx` (`core/llm/localServers.ts:54-67,144-145`): 524,288 here.
2. Reserve: `countingSafetyBuffer = min(1000, 2% of context)` and `minOutputTokens = min(1000, maxTokens)` (`countTokens.ts:370-379,533-541`). The configured `maxTokens` (40k+ in the owner's logs) is _not_ reserved in full. Only 1,000 tokens are, and a local server then gets whatever is left as `max_tokens` (`core/llm/outputLimit.ts:22-37`; live: 15,697).
3. `inputTokensAvailable = context − 1000 − 1000 − tools − system − lastMessages` (`countTokens.ts:538-546`). `lastMessages` is the trailing tool sequence or the last user turn (`extractToolSequence`).
4. `overBy = history − inputTokensAvailable`, which equals `total − (context − 2000)`. That value only grows from turn to turn, because last turn's tail becomes this turn's history.
5. **The bug:** `pruneStep = floor(inputTokensAvailable × 0.1)` and `keepAtMost = history − ceil(overBy / pruneStep) × pruneStep` (`countTokens.ts:600-607`). The amount dropped is `k × pruneStep`, and `pruneStep` moves by a tenth of every change in the size of the last turn. A 10k-token tool result in the tail one turn and a 300-token reply the next move the drop by about 1,000 tokens. That is enough to cross a message boundary in either direction. The comment above it (`:594-598`) states the right intent: "keeps the cut where it was until the conversation has grown by a whole step". The step's base defeats it.
6. Messages are then removed from the front (`:609-616`), keeping the latest user message (`protectedUser`, `:577-580`) and never orphaning a tool result (`removeAt`, `:582-592`). `didPrune` reaches the ledger as `pruned`, which produces "the oldest messages were dropped to fit" (`gui/src/util/cacheSafeguards.ts:459`).

So once a conversation is over the limit, the cut jitters on every request whose last-turn size differs from the previous one. The live `/metrics` shows exactly that: requests at 409,586 (re-read), 408,502, 410,758, 411,082 and 411,436 (hits), then 411,101 (shorter than the one before, re-read) and 412,266 (re-read).

### 4.2 The token estimate for Qwen

`encodingForModel` (`countTokens.ts:75-87`) uses `gpt-4`'s tiktoken only when `autodetectTemplateType` returns nothing or `"none"`. A model id containing `qwen` matches none of the earlier branches and gets `"chatml"` (`core/llm/autodetect.ts:406`), so it is counted with the Llama 2 SentencePiece tokenizer (32k vocabulary; Qwen's is about 150k). `getAdjustedTokenCountFromModel` (`core/llm/getAdjustedTokenCount.ts`) has no Qwen factor. Measured ratio, from the live `max_tokens` grant: 1.231. The overflow correction (`core/llm/contextOverflow.ts:86-128`) learns only from a refused request, and only upwards (`MIN_CORRECTION = 1`). Usage that shows we over-count is never used, so about 97k tokens of the 524k window are never used.

### 4.3 Other trimming paths

- **GUI compaction** (`core/util/conversationCompaction.ts`, called from `gui/src/util/compactConversation.ts`) runs only on request, from the context meter (`gui/src/components/mainInput/ContextMeter.tsx:421`) or a response's Compact button (`gui/src/components/StepContainer/ResponseActions.tsx:53-82`, highlighted when pruned or above 80%). It reuses the warm prefix for the summary request (`conversationPrefix`, `conversationCompaction.ts:21-31`). There is no automatic compaction in the IDE.
- **Summary placement:** `constructMessages` appends the summary _to the system message_ (`gui/src/redux/util/constructMessages.ts:392-396`). The system turn therefore changes at every compaction. On Strata that loses the system-prompt checkpoint; on Anthropic it invalidates the system breakpoint.
- **CLI auto-compaction** (`extensions/cli/src/compaction.ts:282-310,322-367`): it triggers at `inputSpace − min(max(maxTokens, 0.2 × inputSpace), 15,000)`, i.e. within 15k tokens of the limit. `contextManagement.autoCompactRatio` and `autoCompactTokens` override it. It is counted with `gpt-tokenizer`. The CLI does not drip: it compacts once.
- **History ageing** (`core/util/contextAgeing.ts`, masking old tool results) is off unless `CONTINUE_HISTORY_AGEING` is set (`core/llm/index.ts:1125-1130`, `contextAgeing.ts:281`).
- **Images** become text when the model takes none (`countTokens.ts:451-458`). Ageing and "Choose what to keep" (`gui/src/util/selectiveCompaction.ts`) are the only other edits.
- **Command output caps** (#887) bound a single result at write time, so they do not change old messages.
- **Cloud breakpoints** (`core/llm/llms/anthropicCache.ts:56-145`, `Anthropic.ts:334,642`) go on the last tool, the system prompt and the last block of the last two user messages: all 4. Bedrock uses the same placement through `bedrockCachePointFields` (`core/llm/llms/bedrockHelpers.ts:488`).
- **Pre-warm:** none exists. The tool-list hold (#895, `gui/src/util/toolListHold.ts`, `core/tools/toolListHold.ts`) is the pattern for "wait while the cache is warm and say so".

## 5. Strategy comparison on the owner's case

Assumptions:

- 524,288-token window, a 407k-token prompt (real count) of which the head (system and tools) is 16k, growing about 1k real tokens per turn;
- local prefill 4,630 tokens/s (measured: 394,717 tokens in 85.2 s), with 1,700 tokens/s (the owner's earlier figure) in brackets, and decode 55 to 85 tokens/s (measured);
- a summary of 6k tokens and a verbatim tail of 52k;
- cloud prices for Claude Opus 5.5: $4/M input, $20/M output, $0.20/M cache read, $5/M 5-minute write.

| #   | Strategy                                                                    | What changes in the prompt                    | Re-reads per 100 turns              | Local time per 100 turns (foreground)                                                                        | Cloud per event                                                                                       | History lost                | Verdict                                                                                        |
| --- | --------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| 0   | Today                                                                       | Cut jitters after the head                    | ~40 (3 of the last 7 requests)      | ~57 min (2.6 h)                                                                                              | ~$1.98 rewrite of 395k                                                                                | 41k+ at a time, silently    | The bug                                                                                        |
| 0'  | Today's step fixed only (constant step = 10% of window)                     | Cut moves once per ~52k growth                | ~2                                  | ~3 min (8 min)                                                                                               | $1.98                                                                                                 | ~52k per event              | Necessary, not sufficient                                                                      |
| a   | Block drop with hysteresis: over the limit, drop to 65% of the window       | Cut moves once per block (~140k real)         | ~0.7                                | ~50 s (2.3 min)                                                                                              | ~$1.70 (340k rewrite)                                                                                 | ~84k per event              | The forced fallback                                                                            |
| b   | Proactive compaction at 70%, summary after the head                         | Once: `[head][summary][tail]`                 | ~0.35 (one per ~290 turns)          | ~4 s of re-read plus ~86 s of summary decode, per 290 turns                                                  | ~$0.20 summary + $0.29 write; saves $0.067/turn after                                                 | Summarised; full copy saved | The default                                                                                    |
| c   | Keep the head (system, tools, first user message), drop from the middle     | Same as 0 or a, one message later             | as 0 or a                           | saves at most ~2k of each 395k re-read (<1%); on Strata nothing, the root checkpoint already covers the head | saves ~$0.01                                                                                          | as 0 or a                   | Keep the first request verbatim inside the summary instead                                     |
| d   | Breakpoints at stable boundaries (system, summary end, rolling every K)     | n/a                                           | as 0 for a front drop               | n/a (local)                                                                                                  | a front drop still rewrites everything after the system prompt; rolling points help only middle edits | n/a                         | Use with b: system, end of summary, last two user messages                                     |
| e   | Clear old tool results in blocks (`clear_tool_uses`, `clear_at_least`)      | Every position after the first cleared result | one per block                       | like a                                                                                                       | like a, keeps the conversation text                                                                   | Old tool output only        | Later, cloud; locally the same as ageing in blocks                                             |
| f   | llama.cpp `--cache-reuse 256`                                               | Approximate reuse of the chunks after the cut | ~0 exact misses, quality unmeasured | near 0 on llama.cpp full-attention text models                                                               | n/a                                                                                                   | as 0                        | Not possible on Strata (GDN) or Qwen-VL (M-RoPE). Document for llama.cpp users, off by default |
| g   | Park the old conversation (Strata `conversation_cache`)                     | Nothing; the old branch is kept               | does not help a front drop          | 0 gain; ~7 GB RAM per parked 390k                                                                            | n/a                                                                                                   | n/a                         | Helps going back (A→B→A, fork), not trimming                                                   |
| h   | Ask before a big re-read                                                    | Nothing                                       | as the strategy it fronts           | 0                                                                                                            | 0                                                                                                     | n/a                         | Yes: for the forced path, and as the pre-compaction prompt                                     |
| P   | **Planned compaction** (b + fixed boundary + background summary + pre-warm) | Once, prepared ahead                          | ~0.35                               | **0 s** when pre-warmed while idle; otherwise ~12.5 s (34 s)                                                 | as b; the pre-warm moves the same write earlier                                                       | Summarised; full copy saved | **Chosen**                                                                                     |

How the numbers were computed:

- **Row 0:** 3 re-reads of 394k at 85 s in the last 7 requests, i.e. 0.43 per turn: 100 × 0.43 × 85 s ≈ 61 min.
- **Row a:** the limit is at ~424k real (section 4.2), so 424k − 340k = 84k is dropped per event. With the token ratio fixed (C102) the limit rises to about 520k real and the block becomes ~180k.
- **Row b:**
  - The summary request appends about 500 tokens to the warm prompt: it reads 0.1 s and decodes 6k tokens in about 86 s at 70 tokens/s, in the background.
  - The switch-over reads `summary + tail` = 58k at 4,630 tokens/s = 12.5 s; the 16k head is a hit.
  - The next compaction comes after (367k − 74k) / 1k ≈ 290 turns.
  - Cloud: the summary reads 407k from the cache ($0.081) and writes 6k of output ($0.12). The switch writes 58k ($0.29). Each later turn reads 74k instead of 407k from the cache, saving $0.067. Break-even is after (0.20 + 0.29) / 0.067 ≈ 7 turns. Against "do nothing", each forced drop costs a 395k rewrite at $1.98.
- **Claude Sonnet 5.5** ($2/$10, $0.10 read, $2.50 write): drop $0.99; compaction $0.25; saving $0.033/turn; break-even ~7.5 turns.

**Memory trade-off of the pre-warm on Strata.** With one slot the pre-warm _replaces_ the live session, so resident KV does not double. The old branch is parked only if the conversation cache admits it: about 7 GB for a 390k conversation, and `parks: 0` so far says it usually will not. The extra memory is therefore at most one parked snapshot plus the checkpoints (6 × 118 MB by default). The real risk is the one in issues #5895 and #6002, a large park on a full machine. The pre-warm must never be the reason a park happens. Section 6.3 commits at the pre-warm, so the old branch is not needed again.

**Cloud cost of a pre-warm.** It writes the same `summary + tail` entry the switch-over would write, so it costs nothing extra if the next turn comes within the TTL. If the person leaves and the entry expires, the write is lost: $0.29 on Opus 5.5 in the example. Hence it is off by default on cloud providers (section 8).

## 6. Planned compaction (the owner's strategy)

### 6.1 Plan the cut ahead

At the **prepare threshold** (section 8), compute a plan once and store it with the session:

- **head:** the system message and the tools, byte for byte as the last request sent them;
- **span:** history items `[0, b)`, which become the summary. `b` is the first history-item boundary after which the remaining items fit in the **tail budget**, chosen so the tail starts at a user turn and never splits a tool call from its result (reuse `extractToolSequence` and `normalizeTurns`);
- **tail:** items `[b, now)`, kept verbatim. Items added after the plan join the tail; `b` never moves while the plan is live.

The plan is recomputed only when the prompt is edited before `b` (an edit, a "Choose what to keep", a fork), when the model or its window changes, or after it is applied. The first user request is quoted verbatim at the top of the summary when it is under 2k tokens, which gives strategy (c)'s benefit without its cost.

### 6.2 Pre-compute the summary in the background

- **When:** the plan exists, the cache is warm (`warmCacheLoss`), and nothing is streaming. On a local server, also wait until the person has been idle for 10 s, so the summary does not hold the single slot while they type.
- **Request:** the conversation's last request, byte for byte, plus a summary instruction that names the span: "summarise items 1 to N; the rest stays". This is `conversationPrefix` (`conversationCompaction.ts:21-31`), so the prefix is read from the warm cache. The span is fixed, so the summary does not go stale as the tail grows; only the span's own edits invalidate it (section 6.1).
- **On Strata the summary request does not cost the live session.** Its prompt is the live prompt plus one user turn. There is a checkpoint at the last `<|im_start|>`, the turn boundary, so the person's next real turn resumes from that boundary and is a hit (inferred from `generate.cpp:19270-19277`, **verify** in the C106 live check).
- **Cancel on activity:** a message sent, or a tool call started, aborts the summary request and discards the partial result; it is retried at the next idle. On cloud providers it is not cancelled (it costs the same whenever it runs), only deferred while streaming.
- **Cost line:** the estimate of section 7 is shown before the first summary of a session on a cloud provider, and the summary counts against the loop and session budgets (C114).

### 6.3 Pre-warm `[head][summary][tail]`, then switch

The new prompt is `[system][tools]` unchanged, then the summary as a **user message** (`Previous conversation summary: …`), then the tail. Changing `constructMessages.ts:392-396` to stop appending to the system message is C104. The plan stays prepared until one of two things happens:

- **Local servers (Strata, llama.cpp):** once the summary is ready and the person is idle, send `[head][summary][tail]` with `max_tokens: 1`, `strata_prefix: {"messages": 2}` (the pin at the end of the summary) and the same reasoning and tool settings as real traffic. The request reads about 58k tokens, 12.5 s while nobody waits, and becomes the live session. Sending it **is** the switch: from then on requests use the compacted history. Before that, the person can dismiss the plan. Whether Strata honours `strata_prefix` on a 1-token request, and whether the next request hits at the pin, is verified by C106 on a live server before release; if not, the pre-warm is skipped and the switch costs the 12.5 s at the next turn.
- **Anthropic:** `max_tokens: 0`, non-streaming, the same `thinking` and `effort`, `tool_choice` auto. There is no pre-warm support in the fork today. Cloud pre-warm is later (C109), off by default.
- **Bedrock:** a 1-token Converse request with the same `cachePoint` placement (a 0-token one is **unverified**), in C109.

### 6.4 Align the saved points to the boundary

- **Strata:** the root checkpoint covers the head (system prompt checkpoint, `--prompt-cache-root`), and `strata_prefix` pins the end of the summary. Periodic checkpoints cover the tail. A later edit in the tail then falls back to the summary end, not to 16,384.
- **Anthropic and Bedrock** (C109): breakpoints on the system prompt (covers tools), the end of the summary, and the last two user messages. That is 4, so the separate last-tool breakpoint (`markLastToolForCache`) is dropped when a summary is present: the system breakpoint's prefix already contains the tools.

This is the exact form of "segments": head, summary and tail are each separately reusable, because they come in the order of how rarely they change.

### 6.5 What the person sees

- **When the plan is prepared:** a quiet line in the cache notices and the context meter menu: "Compaction prepared: a summary of turns 1 to 80 is ready. It applies at your next message without re-reading the conversation. [Compact now] [Not now]".
- **On a local server once pre-warmed:** "Compacted while you were away: turns 1 to 80 are summarised (the full conversation is kept in this session and can be viewed). [Undo, re-reads 407k tokens, ~85 s]".
- **Compact now** uses the prepared summary when there is one, and falls back to today's flow otherwise.
- **The forced path (strategy h).** When a request would cross the force threshold with no summary ready, or the last request was already pruned (D9), it holds like the tool-change hold (#895): "This turn will re-read about 390k tokens (about 85 s). [Compact now (~90 s, then fast)] [Send anyway, drops the oldest 84k tokens]".
- **In an agent loop, with nobody asked (C117, decision D9).** The hold above is for the person's own message from the chat input. An agent's request after a tool result, a Loop item's message and a resumed turn are never held, and the background summary of 6.2 waits for 10 s with nothing running, which a loop never gives it. So before such a request, when the prompt has reached the force threshold (or the last request was already pruned), the turn compacts instead of dropping: a summary ready for the plan is saved at once; otherwise, on a local server, it is made then, from the last request's own prompt, which the server still holds, while "Generating conversation summary" shows above the span's last item and Stop stops it with the turn. A cloud provider uses only a ready summary. The block drop stays the fallback: planned compaction off, the plan answered with Continue anyway at the hold, no boundary, or a failed summary.
- **When the cache missed because of a drop**, the miss notice says the conversation no longer fits the window, says when the drop came between two of the agent's tool rounds, and offers Compact now (when nothing is streaming), with a pointer to `contextManagement.plannedCompaction` when it is off. The cause list itself is unchanged, so the ledger's wording stays the same.
- **No silent loss:** the compacted-away turns stay in the saved session (`conversationSummary` already keeps them in history, `constructMessages.ts:214-224`) and stay visible above the summary, collapsed. A block drop is announced with the turn range, never only as `isPruned`.

## 7. The cost and time of Compact now

The plan of section 6 makes the estimate exact in its inputs: the span, the head and the tail are known token counts. The estimate is a pure function (C107) of the following inputs.

**Inputs:**

- `head`, `span`, `tail`: tokens as the provider counts them, from the calibrated estimate (C102) or from the last request's usage;
- `summaryOut`: the expected summary length (default 6k; the median of the session's earlier summaries once there is one);
- `warm`: whether the cache holds the conversation (`warmCacheLoss`); on cloud providers, unknown when the TTL is near expiry, so both outcomes are given;
- **pricing:** `findModelPricing` (`core/llm/utils/calculateRequestCost.ts`), the same source as the cost chip and the session ledger;
- **local speeds:** Strata `/metrics` `live.prefill_tok_s_mean` and the median `requests[].decode_tok_s` of the last 10 requests. Without them, use the ledger's own timings (`latencyMs`).

**Outputs:**

| Part                  | Cloud (dollars)                                                                      | Local (seconds)                                                            |
| --------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Summary request       | `read × (head+span+tail)` if warm, else `write × same`; plus `out × summaryOut`      | `~0` prefill if warm, else `(head+span+tail)/prefill`; `summaryOut/decode` |
| Switch-over           | pre-warmed: the new message only; otherwise `write × (summary+tail)` + `read × head` | pre-warmed: 0; otherwise `(summary+tail)/prefill`                          |
| Saving per later turn | `read × (span − summary)`                                                            | prefill unchanged per turn; avoided misses × miss time                     |
| Break-even            | `(summary + switch) / saving per turn`, in turns                                     | turns until avoided misses exceed the summary and switch time              |
| Do nothing            | next forced drop: `write × (everything after head)`                                  | `(everything after head)/prefill`                                          |
| Drop oldest instead   | `write × (tail+span−block)`, plus the history lost                                   | same in seconds                                                            |

**Wording.** Always "about", with a range where cache state is uncertain. For example, on Opus 5.5: "Compact now: about $0.20 for the summary and $0.29 to rewrite the cache ($0.49 to $2.30 if the cache has expired). Each later turn is about $0.07 cheaper, so it pays for itself after about 7 turns. Not compacting: the next forced drop rewrites about 390k tokens, about $1.98". On Strata: "Compact now: about 90 s in the background, then about 12 s once (0 s if prepared while you are away). Not compacting: about 85 s on each of the next few turns".

**Budgets:**

- An automatic compaction respects the loop's `maxCostUsd` (D-033: it asks when someone is watching, and when nobody is it falls back to a block drop and says so) and the item budgets (T5 to T8). The estimate is what gets compared with the remaining budget.
- A compaction that runs is charged to the item and the loop like any request.
- That wiring is C114, later, because the first slice is local-first, where cost is time.

**Test.** C108: a fixture session with recorded `/metrics` snapshots and the usage reported after compaction. The estimate must land within ±15% on time and ±5% on tokens.

## 8. Decisions

**D1. Drip-drop is impossible by construction.**

- The prune step is a constant derived from the context length, never from the room left after the last turn.
- When over, drop a block that brings the total down to the low-water mark.
- A test over 300 simulated turns with random tail sizes asserts the cut never moves back and moves at most once per block of growth (C101).

**D2. Local servers learn the real token ratio.**

- After each request, `usage.prompt_tokens` divided by our estimate of the same prompt gives the per-model factor. It may go below 1 (Qwen: 0.81), clamped to [0.6, 2], with a 5% headroom.
- The overflow correction stays as it is for refusals.
- Cloud providers keep today's behaviour until measured (C102).

**D3. Thresholds** (all as a share of the real window, after calibration; "reserve" is `max(1000, configured maxTokens up to 10% of the window)`):

| Provider class                                     | Prepare plan and summary | Apply                                | Force (summary not ready: block drop)    | Block drop target | Tail kept verbatim      | Pre-warm                   |
| -------------------------------------------------- | ------------------------ | ------------------------------------ | ---------------------------------------- | ----------------- | ----------------------- | -------------------------- |
| Local (`isLocalApiBase`, or `/props` answered)     | 70% (367k of 524k)       | Pre-warm at idle, else the next turn | 85% (446k), with the hold of section 6.5 | 60%               | min(15% of window, 64k) | On (`max_tokens: 1`)       |
| Cloud (Anthropic, Bedrock, OpenAI, Gemini, others) | 75%                      | The next turn                        | 90%, with the hold                       | 65%               | min(10% of window, 64k) | Off; a setting turns it on |

**D4. The summary goes after the head, never inside it** (C104).

**D5. Breakpoints on cloud providers, when a summary is present:** system prompt, end of summary, last two user messages (C109, later).

**D6. Off switches:**

- `contextManagement.plannedCompaction: false` in the model config falls back to block drop only. The CLI reads the same key.
- `contextManagement.prewarm: "off" | "local" | "always"` (default `"local"`).
- The CLI already has `contextManagement.autoCompactRatio` and `autoCompactTokens`; they keep their meaning and set the force threshold.

**D7. No KV shifting or chunk reuse in the product.** It is impossible on Strata and approximate elsewhere. llama.cpp users can turn on `--cache-reuse` themselves; the docs say what it trades.

**D8. Conversation-cache parking is not part of the plan.** The pre-warm commits the switch, so nothing waits for a parked branch.

**D9. A long agent loop compacts at the force threshold instead of block-dropping (C117, 2026-11-15).** Decided from the owner's 2.30.0 report on Strata (524,288 window, one slot): "The prompt cache missed 8 times in this session. The last request read 16k of 327k tokens. Likely cause: message 2 changed: an answer; the oldest messages were dropped to fit."

What the code and the server's metadata showed (`/metrics` `requests`, read with GET only: token counts and timings, no content):

- **The 8 misses were not block drops.** A block drop makes the prompt shorter, and `detectCacheMiss` does not count a shorter prompt (it is an expected rebuild). The misses were requests at 332,599, 333,173 and 335,976 tokens that grew, or shrank by less than 1,000 tokens, and reused exactly 16,384 (the root checkpoint: system prompt and tools), each about 68 s of prefill, between requests that reused all but a few hundred tokens. "Message 2 changed: an answer" is the first message after the head: the cut moved by one message without a block boundary being crossed.
- **Why the cut moved: the usage calibration (C102) moved the budget on every request.** `correctedContextLength` divides the window by the smoothed ratio, updated after each request (`learnTokenCalibration`, smoothing 0.3), so `forceAt`, `block` and the cut at `blocks × block` (`countTokens.ts`) moved by a few hundred tokens per request. In a tool loop, whose messages are a few thousand tokens each, that crosses a message boundary every few requests. C101's invariant (the block is a constant of the window) held for the window, not for the corrected window. **Fix:** the budget follows the smoothed ratio only once it has moved more than 2.5% from the value in use (`CALIBRATION_BAND`, half the 5% headroom, so the budget still never passes the real window).
- **Why nothing compacted: the hypothesis holds, with one more gap.** The hold (C108) is only for the chat input, the prepared summary is applied only at a person's turn, and the background summary never runs during a loop (busy). And the planner (C103) cut only at user turns: a loop that is one request followed by hundreds of tool rounds had either nothing to summarise or a tail of the whole loop. **Fix:** when the newest turn alone is over the tail budget, the planner may start the tail at a later tool round (an answer right after a tool result that no later result reaches back across; a turn's first answer stays with its request, so plain question-and-answer turns are cut as before).
- **The GUI's force threshold was later than core's.** Core prunes against the window less the calibration's 5% headroom; the hold compared with 85% of the real window, so between about 81% and 85% the drop came with no hold. The hold and C117 now use `forceAtTokens` (85% of the window / 1.05 on a local server), and a pruned last request no longer lends its ratio to the plan's sizes.

Decisions:

- **Before a request nobody is held for** (after a tool result, a Loop item's or a resumed turn's message), at the force threshold or with the last request pruned, the turn compacts with nobody asked when planned compaction is on: a ready summary at once, else on a local server one made then from the last request's prompt (a warm read and about 6k tokens of output, ~80 s at 75 tokens/s), after which `[head][summary][tail]` is read once (the tail is at most 64k). Against the drop: one read of the summary and the tail instead of ~300k (68 s) at the drop and at every later cut move, and the prompt falls to about 15% of the window instead of 60%. No prompt is added to the loop (friction): the choice the hold offers is made as its default, Compact now. IDGAF and headless runs never ask either way.
- **Not after Continue anyway** for the same plan: the person chose the drop. "Not now" on the prepared line does not stop it: that put the summary off at 70%, and at the drop it is still the better way. (Confirmed by the owner, 2026-11-15.)
- **Cloud: only a ready summary** until the loop budgets (C114) land. Making one costs money. (Confirmed by the owner, 2026-11-15.)
- **Summaries are made at force only, never in the foreground at the prepare threshold during a loop.** On a single-slot local server a summary started at 70% while the loop runs would queue against the loop's own requests, so it costs the loop the same ~80 s as making it at force, and it would be spent on loops that end before force. The background preparer still runs whenever the loop pauses for 10 s, for example while a tool waits for approval (that is not busy). (Decided by the owner, 2026-11-15.)
- **The hold also fires when the last request was already pruned** (`isPruned`), even when the GUI's estimate is under the force threshold. The GUI and core count differently (images, context items, the token ratio), and a pruned request means core is already cutting, so the person's next message would be cut as well. The hold then says the conversation is already past the point where the oldest turns are dropped. With no plan (below the prepare threshold, or planned compaction off) there is nothing to compact, and it does not hold. (Decided by the owner, 2026-11-15.)
- **The miss notice** names a drop, says when it came between the agent's tool rounds, and offers Compact now.

## 9. What the owner can change in Strata's config today

Flags go in the `"args"` list of the model's `strata-<model>.json`; `STRATA_*` switches go through `strata launch --set` (`DETAILS.md:19-36,476`; `docs/SETTINGS.md`). None of these fixes the front drop: that is C101 and C102 on our side. They help everything else.

- **`--prompt-cache-spread`**: keeps checkpoints spread back through the prompt, so an edit _d_ tokens back re-reads about _d_ instead of falling to 16,384. It helps "Choose what to keep", edited messages, forks and, after C104, the summary boundary.
- **`--prompt-cache 24`** (default 6): more checkpoints, about 118 MB of host RAM each, so 24 is about 2.8 GB. Pair it with `--prompt-cache-spread`. Lower it if RAM is tight; the conversation cache's 24 GB budget matters more.
- **Leave `--prompt-cache-every` at 16,384.** Denser marks only help with `--prompt-cache-spread` and cost RAM (an inference, not measured at 412k).
- **The conversation cache:** `parks: 0` means it is reserving 24 GB of budget for nothing on this workload, while issues #5895 and #6002 describe the OOMs. Consider `--conversation-cache-mib 8192` (or 0) until forks and A→B→A use it.
- **Upgrade from 0.1.54 to 0.1.60** only after checking #6052 (periodic checkpoints skipped on equal prompt chunks in 0.2.14).
- **`strata_prefix` needs `--prompt-cache` of at least 3:** the default 6 is enough, so C106 needs no config change.

## 10. Build plan

Size: S is up to a day, M up to three, L more. "Group" names which rows can be built in parallel: rows in the same group touch disjoint files. Tests run without a live server, using fixtures under `core/llm/__fixtures__/strata/` captured from `/metrics` (the seven requests quoted in section 4.1, captured by C107 and shared by C102, C106 and C108).

### 10.1 First slice for the next release: local servers

| ID   | What                                                                                                                                                                                                                                                                                                                                                  | Size | Depends    | Files                                                                                                                                                                                                                                                                                   | Test without a live server                                                                                                                                                                                    | Group |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| C101 | **No drip-drop.** The prune step is a constant from the context length; over the limit, drop a block down to the low-water mark (D3), so the cut only moves forward and at most once per block. Export the thresholds as one table for C103.                                                                                                          | S    | none       | `core/llm/countTokens.ts`, `core/llm/contextThresholds.ts` (new), `core/llm/countTokens.vitest.ts`                                                                                                                                                                                      | 300 simulated turns with random tail sizes from 100 to 20k tokens: the prefix after the head changes at most once per block, never moves back; today's code fails the same test                               | A     |
| C102 | **Calibrated token estimate for local servers.** Learn `usage.prompt_tokens / estimate` per model after each request (both directions, clamp [0.6, 2]); `correctedContextLength` uses it. Tell the overflow path and the usage path apart in the code.                                                                                                | S    | none       | `core/llm/contextOverflow.ts`, `core/llm/contextOverflow.vitest.ts`, `core/llm/index.ts` (usage hook only)                                                                                                                                                                              | The fixture's 412,266 real against 507,591 estimated gives 0.81 ± 0.01; a refusal still raises the factor; a cloud provider is unchanged                                                                      | A     |
| C103 | **Compaction plan.** Pure `planCompaction(history, counts, window, thresholds)` returns `{head, spanEnd, tail, state}`. The boundary stays fixed across turns, and is recomputed only on an edit before it, a model or window change, or after it is applied.                                                                                         | M    | none       | `core/util/compactionPlan.ts` (new), `core/util/compactionPlan.vitest.ts`                                                                                                                                                                                                               | Grows a 600-turn synthetic history: one plan, the same `spanEnd` for every turn until it is applied; never splits a tool call from its result; an edit before the boundary replans                            | A     |
| C104 | **Summary after the head.** `constructMessages` sends the summary as the first user message, not appended to the system message, so the system turn is byte-stable across compactions.                                                                                                                                                                | S    | none       | `gui/src/redux/util/constructMessages.ts`, `gui/src/redux/util/constructMessages.test.ts`, `core/util/conversationCompaction.ts` (summary prompt wording only)                                                                                                                          | A golden: the system message's bytes are identical before and after a compaction; alternation is kept for providers that need it                                                                              | A     |
| C107 | **Compact now estimate.** Pure estimator of section 7 for local (seconds, from `/metrics` speeds) and cloud (dollars, from `findModelPricing`), with ranges where the cache state is unknown.                                                                                                                                                         | S    | none       | `core/util/compactionEstimate.ts` (new), `core/util/compactionEstimate.vitest.ts`, `core/llm/__fixtures__/strata/metrics-*.json` (new)                                                                                                                                                  | The fixtures give 85 ± 5 s for a 394,717-token re-read and 12.5 ± 1 s for a 58k switch; Opus 5.5 prices give the section 5 dollar figures                                                                     | A     |
| C105 | **Background summary.** When the plan says "prepare", the GUI runs the summary request with `conversationPrefix` at idle (10 s on local servers), cancels on activity, and stores the result on the session with the span it covers. Compact now uses it when present.                                                                                | M    | C103       | `gui/src/redux/thunks/prepareCompaction.ts` (new), `gui/src/redux/slices/sessionSlice.ts`, `gui/src/util/compactConversation.ts`, `core/core.ts` (one message)                                                                                                                          | A mocked messenger: the summary starts after 10 s idle, aborts on a sent message, is discarded when the span is edited, and Compact now applies it without a second request                                   | B     |
| C106 | **Strata pre-warm and the pin.** Once the summary is ready and the person is idle, send `[head][summary][tail]` with `max_tokens: 1` and `strata_prefix: {"messages": 2}`; that commits the switch. Skipped when `/props` is not Strata or llama.cpp, or when `prewarm` is off.                                                                       | M    | C104, C105 | `core/llm/localPrewarm.ts` (new), `core/llm/localPrewarm.vitest.ts`, `core/llm/llms/OpenAI.ts` (pass-through of `strata_prefix` only), `gui/src/redux/thunks/prepareCompaction.ts`                                                                                                      | A request-body golden (fields, the same reasoning and tool settings as real traffic); a fixture where the next real request's `reused` equals the pin. A manual check on the live server is the release gate. | C     |
| C108 | **Compaction notices and the hold.** The "prepared" and "compacted while you were away" lines, the estimate on Compact now (context meter menu, cache notices, `useCompactionCacheNote`), the forced-path hold of section 6.5, and the turn range on a block drop. Plus the fixture test of the estimate against the usage reported after compaction. | M    | C105, C107 | `gui/src/components/mainInput/ContextMeter.tsx`, `gui/src/components/mainInput/CacheMissNotice.tsx`, `gui/src/hooks/useCompactionCacheNote.ts`, `gui/src/util/cacheSafeguards.ts`, `gui/src/util/compactionHold.ts` (new), `core/llm/__fixtures__/strata/session-compaction.json` (new) | Component tests for each line; the fixture session's estimate within ±15% of the recorded time and ±5% of the recorded tokens                                                                                 | C     |

| C117 | **Loops compact instead of dropping; the cut holds still.** Decision D9: compaction at a tool-round boundary (and before a loop's or resumed turn's message) at the force threshold, a tool-round boundary in the planner for a loop that is one long turn, the calibration band that keeps the block-drop cut in place, the GUI's force threshold aligned with core's, and the miss notice's wording and Compact now. | M | C101 to C108 | `gui/src/redux/thunks/compactAtToolRound.ts` (new), `gui/src/redux/thunks/streamResponseAfterToolCall.ts`, `gui/src/redux/thunks/streamResponse.ts`, `gui/src/redux/thunks/prepareCompaction.ts`, `gui/src/util/compactionHold.ts`, `gui/src/components/mainInput/CacheMissNotice.tsx`, `core/util/compactionPlan.ts`, `core/llm/contextOverflow.ts` | A mocked messenger: a 21-round loop at the threshold makes one summary from the previous request's prompt and saves it before the next request; Stop aborts it and sends nothing; a ready summary is saved with no request; cloud sends none. The planner cuts a one-request loop at a round and keeps that boundary. 60 wobbling calibration samples leave the budget and the cut unchanged. The notice's wording for a drop between tool rounds | D |

**Parallel groups:**

- **Group A** (C101, C102, C103, C104, C107) can start at once; their files are disjoint. C107 writes the metrics fixtures that C102 also reads; agree the folder name up front.
- **Group B** (C105) starts when C103 merges.
- **Group C** (C106 and C108) starts when C105 merges. C106 and C108 do not share files, except that C106 adds one call in `prepareCompaction.ts`, which C105 owns; land C106 second, or let C105 leave the hook.

C101 and C102 alone remove the drip and give back about 97k tokens of window. They are the smallest releasable piece if the rest slips.

### 10.2 Later

| ID   | What                                                                                                                                                                                                                                | Size | Depends       | Files                                                                                                                          | Why later                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| C109 | Cloud pre-warm and breakpoints: Anthropic `max_tokens: 0` (non-streaming, the same thinking and effort), Bedrock 1-token `cachePoint`; breakpoints on system, end of summary and the last two user messages (D5); `prewarm` setting | M    | C104, C105    | `core/llm/llms/anthropicCache.ts`, `core/llm/llms/Anthropic.ts`, `core/llm/llms/bedrockHelpers.ts`, `core/llm/llms/Bedrock.ts` | Cloud, and it costs money; measure on Bedrock first (C95 style) |
| C110 | Cloud thresholds (D3) and calibration from usage for cloud providers, measured per family before the factor is allowed below 1                                                                                                      | S    | C101, C102    | `core/llm/contextThresholds.ts`, `core/llm/contextOverflow.ts`                                                                 | Needs measurement                                               |
| C111 | CLI: the same plan, placement and thresholds in `extensions/cli/src/compaction.ts`, the summary after the head, and the background summary in the TUI                                                                               | M    | C103, C104    | `extensions/cli/src/compaction.ts`, `extensions/cli/src/stream/streamChatResponse.ts`                                          | The CLI does not drip today                                     |
| C112 | Old tool results cleared in blocks: history ageing (`contextAgeing.ts`) masks a block at a time with a `clear_at_least` floor; Anthropic `clear_tool_uses_20250919` with `clear_at_least` on the API                                | M    | C101          | `core/util/contextAgeing.ts`, `core/llm/llms/Anthropic.ts`                                                                     | Strategy e; a second lever after compaction                     |
| C113 | A Qwen token factor or vocabulary-level counter, so the first request of a session is estimated right before any usage exists                                                                                                       | S    | C102          | `core/llm/getAdjustedTokenCount.ts`, `core/llm/countTokens.ts`                                                                 | C102 covers it from the second request                          |
| C114 | Budgets: an automatic compaction is compared with the loop's `maxCostUsd` (D-033) and item budgets (T5 to T8) before it runs, and charged to them after                                                                             | S    | C107, C108    | `core/util/loopCost.ts`, `gui/src/redux/thunks/prepareCompaction.ts`                                                           | Cost is time on local servers                                   |
| C115 | Strata side: upstream requests for more than one `strata_prefix` pin, a checkpoint at a client-named message boundary on every request, and a pre-warm that never parks. Filed as issues, not built here                            | S    | C106 measured | none (issues on Niko1221/Strata)                                                                                               | Needs Strata                                                    |
| C116 | Docs: "Why a turn re-reads the whole prompt" gains the drop, the plan and the Strata flags of section 9; llama.cpp `--cache-reuse` explained as approximate (D7)                                                                    | S    | C101          | `docs/` local servers page                                                                                                     | After the behaviour ships                                       |

## 11. Sources

- **Live server:** Strata 0.1.54 at `http://127.0.0.1:8086`: `/v1/models`, `/props`, `/metrics`, `/slots`, `/status` (GET, 2026-11-15).
- **Strata:** <https://github.com/Niko1221/Strata> at `baf163634`: `docs/DETAILS.md`, `docs/GDN_CONTRACT.md`, `docs/PROMPT_CACHE_TAIL.md`, `docs/MESSAGE_BOUNDARY_CACHE.md`, `docs/SETTINGS.md`, `docs/RESEARCH_RUNS.md`, `include/strata/program/conv_cache.hpp`, `include/strata/core/conversation_cache.hpp`, `src/program/generate.cpp`, `serve/server.py`; issues #5641, #5697, #5825, #5861, #5895, #6002, #6006, #6052.
- **Anthropic:** <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>, <https://platform.claude.com/docs/en/build-with-claude/context-editing>, <https://platform.claude.com/docs/en/build-with-claude/compaction-threshold>.
- **Bedrock:** <https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html>.
- **OpenAI:** <https://developers.openai.com/api/docs/guides/prompt-caching>.
- **Gemini:** <https://aistudio.google.com/docs/caching?generate-content=true>.
- **llama.cpp:** <https://github.com/ggml-org/llama.cpp> `tools/server/README.md`, `tools/server/server-context.cpp`, PRs #9866, #15293, #16391.
- **vLLM:** <https://docs.vllm.ai/en/latest/design/prefix_caching.html>.
- **Papers and libraries:** CacheBlend <https://arxiv.org/abs/2405.16444>; LMCache <https://github.com/LMCache/LMCache>; EPIC <https://arxiv.org/abs/2410.15332>; StreamingLLM <https://arxiv.org/abs/2309.17453>, <https://github.com/mit-han-lab/streaming-llm>.
- **Agents:**
  - Claude Code: <https://code.claude.com/docs/en/model-config.md>, `/prompt-caching`, `/costs`, `/env-vars`.
  - Cline: <https://github.com/cline/cline> tag v3.40.0 `src/core/context/context-management/`, and `main` `sdk/packages/core/src/extensions/context/compaction-shared.ts`.
  - Roo Code: <https://github.com/RooCodeInc/Roo-Code> `src/core/context-management/index.ts`, `src/core/condense/index.ts`.
  - Codex CLI: <https://github.com/openai/codex> `codex-rs/core/src/compact.rs`, `protocol/src/openai_models.rs`.
  - Aider: <https://github.com/Aider-AI/aider> `aider/history.py`, `aider/coders/base_coder.py`, `aider/coders/chat_chunks.py`.
  - OpenHands: <https://github.com/OpenHands/software-agent-sdk> `llm_summarizing_condenser.py`.
