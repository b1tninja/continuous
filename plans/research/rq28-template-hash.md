# RQ28: is the chat template inside a local GGUF stale?

Run 2026-11-11. Reader: `bench/lab/tools/gguf-template.mjs` (reads the GGUF metadata header only, never a tensor; writes only the optional `--out` file). Hash: SHA-256 of the text with CRLF turned into LF and trailing whitespace trimmed ("normalised"). Vendor files were fetched on 2026-11-11 with `curl` from the `raw/main` URLs, not through a page summariser, so the bytes are exact; the repository commit lists came from `https://huggingface.co/api/models/<repo>/commits/main`.

## Result

| GGUF                                       | Key present | Length | Normalised SHA-256 (first 16) | Vendor source                                                                                                       | Vendor SHA-256 (first 16) | Match                            |
| ------------------------------------------ | ----------- | -----: | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------- |
| `Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf` | yes         |   6896 | `87710339d25b4e78`            | https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct/raw/main/chat_template.jinja (and `tokenizer_config.json`) | `32bf2564d2245b98`        | No                               |
| `gpt-oss-20b-MXFP4.gguf`                   | yes         |  16714 | `a4c9919cbbd4acdd`            | https://huggingface.co/openai/gpt-oss-20b/raw/main/chat_template.jinja                                              | `a4c9919cbbd4acdd`        | Yes, identical after normalising |

(The raw `gpt-oss` GGUF text and the vendor file are the same bytes before normalising too.) The Qwen `chat_template.jinja` and the `chat_template` field of its `tokenizer_config.json` are the same text (same hash, 6211 characters). `gpt-oss-20b`'s `tokenizer_config.json` carries no `chat_template` field; the template lives only in `chat_template.jinja`.

## Qwen3-Coder: different, not simply older

The GGUF's template opens with `{# Copyright 2025-present Unsloth. Apache 2.0 License. Unsloth Chat template fixes #}`, so it is a third-party edit of the vendor template, not the vendor's text. It differs in 6 hunks (line similarity 0.66; 117 vendor lines against 135). Visible differences: a different helper macro (`render_item_list` instead of the vendor's `render_extra_keys`), no `# Tools` heading before the function list, `<description>` always written (the vendor guards it with `is defined`), and a `<parameters>` rendering written out inline.

The vendor's template was last changed on 2025-08-21 (commit 573fa390 "Update chat_template and tool_parser (#22)"), after 2025-08-07 (8110d98a "Update chat_template in tokenizer_config.json (#14)"). The repository's current head is 2025-12-03 (a `config.json` change). Which side is newer was not established: the GGUF does not say which vendor revision Unsloth started from, and nothing here proves the Unsloth text predates the 2025-08-21 vendor change. What is established: **the template in this file is not the vendor's current template**, and it renders the tool list differently, which is the part tool-call parsing depends on. The lab result in `bench/evidence/2026-11-11-reviewer-remeasure/README.md` (75 percent valid calls with this GGUF's own template against 0 percent with `chatml`) was measured with the Unsloth text.

## What to do

Not changed here (propose only):

- Record the template hash in the lab's model inventory (`bench/lab/lib/inventory.mjs`) so a result carries which template produced it; add a "template differs from vendor" flag when the hash is not the vendor's.
- Before the next local Qwen3-Coder run that matters, run the same suite once with `--chat-template-file` set to the vendor's `chat_template.jinja` (llama-server supports it) and compare valid-call rates (RQ24-style contrast), since the vendor's text and the Unsloth text differ in the tool block.
- `gpt-oss-20b` needs nothing: the template is the vendor's current text.

Limits: two models, one revision of each vendor file as of 2026-11-11; the hash says "same bytes", not "same behaviour" (a different Jinja engine renders the same text differently, which this does not test).
