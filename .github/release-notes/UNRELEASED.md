# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- `continuous --resume <sessionId>` resumes that session. `continuous ls` and the `--resume` picker group sessions by folder: this folder first with its newest session selected, then the other folders, then sessions without a folder. `ls --json` adds `inWorkspace` and `workspaceGroup`.
- The IDE History page groups sessions by workspace folder, the open workspace first and expanded; **Group by: Date** keeps the old view.
- In the IDE, an unsent message is kept per session: the chat input and an edit of an earlier message that is in progress come back after a window reload, an extension update or a crash, with a notice. @-mention chips come back as chips; a pasted image is not kept and the notice says so. Sending clears it, and opening another session shows that session's draft.
- Command Palette: **Open Permissions**, **Open the Audit Inbox**, **Open Stats**, **Stop Response**, **Resume Response**, **Start Loop**, **Stop Loop**, **Show Agents** and **Test Connection of the Chat Model**, each doing what its control in the panel does. None has a default key.
- Model retirement warnings in the IDE beyond the input-toolbar chip: the model picker marks a configured model that is deprecated, retired or retiring soon (for example "(retires 2026-11-30)", with the full sentence and the suggested successor in the tooltip), Settings > Models states it under the role that uses the model, and loading a config warns once per model. Sources: Anthropic's deprecations page (checked-in table, read 2026-11-11; first-party Anthropic only, never Bedrock or Vertex) and the `deprecated` / `retiresAt` fields of a model list you fetched in Add model. Anthropic retires `claude-sonnet-4-5-20250929` on 2026-11-30 (successor `claude-sonnet-5-5`) and `claude-opus-4-5-20251101` not before 2026-11-24 (suggested `claude-opus-5-5`).
- `continuous acp` lists and reopens earlier sessions: `session/list` (filtered by the editor's folder, paged), `session/load`, which replays the conversation and its tool calls, and `session/resume`. It now advertises `loadSession`. Sessions saved by the terminal agent and by the IDE both open. The protocol version stays 1.

## Behaviour changes

- `continuous --resume` in a terminal opens the session picker with the newest session of this folder selected (Enter resumes it) instead of resuming the newest session of any folder. Headless `-p --resume` resumes the newest session of this folder (a subfolder, a parent folder or the same git repository counts); when there is none it resumes the newest overall and says which folder it came from.

- Add model > Anthropic no longer offers Claude Sonnet 4.5 and Claude Opus 4.5 (both retiring; Claude Sonnet 5.5 and Claude Opus 5.5 stay at the top of the list) or the retired Claude Opus 4.1 and Claude Sonnet 4. A new config created from the assistant template uses `claude-sonnet-5-5` instead of the retired `claude-sonnet-4-20250514`. Existing configs and pricing for the old ids are unchanged.

## Removed

- The **Enter Enterprise License Key** command, an upstream leftover: nothing in Continuous answers its request, so it called every key invalid. The second palette entry for `continuous.focusContinuousInput` ("Focus Continuous Chat") is gone too; the command stays as **Add Highlighted Code to Context and Clear Chat**.

## Fixes

- `--resume` no longer continues another project's conversation, and a session picked in `continuous ls` is the one resumed (it could resume the newest session instead).
- In the IDE, **Last Session** and the session restored when a window starts come from the open workspace. Windows share the stored last session, so a window could open another workspace's conversation.
