## New

- `cacheBehavior.subagentTtl` sets the prompt cache lifetime of subagent runs on a model: `5m` (the default), `1h`, `auto` (the Auto rules applied to the run's own requests) or `inherit` (what the chat uses). It applies to the subagent tool, Loop workers and `cn` subagents, and is in the model editor. See "Subagents" in the prompt caching docs.
- `CONTINUOUS_FORCE_CACHE_5M=1` is a debug override that puts every prompt cache entry on the 5-minute lifetime, in the editor and in `cn`, over every other lifetime setting.

## Behaviour changes

- Subagent runs now use the 5-minute prompt cache lifetime by default, also when the chat is set to 1 hour: their requests come seconds apart, so a 1-hour entry cost more to write and was rarely read later. Set `cacheBehavior.subagentTtl: inherit` on the model for the old behaviour.
- The request that lists Anthropic models is now sent with `anthropic-version: 2026-10-21`, and again with `2023-06-01` if a gateway answers 400. Messages requests stay on `2023-06-01`.
