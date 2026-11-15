# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

## Fixes

- **No conversation starters while a session reopens.** A large session takes a while to arrive from the IDE, and the empty chat with its starters showed until then. The chat now says which session is loading and offers **Start a new session instead** and the recent sessions. Typing, a new session or opening another one drops the load, so it cannot replace what you started, and the text you typed stays in the input. Only a session this window reopens (one of its workspace) shows the view. A session that went to the trash or cannot be read opens as an empty chat with a short note, under a new id.
