# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

- Add model > CometAPI no longer offers Claude Sonnet 4.5 (retires 2026-11-30; CometAPI has no Sonnet 5.5 preset yet) or the retired Claude Opus 4.1, Claude Opus 4.1 Thinking, Claude Sonnet 4, Claude Sonnet 4 Thinking and Claude 3.7 Sonnet Latest; Claude Haiku 4.5 stays. Existing configs and pricing are unchanged.

## Fixes

- An unsent message no longer comes back with the "Restored your unsent message" notice after a trip to Settings (or another page of the panel) and back; the text returns quietly. The notice still shows after a window reload, an extension update or a crash, and when you return to a session after opening another.
- **Open the Audit Inbox** lands on the Inbox each time it runs, also after you switched the Permissions page to another view by hand.
- Settings > Providers says how an AWS profile signs in: SSO, `credential_process`, an assumed role, a web identity token, or access keys in `~/.aws/config` or `~/.aws/credentials`. It reads only the key names in the profile's `~/.aws/config` section and never opens `~/.aws/credentials`.
- **No conversation starters while a session reopens.** A large session takes a while to arrive from the IDE, and the empty chat with its starters showed until then. The chat now says which session is loading and offers **Start a new session instead** and the recent sessions. Typing, a new session or opening another one drops the load, so it cannot replace what you started, and the text you typed stays in the input. Only a session this window reopens (one of its workspace) shows the view. A session that went to the trash or cannot be read opens as an empty chat with a short note, under a new id.
