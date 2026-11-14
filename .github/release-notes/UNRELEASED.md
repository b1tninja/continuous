# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

## Fixes

- CLI: `modeModels` entries the CLI skipped without a word are now named in one notice per config load: a name that matches no model or is not a chat model, a `reasoningEffort` of `off`, the reviewer's effort, and an effort for a provider whose request has no reasoning field (AskSage, Cohere, watsonx). Which providers apply the effort comes from the adapters, and a test that sends a request through every provider fails when the two disagree. Anthropic is not on the list since it applies the effort. The `modeModels` docs no longer say the CLI ignores `reasoningEffort` (ROADMAP M8).
