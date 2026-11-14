# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- CLI: the status line shows the model and reasoning effort the next request goes to, and the transcript says when a `modeModels` entry, a Loop item's own model or a fallback changes them, and why. A subagent's output names its model. `-p --format stream-json` writes a `model` line for each change and `reasoningEffort` on `init` (optional fields, schema version 1). A `modeModels` entry that names no model now keeps its own `reasoningEffort` in the CLI, as in the IDE (ROADMAP M7).

## Behaviour changes

## Fixes
