## Behaviour changes

- One renderer now writes what both the editor and the terminal agent tell the model about the machine and folder, from one snapshot read when a session starts and saved with it, so a resumed session sends the same bytes. The system message carries only the platform (no folder, no git answer); the terminal tool names the shell that really runs the command (and no folder); the folder, today's date (your local day, not UTC) and the git facts go in a fenced block in the first message, with your home folder shown as `~`. Your account name, the host name, your git identity and network addresses are never sent.
- The editor's terminal tool no longer says "optimized for win32 and x64 and shell powershell.exe": it carries the same shell sentence as the terminal agent, and the shell is fixed for the session, so a change to `continuous.terminal.shell` takes effect in the next session. A remote window says the shell is not known there.
- A session that runs past midnight, or is resumed on a later day, gets one "Today's date is now ..." notice on the newest message.
- `environment.detail` (`minimal`, `standard`, `full`) in your config.yaml, `continuous.environment.detail` in VS Code and `--env-detail` in the terminal agent choose how much is sent; an assistant's config may only lower it.
- `continuous doctor env` prints what is sent and why (`--json`, `--surface`, `--detail`), with no network call.
- Prompt cache, once more: these change the tools and system text, so the first request after upgrading writes the cache once.
