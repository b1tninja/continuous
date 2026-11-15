# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- `continuous --resume <sessionId>` resumes that session. `continuous ls` and the `--resume` picker group sessions by folder: this folder first with its newest session selected, then the other folders, then sessions without a folder. `ls --json` adds `inWorkspace` and `workspaceGroup`.
- The IDE History page groups sessions by workspace folder, the open workspace first and expanded; **Group by: Date** keeps the old view.

## Behaviour changes

- `continuous --resume` in a terminal opens the session picker with the newest session of this folder selected (Enter resumes it) instead of resuming the newest session of any folder. Headless `-p --resume` resumes the newest session of this folder (a subfolder, a parent folder or the same git repository counts); when there is none it resumes the newest overall and says which folder it came from.

## Fixes

- `--resume` no longer continues another project's conversation, and a session picked in `continuous ls` is the one resumed (it could resume the newest session instead).
- In the IDE, **Last Session** and the session restored when a window starts come from the open workspace. Windows share the stored last session, so a window could open another workspace's conversation.
