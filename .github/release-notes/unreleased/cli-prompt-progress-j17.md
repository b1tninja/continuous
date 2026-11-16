## New

- **`cn` shows how far a local server has read the prompt.** On llama.cpp and Strata, the spinner row says "Reading the prompt: 360k of 384k tokens, 16k from the cache, about 18 s left" while a long prompt is read, the same line as the extension's, updated at most once a second, and goes away when the reply starts. Before, a long read showed only the spinner. In `cn -p` the line goes to stderr, at most once every 10 s, and only with `--verbose`. `cn` asks for it only from a local server whose `/props` answers as llama.cpp's does; cloud APIs and other servers are never sent the field.
