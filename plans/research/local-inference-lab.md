# Local inference stack and the lab: research and experiment plan (2026-11-11)

Status: research and planning only. No model was loaded, no server was started, no GPU was used and nothing was written to C: while writing this. **Nothing in the experiment plan (section 6) runs without the owner's approval.** Web sources were fetched on 2026-11-11. Sources are marked P (primary: vendor model card, project docs, pull request) or S (secondary: blog, aggregator, forum or Reddit snapshot). A recommendation never rests on an S source alone. Anything dated before 2026-05-11 is flagged "old" (more than six months). Figures from the repository's own runs are marked "measured here" and cite the file.

Machine (from `bench/lab/README.md` and `bench/evidence/2026-11-11-reviewer-remeasure/README.md`): one RTX 5090 (32 GB), 125 GB RAM, Ollama 0.40.13 (0.40.16 is current), llama.cpp b12206 at `M:\ai\llama.cpp\b12206` (master is at b12291), GGUFs `Qwen3-Coder-30B-A3B-Instruct-Q4_K_M` (18.6 GB) and `gpt-oss-20b-MXFP4` (12.1 GB) in `M:\ai\gguf`, Ollama models `qwen3.6:27b`, `deepseek-ocr`, `glm-ocr`, `qwen3-embedding:8b`, and the NVFP4 `Qwen3.8-Flash-Next` checkpoint under `M:\Strata-models`. Free space read today with `df`: M: 199 GB, A: 5.2 TB, D: 45 GB, C: 2.4 GB.

## 1. Summary and ranked recommendations

| #   | Recommendation                                                                                                                                                                                                          | Effort           | Risk                               | Owner decision                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------- | -------------------------------- |
| 1   | Run the cheap cache and API-surface experiments first (E1 to E3 in section 6): about 3 GPU-hours total, no downloads, answer RQ25, RQ16, RQ21, RQ22 and finish RQ19.                                                    | S                | none beyond GPU time               | approve GPU time                 |
| 2   | Fix two lab gaps before any claim: send no sampling options on request (RQ26 cannot be run today) and count distinct prompts, not passes, as n at temperature 0 (section 6.1).                                          | S                | low                                | none                             |
| 3   | Refresh the model set: add Qwen3.6-35B-A3B (and Qwen3.8-27B) as the local coding row beside the two we measured; both postdate them and carry vendor SWE-bench and Terminal-Bench numbers well above them.              | M (disk, preset) | low                                | approve about 40 GB of downloads |
| 4   | Treat llama.cpp as the measurement engine and Ollama as the user-facing one; keep both contrasts (RQ16, RQ20) because the handler and renderer, not the weights, produced the largest measured effect (0% against 75%). | none             | none                               | none                             |
| 5   | Do not stand up vLLM or SGLang on this machine now: no disk on C: or D:, WSL2 NVFP4 on SM120 works only with version-specific workarounds, and nothing in the queue needs it that llama.cpp cannot answer.              | none             | skipping loses RQ5's vLLM arm      | defer vLLM arm of RQ5            |
| 6   | Never serve a model from the NAS. Archive on A:, restore to M: before loading (section 7).                                                                                                                              | S                | low                                | grant write on the A: shares     |
| 7   | Keep embeddings a measured option, not a default: try Qwen3-Embedding (already installed as 8b) with a reranker on the codebase-index benchmark (L4) only after the structural tools are measured (section 8).          | M                | licence (Jina is non-commercial)   | none now                         |
| 8   | Add MTP (`--spec-type draft-mtp`) as one lab arm on a Qwen3.6 GGUF only after E1 to E5; the published gains are for long decodes, and agent turns are short (section 4.3).                                              | M                | long-context loss, parallel 1 only | approve a 17 to 23 GB download   |

## 2. What the repository already measured

All from `bench/evidence/2026-11-11-reviewer-remeasure/lab/` (RTX 5090, llama-server b12206, port 18080, `leaks` suite with the agent tool list, temperature 0, 3 passes, 8 prompts, whole and streamed):

| Arm                                                         | Valid calls (Wilson 95%) | Median decode speed | Note                                                             |
| ----------------------------------------------------------- | ------------------------ | ------------------- | ---------------------------------------------------------------- |
| Qwen3-Coder-30B-A3B Q4_K_M, file's own template (`--jinja`) | 36/48 = 75% (61 to 85%)  | 237 to 246 tok/s    | all 48 structured; the 12 invalid are the `plan` and `run` cases |
| same file, `--chat-template chatml`                         | 0/48 = 0% (0 to 7%)      | 330 to 344 tok/s    | all 48 prose; McNemar exact on 36 discordant pairs, p < 0.0001   |
| `qwen3.6:27b`, Ollama `/api/chat`, `think=on`               | 4/4 (51 to 100%)         | 77.5 tok/s          | a think-probe run, not a measurement of validity (n = 4)         |

Three cautions that change how these numbers may be used:

