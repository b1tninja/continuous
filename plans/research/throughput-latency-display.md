# Throughput and latency display: what the agent is doing, and how fast (2026-11-15)

Status: research and design only, written against `main` at `548aefea9` (merge of #923). No code was changed. Provider documentation was read live on 2026-11-15 and is cited by URL in section 11. Upstream source is cited at a commit: llama.cpp `fc504f91d8`, Ollama `15af2b261c`, Strata `baf1636`. The owner's Strata server on 127.0.0.1:8086 was read with two GETs (`/v1/status`, `/metrics`) and nothing else; no chat request was sent to any server and no paid API was called.

The owner's ask: a ROADMAP item for an input and output tokens-per-second display that helps a person understand what the agent is doing, "if it's knowable", or at least whether tokens are being returned or drafted, with latency such as time to first token.

## 1. Summary

1. **Most of it is knowable without one extra request.** The phase (waiting, reading the prompt, thinking, writing, writing a tool call, running a tool) can be read from the stream for every provider we support, because each delta says what it is (reasoning, text or tool-call arguments) and local llama.cpp-style servers already send `prompt_progress`. Time to first token is measurable here for every provider. Output tokens per second is exact at the end of a turn whenever the provider returns a usage count, and an estimate (from characters) while the turn runs, except on llama.cpp, where the server can give the exact rate on every chunk.
2. **What only the server knows is uneven.** llama.cpp and Strata send `timings` (prompt and decode speed, cache reuse, draft tokens offered and accepted). Ollama sends nanosecond durations on its native API and the same `timings` on its OpenAI-compatible one. LM Studio's own API sends `stats` with tokens per second and time to first token. Bedrock sends one server latency number. Anthropic, OpenAI, Gemini and vLLM send token counts and no timing at all. A display must say which numbers are the server's, which were measured here and which are estimates, and show nothing when nothing is known.
3. **We already collect more than we show.** Core captures llama.cpp's prompt read speed, Bedrock's `metrics.latencyMs` and the prompt progress, but the chat shows only the progress line; the read speed is used only for the "a re-read would take about N s" estimates; Bedrock's latency sits in the cache ledger and is never displayed. The only tokens-per-second figure in the product is in the LLM console (off by default), and it is wrong on local servers that stream prompt progress, because it starts the clock at the first progress update instead of the first token (section 2.3).
4. **On the owner's machine the number that matters is time to first token, not output speed.** Strata's last request read 401,472 of 417,856 prompt tokens in 86.4 s (4,649 tok/s) and then wrote 729 tokens in 9.8 s (74.5 tok/s), with 420 of 530 drafted tokens accepted. Across the 37 requests since the server started, it spent 24.5 minutes reading prompts and 3.1 minutes writing. A "74 tok/s" badge would say the session was fast; "first token 86 s: re-read 401k of 418k tokens" says what happened and points at the cache miss.
5. **Proposed design:** one live line in the place that today says "Generating..." (phase, rate, time to first token, prefill speed and draft acceptance where the server reports them); a per-reply timing summary on hover and focus, saved with the reply; a per-request speed history in the usage tooltip and the J1 context panel; and the same line in the CLI's spinner row. Numbers update at most once a second, are never put in a live region, and an estimate always carries `~`.
6. **Rows J15 to J26** (section 10): a pure timing module in core, the server timings in `Usage` (with an Ollama native mapping that today drops every count and duration), the GUI live line, the per-reply summary, CLI parity (including prompt progress, which the CLI does not request today), the console fix, session history, accessibility, exact live speed on llama.cpp, and two owner decisions.

## 2. What we collect and show today

### 2.1 Inventory

| Signal                                        | Measured where                                                                                                                                                                                                                                 | Stored                                                                                                                       | Shown today                                                                                                                                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt read speed (`promptTokensPerSecond`)   | `core/llm/index.ts:1290-1305`: `timings.prompt_per_second` of any chunk on the OpenAI adapter path (llama.cpp, Strata, and Ollama's OpenAI endpoint), copied onto the final `Usage`                                                            | `Usage.promptTokensPerSecond` (`core/index.d.ts:1231`); `session.promptCache.promptTokensPerSecond` via `setPromptReadSpeed` | Not as a number. `streamNormalInput.ts:385-389` keeps it only when at least 1,000 tokens were read; `cacheSafeguards.ts:169-174` and `forkCost.ts:206-215` turn it into "a re-read would take about N s" in the cache and fork notices |
| Cache reuse on llama.cpp (`timings.cache_n`)  | `core/llm/index.ts:1294-1323`, used as `cachedTokens` when the usage has none                                                                                                                                                                  | `Usage.promptTokensDetails.cachedTokens`                                                                                     | In the cache tally and miss line                                                                                                                                                                                                       |
| Prompt progress (`prompt_progress`)           | Requested with `return_progress: true` only for local addresses whose `/props` looks like llama.cpp (`localServers.ts:251-275`, `core/llm/index.ts:1566-1577`); parsed by `promptProgressOf` (`localServers.ts:312-324`)                       | `session.promptProgress` while it streams; cleared by the first reply chunk (`streamNormalInput.ts:421-430`)                 | `StreamingToolbar.tsx:38-66`: "Reading the prompt: 140k of 300k tokens, 120k from the cache, about 40 s left" (`gui/src/util/promptProgress.ts`)                                                                                       |
| Recovery hold                                 | Core's text tool-call recovery (`recoveryHold` chunks)                                                                                                                                                                                         | `session.recoveryHold`                                                                                                       | "Checking the reply for a tool request (12 s)" after 10 s (`StreamingToolbar.tsx`), and the same in the CLI (`ActionStatus.tsx`)                                                                                                       |
| Bedrock server latency (`metrics.latencyMs`)  | `core/llm/llms/Bedrock.ts:1208-1209` (stream metadata) and `:1417` (non-streaming)                                                                                                                                                             | `Usage.response.latencyMs`; `CacheLedgerEntry.latencyMs` (`gui/src/util/cacheLedger.ts:43-46`, `:101-103`)                   | Nowhere in the chat. Only the Bedrock connection test shows a latency, its own wall-clock time (`BedrockConnectionTester.tsx:293`, `Bedrock.ts:909`)                                                                                   |
| Strata's own record (`/metrics` `requests[]`) | Read once after a request, only when the stream gave no cached count (K4, `core/llm/index.ts:1718-1747`, `localServers.ts:797-818`); parses `prompt_tokens`, `reused`, `prompt_read`, `prompt_ms`, `output_tokens` (`localServers.ts:728-757`) | `serverCache` on the stream's return value                                                                                   | In the cache-miss check; `first_engine_token_s`, `decode_tok_s`, `drafts_*` are not parsed                                                                                                                                             |
| Console `To First Token`, `Tokens/s`          | `gui/src/hooks/useLLMSummary.ts:38-62` from the LLM log timestamps                                                                                                                                                                             | In memory (the console view)                                                                                                 | `gui/src/components/console/Details.tsx:101-118`, only with `continuous.enableConsole` (off by default)                                                                                                                                |
| Elapsed time of a reply                       | GUI: none in the chat. CLI: `Timer` from the request start (`extensions/cli/src/ui/components/ActionStatus.tsx`)                                                                                                                               | No                                                                                                                           | CLI spinner row "(12s • esc to interrupt)"                                                                                                                                                                                             |
| Token counts and cost                         | Every provider's usage; `session.usage`; the cache ledger (200 entries)                                                                                                                                                                        | Session file, ledger                                                                                                         | Usage indicator and context meter (GUI); context % and, with `--verbose`, cost in the CLI status bar (`BottomStatusBar.tsx`); Stats page totals per day and model (`gui/src/pages/stats.tsx`, `core/core.ts:2185-2191`)                |
| Server slots and busy state                   | `serverConcurrency` (`/v1/status`, `/props`) and `serverBusyElsewhere` (`/slots`) in `localServers.ts:598-701`, for subagent scheduling and Tab                                                                                                | Cached per address                                                                                                           | Not in the chat                                                                                                                                                                                                                        |

### 2.2 What the CLI does

The CLI streams through `@continuedev/openai-adapters` in `extensions/cli/src/stream/streamChatResponse.ts`, not through core's `BaseLLM.streamChat`, so none of the core path above applies to it. It reads `chunk.usage` (`streamChatResponse.ts:516-520`) and nothing else: no `timings`, no `return_progress`, so a long prompt read on a local server shows only a spinner and an elapsed timer. The status bar has the mode, model, context percentage and (verbose) cost; there is no scriptable status line.

### 2.3 A bug in the console's figures

`BaseLLM.streamChat` logs every chunk as a `message` item (`core/llm/index.ts:1617-1624` through `processChatChunk`, `:1228`), including the empty `promptProgress` chunks of a local server. `useLLMSummary` takes the first logged item as the first token, so on llama.cpp and Strata "To First Token" is the time to the first progress update (a second or two) instead of the time to the first token (86 s in the example in section 5), and "Tokens/s" divides the output by a span that includes most of the prompt read. The figures are right for providers that send no progress. Row J21 fixes it by having the console read the same timing record as the chat.

## 3. What each provider exposes

### 3.1 Table

"Live" means during the request on the stream we already read; "end" means on the last chunk or the final response; "extra" means only from another request, which this design does not make.

| Provider (path we use)                           | Token counts                                                                                                                                                                    | Server timing                                                                                                                                                                                                                   | Prompt progress                                                     | Drafting / speculative                                                                                    | Phase from the stream                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic Messages                               | Input (and cache read/write) at `message_start`; output cumulative in `message_delta`, normally at the end                                                                      | None                                                                                                                                                                                                                            | No                                                                  | No                                                                                                        | `thinking_delta`, `text_delta`, `input_json_delta`; with thinking `display: "omitted"`, a thinking block with no text                                                           |
| Bedrock ConverseStream                           | `metadata.usage` at the end                                                                                                                                                     | `metadata.metrics.latencyMs`, "the latency for the streaming request" (end)                                                                                                                                                     | No                                                                  | No                                                                                                        | Reasoning, text and tool-use deltas                                                                                                                                             |
| Bedrock InvokeModel / Mantle                     | In the body or usage chunk                                                                                                                                                      | No latency header in the API reference (only `PerformanceConfig-Latency` and `Service-Tier`); CloudWatch `TimeToFirstToken` and `InvocationLatency` are aggregates (extra, and AWS-side)                                        | No                                                                  | No                                                                                                        | As the body format allows                                                                                                                                                       |
| OpenAI and OpenAI-compatible cloud               | With `stream_options.include_usage` (we set it, `packages/openai-adapters/src/apis/OpenAI.ts:83-86`), one extra chunk before `[DONE]`; may be lost if the stream is interrupted | None                                                                                                                                                                                                                            | No                                                                  | `accepted_prediction_tokens` / `rejected_prediction_tokens` for Predicted Outputs                         | Content, `reasoning_content` where sent, tool-call deltas; o-series reasoning is not streamed                                                                                   |
| Gemini                                           | `usageMetadata` (`promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount`)                                        | None in `GenerateContentResponse`                                                                                                                                                                                               | No                                                                  | No                                                                                                        | Thought parts, text, function calls. Whether every streamed chunk carries a running `usageMetadata` is not documented; our adapter takes whatever arrives (`Gemini.ts:483-500`) |
| Ollama native `/api/chat`                        | `prompt_eval_count`, `eval_count` (end)                                                                                                                                         | `total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration`, all in nanoseconds (end); tok/s is `eval_count / eval_duration * 1e9`                                                                               | No                                                                  | No (no CUDA speculative decoding, `local-inference-lab.md` 4.3)                                           | Thinking and content fields, tool calls                                                                                                                                         |
| Ollama OpenAI-compatible `/v1`                   | `usage`, `prompt_tokens_details.cached_tokens`                                                                                                                                  | `timings` in llama.cpp's names on completions and chunks (`openai/openai.go`), with `prompt_per_second = prompt_eval_count / prompt_eval_duration`, cached tokens included (section 3.2)                                        | No                                                                  | No                                                                                                        | As OpenAI                                                                                                                                                                       |
| llama.cpp `llama-server`                         | `usage`; `timings.prompt_n`, `cache_n`, `predicted_n`                                                                                                                           | `timings` at the end: `prompt_ms`, `prompt_per_second`, `predicted_ms`, `predicted_per_second`; on every chunk with `timings_per_token: true` (its own web UI sets it)                                                          | `prompt_progress` with `return_progress: true` (we send it)         | `timings.draft_n`, `draft_n_accepted` when drafting ran; `/metrics` counters (extra, needs `--metrics`)   | `reasoning_content`, content, tool-call deltas                                                                                                                                  |
| Strata                                           | `usage` with `cached_tokens`                                                                                                                                                    | `timings` in llama.cpp's names at the end, from the engine clock, including `draft_n` and `draft_n_accepted`; `/metrics` `requests[]` adds `first_engine_token_s`, `duration_s`, `decode_tok_s` (extra)                         | `prompt_progress` (same fields as llama.cpp, `server.py:7164-7181`) | Yes, in the final `timings` and `/metrics` `drafts_offered` / `drafts_accepted`; engine `drafting: "mtp"` | As llama.cpp; `/metrics` `live.phase` names the same phases (extra)                                                                                                             |
| vLLM                                             | `usage` (with `include_usage`)                                                                                                                                                  | None per request in the response; Prometheus histograms (`vllm:time_to_first_token_seconds`, `vllm:inter_token_latency_seconds`, `vllm:request_queue_time_seconds`, `vllm:request_prefill_time_seconds`) are aggregates (extra) | No                                                                  | `vllm:spec_decode_*` counters (extra)                                                                     | As OpenAI                                                                                                                                                                       |
| LM Studio, OpenAI-compatible `/v1` (what we use) | `usage`                                                                                                                                                                         | Not documented on that endpoint                                                                                                                                                                                                 | No                                                                  | Not documented                                                                                            | As OpenAI                                                                                                                                                                       |
| LM Studio native `/api/v1/chat`                  | `stats.input_tokens`, `total_output_tokens`, `reasoning_output_tokens`                                                                                                          | `stats.tokens_per_second`, `time_to_first_token_seconds`, `model_load_time_seconds` (in `chat.end`)                                                                                                                             | `prompt_processing.progress` (0 to 1) and `model_load.progress`     | Not documented                                                                                            | `reasoning.*`, `message.*`, `tool_call.*` events                                                                                                                                |
| OpenRouter                                       | `usage`                                                                                                                                                                         | `GET /api/v1/generation` after the request: `latency`, `generation_time`, `moderation_latency` (extra). Endpoint list: `latency_last_30m` (time to first token, ms) and `throughput_last_30m` percentiles (extra)               | No                                                                  | No                                                                                                        | As OpenAI                                                                                                                                                                       |

### 3.2 Notes per provider

- **Anthropic.** The streaming page lists the flow `message_start`, content blocks with deltas, "one or more `message_delta` events" and `message_stop`, and warns that "the token counts shown in the `usage` field of the `message_delta` event are _cumulative_". `message_start` already carries `input_tokens` and the cache counts, so the prompt size is exact from the first event, before any output. There is no server timing. With thinking `display: "omitted"` the thinking block "receives a `thinking_delta` with an empty `thinking` string and then a single `signature_delta`", so the client can say "Thinking (not shown)" but cannot measure its rate until the final `output_tokens`, which counts thinking and text together. Our parser reads `message_start` and `message_delta` usage at `core/llm/llms/Anthropic.ts:494-508`.
- **Bedrock.** `ConverseStreamMetrics.latencyMs` is "the latency for the streaming request, in milliseconds", one number at the end; it is already captured. The `InvokeModel` and `InvokeModelWithResponseStream` API references list no latency or token-count response header (the "invocation latency headers" the ask mentions are not in either reference), so this design does not rely on them. AWS's own throughput guide defines output tokens per second as `OutputTokenCount / (InvocationLatency - TimeToFirstToken) * 1000` over CloudWatch metrics; the client can compute the same per request from its own first-token time and end time, which is what section 6 does for every provider.
- **OpenAI.** `include_usage` sends "an additional chunk ... before the `data: [DONE]` message" whose usage covers the whole request, and "if the stream is interrupted, you may not receive the final usage chunk". A stopped turn therefore has no exact count; its rate must be an estimate or nothing.
- **Gemini.** Token counts only, including `thoughtsTokenCount` for thinking models. No timing field.
- **Ollama.** "All durations are returned in nanoseconds"; the documented rate is `eval_count / eval_duration * 10^9`. Two findings for us: (a) our native `Ollama` provider declares these fields in its response type (`core/llm/llms/Ollama.ts:100-110`) but never maps them, so a native Ollama turn has no usage at all, not even token counts; (b) on Ollama's OpenAI-compatible endpoint `ToTimings` computes `prompt_per_second` as `PromptEvalCount / PromptEvalDuration`, while its own `--verbose` summary subtracts the cached tokens first ("prompt eval rate" uses `uncached := max(0, m.PromptEvalCount-cached)`, `api/types.go`). Core copies `prompt_per_second` as is, so after a cache hit on Ollama the stored read speed is too high and the "a re-read would take about N s" estimate too short. J16 recomputes it from `prompt_n - cached_tokens`.
- **llama.cpp.** The README documents `timings` ("This provides information on the performance of the server"), `return_progress` with `prompt_progress` ("the actual timed progress is `(processed-cache)/(total-cache)`"), and `timings_per_token` ("Include prompt processing and text generation speed information in each response", default `false`). The server code adds `draft_n` and `draft_n_accepted` to `timings` only when draft tokens were produced (`tools/server/server-common.cpp`, `if (n_draft_tokens > 0)`). The bundled web UI asks for `timings_per_token: true` and `return_progress` and shows `predicted_per_second` live and the prompt progress percentage (`tools/ui/src/lib/stores/chat/processing.svelte.ts`, status `preparing` then `generating`). The Prometheus metrics (`llamacpp:prompt_tokens_seconds`, `llamacpp:predicted_tokens_seconds`, `llamacpp:requests_deferred`, `llamacpp:spec_decode_num_accepted_tokens_total`) need `--metrics` and are server-wide averages.
- **Strata** (source at `baf1636`, live read 2026-11-15). The final chunk carries `usage` with `cached_tokens` and, when the engine has a clock, `timings` in llama.cpp's names, built by `request_timings` (`serve/server.py:6849-6870`) and including `draft_n` / `draft_n_accepted` when the engine reported drafts. Strata does not implement `timings_per_token` or `stream_options` (no match in `server.py`); it always sends usage at the end. `prompt_progress` mirrors llama.cpp's four fields. `/metrics` `live` has `state` (`reading`, `generating`, `idle`, `unloaded`), `queued`, `phase` (`thinking`, `answering`, `writing a tool call: <name>`, `tool call complete`; `server.py:6178-6187`), `prompt_read` / `prompt_total`, `generated`, `tok_s` over a window, `tok_s_mean` and `prefill_tok_s_mean` (`server.py:5751-5761`). Each `requests[]` entry has `first_engine_token_s` ("from entering the engine queue; includes queue/prefill", `server.py:6302`), `duration_s`, `decode_tok_s`, `prompt_read`, `reused`, `drafts_offered`, `drafts_accepted`, and `hit_rate`, which is the **expert** cache hit rate of the MoE engine, not the prompt cache, and must never be labelled as cache reuse. `/v1/status` adds `activity.in_flight` and `last_timings`. Everything in `live` is also derivable from the stream we already read, so the design does not poll it.
- **vLLM.** Only Prometheus aggregates; nothing per request in the response is documented. Client-side measurement is the only per-turn source.
- **LM Studio.** The documented `stats` and `prompt_processing.progress` events are on its own REST API (`/api/v1/chat`; `/api/v0/chat/completions` also returns `stats`), not on the OpenAI-compatible endpoint our provider uses. Getting them means moving LM Studio to its native API, a provider change outside this note (section 9, D5).
- **OpenRouter.** Per-generation timing exists only through a second request to `/api/v1/generation`. The endpoint list's `latency_last_30m` ("Latency measures time to first token", milliseconds, authenticated only) and `throughput_last_30m` are useful for choosing a provider, not for explaining a turn; row J26 keeps them for the model picker, opt-in.

### 3.3 What the client can measure for every provider

Measured here, with no help from the server:

- **Time to response headers** (`sentAt` to the HTTP response): mostly network and admission; a local server answers headers at once even while queued.
- **Time to the first event** and **time to the first output token**: the first chunk that carries reasoning, text or a tool-call delta. The empty `{"role":"assistant","content":""}` chunk that OpenAI-style servers send first does not count: Strata sends it before the request is even admitted (`openai_chunks` yields it before `svc.run` starts, `server.py:7196`).
- **Inter-token gaps** and stalls (no delta for N seconds while the request is open).
- **Output rate from deltas**: characters per second over a sliding window, turned into tokens with the 4 characters per token rule already used by `core/llm/contextBreakdown.ts:66` and `gui/src/util/forkCost.ts:90`. An estimate, always labelled `~`.
- **Final output rate**: the provider's output count divided by the time from the first output token to the last. Exact count, our clock; labelled "measured here". It includes network jitter, so it reads a little lower than a server's decode rate.
- **Tool-call argument size and rate**: bytes of `arguments` so far. Size is the honest unit, because some servers send the arguments in one piece (Strata sends a non-streamed call's arguments whole, `server.py:7235-7240`).
- **Queue or wait time**: only as "no event yet". The client cannot tell a queued request from a slow network or a server that sends no progress; on a llama.cpp-style server, the absence of `prompt_progress` after a few seconds is a strong hint that the request is waiting (section 9, D3).

## 4. What other tools show

| Tool                   | What it shows                                                                                                                                                                               | Source                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| llama.cpp web UI       | Live generation tokens per second (`predicted_per_second`, from per-token timings), prompt processing percentage `(processed-cache)/(total-cache)`, status `preparing` / `generating`       | `tools/ui/src/lib/stores/chat/processing.svelte.ts` at `fc504f91d8` |
| Ollama `run --verbose` | After each reply: total duration, load duration, prompt eval count, prompt eval cached, prompt eval duration, prompt eval rate (uncached tokens only), eval count, eval duration, eval rate | `api/types.go` `Metrics.Summary` at `15af2b261c`                    |
| Open WebUI             | A per-message usage popover with `response_token/s`, `prompt_token/s`, the Ollama durations and an approximate total; "N/A" when a duration is missing                                      | `backend/open_webui/utils/response.py:187-217`                      |
| LM Studio              | `stats` per reply (tokens per second, time to first token, model load time) and prompt processing progress events                                                                           | LM Studio REST docs, section 11                                     |
| Claude Code            | The status line JSON has `cost.total_duration_ms`, `cost.total_api_duration_ms`, context window and current usage; no tokens per second or time to first token field                        | code.claude.com status line docs                                    |
| Cline                  | Tokens in and out, cache reads and writes and cost per task (`getApiMetrics.ts`); no speed figure found in the repository                                                                   | `apps/vscode/src/shared/getApiMetrics.ts`                           |
| Roo Code, Zed          | No tokens-per-second or time-to-first-token display found by a code search of their repositories (absence of a match is not proof)                                                          | GitHub code search, 2026-11-15                                      |
| Cursor                 | Closed source; no documented speed display was found                                                                                                                                        | not verified                                                        |
| OpenRouter             | Per-provider latency (time to first token) and throughput percentiles over 30 minutes on model pages and in the endpoints API; per-generation latency and generation time                   | `openrouter.ai/openapi.json`                                        |

Takeaways: the local-first tools (llama.cpp UI, Ollama, Open WebUI, LM Studio) all show speed, because on local hardware speed is the thing a person tunes. None of them separates "the server's number" from "the client's number", and Open WebUI's `prompt_token/s` repeats Ollama's cached-tokens inflation. The agent tools show tokens and cost, not speed. Nobody shows the phase of an agent turn the way Strata's own console line does ("writing a tool call: edit_file: 412 of max 32768 tokens, 71.2 tok/s, 9 s").

## 5. A worked example from the owner's server

Read from `http://127.0.0.1:8086` on 2026-11-15 (Strata 0.1.54, `qwen3.8-flash-next-nvfp4`, RTX 5090, MTP drafting, one serving slot):

| Measure                   | Value                                                                                                                       | Field                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Last request, prompt      | 417,856 tokens, 16,384 reused, 401,472 read                                                                                 | `requests[0].prompt_tokens`, `reused`, `prompt_read`                   |
| Prompt read               | 86.4 s, 4,648.9 tok/s                                                                                                       | `last_timings.prompt_ms`, `prompt_per_second`                          |
| First token               | 86.5 s after entering the engine queue                                                                                      | `requests[0].first_engine_token_s`                                     |
| Output                    | 729 tokens in 9.78 s, 74.5 tok/s                                                                                            | `last_timings.predicted_n`, `predicted_ms`, `predicted_per_second`     |
| Drafts                    | 420 of 530 accepted (79%)                                                                                                   | `last_timings.draft_n_accepted`, `draft_n`                             |
| Whole request             | 96.3 s                                                                                                                      | `requests[0].duration_s`                                               |
| Since start (37 requests) | 24.5 min reading prompts, 3.1 min writing; 8.37M of 15.06M prompt tokens reused (56%); 8,047 of 9,895 drafts accepted (81%) | `totals.prompt_ms`, `decode_ms`, `reused`, `prompt_tokens`, `drafts_*` |

Everything in the first six rows except `first_engine_token_s` and `duration_s` arrives in the stream's final `timings`, so the display needs no `/metrics` read for it; the client's own first-token time replaces `first_engine_token_s` (it adds the network, a few milliseconds locally).

The example shows why the display leads with time to first token and its cause. 89% of this server's busy time went to reading prompts. A person who sees "first token 86 s, re-read 401k of 418k tokens" next to the cache miss line (#900, J8) knows the slowness was a cache miss, not a slow model.

## 6. Design

### 6.1 One timing record per request

A pure module in core, `core/llm/requestTiming.ts`, folds the chunks of one request into a record. Both hosts use it: the GUI through `BaseLLM.streamChat`, the CLI through `streamChatResponse.ts` (the CLI already imports core).

```ts
type Source = "server" | "measured" | "estimate";

interface RequestTiming {
  sentAt: number;
  headersAt?: number;
  firstEventAt?: number; // any chunk but the empty role chunk
  firstOutputAt?: number; // first reasoning, text or tool-call delta
  endAt?: number;
  phase: Phase; // the live phase, see 6.2
  phaseSince: number;
  outputChars: number; // reasoning + text + tool arguments
  toolArgBytes?: number;
  outputTokens?: { value: number; source: Source };
  outputRate?: { value: number; source: Source }; // tokens/s
  promptTokens?: number; // exact at message_start on Anthropic
  prefill?: {
    read: number;
    cached: number;
    ms?: number;
    rate?: number;
    source: Source;
  };
  drafts?: { offered: number; accepted: number }; // server only
  serverLatencyMs?: number; // Bedrock metrics.latencyMs
  loadMs?: number; // Ollama load_duration, LM Studio model_load_time_seconds
  stalledSince?: number; // no delta for STALL_MS while open
}
```

Rules, in the module and tested there:

- **Live rate** is characters over the last 3 s divided by 4, shown only after 20 estimated tokens and 1 s of output, rounded to two significant figures, and always with `~`. On llama.cpp with `timings_per_token` (J24) the server's `predicted_per_second` replaces it and the `~` goes.
- **Final rate**: the server's `predicted_per_second` when sent (llama.cpp, Strata, Ollama via `eval_count / eval_duration`); otherwise the provider's output count over `endAt - firstOutputAt` ("measured here"); otherwise, when no count came (stopped turn, a server without usage), the character estimate with `~`; never a number under 20 tokens.
- **Prefill**: `timings.prompt_n`, `cache_n`, `prompt_ms`, `prompt_per_second` from the server. Ollama's OpenAI endpoint gets its rate recomputed from `prompt_n - cached_tokens` (section 3.2). No provider without server timing gets a prefill rate: time to first token is shown instead, because it mixes queueing, network and prefill and pretending otherwise would be a fake number.
- **Thinking without text** (Anthropic `display: "omitted"`, OpenAI o-series): phase `thinking`, no rate, and the summary's output count says "includes thinking".
- **Drafts**: only from the server (`draft_n`, `draft_n_accepted`); never inferred.
- **Nothing is sent and nothing is polled** to fill the record (section 6.7).

The record lands on the final `Usage` as `Usage.timing` (`core/index.d.ts`), so the cache ledger, the session file and `cn serve` `/state` get it with no new message.

### 6.2 Phases

| Phase                        | Entered when                                                                                       | Label                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `waiting`                    | Request sent, no event yet                                                                         | "Waiting for the model" (cloud) / "Waiting for the server" (local), with seconds after 3 s |
| `reading`                    | A `prompt_progress` chunk                                                                          | Today's "Reading the prompt: ..." line, plus the read speed once known                     |
| `thinking`                   | A reasoning delta, or a thinking block with no text                                                | "Thinking" or "Thinking (not shown)"                                                       |
| `writing`                    | A text delta                                                                                       | "Writing"                                                                                  |
| `tool-call`                  | A tool-call delta with a name                                                                      | "Writing a tool call: `name`", with the argument size                                      |
| `held`                       | `recoveryHold: "start"`                                                                            | Today's "Checking the reply for a tool request"                                            |
| `stalled`                    | No delta for 15 s while the stream is open (not during `reading` with progress, and not `waiting`) | "No new tokens for 20 s" appended to the phase                                             |
| `tool` (host side, not core) | The GUI's tool call state is `calling`; the CLI's tool executor runs                               | "Running `name`", with seconds                                                             |

### 6.3 Live during a turn (GUI)

The line replaces the "Generating..." text in `StreamingToolbar` (`gui/src/components/mainInput/Lump/LumpToolbar/StreamingToolbar.tsx`), so it adds no new row. Order of parts is order of priority; at narrow widths the line truncates from the end.

```
+--------------------------------------------------------------------------+
| Waiting for the server · 4 s                                       Stop |
| Reading the prompt: 140k of 401k tokens, 16k from the cache,            |
|   4.6k tok/s, about 56 s left                                      Stop |
| Thinking · ~38 tok/s · first token 86.5 s                          Stop |
| Writing · 74 tok/s · drafts 79% accepted                           Stop |
| Writing a tool call: edit_file · 2.1 kB                            Stop |
| Running edit_file · 4 s                                            Stop |
| Writing · ~61 tok/s · no new tokens for 20 s                       Stop |
+--------------------------------------------------------------------------+
  Claude on the Anthropic API, same turn:
| Thinking (not shown) · first token 1.4 s                           Stop |
| Writing · ~58 tok/s                                                Stop |
```

At 300 px only the phase and the first number fit: "Writing · ~58 tok/s". The draft share shows only when the server reported drafts on an earlier request of this session (it is known only at the end of each request, so the live line carries the previous request's share, labelled "last request").

### 6.4 Per-turn summary on hover and focus

A small "timing" button in the reply's actions row (`gui/src/components/StepContainer/ResponseActions.tsx`), shown after the reply ends. Its accessible name is the one-line summary ("First token 86.5 s, 74 tokens per second"); hover or focus opens the detail. A turn with several requests (tool rounds) lists one line per request and a total. Saved on the history item, so it survives a reload and a resumed session.

```
+-----------------------------------------------------------+
| This reply: 3 requests, 2 min 11 s                        |
|                                                           |
| Request 1  first token 86.5 s                             |
|            read 401k of 418k tokens at 4,649 tok/s        |
|            (16k from the cache)            server         |
|            wrote 729 tokens at 74.5 tok/s  server         |
|            drafts 420 of 530 accepted (79%) server        |
| Request 2  first token 0.9 s, 18k read at 4,512 tok/s     |
|            wrote 211 tokens at 73.0 tok/s  server         |
| Request 3  stopped after 6 s: ~140 tokens  estimate       |
|                                                           |
| Times are measured here. "server" values are the          |
| server's own. "~" is estimated from characters.           |
+-----------------------------------------------------------+

  Claude on Bedrock:
| Request 1  first token 1.6 s                    measured  |
|            wrote 1,220 tokens at 61 tok/s       measured  |
|            Bedrock latency 21.4 s               server    |
|            no prompt speed: Bedrock does not report it    |
```

### 6.5 Session history

- **Cache ledger** (`gui/src/util/cacheLedger.ts`): each entry gains `firstOutputMs`, `outputRate` and its source, `prefillRate`, `drafts`. The ledger already keeps 200 entries and `latencyMs`; the Copy context record and `cacheExport.ts` include the new fields.
- **Usage tooltip** (`UsageIndicator.tsx`) first, then the J1 context panel: two rows of a static sparkline (one bar per request, the last 30), with a text equivalent that is what a screen reader gets.

```
Speed this session (last 30 requests)
  first token  ▁▁▁▁█▁▁▁▂▁  median 1.9 s, longest 86.5 s (prompt re-read)
  output       ▅▆▆▅▆▆▅▆▆▅  median 72 tok/s (server)
```

- **Stats page** (`gui/src/pages/stats.tsx`): per model, median time to first token and median output rate over the requests in the dev data that have them. Rows without a timing are left out of the medians, not counted as zero.

### 6.6 CLI

The spinner row in `ActionStatus.tsx` takes the same phase text, and the timer stays:

```
⠋ Waiting for the server (4s • esc to interrupt)
⠋ Reading the prompt: 140k of 401k tokens, 4.6k tok/s, about 56 s left (31s • esc to interrupt)
⠋ Writing · ~42 tok/s · first token 1.3 s (12s • esc to interrupt)
⠋ Writing a tool call: edit_file · 2.1 kB (14s • esc to interrupt)
```

After a turn, the status bar shows the last request's summary in dim text when there is room ("· last: 74 tok/s, first 86 s"); `/info` and the `--verbose` exit line list per-request timings; `cn serve` `/state` gets a `timing` object (the J8 `prompt_cache` object's sibling) for scripts. The CLI also starts sending `return_progress` to llama.cpp-style local servers (J17), which it does not do today.

### 6.7 Accessibility, honesty, cost and privacy

**Accessibility.**

- The live line is not a live region and its numbers are never announced: rates change every second and would bury the reply. The streamed reply keeps UX18's polite region.
- Phase changes are announced through `announce()` (`gui/src/components/a11y/announcer.ts`) only when the new phase is expected to last: "Reading the prompt, about 56 seconds" once when a read longer than 5 s starts, "Waiting for the server" once after 10 s of waiting, and "No new tokens for 20 seconds" once per stall. At most one announcement per phase per request.
- The text updates at most once a second; with `vscode-reduce-motion` (UX17) the ellipsis animation stops and the sparkline never animates.
- The summary button has a full accessible name; the sparkline has a text equivalent; no number is conveyed by colour alone.
- The CLI writes no extra lines for speed; the row is rewritten in place as it is today.

**Honesty.**

- Three labels, used everywhere: "server" (the server's own clock), "measured" (this client's clock and the provider's count), `~` (estimated from characters). The hover summary spells them out once.
- A provider that sends nothing gets nothing: no prompt rate on Anthropic, OpenAI, Gemini, vLLM or Bedrock; no draft share anywhere but llama.cpp and Strata. "First token" is always available and always measured here.
- Strata's `hit_rate` (expert cache) is not shown as cache reuse; Ollama's OpenAI `prompt_per_second` is recomputed without cached tokens.
- A stopped or failed request's numbers are estimates and are marked so; they are left out of the medians.

**Cost.** No extra request of any kind. Every number comes from the stream already being read. Strata's `/metrics` stays a single read after a request, and only when the stream gave no cached count, as K4 and #900 do; this design does not add `/metrics` fields that would justify reading it more often. `timings_per_token` (J24) is a request field to a local server, not a request.

**Privacy.** Timings are local: the session file, the cache ledger and the dev data the Stats page already reads. Nothing goes to telemetry. No text is stored with a timing, only counts and times.

## 7. Settings

One setting, `ui.speed`: `auto` (default), `always`, `off`.

- `auto`: the live line shows phase and time to first token always; rates only after 20 tokens; the per-reply button always.
- `always`: the same, plus the last-request summary in the CLI status bar and the sparkline open by default.
- `off`: the toolbar keeps today's text ("Generating...", the prompt progress line, the recovery line); no button, no sparkline. The record is still kept, so the ledger and `/state` have it.

The phase alone is shown whatever the setting: "Waiting for the server" and "Writing a tool call" are the answers to "what is it doing", and replacing "Generating..." with them costs nothing.

## 8. What this does not do

- No polling of `/metrics`, `/v1/status` or `/slots` during a request (see D3 for the one exception to decide).
- No OpenRouter `/generation` call after each request.
- No CloudWatch read for Bedrock.
- No moving LM Studio or Ollama to a different API to get their stats (D5).
- No GPU, power or temperature figures, though Strata's `/metrics` has them: they describe the machine, not the turn.

## 9. Decisions for the owner

| ID  | Question                                                                                                                                                               | Recommendation                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | `ui.speed` default                                                                                                                                                     | `auto`: phase always, numbers when known                                                                                                                                                                                                         |
| D2  | Lead number in the live line                                                                                                                                           | Time to first token while waiting or reading, output rate once writing                                                                                                                                                                           |
| D3  | One status read when a local request has shown no event for 5 s, to say "queued behind another request" (Strata `/v1/status` `activity.in_flight`, llama.cpp `/slots`) | Not in the first slice. It is one GET to a local address and answers the question people ask most ("is it stuck?"), but it breaks the "no extra requests" rule; decide after J18 ships and the "Waiting for the server" line has been lived with |
| D4  | Send `timings_per_token: true` to llama.cpp-style local servers for an exact live rate                                                                                 | Yes, with `return_progress`, only where `/props` says llama.cpp style (J24); check that Strata ignores it                                                                                                                                        |
| D5  | Move LM Studio to its native `/api/v1/chat` for `stats` and prompt progress                                                                                            | Not for this feature; record as a Track PL question. Client-side figures cover LM Studio meanwhile                                                                                                                                               |
| D6  | OpenRouter provider percentiles in the model picker                                                                                                                    | Later, opt-in, one cached list request per model (J26)                                                                                                                                                                                           |

## 10. Proposed ROADMAP rows (Track J)

The largest Track J row on `main` is J14 and no plan or open PR uses J15 or later, so these start at J15. Sizes follow the UX track's convention (S under 1 h, M under half a day). Groups: rows in one group can be built in parallel; a group starts when the rows it depends on are merged. This note does not edit `ROADMAP.md`; the rows are for the owner to place.

| ID  | Scope                                                                                                                                                                                                                                                                                                                                                             | Depends on                 | Files                                                                                                                                              | Size | Group |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| J15 | `RequestTiming`: a pure fold of one request's chunks into phase, timestamps (sent, headers, first event, first output, end), character-based live rate, final rate with its source, stall detection; `Usage.timing`; recorded-stream tests for Anthropic, OpenAI, Bedrock, llama.cpp, Strata and Ollama                                                           | none                       | `core/llm/requestTiming.ts` (new) and its test, `core/index.d.ts`, `core/llm/index.ts` (`streamChat` hands chunks to it)                           | M    | A     |
| J16 | Server timings into `Usage`: all of llama.cpp's and Strata's `timings` (`predicted_*`, `prompt_ms`, `prompt_n`, `draft_n`, `draft_n_accepted`); Ollama native `/api/chat` maps `prompt_eval_count`, `eval_count`, the four durations and `load_duration` (today it reports no usage at all); Ollama's OpenAI `prompt_per_second` recomputed without cached tokens | none                       | `core/llm/index.ts:1281-1325`, `core/llm/llms/Ollama.ts`, `core/index.d.ts`                                                                        | M    | A     |
| J17 | CLI prompt progress: send `return_progress` to llama.cpp-style local servers through `streamsPromptProgress`, and show "Reading the prompt: ..." in the spinner row (shared formatter moved from `gui/src/util/promptProgress.ts` to core)                                                                                                                        | none                       | `extensions/cli/src/stream/streamChatResponse.ts`, `extensions/cli/src/ui/components/ActionStatus.tsx`, `core/llm/promptProgressText.ts` (new)     | S    | A     |
| J18 | GUI live line: the phase, rate and first-token time in `StreamingToolbar` (section 6.3), at most one update a second, `~` on estimates, read speed added to the prompt progress line, "Running `name`" from the tool call state                                                                                                                                   | J15                        | `StreamingToolbar.tsx`, `GeneratingIndicator.tsx`, `gui/src/util/turnTiming.ts` (new), `sessionSlice.ts`, `streamNormalInput.ts`                   | M    | B     |
| J19 | Per-reply timing summary: the actions-row button with its accessible name and the hover and focus detail (section 6.4), saved on the history item and in the Copy context record                                                                                                                                                                                  | J15, J16                   | `ResponseActions.tsx`, `gui/src/components/StepContainer/TimingSummary.tsx` (new), `core/index.d.ts` (`ChatHistoryItem.timing`), `sessionSlice.ts` | S    | B     |
| J20 | CLI live line and per-turn output: the phase and rate in the spinner row, the last-request summary in the status bar when there is room, per-request timings in `/info` and the `--verbose` exit line, a `timing` object in `cn serve` `/state`                                                                                                                   | J15, J16, J17              | `ActionStatus.tsx`, `BottomStatusBar.tsx`, `streamChatResponse.ts`, the `/info` command, `cn serve` state                                          | S    | B     |
| J21 | Console figures from the timing record: "To First Token" from the first output token, not the first logged chunk (today it is the first `prompt_progress` update on llama.cpp and Strata), "Tokens/s" from the record with its source                                                                                                                             | J15                        | `gui/src/hooks/useLLMSummary.ts`, `gui/src/components/console/Details.tsx`, `core/llm/index.ts` (log the record on the end item)                   | S    | B     |
| J22 | Session history: ledger fields (`firstOutputMs`, `outputRate`, `prefillRate`, `drafts`), the sparkline with its text equivalent in the usage tooltip, then in the J1 panel; Stats page medians per model                                                                                                                                                          | J19; J1 for the panel part | `gui/src/util/cacheLedger.ts`, `cacheExport.ts`, `UsageIndicator.tsx`, `gui/src/pages/stats.tsx`, `core/data/devdataSqlite.ts`                     | M    | C     |
| J23 | Accessibility pass: the phase announcements and their limits (section 6.7), reduce motion, screenshot states for each phase at 300 px with `axe-core`                                                                                                                                                                                                             | J18, UX17, UX18            | `StreamingToolbar.tsx`, `announcer.ts` callers, `bench/screenshots` views                                                                          | S    | C     |
| J24 | Exact live rate on llama.cpp: `timings_per_token: true` beside `return_progress` for llama.cpp-style local servers; the record prefers the per-chunk `predicted_per_second`; check that Strata ignores the field (it has no handler today)                                                                                                                        | J16; D4                    | `core/llm/index.ts:1566-1577`, `localServers.ts`, `requestTiming.ts`                                                                               | S    | C     |
| J25 | Owner decision D3 (one local status read to say "queued"), then, if yes, the read: once per request, local addresses only, after 5 s without an event                                                                                                                                                                                                             | J18                        | `localServers.ts`, `requestTiming.ts`                                                                                                              | S    | D     |
| J26 | Later: OpenRouter's `latency_last_30m` and `throughput_last_30m` in the model picker, opt-in, one cached request per model (D6)                                                                                                                                                                                                                                   | none                       | model picker, `packages/openai-adapters` OpenRouter list                                                                                           | S    | D     |

Group A (J15, J16, J17) has no dependencies and touches different files, except that J15 and J16 both edit `core/llm/index.ts` and `core/index.d.ts`: land J16 first or rebase J15 on it. Group B rows touch separate surfaces (GUI toolbar, reply actions, CLI, console). J22 can ship the tooltip half before J1 lands.

## 11. Sources

Read live on 2026-11-15. P is primary (vendor documentation or source), S secondary.

- P: Anthropic, Streaming messages: https://platform.claude.com/docs/en/build-with-claude/streaming
- P: AWS, `ConverseStreamMetrics`: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStreamMetrics.html
- P: AWS, `InvokeModel`: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html
- P: AWS, `InvokeModelWithResponseStream`: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModelWithResponseStream.html
- P: AWS, Diagnose `InvocationLatency` increases using OTPS: https://docs.aws.amazon.com/bedrock/latest/userguide/monitoring-runtime-otps.html
- P: OpenAI, Create chat completion (`stream_options`, `completion_tokens_details`): https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- P: Google, Generate content API (`UsageMetadata`): https://aistudio.google.com/api-reference/generate-content
- P: Ollama API: https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md; source `api/types.go` (`Metrics.Summary`) and `openai/openai.go` (`Timings`, `ToTimings`) at `15af2b261c`
- P: llama.cpp server README: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md; source `tools/server/server-common.cpp` (timings JSON), `tools/server/server-context.cpp` (`timings_per_token`), `tools/ui/src/lib/stores/chat/processing.svelte.ts` at `fc504f91d8`
- P: vLLM metrics: https://docs.vllm.ai/en/latest/usage/metrics.html
- P: LM Studio REST v0: https://lmstudio.ai/docs/developer/rest/endpoints; v1 chat: https://lmstudio.ai/docs/developer/rest/chat; streaming events: https://lmstudio.ai/docs/developer/rest/streaming-events
- P: OpenRouter OpenAPI (`/generation`, `/models/{author}/{slug}/endpoints`): https://openrouter.ai/openapi.json
- P: Claude Code status line: https://code.claude.com/docs/en/statusline
- P: Open WebUI `backend/open_webui/utils/response.py`: https://github.com/open-webui/open-webui
- P: Cline `apps/vscode/src/shared/getApiMetrics.ts`: https://github.com/cline/cline
- P: Strata source `serve/server.py` at `baf1636` (https://github.com/Niko1221/Strata), and the live `/v1/status` and `/metrics` answers of the owner's server
- Repository: `plans/research/local-provider-capacity.md` (Strata endpoints, capacity), `plans/research/local-inference-lab.md` 4.3 (speculative decoding), `plans/usage-display.md`, `plans/context-visibility.md`
