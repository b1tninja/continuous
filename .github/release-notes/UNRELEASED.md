# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- `continuous --resume <sessionId>` resumes that session. `continuous ls` and the `--resume` picker group sessions by folder: this folder first with its newest session selected, then the other folders, then sessions without a folder. `ls --json` adds `inWorkspace` and `workspaceGroup`.
- The IDE History page groups sessions by workspace folder, the open workspace first and expanded; **Group by: Date** keeps the old view.
- Deleted sessions go to a trash for 7 days (`~/.continuous/sessions-trash/`). The History page shows **Undo** after a delete and a **Trash** group with **Restore** and **Delete permanently**; the terminal agent has `continuous sessions trash` and `continuous sessions restore <id>`. A session open in another window or agent is moved only after you confirm.
- The History search box also finds words in message text, not only titles: titles still match as you type, and a moment later sessions whose messages hold every word are added with the matching text shown. It reads the 200 most recently written sessions and says when it stopped early.
- The terminal session picker (`continuous ls`, `--resume`, `/resume`) filters as you type (title, first message, folder). Del, then `y`, moves the selected session to the trash; Ctrl+U puts it back.
- In the IDE, an unsent message is kept per session: the chat input and an edit of an earlier message that is in progress come back after a window reload, an extension update or a crash, with a notice. Going to Settings (or another page of the panel) and back brings the text back without the notice; opening another session and returning shows it again. @-mention chips come back as chips; a pasted image is not kept and the notice says so. Sending clears it, and opening another session shows that session's draft.
- Command Palette: **Open Permissions**, **Open the Audit Inbox**, **Open Stats**, **Stop Response**, **Resume Response**, **Start Loop**, **Stop Loop**, **Show Agents** and **Test Connection of the Chat Model**, each doing what its control in the panel does; **Open the Audit Inbox** lands on the Inbox each time it runs, also after you switched the Permissions page to another view by hand. None has a default key.
- Model retirement warnings in the IDE beyond the input-toolbar chip: the model picker marks a configured model that is deprecated, retired or retiring soon (for example "(retires 2026-11-30)", with the full sentence and the suggested successor in the tooltip), Settings > Models states it under the role that uses the model, and loading a config warns once per model. Sources: Anthropic's deprecations page (checked-in table, read 2026-11-11; first-party Anthropic only, never Bedrock or Vertex) and the `deprecated` / `retiresAt` fields of a model list you fetched in Add model. Anthropic retires `claude-sonnet-4-5-20250929` on 2026-11-30 (successor `claude-sonnet-5-5`) and `claude-opus-4-5-20251101` not before 2026-11-24 (suggested `claude-opus-5-5`).
- **Settings > Providers**: a page of its own for provider connections, beside Models, so they no longer sit behind Add model. Each connection shows its provider, account or endpoint and region, how it signs in (key in secure storage or `~/.continuous/.env`, environment variable, AWS profile or default credentials; never the key) and how many models are enabled, with **Manage models**, **Edit connection**, **Test connection** and **Remove** (which says what leaves `config.yaml` and that stored keys stay). Provider accounts moved there from Settings > Models. Reach it from the Settings sidebar, **Providers...** on Settings > Models and in the model picker, or the Command Palette's **Open Providers** (no default key).
- `continuous acp` lists and reopens earlier sessions: `session/list` (filtered by the editor's folder, paged), `session/load`, which replays the conversation and its tool calls, and `session/resume`. It now advertises `loadSession`. Sessions saved by the terminal agent and by the IDE both open. The protocol version stays 1.

## Behaviour changes

- Delete on the History page and in the terminal picker no longer removes a session at once: it can be restored for 7 days. **Clear chats** still deletes everything, the trash included.
- In the terminal session picker, letters type into the filter, so `j` and `k` no longer move the selection; use the arrow keys (or Ctrl+N and Ctrl+P). Esc clears the filter, and leaves when it is empty.

- `continuous --resume` in a terminal opens the session picker with the newest session of this folder selected (Enter resumes it) instead of resuming the newest session of any folder. Headless `-p --resume` resumes the newest session of this folder (a subfolder, a parent folder or the same git repository counts); when there is none it resumes the newest overall and says which folder it came from.

- Add model > Anthropic no longer offers Claude Sonnet 4.5 and Claude Opus 4.5 (both retiring; Claude Sonnet 5.5 and Claude Opus 5.5 stay at the top of the list) or the retired Claude Opus 4.1 and Claude Sonnet 4. A new config created from the assistant template uses `claude-sonnet-5-5` instead of the retired `claude-sonnet-4-20250514`. Existing configs and pricing for the old ids are unchanged.
- Add model > CometAPI no longer offers Claude Sonnet 4.5 (retires 2026-11-30; CometAPI has no Sonnet 5.5 preset yet) or the retired Claude Opus 4.1, Claude Opus 4.1 Thinking, Claude Sonnet 4, Claude Sonnet 4 Thinking and Claude 3.7 Sonnet Latest; Claude Haiku 4.5 stays. Existing configs and pricing are unchanged.

## Removed

- The **Enter Enterprise License Key** command, an upstream leftover: nothing in Continuous answers its request, so it called every key invalid. The second palette entry for `continuous.focusContinuousInput` ("Focus Continuous Chat") is gone too; the command stays as **Add Highlighted Code to Context and Clear Chat**.

## Fixes

- The History page's row actions (Edit, Save as Markdown, Archive, Delete) can be reached with the keyboard: Tab to a row (Enter opens it, Delete deletes it) and Tab again to its buttons, which show on hover and while the row has focus. Before, they were only in the page while the mouse was over the row.

- `--resume` no longer continues another project's conversation, and a session picked in `continuous ls` is the one resumed (it could resume the newest session instead).
- In the IDE, **Last Session** and the session restored when a window starts come from the open workspace. Windows share the stored last session, so a window could open another workspace's conversation.
