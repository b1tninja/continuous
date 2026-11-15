## New

- Strata, llama.cpp and vLLM: the token estimate is calibrated from the server's own `prompt_tokens` after each answered request, per model (between 0.6 and 2, with 5% headroom; a single request outside 0.7 to 1.5 times the current ratio is ignored). Ollama, LM Studio and other local servers, which may leave cached tokens out of the count, keep only the existing overflow correction. Qwen models, which the Llama 2 tokenizer over-counts by about 23%, get about 97k tokens of a 524k window back. Hosted providers are unchanged.

## Behaviour changes

- A long conversation is trimmed in whole blocks: nothing is dropped until the prompt passes 85% of the window (local servers) or 90% (hosted providers); then the oldest messages go at once, down to 60% or 65%, and the prompt grows append-only, reusing the prompt cache, until it passes the threshold again. A compaction summary is never dropped; blocks are counted from the turns after it. The context meter's prune line shows the new threshold.
- The configured `maxTokens` is reserved for the reply, up to 10% of the window and at least 1,000 tokens, instead of a fixed 1,000 tokens.

## Fixes

- Once a conversation was over the window, the cut moved by a message or two on most turns because its size depended on the latest turn, and every move made a local server read the whole conversation again (about 85 s for 394k tokens on Strata). The cut now moves only forward, once per block.
