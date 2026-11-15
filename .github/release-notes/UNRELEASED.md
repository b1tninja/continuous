# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- Changing tools while the prompt cache is warm no longer rebuilds the cache without asking. Turning a tool, a tool group or an MCP server on or off, or a server that connects late or changes its tools, now waits until the cache goes cold when re-reading the conversation would cost a significant amount. The Tools page says what applying it now would cost and offers Apply now, Apply when the cache goes cold (the default) or Start a new session with it; a line above the input shows what is waiting. In the `cn` command line, `/tools` lists waiting changes and `/tools apply` applies them. See "Changing tools during a session" in the prompt caching docs.

## Behaviour changes

- A tool turned off while the prompt cache is warm stays in the request's tool list until the cache goes cold, after compaction or in a new session, and a call to it is refused with a result that says why and recorded in the audit trail. To apply tool changes at once as before, choose "Apply tool changes at once" in the prompt cache menu, or set `CONTINUE_TOOL_CHANGES=now` for `cn`.
- On models with preserved thinking's prefix check (Claude Fable 5.2 and Mythos 5.2, and depending on the account Fable 5.1, Mythos 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5), the reasoning from before a tool list change is no longer sent back once the change applies, because those models refuse it.

## Fixes
