# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Continuous: Clean up old sessions**, and `continuous sessions clean` in the terminal: removes the full prompts earlier releases stored in every session and in `dev_data`, and old logs. It shows what it found first (sessions, MB of old prompt logs, the largest file), reads each file in pieces so a session too large to open is cleaned too, checks every rewritten file, keeps the originals in `~/.continuous/cleanup-backups/<date>/`, and leaves sessions open in another window or agent alone. After an update VS Code offers it once, only when more than 100 MB can be reclaimed.
- **Debug prompt log**, off by default: `continuous.debugPromptLog` in VS Code, `--debug-prompt-log` in the terminal. Each request's full prompt goes to `~/.continuous/logs/prompts/`, secrets masked, 50 MB at most, deleted after 14 days.

## Behaviour changes

- Local dev data no longer stores the full prompt and completion of each chat request: `chatInteraction` records keep their sizes, the token counts and a hash. A `data` destination you configured still receives the full event.

## Fixes
