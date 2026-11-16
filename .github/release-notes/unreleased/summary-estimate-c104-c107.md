## Behaviour changes

- After **Compact**, the conversation summary is sent as the first message after the system message instead of being added to the system message. The tools and the system message are now the same bytes before and after a compaction, so the provider keeps them cached (an Anthropic or Bedrock breakpoint on the system prompt, a local server's system-prompt checkpoint) and only the summary and the turns after it are read again. A rule that only a summarised turn matched is sent with the summary.

## Fixes

- On Claude models that check that earlier reasoning still matches the conversation (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable and Mythos 5.1 and 5.2), compacting at an earlier response no longer sends back the reasoning of the turns it kept. That reasoning was produced with the summarised turns in front of it, and sending it after the summary could be refused with an error. Reasoning produced after the compaction is still sent.
