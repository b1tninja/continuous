# RQ7: false-call rate of the recovery parsers over the replies in this repository

Run 2026-11-11 at `origin/main` 0d4fe36f3 with `node bench/rq7/scan.mjs` (dev only, read-only, no model call). Excerpts are masked through `core/util/secretScan` and cut at 120 characters.

## Result

Zero false calls. No parser accepted a call on any of the 254 replies that are not tool calls, whole or streamed in 13-character chunks.

| Input                                                                          | Unique replies |
| ------------------------------------------------------------------------------ | -------------: |
| Reviewer raw replies, `bench/evidence/2026-11-11-reviewer-remeasure/reviewer/` |            234 |
| Bedrock stream-force `response.text` with no call                              |              5 |
| `bench/tier0/fixtures` histories (assistant messages without calls)            |              4 |
| `extensions/vscode/e2e` config history                                         |              1 |
| `NEGATIVE` list in `core/util/toolDialectDetect.fixtures.ts`                   |             12 |
| Total after de-duplication by hash                                             |            256 |

Of the 256, two are calls a model wrote as text (see below), so they are leaks, not false-call material; 254 are non-calls. 11 assistant messages with structured calls were excluded. All 502 JSON and JSONL files in the worktree were walked (excluding `node_modules`); the corpus fixtures were handled separately (200 negative, 121 positive).

Each of 23 parsers was forced through `createTextToolRecovery` (`x_continue_recover_text_tool_calls: force:<dialect>`), the path both Bedrock handlers and the OpenAI-compatible adapter use, which is the strict whole-reply path of Q28 (#532). The tool list is `bench/lab/fixtures/agent-tools.json`.

| Dialect                                                                                                                                                                                                                                                                                                          | Replies scanned | Accepted (whole) | Accepted (stream) | Nudge hits attributed | False calls |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------: | ---------------: | ----------------: | --------------------: | ----------: |
| qwen-xml, pythonic, hermes-json, glm-xml, kimi-tokens, kimi-xtml, minimax-xml, minimax-ns-xml, toolcall-json, harmony, mistral, dsml, deepseek-v31, deepseek-r1, granite-tokens, lfm-tokens, hy3-tags, solar-tokens, longcat-json, olmo-function-calls, seed-xml, cohere-action (22 parsers, each row identical) |             256 |                0 |                 0 |                     0 |           0 |
| llama-json                                                                                                                                                                                                                                                                                                       |             256 |                0 |                 0 |                     1 |           0 |

The 22 identical rows are collapsed here; `node bench/rq7/scan.mjs` prints all 23. No parser threw.

## Leak-nudge classifier (#601, `isLeakedToolCall`) and the detector

Classifier classes over the 256 replies: `unknown` 235 (a reply that is only a fenced JSON block has no text outside the fence), `prose` 19, `llama-json` 1, `qwen-xml` 1. Nudge hits: 1. `detectToolDialectLeak` hits: 1.

- llama-json, nudge hit: `{"type": "function", "name": "read_file", "parameters": {"path": "src/main.ts"}}` (Llama 3.3 70B on Bedrock, stream-force run, outcome `text`). A true leak, correctly nudged. The parser did not accept it because the lab tool list names the parameter `filepath`, not `path`: the schema check refused.
- qwen-xml, no nudge: `<tool_call> <function=Write> <parameter=filepath> notes.md ...` (`bench/tier0/fixtures/dialect-history-leaked.json`). A true leak. Neither the nudge nor the parser fired because `Write` is not in the lab tool list. A limit of the harness's tool list, not a parser fault.
- No hit on any of the 254 non-calls, so no nudge false positive in this population.

## Corpus

Positive control: the own-dialect parser recovered 117 of 121 positive fixtures. The four it did not are `llama3-semicolon-separated-json`, `minimax-m2-missing-last-closing-tag`, `minimax-m2-think-then-call` and `pythonic-raw-newline-in-string-vllm-61954`. The scan does not explain them (the corpus's own tests carry each fixture's policy); they show only that the harness sees calls.

Negatives (200, adversarial by design: prose around a call, truncation, quoted examples, undeclared tools, wrong marker). One parser acceptance: `gemma3-has-no-tool-section` under forced `llama-json`. The fixture text is a bare Llama JSON call; the case records that Gemma 3 has no tool section, so no dialect is selected for it. The parser accepted it only because the scan forces every parser on every reply. The reply is a call in text, so this is not a false call; it is a reason a preset must not force `llama-json` on a Gemma model. Every other negative was refused by every parser.

Nudge on the negatives: 130 of 200 flagged. By failure mode they are real calls that strict recovery refuses, which is what the nudge is for (prose around the call 28 of 28, truncated 12 of 12, partial arguments 11 of 11, malformed 12 of 12, parallel-merged 6 of 6, argument-type-mismatch 12 of 12). The genuine non-calls were not flagged: `quoted-not-called` 0 of 31, `undeclared-tool` 0 of 20, `unknown-tool` 0 of 2, `not-a-call` 0 of 1, `special-token-leak` 0 of 4. One flagged negative is arguable: `qwen3-coder-call-inside-think-vllm-39056`, a call written inside a `<think>` block. The classifier does not skip think blocks, so the nudge fires on a call that sat in the reasoning. Whether that deserves a nudge is a policy question for the owner; it is not a parser acceptance.

## What this does not show

- **The owner's local sessions were NOT scanned.** Nothing under `~/.continue`, `~/.continuous`, the Strata archive or any file outside the worktree was read. The earlier RQ7 figure (0 false in 22,994 replies; 0 of 467 agent replies, 95 percent upper bound 0.82 percent) came from those sources and is neither repeated nor refuted here. That scan would add real agent-turn prose, which is what the zero-false-call bar is about: 92 percent of the repository's non-calls are short fenced reviewer verdicts, a narrow distribution. It would also supply the population the bound needs: with 254 replies and zero events the rule-of-three upper bound is about 1.2 percent. It needs the owner's separate approval.
- The repository holds almost no reply from the families that leak most (Llama, Qwen3-Coder without a server parser, Nova) beyond the two leaks above.
- Inline strings in `*.vitest.ts` files were not extracted: they are the parsers' authors' own assertions, not recorded replies.
- All three parser groups (#522, #524, #525) are included; none accepted anything.

## Proposed fixes

None for a parser: no false call exists. If the owner decides the think-block nudge is wrong, the minimal fix is for the classifier to strip a `<think>...</think>` span before scanning, with a skipped test in `core/util/toolDialectLeak.vitest.ts`: "a call written only inside a think block is not a leaked call", using the `qwen3-coder-call-inside-think-vllm-39056` text. Not added, so the decision stays with the owner.

Follow-ups for the roadmap (not edited here): RQ7 rerun over local sessions after owner approval; a guard against forcing `llama-json` on a Gemma model.
