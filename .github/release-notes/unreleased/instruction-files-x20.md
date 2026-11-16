## New

- Instruction files (`AGENTS.md`, `AGENT.md`, `CLAUDE.md` and rule files) are checked as they load, in the IDE and in `cn`: hidden characters (zero-width, text-direction, tag and other invisible characters) are removed, with a notice naming the file and lines but not the removed text; a value that looks like a key or token gives a warning naming the file and line, and the file still loads as written. In the IDE the notices show above the chat input with a link to the file; `cn` prints each once.

## Behaviour changes

- In a workspace VS Code has not trusted (Restricted Mode), `AGENTS.md` (or `AGENT.md`, `CLAUDE.md`) is no longer read. A line above the chat input offers **Load**, which reads it for that window only and saves nothing; trusting the workspace reads it from then on. `cn` is unchanged here.
- An instruction file longer than 32 KiB is cut after the last whole line that fits, with a line naming the file where it was cut and a notice saying how many lines were loaded. Before, the whole file was sent.
