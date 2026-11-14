# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Continuous: Clean up old sessions**, and `continuous sessions clean` in the terminal: removes the full prompts earlier releases stored in every session and in `dev_data`, and old logs. It shows what it found first (sessions, MB of old prompt logs, the largest file), reads each file in pieces so a session too large to open is cleaned too, checks every rewritten file, keeps the originals in `~/.continuous/cleanup-backups/<date>/`, and leaves sessions open in another window or agent alone. After an update VS Code offers it once, only when more than 100 MB can be reclaimed.
- **Debug prompt log**, off by default: `continuous.debugPromptLog` in VS Code, `--debug-prompt-log` in the terminal. Each request's full prompt goes to `~/.continuous/logs/prompts/`, secrets masked, 50 MB at most, deleted after 14 days.
- A turn is saved while it runs. Your message is saved when you send it, each tool result when the tool finishes, and the answer every few seconds as it streams, so if the window or VS Code dies in the middle of a turn, the chat reopens with all of that and offers Resume. This needs the append-only chat log below, which is on by default.

## Behaviour changes

- Chats are saved as an append-only log (`sessions/<id>.jsonl`). Each save adds only what changed, instead of rewriting the whole chat file. Tool outputs over 4 KB, and any other text or image over 16 KB, are stored once in `sessions/<id>/blobs/`, so a tool output is no longer kept twice and a file read twice is stored once. A chat saved the old way (`<id>.json`) is converted the next time it is saved, and the old file is removed only after the new one reads back the same. "Save chats as an append-only log" in Settings turns this off, which converts chats back to `.json` as they are saved. The `cn` CLI still writes `.json`, and reads both.
- Local dev data no longer stores the full prompt and completion of each chat request: `chatInteraction` records keep their sizes, the token counts and a hash. A `data` destination you configured still receives the full event.

## Fixes
