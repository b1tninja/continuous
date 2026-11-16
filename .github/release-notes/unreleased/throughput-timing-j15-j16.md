## New

- **The server's own timings are kept with each reply's usage.** From llama.cpp and Strata: how many prompt tokens were read and how many came from the cache, how long the read and the writing took, the write speed, and the speculative draft tokens offered and accepted. From Ollama: the token counts and its durations, including the time to load the model. Nothing is shown yet; the speed display builds on this.

## Fixes

- **Ollama's native API now reports usage.** A reply from an `ollama` model had no token counts at all; it now has the prompt and reply counts, the cached part of the prompt, and Ollama's timings.
- **The "a re-read would take about N s" estimate on Ollama after a cache hit.** Ollama's OpenAI-compatible endpoint counts cached tokens in its prompt read speed, so after a cache hit the speed was too high and the estimate too short. The speed is now worked out from the tokens Ollama actually read.
