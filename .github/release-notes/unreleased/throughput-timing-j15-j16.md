## New

- **The server's own timings are kept with each reply's usage.** From llama.cpp and Strata: how many prompt tokens were read and how many came from the cache, how long the read and the writing took, the write speed, and the speculative draft tokens offered and accepted. From Ollama: the token counts and its durations, including the time to load the model. Nothing is shown yet; the speed display builds on this.
- **Each chat request records what it did and how fast.** From the stream it is already reading, with no extra request: when it was sent, the first event, the first token, the first text or tool call, the phases it went through (waiting, reading the prompt, thinking, writing, writing a tool call), the time to first token, the output speed and the prompt read speed where the server reports one, each marked as the server's figure, measured here, or an estimate from characters. The record is kept with the reply's usage and in the LLM log; the live speed line and the per-reply summary build on it.

## Fixes

- **Ollama's native API now reports usage.** A reply from an `ollama` model had no token counts at all; it now has the prompt and reply counts, the cached part of the prompt, and Ollama's timings.
- **The "a re-read would take about N s" estimate on Ollama after a cache hit.** Ollama's OpenAI-compatible endpoint counts cached tokens in its prompt read speed, so after a cache hit the speed was too high and the estimate too short. The speed is now worked out from the tokens Ollama actually read.
- **The LLM console's "To First Token" on llama.cpp and Strata.** It counted from the first prompt-progress update, a second or two in, instead of the first token, and "Tokens/s" included most of the prompt read. Both now come from the request's timing record.
