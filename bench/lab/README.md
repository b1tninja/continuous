# Local lab

A scripted test harness for finding out what a local model (Ollama) responds to: which tool-call format, which prompt style, native `tools` field or the family's own text dialect. It is built for a resource-limited machine: one model at a time, one request at a time, hard budgets, resumable, and it refuses models that are too big for the limits you set.

Plain Node ESM (Node 22.13 or newer, the repository's `.nvmrc` is fine), no npm dependencies. It is dev-only: nothing in `core/`, `gui/`, `extensions/`, `binary/` or `packages/` imports it and no workflow runs it. It is designed so the whole folder can move to its own repository (see "Moving this folder").

Everything here is a measurement of a **local build and quantisation** of a model. It tells you what that local model does, not what the hosted model does.

## Quick start on this machine

Facts read on 2026-11-10 (run `inventory` for current ones): Ollama 0.40.13 at `http://127.0.0.1:11434`, 125 GB RAM, RTX 5090 with about 32 GB VRAM (`nvidia-smi`; the OS reports 4 GB because the adapter figure is a 32-bit cap). Models live in `D:\ai\models\` (`OLLAMA_MODELS`), and **that drive has about 1.3 GB free**. The lab never pulls, copies or deletes a model and never writes there.

Installed models that can chat with tools are all large (17 to 23 GB). `glm-ocr`, `deepseek-ocr` and `qwen3-embedding` are refused as not chat models. The smallest capable one is `qwen3.6:27b` (17.4 GB), so the default limits (8 GB) refuse it and you raise them on purpose:

```sh
# 1. what is installed and what is safe (reads only, loads nothing)
node bench/lab/lab.mjs inventory

# 2. a dry plan: cases x models x passes and an estimated time (sends nothing)
node bench/lab/lab.mjs plan --suite dialect-probe --models qwen3.6:27b --max-vram 20 --max-ram 20

# 3. optional: measure real speed with ONE tiny request (loads the model, then unloads it)
node bench/lab/lab.mjs plan --suite dialect-probe --models qwen3.6:27b --max-vram 20 --max-ram 20 --warmup

# 4. a first small real run: 6 cases (3 probes, each native and text), at most 12 requests, 10 minutes
node bench/lab/lab.mjs run --run --suite dialect-probe --models qwen3.6:27b \
  --max-vram 20 --max-ram 20 --limit 6 --max-requests 12 --max-minutes 10

# 5. read it
node bench/lab/lab.mjs report
node bench/lab/lab.mjs suggest        # writes bench/lab/profiles/<model>.json
```

Expected time for step 4: loading a 17 GB model takes tens of seconds, then each probe is a reply of under 100 tokens, a few seconds each. The plan prints its own estimate (assumed 20 tokens a second until it has a measurement, from `--warmup` or from earlier results). Treat the figure as an estimate, not a promise; the first run on this machine will replace it with a measured one. Thinking is switched off (`think: false`) for models that report a thinking capability, because reasoning tokens would dominate the time.

**To interrupt:** press Ctrl-C once. The lab finishes the request in flight, writes its record, sends `keep_alive: 0` to unload the model and exits with code 130. Press Ctrl-C a second time to quit at once (the model then unloads by itself after its 2 minute keep-alive, or run `ollama stop <model>`). Rerun the same command to resume: completed cases are skipped.

## Safety

- **One model, one request at a time.** There is no concurrency option; `--concurrency` other than 1 is refused.
- **Size guards.** `--max-vram GB` (default 8) and `--max-ram GB` (default 16) refuse a model whose reported size (weights on disk, a floor for what it needs loaded) exceeds them. A model is also refused if it is larger than the VRAM `nvidia-smi` says is free right now, if it is an embedding or OCR model, or if another model is already loaded (`--ignore-loaded` overrides that one).
- **Budgets.** `--max-requests` (default 60), `--max-minutes` (default 30 wall clock for the run), `--model-minutes` (default 15 per model), `--request-timeout` seconds (default 120). Any of them ends the run cleanly after unloading.
- **Cooldown** `--cooldown` seconds (default 15) between models, interruptible.
- **Circuit breaker.** Three consecutive failed requests stop that model.
- **Unload.** Every model is unloaded with `keep_alive: 0` when its cases finish, on error, and on interrupt.
- **Dry by default.** `run` prints the plan and sends nothing unless you pass `--run`.
- **Network.** Only the `--base-url` you give, and it must be loopback (`127.0.0.1`, `localhost`, `::1`) unless you pass `--allow-remote`. No credentials are read or sent.
- **Writes.** Only to `bench/lab/results`, `bench/lab/profiles` and a `continuous-lab` folder under the OS temp directory. `lib/paths.mjs` refuses any other path, and the tests check that. The product is read only. `suggest` writes profiles to the lab's own folder and never touches `core/util/toolDialectPresetTable.ts`.
- **Models.** The lab never runs `ollama pull`, `rm` or `create`.

## Commands

| command                       | what it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inventory`                   | Machine facts (nvidia-smi VRAM, RAM, models directory and its free disk, what is loaded), then every installed model: size, quantisation, family, context, `tools` capability, the preset row it matches and that row's `promptStyle`, and whether it is safe under the limits.                                                                                                                                                                                                                                          |
| `plan --suite S --models M`   | Cases x models x passes, how many remain after earlier results, and estimated minutes. `--warmup` sends one tiny request per model to measure tokens a second.                                                                                                                                                                                                                                                                                                                                                           |
| `run --run`                   | Runs the plan. Appends one JSON line per finished case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `report`                      | Markdown: per model and per arm and case group, valid-call rate with a Wilson 95% interval on the effective n (raw and effective n in separate columns), outcome counts, false calls, median tokens, latency and tokens a second, plus which recovery parsers read the text replies. `--suite`, `--file`, `--out`.                                                                                                                                                                                                       |
| `diff <before> <after>`       | Two result files, per arm: both rates, the change, whether the intervals are disjoint, and the cases that flipped. For before and after a prompt change.                                                                                                                                                                                                                                                                                                                                                                 |
| `compare <A> <B>`             | Two result sets (files or folders) paired by suite, arm, case id and pass index, then by prompt: raw and effective n, both valid-call rates with Wilson intervals, the 2x2 table, McNemar's exact two-sided test on the discordant pairs (per pass and per prompt), a cluster bootstrap interval for the difference, and the cases that flipped (`--unit prompt\|pass\|auto`). Under 25 pairs the verdict reads `NOT ENOUGH PAIRS` and claims nothing. `--model-a`/`--model-b` pick one model when a side holds several. |
| `replay --dumps PATH [--run]` | Sends recorded request dumps through the cache path and reports cached and evaluated tokens per request (see "Request-dump replay"). Dry without `--run`.                                                                                                                                                                                                                                                                                                                                                                |
| `suggest`                     | Writes `profiles/<model>.json` (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fixtures --suite S`          | Writes observed corpus fixtures from raw replies to `results/fixtures/` (see below). `--only-leaks`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `snapshot-tools`              | Regenerates the real agent tool list from the product's install (needs `core` dependencies installed) into `results/agent-tools.snapshot.json`; copy it to `fixtures/agent-tools.json` to adopt it.                                                                                                                                                                                                                                                                                                                      |

`--models` takes names, `smallest-safe` or `all-safe`. `--passes N` repeats each case N times, which is **not** the same as N times the evidence: at temperature 0 a pass repeats the same output and adds nothing to n (see "Statistics: raw n and effective n"). `--limit N` takes the first N cases (stratified by class for the reviewer suite). `--num-ctx` sets the context (default 8192, 16384 for `leaks`).

## Suites

Suites are data files in `suites/`; pass a name or a path.

**`dialect-probe`** (the R3 experiment, locally). Six Tier 1 probes: a native call, parallel calls, an integer argument, quotes, newlines and unicode in a string, a nested object, and a prompt that needs no tool. Each is sent two ways:

- `native`: the `tools` field through `/api/chat`.
- `text`: no `tools` field; the system prompt teaches the family's trained-in dialect, taken from the model's preset row `promptStyle` (`qwen-xml`, `hermes-json`, `glm-xml`, `pythonic`, `llama-json`, `toolcall-json`) or the generic `codeblock` when the preset says `native` or there is none. `--styles all` or a list asks every style of the same model, which is how you find the style a model prefers.

Each reply is classified as `structured` (a tool call came back), `text-call` (a call written as text that the product's leak detector `classifyToolReply` or one of the recovery parsers can read), `format-broken` (tool markup that nothing can read, or arguments that are not a JSON object), `refused` or `prose`. Every recovery parser is run on every text reply and the report says which would have recovered it. A reply is _valid_ when the right tool was called with arguments that fit the schema and match what the probe asked for.

**`prompt-variants`**. Three tasks (read, run, no-tool) under seven system-prompt styles: terse, verbose, example-laden, XML-tagged, JSON-schema-first, announce-then-call, call-only. Scored by call validity, schema validity, false calls (a call when none was needed), tokens and latency. `--variants file.json` replaces the variants with your own (`[{id, system, delivery?}]`, with `{{TOOL_NAMES}}`, `{{TOOL_LIST}}`, `{{TOOLS_JSON}}` filled in); `--deliveries native,text` runs each variant with the tools field and with the dialect in the prompt.

**`reviewer`**. The Auto-mode reviewer evaluation with a local model as the reviewer. The labelled set is the product's B4 evaluation set (`core/tools/permissions/auto/evaluation/cases.ts`); the prompt is the product's `buildReviewMessages` and the verdict is read by the product's `parseReviewerReply`. When the B12 gate lands, point `--dataset` at its labelled set (an array of `{id, request, tool, args, expect, category?}`). A case is acceptable when a deny or ask case is not allowed, or an allow case is allowed; the report adds dangerous allows (the number that matters) and unusable replies. The rules engine is not applied, so every case reaches the model: stricter than Auto mode itself.

**`leaks`**. The R4/R6-style census. The agent's eight common prompts with 2, 14, 60 or all 21 real agent tools, at chosen temperatures, streaming and not. The default grid is small (2 and 14 tools, temperature 0, not streamed); `--full-grid` runs every combination, or pick with `--tool-counts 2,14,60,agent --temperatures 0,0.7 --streams false,true`. Streaming runs keep the chunk boundaries.

## Results and learning

Each suite appends to `results/<suite>.jsonl`, one record per case and pass, keyed `suite|model|caseId|pN`. A record holds the classification, the score, token counts and timings, and the **raw reply** (text, thinking, tool calls, stop reason, stream chunks). A torn last line from an interrupted write is ignored on the next run. Errors are recorded and never counted in a rate; `--retry-errors` reruns them.

`suggest` reads the results and writes `profiles/<model>.json`: the ranked arms (native, each text style, each prompt variant) with counts and Wilson intervals, the best text style, whether native beats text at this sample size (only when the intervals are disjoint), the leak dialects seen, the parsers that recovered text, and a `row` in the shape of a preset-table row (`nativeToolCalls`, `textDialect`, `promptStyle` with its evidence string, `observedLeak`, `recoverWith`, `unverified`). It says `unmeasured` and `not enough evidence` below `--min-n` (default 8) **distinct prompts** per arm: `n` and `k` in the profile are the effective counts (next section), with `rawK` and `rawN` beside them. A person reads the profile and decides what, if anything, goes into `core/util/toolDialectPresetTable.ts`.

`fixtures --suite S` turns recorded replies into observed corpus fixtures in the format the product's live-capture harness writes (it calls the product's `buildFixture`, so the format cannot drift): unreviewed negatives with `policy: "either"`, to be promoted to positives by hand once the calls they should yield are agreed. Copy chosen files into `core/llm/toolDialects/corpus/fixtures/` in a product PR.

`samples/` holds a small committed example of each output. It was generated against the fake server in `test/fakeOllama.mjs`, so it measures nothing.

## Statistics: raw n and effective n

**The unit of evidence is the distinct prompt, not the request.** At temperature 0 the passes of one prompt repeat the same output, so a run of 8 prompts x 3 passes has a raw n of 24 but an effective n of 8, and a Wilson interval computed on 24 is too narrow (all 24 valid reads as [86%, 100%]; on 8 it is [68%, 100%]). Above temperature 0 the passes are draws, but draws of one prompt share its difficulty, so they are worth less than independent prompts. Every figure the lab prints therefore carries both numbers.

How the effective n is computed (`lib/stats.mjs`, `effectiveRate`): the records of an arm are grouped by prompt (the case id). With `m` requests per prompt, `N` in all, `u` prompts, the one-way ANOVA intraclass correlation `rho` of the pass results within a prompt gives the design effect `1 + (N/u - 1) * rho`, and `n_eff = N / deff`, never below `u` and never above `N`. When no prompt's passes ever disagree (always the case at temperature 0 on a deterministic engine, or with a constant seed), `rho` is 1 and `n_eff = u`: the passes are counted as the repeats they are. With one prompt only, `rho` cannot be estimated and is taken as 1. The interval is Wilson on `n_eff` with the observed rate, so it is wider than the naive one and equal to it when every request is its own prompt.

Where it shows:

- `report`: columns `n raw` and `n effective`, intervals on the effective n, the raw count after each rate (`6/8 = 75% [41%, 93%] (raw 18/24, 8 prompts)`), and a `REPEATS:` line for every arm whose passes all agreed.
- `plan` and `run`: `24 raw n, effective n 8; temperature 0: the 3 passes repeat the same output ...` per model, before any request is sent. Under `--temperature inherit` the effective n is only known after the run (the server decides whether passes differ) and the plan says so.
- `suggest` and `diff`: the arms are ranked, compared with `--min-n` and tested for disjoint intervals on the effective n; the profile keeps `rawK` and `rawN`.
- `compare`: both levels are always printed (see "Comparing engines"); `--unit prompt|pass|auto` picks which one carries the verdict.

What to do about it: ask for a bigger n with **more distinct prompts**, or run at temperature above 0 with `--seed` so the passes are distinct, reproducible draws, and read the effective n the report prints; do not read `--passes 3` at temperature 0 as three times the data. Use `--passes` at temperature 0 only to check that the engine is deterministic (the passes should not disagree).

How big n has to be (`plans/research/rq10-sample-sizes.md`, n per arm, 80% power; the figures are effective n). Runs per arm for a difference `d` between the arms, by the better arm's true rate:

| Better arm | d=0.2 | d=0.3 | d=0.5 | rule                                 |
| ---------- | ----- | ----- | ----- | ------------------------------------ |
| 100%       | 39    | 21    | 12    | two-sided Fisher exact, alpha 0.05   |
| 90%        | 69    | 36    | 17    | two-sided Fisher exact, alpha 0.05   |
| 70%        | 102   | 48    | 18    | two-sided Fisher exact, alpha 0.05   |
| 100%       | 50    | 29    | 17    | disjoint Wilson 95% (what `suggest`) |
| 90%        | 100   | 51    | 22    | disjoint Wilson 95% (what `suggest`) |
| 70%        | 154   | 71    | 24    | disjoint Wilson 95% (what `suggest`) |

A difference of 0.1 needs more than 78 per arm even from a 100% baseline and is out of reach at these rates. The smallest difference the disjoint-Wilson rule can detect is 0.81 at n=8 from a 100% baseline (nothing from 80% or below) and 0.68 at n=10; about 0.3 needs n=29 or more. So the rules that follow:

1. **Below 10 prompts per arm every number is a screening result.** `suggest --min-n` is 8; `compare` says nothing under 25 pairs (and counts prompts, not passes, when the passes ran at temperature 0).
2. **8 prompts is not a claim about a difference.** The `leaks` suite has 8 prompts per arm; two arms differ detectably there only if they differ by 0.7 or more. For a 0.3 difference plan 25 to 50 effective n per arm, with an exact test, i.e. extend the prompt battery or sample above temperature 0.
3. **Say the n.** Quote `k/n_eff (raw k/N, u prompts)` for every rate, never the raw count alone.

## Transports

By default the lab speaks Ollama `/api/chat`, as it always has: reasoning off where the model reports the capability, temperature 0 (or the suite's own), the suite's token cap (400). **Every result recorded that way is "reasoning off, greedy, 400 tokens", and a model that cannot turn reasoning off (gpt-oss-20b) is cut off by that cap: say so, or pass `--num-predict`.** The options below send the same case, tool list and sampling over each surface.

| `--api`        | Request                                                                                                                                                                                                               | Reply fields read                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ollama-chat`  | `POST /api/chat`: `tools`, `think`, `options{temperature,num_predict,num_ctx,seed}`                                                                                                                                   | `message.content`, `message.thinking`, `message.tool_calls`, `done_reason`, `prompt_eval_count`, `eval_count`, `*_duration`                                                        |
| `ollama-v1`    | `POST /v1/chat/completions`: `tools`, `tool_choice`, `max_tokens`, `seed`, `reasoning_effort`, `stream_options.include_usage`                                                                                         | `choices[0].message` or `delta`: `content`, `reasoning` (also `reasoning_content`, `thinking`), `tool_calls` (streamed fragments joined by `index`), `finish_reason`, `usage`      |
| `ollama-raw`   | `POST /api/generate` with `raw: true`: no template is applied, so **the lab renders ChatML itself** (a faithful contrast only for ChatML models such as Qwen); tools go into the system text in the case's text style | `response`, `thinking` if present, `done_reason`, durations and counts as above                                                                                                    |
| `openai-chat`  | llama-server `POST /v1/chat/completions`: as `ollama-v1`, `--think` becomes `chat_template_kwargs.enable_thinking` or `reasoning_effort`                                                                              | as `ollama-v1`, plus `timings{cache_n,prompt_n,prompt_ms,predicted_n,predicted_ms,predicted_per_second,prompt_per_second}`; `usage.prompt_tokens_details.cached_tokens` if present |
| `llamacpp-raw` | llama-server `POST /apply-template` (`messages` in, `prompt` out), then `POST /completion` (`prompt`, `n_predict`, `cache_prompt`); not streamed                                                                      | `content`, `stop_type` (none, eos, limit, word), `tokens_cached`, `tokens_evaluated`, `timings`                                                                                    |

Options: `--think on|off|default|low|medium|high` (`default` sends nothing; unspecified keeps the old rule on `ollama-chat` and sends nothing elsewhere, so pass it explicitly), `--temperature T|inherit` (see "Sampling: what is sent, what is inherited"), `--num-predict N` (`-1` removes the cap), `--tool-choice auto|required|none|<tool name>` (sent as an OpenAI `tool_choice`; Ollama documents it as unsupported on `/v1` and the lab sends it anyway so the record shows whether it was ignored or rejected; `ollama-chat` and the raw surfaces cannot carry it and the record's `request.notes` says so), `--seed N`, `--body-extra '{"reasoning_format":"none"}'` (merged into the body, for knobs the lab has no flag for; an `options` object is merged key by key into the one the lab built, so `--body-extra '{"options":{"top_p":0.95}}'` keeps the temperature, `num_predict` and `num_ctx`; earlier builds replaced the whole `options` object and silently dropped them). Every record carries `api`, `cfg`, the engine descriptor (Ollama: version, template hash, parser; llama-server: build, slots, context, template hash from `/props`), the `request` notes and, in `reply`, the name of the field that carried reasoning. **Any non-default configuration changes the case key** (`caseId@openai-chat,think=on,np=2048`), so arms never mask each other on a rerun and never need separate folders; arms that differ only in a server flag (a chat template) differ by `--alias`.

Usage fields in a record: `promptTokens`, `outputTokens`, `cachedTokens` (llama-server `cache_n`), `promptEvalTokens` (`prompt_n`), `promptEvalMs`, `evalMs`, `predictedPerSecond`, `ttftMs` (streamed runs only), `wallMs`. Ollama reports no cached count; read the drop in `promptTokens` between requests instead, and confirm it on the first real run (see "What could not be verified").

`--base-url` must be loopback unless `--allow-remote`. llama-server is `http://127.0.0.1:8080` by default for `openai-chat` and `llamacpp-raw`. **On this machine Strata holds port 8080**: start the lab's server somewhere else and point the client at it, `--port 18080 --base-url http://127.0.0.1:18080` (both flags, always together; every llama-server command below and in the experiment plans is meant to carry them). Those apis need `--gguf FILE` (its size is the guard; with `--serve` it is also the file to start). While a llama-server run is planned the lab asks Ollama (`--ollama-url`) what is loaded and refuses if anything is: 32 GB of VRAM cannot hold both.

### Sampling: what is sent, what is inherited

Without `--temperature` the lab sends the suite's own temperature (0 for every shipped suite) on every request, so **every result recorded that way is a greedy result, whatever the model's Modelfile or the server's startup flags say.** Two flags change that:

- `--temperature T` sends `T` on every request (Ollama `options.temperature`, OpenAI `temperature`, `/completion` `temperature`).
- `--temperature inherit` sends **no sampling option**: no temperature, `top_p`, `top_k`, `min_p`, penalties, and no seed unless `--seed` is given. The engine applies its own defaults and, on Ollama, the Modelfile `PARAMETER` lines of the model. The token cap (`num_predict` or `max_tokens`) and the context (`num_ctx`) are not sampling and are still sent. This is what RQ26 needs: an agent that sends nothing gets the Modelfile's sampling, and the lab can now measure that arm. The case key carries `t=inherit`, so inherited and explicit runs never mask each other on a rerun, and a `--temperatures` grid of several values is refused with it (they would be the same request). `compare`, `replay`, `report`, `diff` and `suggest` accept these runs; a report row for a `leaks` arm reads `t=inherited`.
- `--seed N` is the base seed: pass `p` sends `N + p - 1`, so the passes of a prompt are distinct draws at temperature above 0 and a rerun reproduces each one. (A constant seed would make every pass an exact repeat.) At temperature 0 a seed changes nothing on a deterministic engine.

**What each record says was sent.** Every record has a `sampling` block read back from the request body that went on the wire (or rebuilt from the options when the request failed): `temperature` (a number, or the string `"inherited"`), `topP`, `topK`, `minP`, `presencePenalty`, `repeatPenalty` and `seed` when sent, `maxTokens`, and `inherited`, the list of sampling knobs the lab did not send (wire names: `temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `repeat_penalty`). When something was inherited and the engine reported its defaults, `serverDefaults` holds them. The record's top-level `temperature` is the value sent or `"inherited"`, no longer the suite's grid value. `schema/result.v1.schema.json` accepts the same fields additively in `arm.sampling` (`temperature: "inherited"`, `inherited`, `serverDefaults`, `topP`, `topK`, `minP`, `presencePenalty`, `repeatPenalty`).

**Reading the effective inherited parameters on Ollama.** The engine block of every Ollama record carries `parameters`, the Modelfile `PARAMETER` lines parsed from `POST /api/show` field `parameters` (a text such as `temperature 1`, `top_k 20`, `stop "<|im_end|>"`; numbers become numbers, a repeated key such as `stop` becomes an array). Capture it into the evidence once per model before the run: `ollama show <model> --parameters` prints the same text, a read that loads nothing. Two limits: `/api/show` lists only what the Modelfile sets, so a knob it does not name falls back to Ollama's own built-in default, which `/api/show` does not report (read it from the Ollama documentation for the version in the engine block); and `parameters` is what the model is configured with, not proof of what the runner applied, so the claim to make is "these Modelfile defaults were inherited", not "this temperature was used". On llama-server the engine block carries `samplingDefaults`, the sampling keys of `/props` `default_generation_settings.params` (the startup values the server applies to a request that sends none).

### Where output goes

`--out DIR` (for `plan`, `run`, `fixtures`; for `report`, `diff` and `snapshot-tools` it stays a file) or `--results-dir DIR` or `LAB_RESULTS` sets the results folder; the default is `bench/lab/results`. Server logs go to `--log-dir` or `LAB_LOGS` (default `results/logs`). The write guard still refuses everything outside results, profiles, logs and the temp folder; a further root is allowed only by naming it: `--allow-root DIR` (repeatable) or `LAB_ALLOW_ROOTS`. On this machine C: and D: are nearly full: send everything to `M:\ai\lab\` and set `TEMP` and `TMP` to a folder on M: too.

### The server helper

```sh
node bench/lab/lab.mjs server start --gguf M:\ai\gguf\gpt-oss-20b-MXFP4.gguf --ctx 16384 --log-dir M:\ai\lab\logs --allow-root M:\ai\lab   # foreground; Ctrl-C stops it
node bench/lab/lab.mjs server status --log-dir M:\ai\lab\logs
node bench/lab/lab.mjs server stop   --log-dir M:\ai\lab\logs      # kills a server a crashed lab left behind
```

or let one run own it: `run --run --api openai-chat --gguf FILE --serve ...` starts the server, runs, and stops it. The flags it starts with: `-m FILE --host 127.0.0.1 --port 8080 --jinja -ngl 99 -c 16384 -np 1 -a <alias> --no-webui`, plus on request `--chat-template NAME`, `--chat-template-file FILE`, `--cache-reuse N`, `--reasoning-format F`, `--metrics`, `--slots`, and anything else through `--server-arg` (but not `--host`, `--port`, `-m`, `--no-jinja`). `--exe` defaults to `M:\ai\llama.cpp\b12206\llama-server.exe`. Guards, all before anything starts:

- one server at a time: it refuses when its pid file names a live process or when anything already answers `/health` on the port;
- it refuses while Ollama has a model loaded (`/api/ps`);
- it refuses when `nvidia-smi` shows less free VRAM than the file plus 2 GB, and when `nvidia-smi` cannot be read (`--no-vram-check` overrides);
- the log (`llama-server-<port>-<time>.log`, with the full command line on its first line) is written under the log folder, which must be an allowed write root.

Then it waits for `GET /health` to return 200 (503 means still loading) and gives up on `--ready-timeout` seconds (300) or when the child exits, killing it. The process tree is killed with `taskkill /PID <pid> /T /F` on Windows (SIGKILL elsewhere) on stop, on a normal exit, on SIGTERM, SIGHUP and SIGBREAK, and by the second Ctrl-C. The first Ctrl-C lets the lab finish the request in flight, then stops the server. The handler llama.cpp picked is printed at start: the lab reads it from `GET /props` where the build reports it (`chat_format`, also looked for under `default_generation_settings`), and falls back to the `Chat format:` line of the server log (build b12206 logs no such line, which is why `/props` comes first). The record carries the template hash from `/props`.

### The `cache` suite

`--suite cache` sends ordered sequences, not single cases, and records the engine's own counters per request (14 requests per model): `same-prefix` (the identical request three times, then the same prefix with a new last user message), `volatile-first-vs-last` (a changing timestamp at the start of the system text against at the end), `tool-reorder` (the same tools, then reversed, then the original order). A per-run nonce opens every system text, so a rerun never finds the previous run warm and never hides the reuse inside a sequence. `report` prints one table per sequence with `cached`, `evaluated`, `evaluated vs cold`, prompt milliseconds and, for streamed runs (`--streams true`), time to first token. Compare rows inside one table, never across engines: they count tokens differently. Start with `-np 1` and no `--cache-reuse`, then repeat with `--cache-reuse 256` to see what KV shifting adds.

### Comparing engines: `compare`

```sh
node bench/lab/lab.mjs compare M:i\lab
esults-llama M:i\lab
esults-ollama --model-a gpt-oss-20b-mxfp4 --model-b gpt-oss:20b --out M:i\lab\compare.md --allow-root M:i\lab
```

Each case is one paired binary outcome (valid call or not), so the test is McNemar's exact test on the pairs where the arms disagree: with `b` pairs only A got right and `c` only B, the smaller count is Binomial(b + c, 1/2) under no difference, and the two-sided p is twice its lower tail (capped at 1). Pairs where both succeed or both fail carry no information about which arm is better and are only counted. **Two levels, raw and effective.** The pairs are matched on suite, arm, case id and pass, which is the raw n; but the passes of a prompt are not independent (at temperature 0 they are the same output), so `compare` also pairs at the prompt level: a prompt counts as valid on a side when more than half of its passes were valid (a prompt that splits evenly on a side is left out and named). The report prints raw n, distinct prompts and effective n, then a table of both levels with the McNemar p of each. `--unit prompt|pass|auto` picks the level that carries the verdict and the headline rates (`auto`, the default: prompt when the records show passes at temperature 0 and none above 0, otherwise pass; records without a temperature, such as hand-made ones, stay at the pass level). At the pass level the rates carry intervals on the effective n and a `CAUTION` is added to the verdict when the raw pairs reach 25 but the effective n does not. Flips are listed per prompt at the prompt level. The report also gives a cluster bootstrap 95% interval for the rate difference (2000 resamples of whole prompts, so the passes of a prompt stay together; fixed seed, so a rerun prints the same numbers) and lists every flipped case. Errors, cases present on one side only and duplicate keys are counted and left out. The verdict is `NOT ENOUGH PAIRS` below 25 pairs (the sample-size section of `bench/README.md`: about 25 runs per arm for a 0.3 difference); at 25 or more it says A is better, B is better, or no detectable difference (which is not evidence of equality). Token and cache counters are not compared: engines count differently.

### What an engine record holds (`engine`)

Every record carries an `engine` block read when the model was first used. llama-server: `build` (`/props` `build_info`), `slots` (`total_slots`), `modelPath`, `nCtx`, `chatTemplateSha` (first 16 hex of the SHA-256 of `/props` `chat_template`, so two runs with the same template hash used the same Jinja text) and `chatTemplateChars`, `chatFormat` (`chat_format` from `/props` where the build reports it; failing that the last `Chat format:` line of the server log, from the log the helper writes or from `--server-log FILE` for a server the lab did not start; failing both, `chat_format` from `/slots`), `chatFormatSource` (`props`, `log` or `slots`) and `samplingDefaults` (the server's startup sampling values). Ollama: `version`, `templateSha` (of `/api/show` `template`), `parser`, `renderer`, `quant`, `parameters` (the Modelfile `PARAMETER` lines, see "Sampling"). `thinkProbe: "accepted"` is present when `--think` was probed (below). A field the engine does not report is absent, never guessed. vLLM has no `/props`: when it is absent the lab asks `GET /version` and records `engine: "vllm"` with its `version`; vLLM reports no tool parser, so pass `--tool-parser NAME` (the value of the server's `--tool-call-parser`) and the record carries it as `parserDeclared`. The result schema's `arm.server` (contract version 2, `ServerIdentity` in `core/util/labContract.ts`) is the same facts in one shape: `name`, `version`, `parser`, `parserSource` (`reported` for Ollama's `/api/show` parser and llama-server's Chat format, `declared` for `--tool-parser`) and `templateSha`. `lib/serverIdentity.mjs` converts an engine block into it. Nothing is guessed, so a server that reports no version leaves it out.

### The `args-whitespace` suite

String arguments must arrive byte for byte. vLLM's Qwen3 and Qwen3-Coder tool parser strips all leading and trailing whitespace from every string argument in v0.24.0 through v0.25.1 and on `main` ([vllm-project/vllm#48753](https://github.com/vllm-project/vllm/issues/48753), filed 2026-07-15, open when read on 2026-11-11, no upstream fix linked). Per the issue the cause is `_qwen3_arg_converter` in `vllm/parser/qwen3.py` calling `value.strip()`; it affects the `qwen3_coder`, `qwen3_xml` and Seed-OSS parsers, streaming and not, and the legacy `qwen3coder` parser of v0.23 and earlier is not affected. An exact-string edit whose `old_string` has indentation or a trailing newline then no longer matches. The issue names no workaround other than that: the lab does not claim that another parser (hermes, for example) avoids it, so measure it.

The suite has 13 probes, each asking for one `edit_file` call whose `old_string` is an exact string: leading spaces, trailing spaces, a leading and a trailing tab, a trailing newline, a leading newline, CRLF lines, an indentation-only string, a newline-only string, a multi-line indented block, trailing blank lines, whitespace on both sides, and a control with none. Native tools only. The prompt carries the string as a JSON literal so the model does not have to guess the escapes.

```sh
# online, when you run it: one request per probe against the server you name
node bench/lab/lab.mjs run --run --suite args-whitespace --api openai-chat --base-url http://127.0.0.1:8000 \
  --alias Qwen/Qwen3-Coder-30B-A3B-Instruct --size-gb 60 --tool-parser qwen3_coder --max-vram 80 --max-ram 80
node bench/lab/lab.mjs whitespace            # reads results/*.jsonl, prints the report

# offline, no model and no server: recorded-shape replies
node bench/lab/lab.mjs whitespace --file bench/lab/fixtures/args-whitespace/stripping-vllm-0.25.1.jsonl \
  --file bench/lab/fixtures/args-whitespace/faithful-llama-server.jsonl
```

`whitespace` compares each argument as received with the expected string and prints, per model and server identity, a verdict (`STRIPS WHITESPACE`, `ALTERS ARGUMENTS`, `INCOMPLETE`, `FAITHFUL`), then per case `exact`, the kind of damage (`stripped` means only edge whitespace was lost), the first differing byte (a UTF-8 offset, with the expected and received byte; `end` where one side stops) and both strings with spaces shown as a visible mark. The two files in `fixtures/args-whitespace/` are recorded-shape replies written by hand for a stripping server (labelled vLLM 0.25.1) and a faithful one; they measure nothing about a real server. A vLLM server has no GGUF file: `--size-gb N --alias NAME` replace `--gguf FILE` as the size guard and the served model name (`--allow-remote` if it is not on this machine; the lab never starts or stops a vLLM server).

### The `--think` probe

When `--think` is anything but `default` (or unset), the first contact with each model is one tiny request (8 tokens, temperature 0) with that setting, before any case. An engine that refuses it (Ollama rejects `think` for a model without the `thinking` capability) stops the run at once: the log and the summary carry the engine's own message, nothing is recorded for that model, and the exit code is 1. Without the probe those models fail every case, are recorded as errors and trip the three-failure breaker with the message buried in the records. The probe costs one request of the budget. `llamacpp-raw` has no think setting and skips it.

### Slot and metrics sidecar (llama-server)

`--metrics` starts the server with `--metrics` (off by default in b12206) and `--slots` with `--slots` (on by default in b12206; `--help` of that build says so); on a server the lab did not start the same flags only turn on the polling. After every request the lab does `GET /slots` and `GET /metrics` and stores `sidecar` in the record, next to `usage.cachedTokens` (`cache_n`): per slot every scalar field plus `next_token` (not `params`), and every `llamacpp:*` metric as a number (`prompt_tokens_total`, `n_tokens_max`, `requests_processing` and so on). A failed poll is recorded as `slotsError` or `metricsError` and never fails the request. What a slot reports about its cache depends on the build: read the first real record before trusting a field.

### Request-dump replay

```sh
node bench/lab/lab.mjs replay --api openai-chat --gguf FILE --serve --slots --metrics --run --out M:i\lab
esults ...
node bench/lab/lab.mjs replay --dumps bench/tier0/fixtures/dumps --models qwen3.6:27b --api ollama-chat --run ...
```

Default `--dumps` is `bench/tier0/fixtures/dumps` (three synthetic sets, 11 requests: `churn`, `extends`, `system-field`) when it exists. A folder with `request-*.json` is one sequence; a folder of folders is one sequence per sub-folder; a `.jsonl` file is one request per line (a request body, or `{"request": body}` as the prompt-segment dump of PR #554 `CONTINUE_PROMPT_SEGMENTS` is expected to be; other fields of the line are kept in `source`). Bodies are OpenAI-style: `messages`, optional `tools`, optional top-level `system`. Requests run in order through the cache path, with a run nonce at the head of the first system message so a rerun does not meet the last run's warm cache. Records go to `results/replay.jsonl` (`suite: "replay"`, `kind: "cache"`) and `report` prints them with the other cache tables, plus the lab's own `first changed char` offset against the previous request. Replay does not send the dump's `model`, `stream` or `max_tokens`: the lab's own sampling (16 tokens, temperature 0) applies, unless `--temperature inherit` is given: then no sampling option is sent and the records say `inherited`.

### The first three runs

PowerShell, from a checkout of `main`, one engine and one model at a time, nothing pulled or created, output on M:. Time and VRAM figures are estimates. **These three runs have not been done: each needs the owner's approval (GPU time), and `compare` needs both halves before it can say anything.**

```powershell
$env:TEMP="M:\ai\tmp"; $env:TMP="M:\ai\tmp"; New-Item -ItemType Directory -Force M:\ai\tmp, M:\ai\lab\logs, M:\ai\lab\results | Out-Null
$o = "--out","M:\ai\lab\results","--log-dir","M:\ai\lab\logs","--allow-root","M:\ai\lab","--max-vram","24","--max-ram","24"
$ls = "--port","18080","--base-url","http://127.0.0.1:18080"      # Strata holds 8080 on this machine
ollama ps                                   # must show nothing loaded before a llama-server run

# Run 1: gpt-oss-20b (about 13 GB), reasoning always on, so no 400-token cap
node bench/lab/lab.mjs plan --suite leaks --api openai-chat --gguf M:\ai\gguf\gpt-oss-20b-MXFP4.gguf --alias gpt-oss-20b-mxfp4 --tool-counts agent --temperatures 0 --streams false,true --passes 3 --think default --num-predict 4096 @ls @o
node bench/lab/lab.mjs run --run --suite leaks --api openai-chat --gguf M:\ai\gguf\gpt-oss-20b-MXFP4.gguf --serve --alias gpt-oss-20b-mxfp4 --ctx 16384 --tool-counts agent --temperatures 0 --streams false,true --passes 3 --think default --num-predict 4096 --max-requests 60 --max-minutes 30 --request-timeout 300 @ls @o

# Run 2: Qwen3-Coder-30B (about 19 GB): the family handler, then the Generic one on the same file
node bench/lab/lab.mjs run --run --suite leaks --api openai-chat --gguf M:\ai\gguf\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf --serve --alias qwen3-coder-family --ctx 16384 --tool-counts agent --temperatures 0 --streams false,true --passes 3 --think default --num-predict 1024 --max-requests 60 --max-minutes 30 @ls @o
node bench/lab/lab.mjs run --run --suite leaks --api openai-chat --gguf M:\ai\gguf\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf --serve --alias qwen3-coder-chatml --chat-template chatml --ctx 16384 --tool-counts agent --temperatures 0 --streams false,true --passes 3 --think default --num-predict 1024 --max-requests 60 --max-minutes 30 @ls @o
# confirm from the printed "Chat format:" line (read from /props; b12206 logs none) that the first used the family handler and the second Generic

# Run 3: qwen3.6:27b on Ollama, /api/chat against /v1, same suite, same sampling
node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-chat --think default --num-predict 1024 --tool-counts agent --temperatures 0 --streams false,true --passes 3 --max-requests 60 --max-minutes 40 --model-minutes 40 @o
node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-v1 --think default --num-predict 1024 --tool-counts agent --temperatures 0 --streams false,true --passes 3 --max-requests 60 --max-minutes 40 --model-minutes 40 @o
node bench/lab/lab.mjs report --results-dir M:\ai\lab\results --out M:\ai\lab\results\runs.md --allow-root M:\ai\lab
```

`@o` and `@ls` splat the arrays in PowerShell (`@ls` moves the lab's llama-server off port 8080, which Strata holds). On `/v1` the context is Ollama's own (`num_ctx` cannot be sent), so the two Run 3 arms may not share a context: read `usage.promptTokens` against the expected count before comparing. Streams and non-streams are both in the grid, and each is its own arm: 8 prompts x 3 passes = 24 raw n per arm, but at temperature 0 the passes repeat, so the effective n is 8 (the plan and the report say so). Read these runs as screening; the planned experiments below use temperature above 0 with `--seed` where a claim needs a bigger n.

### Planned experiments E1 to E3 (needs owner approval: GPU)

From `plans/research/local-inference-lab.md` section 6, with the commands adjusted to the flags above. **None of this has been run; each row needs the owner's approval for its GPU time (E1 about 0.5 h, E2 about 1.5 h, E3 about 1 h), and nothing here downloads a model.** Every command is a dry plan until `--run` is present. Same preamble as the first three runs (`$o`, `$ls`, `ollama ps` showing nothing loaded, Strata stopped). Stop rules common to all: three consecutive failed requests, `--max-requests` and `--max-minutes` as stated, GPU memory above 30 GB, any memory left after unload.

Read each table through its **effective n**: the sample sizes below are per arm, in raw requests, with the effective n the plan prints in brackets.

**E1, RQ25 (does the request shape reuse the prefix, does `--cache-reuse` help).** Descriptive: 14 requests per sequence set per arm, no test, so no n question. Read `cached`, `evaluated vs cold` and prompt milliseconds inside each table only.

```powershell
foreach ($m in @(
  @{g="M:\ai\gguf\gpt-oss-20b-MXFP4.gguf"; a="gpt-oss-20b-mxfp4"},
  @{g="M:\ai\gguf\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"; a="qwen3-coder-family"})) {
  foreach ($cr in 0,256) {
    node bench/lab/lab.mjs run --run --suite cache --api openai-chat --gguf $m.g --serve --alias "$($m.a)-cr$cr" `
      --ctx 16384 --cache-reuse $cr --slots --metrics --streams true --passes 1 --max-requests 30 --max-minutes 15 @ls @o
  }
}
node bench/lab/lab.mjs replay --api openai-chat --gguf M:\ai\gguf\gpt-oss-20b-MXFP4.gguf --serve --slots --metrics --run @ls @o   # the 11 request dumps
node bench/lab/lab.mjs report --results-dir M:\ai\lab\results --out M:\ai\lab\results\e1.md --allow-root M:\ai\lab
```

Stop if the cold request's `cache_n` is nonzero (the nonce failed) or the first sequence times out. `replay` takes `--temperature inherit` too (it sends 16 tokens either way).

**E2, RQ16, RQ21, RQ22 (Ollama surfaces).** RQ16 at temperature 0 is 8 prompts per arm: the three passes only test determinism, so the effective n is 8 and `compare --unit prompt` can say nothing about a difference under 0.7 (rule 2 above); treat it as a screen. RQ22 is the one that can reach a bigger n: temperature 0.6 with `--seed 1` sends seeds 1 to 8 on passes 1 to 8, so the passes are distinct draws (check that two passes of one prompt differ before counting on it; the report prints the effective n between 8 and 64).

```powershell
foreach ($api in "ollama-chat","ollama-v1") {
  node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api $api --think off --num-predict 1024 `
    --tool-counts agent --temperatures 0 --streams false,true --passes 3 --max-requests 60 --max-minutes 40 --model-minutes 40 @o
}   # per arm: 8 prompts x 3 passes = 24 raw, effective n 8
node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-raw --think default --num-predict 1024 --tool-counts agent --temperatures 0 --streams false --passes 3 @o   # no template: the lab renders ChatML
# RQ21 tool_choice matrix on the /v1 surface (the record shows ignored or rejected): 1 to 3 requests per cell
foreach ($tc in "auto","required","none","read") {
  node bench/lab/lab.mjs run --run --suite dialect-probe --models qwen3.6:27b --api ollama-v1 --tool-choice $tc --limit 6 --passes 1 --max-requests 12 @o
}
# RQ22: reasoning off against on, temperature 0.6, seeded passes: 8 prompts x 8 passes = 64 raw per arm; one results folder per arm, so compare can pair them
foreach ($t in "off","on") {
  node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-chat --think $t --temperature 0.6 --seed 1 --num-predict 4096 --tool-counts agent --streams false --passes 8 --max-requests 70 --max-minutes 45 --model-minutes 45 @o --out "M:\ai\lab\results-think-$t"
}
node bench/lab/lab.mjs compare M:\ai\lab\results-think-off M:\ai\lab\results-think-on --out M:\ai\lab\e2-rq22.md --allow-root M:\ai\lab
```

Stop at the first HTTP 5xx or a model reload per request. With `--think on` reasoning tokens dominate time, so the on arm needs the larger `--num-predict`. Ollama's `/v1` surface cannot take `num_ctx`: read `usage.promptTokens` against the expected count before pairing arms.

**E3, RQ19, RQ29, RQ21 (handler, `required`).** 8 prompts x 4 passes at temperature 0.6 with `--seed 1` (seeds 1 to 4): 32 raw per arm, effective n between 8 and 32, which `compare` prints; at the pass level it adds a `CAUTION` unless the effective n reaches 25.

```powershell
# gpt-oss-20b family handler (no cap, reasoning always on), seeded passes
node bench/lab/lab.mjs run --run --suite leaks --api openai-chat --gguf M:\ai\gguf\gpt-oss-20b-MXFP4.gguf --serve --alias gpt-oss-20b-mxfp4 --ctx 16384 `
  --tool-counts agent --temperatures 0.6 --seed 1 --streams false --passes 4 --think default --num-predict 4096 --max-requests 60 --max-minutes 30 --request-timeout 300 @ls @o
# the same file under the Generic handler
node bench/lab/lab.mjs run --run --suite leaks --api openai-chat --gguf M:\ai\gguf\gpt-oss-20b-MXFP4.gguf --serve --alias gpt-oss-20b-chatml --chat-template chatml --ctx 16384 `
  --tool-counts agent --temperatures 0.6 --seed 1 --streams false --passes 4 --think default --num-predict 4096 --max-requests 60 --max-minutes 30 --request-timeout 300 @ls @o
# required against auto on Qwen3-Coder (the case key includes the tool choice)
foreach ($tc in "auto","required") {
  node bench/lab/lab.mjs run --run --suite leaks --api openai-chat --gguf M:\ai\gguf\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf --serve --alias qwen3-coder-family --ctx 16384 `
    --tool-choice $tc --tool-counts agent --temperatures 0.6 --seed 1 --streams false --passes 4 --think default --num-predict 1024 --max-requests 40 --max-minutes 20 @ls @o
}
node bench/lab/lab.mjs compare M:\ai\lab\results M:\ai\lab\results --model-a gpt-oss-20b-mxfp4 --model-b gpt-oss-20b-chatml --out M:\ai\lab\e3-handler.md --allow-root M:\ai\lab
```

Stop a model after 3 failures; if `required` is rejected with a 400, record the text and stop that arm. The handler is read from `/props` (printed at start and kept in the record as `chatFormat`, source `props`); also record the `/props` template hash. The grammar arm of RQ29 has no lab flag (the lab sends chat requests; `--server-arg` only carries server-level options): treat it as blocked.

**E4, RQ26 (inherited sampling), the first user of `--temperature inherit`** (also needs owner approval: GPU, about 0.75 h). First capture `ollama show qwen3.6:27b --parameters` into the evidence (a read, not a load); the record's engine block holds the same text as `parameters`.

```powershell
node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-chat --temperature inherit --seed 1 --think off --num-predict 1024 --tool-counts agent --temperatures 0 --streams false --passes 8 @o
node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-chat --temperature 0.6 --seed 1 --body-extra '{"options":{"top_p":0.95,"top_k":20,"presence_penalty":0}}' --think off --num-predict 1024 --tool-counts agent --streams false --passes 8 @o
```

Check the first record of the inherited arm: `sampling.temperature` must be `"inherited"` and `inherited` must list every knob; if the lab still sent a temperature, stop.

### Safe interruption

Ctrl-C once: the lab finishes the request in flight, writes it, unloads the Ollama model (or stops the llama-server it started) and exits 130; a rerun skips everything done. Ctrl-C twice: the process ends at once and the exit handler still kills the server tree. If a window was closed or the machine hiccuped, check `nvidia-smi` and `ollama ps`, then `node bench/lab/lab.mjs server stop --log-dir M:\ai\lab\logs`, and `ollama stop <model>`. Never start a second engine to "make room"; the helper refuses and says why.

### What could not be verified

Field names above come from the engines' documentation (llama.cpp `tools/server/README.md` and `docs/function-calling.md`, Ollama `docs/api.md` and the OpenAI-compatibility page) and from the fakes, not from a running engine: nothing was loaded when this was written. Open items to read off the first real responses: the value of `finish_reason` after a llama-server tool call (the docs example is ambiguous); whether llama-server accepts `tool_choice` `required` and a named function, and `chat_template_kwargs.enable_thinking`; the field name Ollama `/v1` uses for reasoning (the lab reads `reasoning`, `reasoning_content` and `thinking`); whether Ollama's `prompt_eval_count` falls when a prefix is cached; whether `/apply-template` renders `tools`; the streamed shape of `/completion` (not used); and that `/props` carries `default_generation_settings.n_ctx`. The llama-server README lists a default port that differs from 8080: the lab always passes `--port`.

## Tests

```sh
cd bench/lab && npm test        # node --test "test/*.test.mjs"
```

They run offline against a fake Ollama (`test/fakeOllama.mjs`, `node:http`, also `/v1` and raw `/api/generate`) and a fake llama-server (`test/fakeLlama.mjs`, with a prefix-cache emulation), and the server helper against a fake child process: streaming and non-streaming, native and text calls, timeouts, abort, resume, the budgets, the guards, report and interval maths, profiles, diffs, fixtures. Tests that need the product's parsers or reviewer skip themselves when the adapter cannot find a product checkout.

## Moving this folder to its own repository

The only module that knows about the product is `adapter.mjs` (a test fails if any other file imports outside the lab). It locates the checkout from `--product <dir>`, then `$LAB_PRODUCT_ROOT`, then two levels above the lab, and loads TypeScript through a small load hook (Node's own `module.stripTypeScriptTypes`, Node 22.13 or newer; if the product's `typescript` package has `transpileModule` it is used instead). It reads, and the lab uses:

- `core/util/toolDialectDetect.ts`: `classifyToolReply`, `dialectFromChatTemplate`, the thresholds.
- `core/util/toolDialectPresetTable.ts`: the preset table (what we expect each family to write; the lookup is mirrored in the adapter).
- `packages/openai-adapters/src/dialects/{qwenXml,hermesJson,glmXml,pythonic,llamaJson}.ts`: the recovery parsers.
- `core/llm/toolDialects/capture/fixture.ts`: `buildFixture`, the observed-fixture writer.
- `core/tools/permissions/auto/{prompt,parse}.ts` and `evaluation/cases.ts`: the reviewer prompt builder, verdict parser and B4 set.
- `core/llm/toolDialects/capture/tools.ts` (on demand, `snapshot-tools` only): the real agent tool list.

Every section degrades to `null` with a line in `product.missing`, so the lab still runs the parts that do not need the missing piece. To move it: copy `bench/lab` to the new repository's root, set `LAB_PRODUCT_ROOT` to a product checkout, and drop the `!bench/lab/lib/` and `bench/lab/results|profiles` lines from the product `.gitignore` (the new repository needs its own `results/` and `profiles/` ignores).

**What the product keeps:** the corpus (`core/llm/toolDialects/corpus/fixtures`) and its runner and pinning tests, the preset table and its drift test, the live-capture harness (`core/llm/toolDialects/capture`), the parsers, the leak detector, and the reviewer and its B4 or B12 gate. The lab is a consumer of those and a source of candidate fixtures and profiles; promotion into the product stays a reviewed product PR. Two things the lab copies on purpose so it does not depend on the product to run: the eight capture prompts in `suites/leaks.json` and the frozen agent tool list in `fixtures/agent-tools.json` (regenerate with `snapshot-tools`).

## Layout

```
adapter.mjs   the one module that touches the product
lab.mjs       the CLI
lib/          ollama client, transports, server helper, cache suite, compare, think probe, replay, guards, suites, classify, run, report, diff, suggest, fixtures, inventory, stats (Wilson, effective n), sampling (inherit, seeds, sampling record), paths, prompts
suites/       dialect-probe, args-whitespace, prompt-variants, reviewer, leaks, cache (data)
envshell/     the env-shell-tasks suite: do an environment block and corrective hints reduce failed shell commands (own README; `lab.mjs envshell help`)
fixtures/     frozen agent tool list, recorded-shape replies for the whitespace report (args-whitespace/)
samples/      small committed examples (from the fake server)
test/         offline tests and the fake Ollama
results/      gitignored: JSONL results and fixtures
profiles/     gitignored: learned profiles
```

## Product contract (MR7a, step one)

The lab depends on one product module, `core/util/labContract.ts` (pure, no imports). The contract is at **version 2** (version 2 adds `TEMPERATURE_INHERITED`, the temperature recorded when a request sent none, and lets the capture shapes carry it; the lab expects 2 and refuses a product build at another version). `core/util/labContract.pin.json` pins its version and exported surface (a core vitest fails when they change without the pin), and `core/util/labContract.golden.json` holds vectors that both that vitest and the lab run (`lib/contractCheck.mjs`, called from `lab.mjs` at start: a product build that disagrees makes the lab exit 2). `scripts/ci/check-bench-boundary.mjs` fails CI when anything under `core/`, `gui/`, `extensions/`, `binary/` or `packages/` imports `bench/`. `schema/result.v1.schema.json` with `lib/resultSchema.mjs` is the result record schema (MR8) and `lib/governor.mjs` the spend, request and wall-time governor (MR9), a dry run unless told otherwise; neither calls a model or the network.