1. **At temperature 0 the three passes are repeats, not samples.** The 36 discordant pairs are 6 distinct prompts times 2 stream modes times 3 passes. The honest unit is the prompt: 6 of 8 prompts flipped. The effect is still decisive (it is all one direction), but the Wilson interval on 48 is narrower than the evidence supports, and any smaller contrast (RQ19's `auto` against `required`, RQ26) cannot be decided on 8 prompts however many passes are run. Section 6.1 gives the fix.
2. The speeds are for replies of about 50 tokens. They are decode-heavy at the start of a context; they say nothing about decode speed at 32K tokens of history. The published figures in section 3 fall by 15 to 30% over that range.
3. llama-server b12206 prints no `Chat format:` line, so which handler ran is inferred from the 0% result, not read (evidence README, "Surprises" 3; ROADMAP MR27). Until MR27 lands, record the `/props` `chat_template` hash and the first tool-call response shape per arm.

## 3. Local coding-agent models that fit 32 GB (as of 2026-11-11)

Vendor numbers are from the model cards and were produced on the vendor's harness: they are not comparable across rows and none has been reproduced here. BFCL: the Berkeley leaderboard page was fetched but its table is not in the fetched text (the page says last updated 2026-04-12), so no BFCL figure is quoted for any model.

### 3.1 Candidates

| Model (source)                                                                                               | Shape and size on disk                                                                                   | Vendor coding and agent numbers                                                               | Tool-call handling                                                                                                                                         | Published 5090 speed                                                                              |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Qwen3.8-27B (P: https://huggingface.co/Qwen/Qwen3.8-27B, Aug 2026)                                           | 27B hybrid (3 Gated DeltaNet : 1 gated attention), MTP trained, 262K context, Apache-2.0; Q4 about 17 GB | SWE-bench Pro 61.7, Terminal-Bench 2.1 73.0, LiveCodeBench v6 90.3 (vendor, not reproduced)   | vendor serves with vLLM or SGLang; the `qwen3_coder` parser flag is documented on the 3.6 cards, not on this one                                           | one S source: about 59 tok/s at Q6_K                                                              |
| Qwen3.6-27B (P: https://huggingface.co/Qwen/Qwen3.6-27B, Apr 2026)                                           | same architecture, 64 layers, Q4 about 17 GB; Ollama tag `27b` is 18 to 19 GB                            | SWE-bench Verified 77.2, Terminal-Bench 2.0 59.3, LiveCodeBench v6 83.9                       | vLLM and SGLang `--tool-call-parser qwen3_coder --reasoning-parser qwen3`; Ollama tag has tools and thinking (P: https://ollama.com/library/qwen3.6)       | measured here: 77.5 tok/s on Ollama (think on, 4 requests)                                        |
| Qwen3.6-35B-A3B (P: https://huggingface.co/Qwen/Qwen3.6-35B-A3B, Apr 2026)                                   | 35B MoE, 3B active, 256 experts, Q4 about 23 GB (Ollama `latest` is 23 GB)                               | SWE-bench Verified 73.4, SWE-bench Pro 49.5, Terminal-Bench 2.0 51.5, MCP-Atlas 62.8          | as above                                                                                                                                                   | S: about 80 tok/s at Q6_K on a 5090                                                               |
| Qwen3-Coder-30B-A3B-Instruct (old, 2025; local)                                                              | 30B MoE, 3B active, Q4_K_M 18.6 GB                                                                       | no figure re-fetched; older than the Qwen3.6 generation                                       | llama.cpp: works with the family handler under `--jinja`; the Generic handler failed 48/48 (section 2)                                                     | measured here: about 240 tok/s (short replies)                                                    |
| gpt-oss-20b (old, 2025; local MXFP4)                                                                         | 21B MoE, MXFP4 12.1 GB, reasoning always on                                                              | S: a SWE-bench Verified of 60.7 is quoted for the model card                                  | llama.cpp has a native Harmony handler (P: docs/function-calling.md)                                                                                       | S: NVIDIA says up to 250 tok/s on a 5090; llama.cpp tests quoted at 282 (quantisation not stated) |
| Devstral Small 2 24B (P: https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512, Dec 2025, old) | 24B dense, about 15 GB at Q4                                                                             | SWE-bench Verified 68.0 (Mistral); Terminal-Bench 2 22.5 on the card, 32.0 on the Ollama page | Mistral serves with vLLM and a Mistral parser; llama.cpp needs a fixed build (PR 17945 cited on the card); Unsloth warns implementations may be inaccurate | none found                                                                                        |
| GLM-4.7-Flash (S, Jan 2026, old)                                                                             | 30B MoE, 3B active                                                                                       | S: SWE-bench Verified 59.2 (vendor figure; an arXiv note says such scores may not reproduce)  | works with Claude Code per anecdotes                                                                                                                       | S: about 43 tok/s on a 3090 at 32K                                                                |
| Gemma 4 26B-A4B and 31B (S, Apr 2026)                                                                        | MoE and dense                                                                                            | no coding benchmark found                                                                     | S: Ollama at least 0.22 for correct tool calling; vLLM needs `--tool-call-parser gemma4`                                                                   | S: llama.cpp b8639 Q4_K_M: 26B-A4B 180 tok/s at 4K, 106 at 256K; 31B 61 at 4K, 43 at 128K         |

Not covered by a usable source in this pass: Kimi (no model that fits 32 GB was found), Seed-OSS-36B and Nemotron 3 Nano (one practitioner remark that Nemotron 3 Nano does not show its benchmark lead on real work, S). They stay on the ROADMAP's "families not yet measured" row; there is no case for spending GPU time on them before the Qwen3.6 generation is in the lab.

Reading the table: the two models we can run today are a generation behind. The vendor-reported gap is large (SWE-bench Verified 73 to 77 for the Qwen3.6 pair; the Qwen3.8 card reports Pro rather than Verified), but it is the vendor's harness. Our own question is narrower and the lab measures it: does the product's tool list and prompt produce valid calls, through which parser, at which cost. That is why section 6 never asks "which model is smartest".

### 3.2 Sampling the vendor recommends, and what Ollama applies

Qwen3.6-35B-A3B card (P): thinking, general: temperature 1.0, top_p 0.95, top_k 20, presence_penalty 1.5; thinking, precise coding: temperature 0.6, top_p 0.95, top_k 20, presence_penalty 0.0; non-thinking: temperature 0.7, top_p 0.8, top_k 20, presence_penalty 1.5. The 27B card gives presence_penalty 0.0 for thinking general. The ROADMAP's RQ26 note says the `qwen3.6:27b` Modelfile sets temperature 1 and presence_penalty 1.5. If that is right, an agent that sends no sampling options gets the general-chat set on a coding task, and presence_penalty 1.5 is a plausible cause of exact-string edit failures (it penalises repeating a token already in the context, and an exact edit repeats the file's own text). That is a hypothesis RQ26 can test in about 45 minutes (E4); it is not a finding.

### 3.3 Quantisation formats on this card

| Format                    | Status in llama.cpp                                                                                                                                                                                                                                                                         | Note                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q4_K_M, Q6_K, Q8_0        | mature                                                                                                                                                                                                                                                                                      | the lab's current files                                                                                                                                                    |
| MXFP4                     | native (gpt-oss ships it)                                                                                                                                                                                                                                                                   | local file already                                                                                                                                                         |
| NVFP4                     | type merged March 2026 (S); CUDA kernels April 2026 (S); **Blackwell-native path merged 2026-04-28, PR #22196** (P: https://github.com/ggml-org/llama.cpp/pull/22196). Build b12284 (2026-11-11) carries an NVFP4 Qwen3.6-27B benchmark log from a Blackwell RTX PRO 4500 (P: release list) | the 5090 is the target; no published 5090 NVFP4 token rate was found; the pull request reports perplexity slightly worse than Q4_K (4.6577 against 4.6237 on a 120B model) |
| FP8 KV cache              | b12274 "FP8 KV-cache support" and b12284 "OCP FP8" (P: release list)                                                                                                                                                                                                                        | after b12206; the lab's binary does not have it                                                                                                                            |
| AWQ, GPTQ, ModelOpt NVFP4 | vLLM and SGLang only                                                                                                                                                                                                                                                                        | section 5                                                                                                                                                                  |

NVFP4's value on a 32 GB card is bandwidth, not capacity: a 27B at 4 bits is about 15 to 17 GB either way. Do not expect a different fit, and quality against Q4_K_M is unmeasured for this family. It is a candidate row only after Qwen3.6 or 3.8 GGUFs exist locally.

### 3.4 Context against VRAM (calculation, not measurement)

KV bytes per token = (attention layers) x 2 x (KV heads) x (head dim) x (bytes per element).

| Model                       | Inputs (source)                                                                                        | f16 per token | 32K   | 128K   | 256K   |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ------------- | ----- | ------ | ------ |
| Qwen3.6-27B and Qwen3.8-27B | 16 attention layers (one per block of four, 64 layers), 4 KV heads, head dim 256 (P: Qwen3.8-27B card) | 64 KiB        | 2 GiB | 8 GiB  | 16 GiB |
| Qwen3-Coder-30B-A3B         | 48 layers, 4 KV heads, head dim 128 (from memory of its `config.json`, **verify**)                     | 96 KiB        | 3 GiB | 12 GiB | 24 GiB |

With `-ctk q8_0 -ctv q8_0` halve every figure. The 27B hybrid is cheap in KV because 48 of 64 layers hold a fixed-size recurrent state instead; weights (about 17 GB) plus 8 GiB at 128K f16 is 25 GB, so 128K fits and 256K needs q8_0 KV. The recurrent state and the compute buffer add a few GB: read the real KV and buffer sizes from the first llama-server log lines instead of trusting this table. llama.cpp's own docs warn that `-ctk q4_0` "can substantially degrade tool calling" (P: docs/function-calling.md); Ollama says q8_0 costs "very little quality" and q4_0 more at long context (P: https://docs.ollama.com/faq). The tool-call validity cost of q8_0 on our prompts is unmeasured: that is RQ-TBD-D in section 9.

## 4. Engine features that matter for an agent

### 4.1 llama.cpp

All flags below are from master's `tools/server/README.md` (P, fetched today) and **may differ in b12206**: run `llama-server --help` from `M:\ai\llama.cpp\b12206` and record it in the evidence folder before any run (the lab README already notes `--metrics` is off and `--slots` on in b12206).

| Feature                | Flag and default (master)                                                                                                                                | Relevance to the agent                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prefix cache, KV shift | `--cache-reuse N` default 0; `--cache-ram` default 8192 MiB; `--cache-idle-slots` on; `-np` auto                                                         | E1 measures what the product's request shape gets; with `-np 1` there is one slot, so alternating sub-agents evict each other                                                                                                                                                                                                                                                                                                           |
| Context checkpoints    | `-ctxcp` default 32, `-cms` 8192                                                                                                                         | recurrent and sliding-window models (the Qwen3.6 and 3.8 hybrids, gpt-oss) cannot rewind to an arbitrary position; checkpoints are what let a prefix be reused (inference from the MTP pull request's recurrent-state notes; **verify in E1**)                                                                                                                                                                                          |
| Slot save and restore  | `--slot-save-path` disabled                                                                                                                              | would let a session's cache survive a server restart; not evaluated                                                                                                                                                                                                                                                                                                                                                                     |
| Flash attention        | `-fa auto`                                                                                                                                               | required for a quantised V cache                                                                                                                                                                                                                                                                                                                                                                                                        |
| KV types               | `-ctk/-ctv f16`                                                                                                                                          | section 3.4                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Templates and tools    | `--jinja` on; an unknown template logs `Chat format: Generic` and "may consume more tokens and be less efficient"                                        | the 0% result. The function-calling page lists native handlers for Llama 3.x, Hermes, Qwen 2.5 and Qwen 2.5 Coder, Mistral Nemo, Command R7B, DeepSeek R1 (WIP) and gpt-oss Harmony, and **does not list Qwen3-Coder, Qwen3.x, GLM, Devstral or Kimi**, yet our Qwen3-Coder arm worked, so the page is not a complete list of what template detection picks. Parallel calls are off unless the request sets `parallel_tool_calls: true` |
| Reasoning              | `--reasoning-format auto`, `-rea on/off/auto`, `--reasoning-budget -1`                                                                                   | RQ22; `--reasoning-budget 0` ends thinking immediately                                                                                                                                                                                                                                                                                                                                                                                  |
| Grammar and schema     | `--grammar`, `--grammar-file`, `-j`, request `json_schema` and `response_format`; b12282 fixes `response_format json_schema` being ignored for one model | RQ29 and RQ32; use a build at or after b12282 for schema claims                                                                                                                                                                                                                                                                                                                                                                         |
| Router mode            | `--models-dir`, `--models-max 4`, `--models-autoload`                                                                                                    | could swap models on demand; the lab's one-server guard does not know it, so do not enable it                                                                                                                                                                                                                                                                                                                                           |

### 4.2 Ollama

| Fact                                                                                                                                                                                                            | Source                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `keep_alive` default 5 minutes; `OLLAMA_KEEP_ALIVE` overrides; the API field overrides both                                                                                                                     | P: https://docs.ollama.com/faq                                                              |
| Default context by VRAM: under 24 GiB 4k; 24 to 48 GiB 32k; 48 GiB and up 256k; the docs say agents and coding tools should use at least 64,000                                                                 | P: https://docs.ollama.com/context-length (the FAQ still says 4096; the newer page is used) |
| `OLLAMA_FLASH_ATTENTION` automatic when supported; `OLLAMA_KV_CACHE_TYPE` f16 default, q8_0 and q4_0 global, needs flash attention; `OLLAMA_NUM_PARALLEL` 1; `OLLAMA_MAX_LOADED_MODELS` 3 per GPU               | P: FAQ                                                                                      |
| The 5090 is in the 24 to 48 GiB tier, so an unconfigured Ollama allocates 32k context; the lab always sends `num_ctx` (8,192, or 16,384 for `leaks`), so lab results are not what a user's default session gets | inference from the two rows above; RQ23 is the related truncation question                  |
| Modelfile parameters are applied when a request sets none (RQ26); the FAQ does not describe this                                                                                                                | ROADMAP RQ26; not confirmed by a doc                                                        |
| 0.40.15 added YaRN scaling for Qwen3 and Qwen3.5; 0.40.16 stops `/v1/responses` truncating silently; 0.40.12 added DFlash draft decoding **on MLX only**; no NVFP4 or MTP note in the last eight releases       | P: https://github.com/ollama/ollama/releases                                                |

So Ollama has no CUDA speculative decoding or MTP today (from the release notes; absence of a note is not proof). Every speed-up experiment is therefore llama.cpp-only.

### 4.3 Speculative decoding and MTP

P: https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md. `--spec-type` accepts `draft-simple` (a small draft model), `draft-eagle3`, `draft-dflash`, `draft-dspark` (Qwen3 backbones only), `draft-mtp`, and the draftless `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`, `ngram-mod`, `ngram-cache`; types combine by comma. `--spec-draft-n-max` defaults to 3. The page gives no speedup figures.

MTP, P: https://github.com/ggml-org/llama.cpp/pull/22673 (merged 2026-05-16, so it is more than five months old; the flag was renamed from `mtp` to `draft-mtp` on 2026-05-13, S). Author-tested on Qwen3.6-27B and Qwen3.6-35B-A3B, with MTP GGUFs published under ggml-org. Caveats in the pull request thread: **requires `--parallel 1`**; prompt processing is slower (one user 1,315 against 665 tok/s prefill); about 2.5 GiB extra VRAM; Vulkan produced garbage for one user. Reported decode gains are community figures on other cards: 27B Q6_K on two GPUs 22.97 to 42.45 tok/s (1.85x, 76% acceptance); 35B-A3B on a 6 GB laptop 22.9 to 29.4 (1.28x). Two S reports say the gain disappears at 128K context on the 35B MoE and that autoregressive decoding wins below about 900 output tokens.

Agent turns are mostly short (a tool call is 40 to 100 tokens, measured above) and prompts are long, which is the regime where MTP helps least and its prefill penalty hurts most. The 30B-A3B and 35B-A3B MoE models already decode at 80 to 240 tok/s, so MTP could only matter for the dense 27B (77 tok/s). Recommendation: one arm (E8), after the rest, not a default.

NVIDIA's Qwen3.8-Flash-Next card documents MTP only for vLLM across 8 GPUs and requires a vLLM pull request that was not yet merged when the card was written.

### 4.4 The local NVFP4 Qwen3.8-Flash-Next

NVIDIA's card (P: https://huggingface.co/nvidia/Qwen3.8-Flash-Next-NVFP4, 2026-08-31): 125B total parameters, 6B active, plus 51B n-gram embedding and 4B MTP; routed MoE experts W4A4 NVFP4, attention and shared experts BF16, MTP experts FP8; vLLM is the supported runtime, tested on B200 and B300; Terminal-Bench 2.1 82.9 NVFP4 against 83.3 FP8 (vendor figure). The local copy holds 96 GB of tensors and a 99 GB `prepared` folder (`dense.gguf`, `ple-nvfp4.gguf`, `mtp`, `pack`), so it cannot be GPU-resident on 32 GB: the owner's Strata launcher must page experts through the 125 GB of host RAM. That is inference from file names and sizes; the Strata design was not read. It is not a llama-server experiment and not part of the one-server-at-a-time plan, except that Strata also holds port 8080 (MR28) and VRAM: **nothing from section 6 may run while Strata has the model loaded.**

## 5. vLLM and SGLang on this machine

| Question              | Finding                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native Windows        | No supported path found; the community route is WSL2 or Docker Desktop with the WSL2 backend (S: https://discuss.vllm.ai/t/project-vllm-docker-for-running-smoothly-on-rtx-5090-wsl2/1697, whose most-cited container was last pushed October 2025, old)                                                                                                                         |
| NVFP4 on SM120 (5090) | kernels compiled since vLLM 0.12 to 0.13 (S: a vLLM issue); an open report that a Qwen3.6-27B NVFP4 ModelOpt checkpoint falls back to a Marlin FP4 path on a 5090 with vLLM 0.24.0 (S, a vLLM GitHub issue); another reports about 145 tok/s for NVIDIA's Qwen3.6-35B-A3B-NVFP4 under Docker Desktop WSL2 (S: https://huggingface.co/nvidia/Qwen3.6-35B-A3B-NVFP4/discussions/2) |
| WSL2 workarounds      | environment variables such as `NCCL_P2P_DISABLE=1`, `NCCL_CUMEM_ENABLE=0`, `VLLM_WORKER_MULTIPROC_METHOD=spawn` reported on a different Blackwell card; one user needed five undocumented fixes (S)                                                                                                                                                                              |
| Disk                  | a vLLM image and a WSL2 virtual disk are 10 to 30 GB on C: or D:, which have 2.4 GB and 45 GB free; a relocated WSL distro on M: is possible but is a change to the machine, not to the repository                                                                                                                                                                               |
| TensorRT-LLM          | nothing found that supports a consumer 5090 for these models; NVIDIA's own cards list B200 and B300                                                                                                                                                                                                                                                                              |
| What vLLM would add   | the vendor-documented `qwen3_coder` parser and `qwen3_next_mtp`; a second parser implementation to contrast with llama.cpp (RQ5 asks for it); continuous batching, irrelevant to one request at a time                                                                                                                                                                           |

Recommendation: defer. RQ5's vLLM arm can instead be answered from declared facts (MR2 already collects parser-registry pairings) until the owner wants to spend a disk and an afternoon. If it is wanted later, the cheapest honest version is a pre-built image pulled once onto M: with NVIDIA's `Qwen3.6-35B-A3B-NVFP4`, one arm of the `leaks` suite over `openai-chat`, and a stop after the first run that shows the Marlin fallback warning.

## 6. Experiment plan

**NOTHING IN THIS SECTION RUNS WITHOUT THE OWNER'S APPROVAL.** Each experiment names its GPU time, so approval can be given per row. Commands are PowerShell from a checkout of `main`, using the lab as it exists on `origin/main` (`bench/lab/lab.mjs`, flags read from its README and `--help` text on 2026-11-11). Every command is a dry plan until `--run` is present. Preamble for all of them:

```powershell
$env:TEMP="M:\ai\tmp"; $env:TMP="M:\ai\tmp"
New-Item -ItemType Directory -Force M:\ai\tmp, M:\ai\lab\logs, M:\ai\lab\results | Out-Null
$o  = "--out","M:\ai\lab\results","--log-dir","M:\ai\lab\logs","--allow-root","M:\ai\lab","--max-vram","24","--max-ram","24"
$ls = "--port","18080","--base-url","http://127.0.0.1:18080"      # 8080 is Strata's (MR28)
ollama ps ; nvidia-smi --query-gpu=memory.used,memory.total --format=csv   # nothing of ours loaded; Strata stopped
```

### 6.1 Method rules that apply to every row

1. **One server at a time.** The lab refuses a second engine; never override with `--ignore-loaded` or `--no-vram-check`.
2. **n per arm and Wilson bounds.** Wilson 95% for k = n and for k = n - 1: n = 8: 68 to 100% and 53 to 98%; n = 16: 81 to 100% and 72 to 99%; n = 24: 86 to 100% and 80 to 99%; n = 32: 89 to 100% and 84 to 99%; n = 48: 93 to 100% and 89 to 100%; n = 96: 96 to 100% and 94 to 100%. At p = 0.5 the interval is 22 to 78% for n = 8, 34 to 66% for n = 32 and 40 to 60% for n = 96. The lab's rule stands: below 10 per arm every number is labelled screening; `compare` says nothing under 25 pairs; about 25 pairs detect a 0.3 difference.
3. **Independent items.** At temperature 0 a pass repeats the same output; count distinct prompts. For any claim that needs n of 25 or more, either run at temperature 0.6 to 1.0 with `--seed` (the lab has the flag) or extend the prompt battery (MR11). Until the lab reports effective n (MR-TBD-2), quote the prompt count beside every rate.
4. **Report the factor settings.** Every record already carries the engine build, template hash, `cfg` and case key; also save `llama-server --help` and `ollama --version` output into the results folder once.
5. **Stop rules common to all:** three consecutive failed requests (the lab's breaker); `--max-requests` and `--max-minutes` as stated per row; GPU memory above 30 GB; any `nvidia-smi` memory left after unload; a request time above 3x the first measured one.
6. **Disk:** results are JSONL of a few MB, all to `M:\ai\lab`. Nothing is written to C: or D:. Downloads, where a row needs them, go to `M:\ai\gguf` and are archived to A: afterwards (section 7).

### 6.2 The plan, ordered by value per GPU-hour

| Rank | ID  | RQs                 | What it decides                                                                                                                                    | Model and engine                                                                                           | VRAM        | n per arm                                                                                                                                      | GPU time            | Disk added                  | Stop rule                                                                                                     |
| ---- | --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | E1  | RQ25                | whether the product's request shape reuses the prefix, and whether `--cache-reuse` helps (C55, K4, Z3, the tail decision)                          | gpt-oss-20b MXFP4 and Qwen3-Coder Q4_K_M under llama-server, `-np 1`, with and without `--cache-reuse 256` | 13 to 22 GB | 14 requests per sequence set per arm: a descriptive table, no test                                                                             | 0.5 h               | MB                          | stop if the cold request's `cache_n` is nonzero (the nonce failed) or the first sequence times out            |
| 2    | E2  | RQ16, RQ21, RQ22    | do Ollama `/api/chat`, `/v1` and raw agree; which `tool_choice` and `think` values are accepted, ignored or rejected; does reasoning move validity | `qwen3.6:27b`, Ollama 0.40.13                                                                              | 19 to 22 GB | RQ16: 8 prompts x 2 stream modes x 3 passes = 48 (8 independent); RQ21: 1 to 3 requests per cell; RQ22: 8 prompts x 8 seeded passes = 64 pairs | 1.5 h               | MB                          | per arm `--max-requests 60 --max-minutes 40`; stop at the first HTTP 5xx or a model reload per request        |
| 3    | E3  | RQ19, RQ29, RQ21    | finish the handler contrast on gpt-oss-20b (family handler, Harmony) and test `--tool-choice required` against `auto` on both GGUFs                | gpt-oss-20b and Qwen3-Coder under llama-server                                                             | 13 to 22 GB | 8 prompts x 4 seeded passes at temperature 0.6 per arm: 32 pairs per contrast                                                                  | 1 h                 | MB                          | stop a model after 3 failures; if `required` is rejected with a 400, record the text and stop that arm        |
| 4    | E4  | RQ26                | does the inherited Modelfile sampling change call validity and exact-string edits                                                                  | `qwen3.6:27b`, Ollama                                                                                      | 19 to 22 GB | 64 pairs (8 prompts x 8 passes) per arm, three arms: inherited, vendor coding set, temperature 0                                               | 0.75 h              | MB                          | blocked until MR-TBD-1 lands; stop if the inherited arm's request echo shows the lab still sent a temperature |
| 5    | E5  | RQ20, RQ5 (one arm) | does an Ollama import from the GGUF with no parser line leak where the library tag does not; engine contrast on one GGUF                           | Qwen3-Coder GGUF: `ollama create` with and without a `PARSER` line, against llama-server (E3's arm)        | 22 GB       | 8 prompts x 4 passes x 2 stream modes = 64 per variant, three variants                                                                         | 1.25 h incl. import | 18.6 GB on M: per import    | the owner runs `ollama create`; stop if M: free space falls under 60 GB; the lab never creates a model        |
| 6    | E6  | RQ30                | cost of forced turns: false calls on no-tool prompts, escape-tool use, reasoning-quality proxy                                                     | gpt-oss-20b and Qwen3-Coder under llama-server                                                             | 13 to 22 GB | 32 no-tool prompts (needs MR11's battery), 20 checkable tasks, two reasoning settings                                                          | 1.5 h               | MB                          | needs E3 first; stop if `required` is ignored on a model (nothing to cost)                                    |
| 7    | E7  | model refresh       | whether Qwen3.6-35B-A3B and Qwen3.8-27B GGUFs do as well as Qwen3-Coder on `leaks` and `dialect-probe`; which handler                              | new GGUFs under llama-server                                                                               | 17 to 24 GB | 8 prompts x 4 passes x 2 streams per model                                                                                                     | 1 h plus download   | 17 to 23 GB per model on M: | owner approves each download; stop if the `/props` template is not detected (Generic) on the first request    |
| 8    | E8  | MTP and speed-up    | whether `--spec-type draft-mtp` pays off at agent shapes (short output, 10 to 60K prompt), and what it costs in prefill                            | Qwen3.6-27B MTP GGUF (ggml-org) under llama-server, `-np 1`                                                | 20 to 26 GB | 10 requests per arm per length, descriptive: tok/s, prefill tok/s, acceptance                                                                  | 1 h                 | about 18 GB                 | stop if prefill falls under half of the no-MTP arm at 16K; stop on any garbage output                         |
| 9    | E9  | RQ34                | leave-one-out rule shedding per family                                                                                                             | the local Qwen row chosen after E7                                                                         | 19 to 24 GB | group screening n = 10, bullet confirmation n = 29 to 33 (per `prompt-segment-plan.md` section 9)                                              | 3 to 6 h (est.)     | MB                          | the plan's own stopping rule; do not start before E1 to E7 and a decision on the Qwen row                     |

Time estimates come from the two decode speeds measured here (about 240 tok/s for the 30B-A3B, 77 tok/s for the 27B), replies of 50 to 400 tokens, load times of 30 to 60 s per start and the lab's own plan output; `plan --warmup` replaces them with a measured value for the first model. None was measured for the rows themselves.

### 6.3 Exact commands (existing flags only)

**E1, RQ25 (cache suite).**

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

Four server starts. Read `cached`, `evaluated vs cold` and prompt milliseconds inside each table only.

**E2, RQ16, RQ21, RQ22 (Ollama surfaces).**

```powershell
foreach ($api in "ollama-chat","ollama-v1") {
  node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api $api --think off --num-predict 1024 `
    --tool-counts agent --temperatures 0 --streams false,true --passes 3 --max-requests 60 --max-minutes 40 --model-minutes 40 @o
}
node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-raw --think default --num-predict 1024 --tool-counts agent --temperatures 0 --streams false --passes 3 @o   # no template: the lab renders ChatML
# RQ21 tool_choice matrix on the /v1 surface (the record shows ignored or rejected)
foreach ($tc in "auto","required","none","read") {
  node bench/lab/lab.mjs run --run --suite dialect-probe --models qwen3.6:27b --api ollama-v1 --tool-choice $tc --limit 6 --passes 1 --max-requests 12 @o
}
# RQ22: reasoning off against on, temperature 0.6, seeded
foreach ($t in "off","on") {
  node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-chat --think $t --temperature 0.6 --seed 1 --num-predict 4096 --tool-counts agent --streams false --passes 8 --max-requests 70 --max-minutes 45 --model-minutes 45 @o
}
```

With `--think on` reasoning tokens dominate time (the lab turns thinking off by default for this reason), so the on arm needs the larger `--num-predict`; compare validity, not time. `--seed` is one constant: check that two passes of one prompt differ before trusting n = 64. Ollama's `/v1` surface cannot take `num_ctx`; read `usage.promptTokens` against the expected count before pairing arms (lab README).

**E3, RQ19, RQ29, RQ21 (handler, `required`).**

```powershell
# README Run 1: gpt-oss-20b family handler (no cap, reasoning always on), seeded passes
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

Record the `/props` template hash and read the first reply's shape to identify the handler (b12206 logs no `Chat format:` line). The grammar arm of RQ29 has no lab flag: the lab sends chat requests, and `--server-arg` only carries server-level options. Treat the grammar arm as blocked and say so in the evidence rather than improvising.

**E4, RQ26 (inherited sampling).** Needs a lab change first (MR-TBD-1): the lab always sends `options.temperature` (suite default 0). After it lands:

```powershell
node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-chat --temperature inherit --think off --num-predict 1024 --tool-counts agent --streams false --passes 8 @o
node bench/lab/lab.mjs run --run --suite leaks --models qwen3.6:27b --api ollama-chat --temperature 0.6 --body-extra '{"options":{"top_p":0.95,"top_k":20,"presence_penalty":0}}' --think off --num-predict 1024 --tool-counts agent --streams false --passes 8 @o
```

`--temperature inherit` is the proposed flag, not an existing one. Whether `--body-extra` merges into `options` or replaces it is not documented: check the first record's request echo. First capture `ollama show qwen3.6:27b --parameters` into the evidence, to prove which defaults exist (a read, not a load).

**E5, RQ20 and RQ5 (import path).** The owner runs the create; the lab does not.

```powershell
# Modelfiles in M:\ai\lab\import\ : FROM M:\ai\gguf\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf
#   A.Modelfile: nothing else.  B.Modelfile: the PARSER line the library tag uses.
ollama create qwen3-coder-import-a -f M:\ai\lab\import\A.Modelfile
ollama create qwen3-coder-import-b -f M:\ai\lab\import\B.Modelfile
foreach ($m in "qwen3-coder-import-a","qwen3-coder-import-b") {
  node bench/lab/lab.mjs run --run --suite leaks --models $m --api ollama-chat --think default --num-predict 1024 --tool-counts agent --temperatures 0 --streams false,true --passes 3 @o
}
```

The Ollama store appears to be on M: (`M:\ai\models` holds `blobs` and `manifests` folders), so each import adds about 18.6 GB there; confirm `OLLAMA_MODELS` first. Remove the aliases afterwards (`ollama rm`, owner only).

**E7, model refresh.** Download nothing without approval. If approved: a Qwen3.6-35B-A3B Q4_K_M GGUF (about 23 GB) and, for E8, `ggml-org/Qwen3.6-27B-MTP-GGUF` (named in the MTP pull request; size not checked) into `M:\ai\gguf`, then the E3 command with `--gguf` swapped and `--alias qwen3.6-35b-a3b-family`, plus `dialect-probe` for the text-dialect arms. M: has 199 GB free; stop the download if it falls under 100 GB.

**E8, MTP.** Add `--server-arg "--spec-type draft-mtp" --server-arg "--spec-draft-n-max 3"` (the lab passes other flags through `--server-arg`; confirm the spelling with the b12206 `--help`, since the flag was renamed on 2026-05-13) and compare against the same GGUF without them, using the `cache` suite's long-prefix sequences for prefill and `leaks` for decode.

### 6.4 What each result unlocks

| Result                                                                | Decision it unlocks                                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| E1: reuse across turns is high; `--cache-reuse` adds nothing or helps | the Strata and llama.cpp cache hints (K4, K15), whether the prompt tail must be stable (C55), the local row of the cache plan            |
| E2: `/api/chat` and `/v1` differ beyond the retest floor              | which surface the product's Ollama provider uses and whether `/v1` needs a leak notice (Q20, PL3)                                        |
| E2 (RQ21): `tool_choice` ignored on Ollama `/v1`                      | the `toolForce` fact for Ollama stays `ignored` (PL7) and forced turns on Ollama use the escape tool, not `required`                     |
| E3: Generic handler fails on a second family                          | PL3's "your server's template" warning is justified for llama.cpp; the leak notice becomes a template-hash check, not a model-name check |
| E4: the inherited set loses to the vendor coding set                  | explicit sampling on local providers by default (K4, Q19), written as a per-family preset row                                            |
| E5: import without parser leaks, with parser does not                 | Q27 (read `parser` and `renderer` from `/api/show`) moves from hint to warning                                                           |
| E6: forced turns cost reasoning quality                               | PL7's `toolConstraint` stays `none` for that family                                                                                      |
| E7: Qwen3.6-35B-A3B at least as valid as Qwen3-Coder                  | the default local coding row in docs and the preset table; the 2025 models stop being the reference                                      |
| E8: MTP gain under 1.2x at agent shapes                               | MTP stays off by default and out of the product's recommendations                                                                        |

## 7. NAS-backed model storage

Facts here: A: is a share with 5.2 TB free; `A:\ollama-archive` and `A:\Strata-archive` exist. The tool `M:\ai\tools\ollama-cache\ollama_cache.py` (its README was read; it says A: is currently read-only for this Windows user and its tests used a simulated tier under `D:\temp\a-sim`) implements `archive <model>` (store to archive, sha256-verified), `restore <model>` (tiers to store, sha256-verified, offline) and `serve` (a pull-through shim on port 11600 that Ollama pulls from with `--insecure` and that fills `A:\ollama-cache`). It never deletes anything and has no eviction, no TLS and no private-model auth; on a miss it downloads the whole blob before answering, which can time out for 20 GB blobs.

What the documentation says about mmap over a network share: nothing authoritative was found. The searches returned only S advice that network filesystems (NFS, SMB) are a case for `--no-mmap` or for copying the file first (a community performance page and an Aspose doc), and llama.cpp discussions noting that disabling mmap loads slower but avoids page-outs, and that a model larger than RAM cannot load without mmap. Measured evidence is for local storage only: gpt-oss-120b on a DGX Spark loaded in 1 min 44 s with mmap and 56 s with `--no-mmap` (S: NVIDIA forum). The mechanism on SMB (a page fault becomes a network round trip, so first touch of a 19 GB file is many small reads) is reasoning, not a cited fact. Ollama's loading path was not found documented for network paths; its docs describe `OLLAMA_MODELS` only as a directory with permissions.

Expected copy throughput, **arithmetic from line rate, not measured** (the NAS disks and SMB settings can cap it lower):

| File                            | 1 GbE at about 112 MB/s | 10 GbE at about 1.0 GB/s (practical SMB) |
| ------------------------------- | ----------------------- | ---------------------------------------- |
| gpt-oss-20b MXFP4, 12.1 GB      | 108 s                   | 12 to 15 s                               |
| Qwen3-Coder Q4_K_M, 18.6 GB     | 166 s                   | 19 to 25 s                               |
| Qwen3.6-35B-A3B Q4, about 23 GB | 205 s                   | 23 to 30 s                               |
| Flash-Next tensors, 96 GB       | 14 min                  | 1.6 to 2.5 min                           |

Recommended pattern: **the NAS is an archive, local NVMe (M:) is the serving store.** Restore before load (`ollama_cache.py restore` for Ollama blobs, a verified copy for GGUFs into `M:\ai\gguf`), verify the hash, load from M:. The tool's two tiers (archive plus pull-through cache) already match this. If the owner ever wants to load straight from A:, the test is one E1 row with `--server-arg "--no-mmap"` against the same file on A: and on M:, compared by `/health` readiness time (`--ready-timeout` 300 s); stop if readiness exceeds 300 s. It is not recommended by default.

Needed from the owner: write access (Modify, or Create and Write) on the two A: shares before any archive. Until then every restore test uses the simulated tier on D:.

## 8. Embeddings and rerankers for code search

The repository's own conclusion (`plans/codebase-index.md`) is that the structural index plus language servers is the measured win and embeddings are "a layer behind a reranker for teams that have one" (Cursor's 2025 data: +12.5 percent offline, +0.3 to 2.6 percent online). That frames the table below: these are candidates for L4's benchmark, not a build order.

| Model                              | Role          | Facts                                                                                                                                                                                                                                                                                        | Fit                                                                                                               |
| ---------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Qwen3-Embedding 0.6B, 4B, 8B       | embedding     | Apache-2.0; 8B reports MTEB-Code 80.68 (P: https://arxiv.org/abs/2506.05176, Jun 2025, old); `qwen3-embedding:8b` is already in Ollama here                                                                                                                                                  | 8B at Q4 is about 5 GB (estimate); fits beside a 19 GB chat model, but the lab refuses concurrent models          |
| Qwen3-Reranker 0.6B, 4B, 8B        | cross-encoder | Apache-2.0; 4B reports MTEB-Code 81.20 as reranking over the embedder's candidates (P: https://huggingface.co/Qwen/Qwen3-Reranker-4B); the card documents Transformers, sentence-transformers and vLLM, not llama.cpp or Ollama                                                              | needs a runner we do not have; llama.cpp reranking exists for other models but support for this one is unverified |
| jina-code-embeddings 0.5B and 1.5B | embedding     | 32K context, 1536 dims with Matryoshka down to 128; **CC-BY-NC-4.0** (P: https://huggingface.co/jinaai/jina-code-embeddings-1.5b); a May 2026 paper (CoREB, arXiv 2605.04615, S via a listing) reports Qwen3-Embedding-8B at 0.320 against jina-code-0.5b at 0.677 on code-to-code retrieval | the licence blocks shipping it; a research baseline only                                                          |

Practical points. A text-to-code query ("where is retry handled") and a code-to-code query ("find similar functions") are different tasks and the sources disagree by task; the agent's `search_codebase` (L3) mostly issues the first. CPU embedding of a large repository is feasible with 125 GB RAM but takes hours, not minutes, for an 8B model; use the 0.6B for a first index build and the 8B only if L4 shows it pays. No retrieval metric exists in the lab; L4 is the place for recall@10 on the repository's own queries. The lab refuses embedding models as chat models, which is right for its suites and means an embedding suite needs its own command (MR-TBD-5).

## 9. Proposed ROADMAP rows (ids TBD; `plans/ROADMAP.md` is not edited by this PR)

Table style follows Track MR and the research queue.

| ID       | Scope                                                                                                                                                                                                                  | Depends on                   | State       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------- |
| MR-TBD-1 | Lab: `--temperature inherit` sends no sampling options so the engine's own defaults apply (RQ26 cannot run without it: the suites always send temperature 0); record the echo of options actually sent                 | MR14                         | Not started |
| MR-TBD-2 | Lab: report effective n (distinct prompts) beside every rate; flag a rate whose passes ran at temperature 0 as repeats; `compare` counts prompts as the pairing unit when asked                                        | MR17                         | Not started |
| MR-TBD-3 | Lab: record `llama-server --help` and `ollama --version` into the results folder once per run; assert the flags a suite needs exist in the binary (MTP, `--cache-reuse`, FP8 KV)                                       | MR15                         | Not started |
| MR-TBD-4 | Lab: speculative sidecar: read draft and accepted token counts from `/metrics` or `timings` (field names unverified in b12206) so an MTP arm reports acceptance beside tok/s                                           | MR21                         | Not started |
| MR-TBD-5 | Lab: a retrieval suite (recall@10 on the repository's own queries, one embedding model at a time) for L4                                                                                                               | L4                           | Not started |
| RQ-TBD-A | Model refresh on the lab: Qwen3.6-35B-A3B and Qwen3.8-27B GGUFs on `leaks` and `dialect-probe`, family handler against Generic, `/props` template hash recorded. Free after the download                               | E3, owner approval for 40 GB | Not started |
| RQ-TBD-B | MTP at agent shapes: `--spec-type draft-mtp` on a Qwen3.6 GGUF, decode and prefill at 10 to 60K prompt tokens, acceptance rate; keep off unless the gain is 1.2x or more. Free                                         | RQ-TBD-A, MR-TBD-4           | Not started |
| RQ-TBD-C | Prefix reuse on hybrid and sliding-window models: do context checkpoints give the reuse that KV shifting gives a transformer (Qwen3.6 hybrid, gpt-oss) under the `cache` suite. Free                                   | RQ25                         | Not started |
| RQ-TBD-D | KV cache type and tool-call validity: f16 against q8_0 on one GGUF (the llama.cpp docs warn only about q4_0). Free                                                                                                     | RQ19                         | Not started |
| RQ-TBD-E | Ollama default context against the lab's explicit `num_ctx`: on this card Ollama's default is 32k; does the product's prompt plus tools fit it, and what happens at 64k (`ollama ps` `CONTEXT`). Free; related to RQ23 | RQ23                         | Not started |
| K-TBD-1  | Local coding preset rows for Qwen3.6 and Qwen3.8: `qwen3_coder` tool form, vendor sampling for coding (temperature 0.6, top_p 0.95, top_k 20, presence_penalty 0) as explicit local-provider defaults, only after RQ26 | RQ26, RQ-TBD-A               | Not started |
| PL-TBD-1 | Model store runbook for the dev machine: archive on A:, restore to M:, hash check, never load from the share; the `ollama-cache` tool moves with the lab repository (MR7b), with its README                            | MR7b                         | Not started |
| RQ-TBD-F | Embedding and reranker trial for L3: Qwen3-Embedding 0.6B and 8B with and without a reranker on L4's scenario; Jina as a non-shippable baseline                                                                        | L3, L4, MR-TBD-5             | Not started |
| RQ-TBD-G | vLLM arm of RQ5, only if the owner asks: Docker Desktop WSL2 image on M:, NVIDIA's Qwen3.6-35B-A3B-NVFP4, `leaks` over `openai-chat`; stop on a Marlin FP4 fallback warning                                            | RQ5, owner                   | Deferred    |

## 10. Owner decisions this report needs

1. Approve GPU time per row (E1 to E3 are the recommended first batch: about 3 GPU-hours, no downloads, no disk).
2. Approve downloads of one or two GGUFs (about 40 GB on M:, then archive to A:), or say the model set stays as it is.
3. Grant write access on the A: shares so the archive tier can be tested for real.
4. Decide the local default coding model after E7 (Qwen3.6-35B-A3B for speed, Qwen3.6-27B or Qwen3.8-27B for the vendor's higher agent scores).
5. Confirm vLLM and SGLang stay deferred.
6. Confirm Strata is stopped, and not started by other work, for each GPU window; the lab's guards refuse an engine conflict only for Ollama and its own server.

## 11. What was not verified

- The b12206 `--help` was not read (nothing may be run); every flag and default above is from master docs fetched today. The lab's evidence says b12206 prints no `Chat format:` line and has `--metrics` off by default, so it differs from master.
- Qwen3.8-27B's card dates itself "August 2026" in the citation only; its Ollama and llama.cpp status was not checked, and no Qwen3.8 GGUF with the family handler has been tested by anyone cited here.
- BFCL scores: the leaderboard table was not available to the fetch tool, so none is quoted. Terminal-Bench and SWE-bench numbers differ by version across cards (Terminal-Bench 2.0 and 2.1; SWE-bench Verified and Pro) and are never compared across rows.
- All "tok/s on a 5090" figures other than the two measured here are S sources, on varying builds, quantisations and context.
- Qwen3-Coder's KV geometry in section 3.4 is from memory of its config file and is flagged there.
- The Modelfile defaults of `qwen3.6:27b` are as stated in ROADMAP RQ26, not re-checked.
- NAS throughput is line-rate arithmetic. Nothing was read from or written to the NAS.

## 12. Sources (all fetched 2026-11-11)

P: https://huggingface.co/Qwen/Qwen3.6-27B; https://huggingface.co/Qwen/Qwen3.6-35B-A3B; https://huggingface.co/Qwen/Qwen3.8-27B; https://huggingface.co/nvidia/Qwen3.8-Flash-Next-NVFP4; https://ollama.com/library/qwen3.6; https://github.com/ollama/ollama/releases; https://docs.ollama.com/faq; https://docs.ollama.com/context-length; https://github.com/ggml-org/llama.cpp/releases; https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md; https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md; https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md; https://github.com/ggml-org/llama.cpp/pull/22196; https://github.com/ggml-org/llama.cpp/pull/22673; https://huggingface.co/Qwen/Qwen3-Reranker-4B; https://huggingface.co/jinaai/jina-code-embeddings-1.5b; https://arxiv.org/abs/2506.05176; https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512 (via a search result); https://gorilla.cs.berkeley.edu/leaderboard.html (table not retrievable).

S: https://discuss.vllm.ai/t/project-vllm-docker-for-running-smoothly-on-rtx-5090-wsl2/1697; https://huggingface.co/nvidia/Qwen3.6-35B-A3B-NVFP4/discussions/2; https://www.cloudmagazin.com/en/2026/05/27/llama-cpp-mtp-support-27b-modelle-1-7x-schneller-consumer/; https://ianlpaterson.com/blog/3090-ti-qwen-speedup-dflash-mtp/; https://aiweekly.co/alerts/qwen36-35b-moe-loses-mtp-speedup-at-128k-context; https://markaicode.com/benchmarks/gemma-4-llamacpp-benchmark/; https://www.hardware-corner.net/gpu-llm-benchmarks/rtx-5090/; https://blogs.nvidia.com/blog/rtx-ai-garage-openai-oss; https://forums.developer.nvidia.com/t/very-slow-mmap-on-dgx-spark-that-affects-model-loading-questions-to-nvidia/349886; https://notebook-dg9.pages.dev/kb/ai/llama-cpp/performance-tuning/; https://www.techloy.com/zhipu-ai-launches-glm-4-7-flash-a-local-ai-coding-model-for-consumer-hardware/; https://llmconfigurator.com/en/best-models/rtx-5090; https://www.emergentmind.com/papers/2605.04615.

Repository: `bench/lab/README.md`; `bench/evidence/2026-11-11-reviewer-remeasure/README.md` and `lab/*.md`; `plans/ROADMAP.md` (Tracks K, L, MR, PL; research queue RQ1 to RQ34); `plans/codebase-index.md`; `plans/model-families-2026-11.md`; `M:\ai\tools\ollama-cache\README.md`.
