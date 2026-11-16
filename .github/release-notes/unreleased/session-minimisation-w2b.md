## New

- `continuous sessions prune --older-than <age>` moves every session last used before the age to the trash, where it can be restored for 7 days with `continuous sessions restore <id>`. It lists them first and asks, or takes `--yes`; `--dry-run` and `--json` report. Sessions open in a window or a running agent are left alone. Nothing deletes sessions by itself: there is no retention period.
- `continuous -p --no-session-persistence` runs without writing the session to disk, so it cannot be resumed.
- `/export` and `continuous export` say how many values were masked, and `--raw` writes the text unmasked, with a warning.

## Behaviour changes

- `/export --json` (the session file `/import` reads) now replaces secrets the at-rest scanner recognises with `[REDACTED:<kind>:xxxx]` and says how many; before, it wrote the session as it was. `/export --json --raw` keeps the old behaviour.
- `continuous clean --yes` moves old sessions to the trash instead of deleting them, so a clean can be undone with `continuous sessions restore <id>` for 7 days, and it leaves sessions open in another window or a running agent alone. Logs and `dev_data` are deleted as before.
- Feedback (thumbs up or down on a reply) sends the full prompt of the newest request only. Every other request sends its size and SHA-256 in place of the prompt; before, it sent `[prompt not kept: older request]` and nothing else.
