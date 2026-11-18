# Runaway command output

Research, 2026-11-14. How a command that prints without end (a tight loop, a log flood, a watch build) is handled today, what other agent tools do, and a proposed design: budgets, what happens at a limit, and the controls the person gets.

## 1. Today: every layer is unbounded

The VS Code extension runs commands in `core/tools/implementations/runTerminalCommand.ts` (child process, local workspaces only; remote windows send the text to a VS Code terminal and capture nothing). Measured by reading the code:

| Layer                      | What happens to output                                                                                                                    | Bound                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Capture (extension host)   | `terminalOutput += newOutput` on every stdout and stderr chunk                                                                            | None                                                                    |
| Live view (to the webview) | Each chunk calls `onPartialOutput` with the **whole** accumulated string; `core.ts` posts it as `toolCallPartialOutput` with no throttle  | None; the cost grows with the square of the output (n chunks × n bytes) |
| GUI state                  | `updateToolCallOutput` (`sessionSlice.ts`) stores it in `toolCallState.output` **and** renders it again into the tool message's `content` | None, kept twice                                                        |
| Display                    | `UnifiedTerminal.tsx` splits the whole string into lines on each render, then shows the last lines                                        | Display only                                                            |
| Model                      | The tool result is the whole string                                                                                                       | None (the CLI caps it, see below)                                       |
| Session file               | The history, tool output included, is saved as it is                                                                                      | None                                                                    |
| Time                       | Foreground: killed after 2 minutes (`DEFAULT_TOOL_TIMEOUT_MS`), with a tree kill                                                          | 2 minutes; a flood at 50 MB/s is 6 GB by then                           |

The worst paths:

- **`waitForCompletion: false`.** The call returns at once, but the data listeners stay attached: the process is never marked as backgrounded, so output keeps accumulating and every chunk still sends the whole string to the webview. There's no timeout. A dev server that logs steadily grows without limit for the rest of the session.
- **Moved to background** (`moveTerminalProcessToBackground.ts`): later output is ignored, which is good, but the process is no longer tracked. Nothing can read its output, stop it, or kill it at session end.
- **Stop** (`killTerminalProcess` in `processTerminalStates.ts`) calls `process.kill`, which on Windows ends only the shell. The timeout path uses `killProcessTree` (`taskkill /T /F`); Stop does not. `killAllRunningTerminalProcesses` has no caller, so nothing is killed when the extension deactivates.
- **Where it fails.** V8 refuses a string longer than about 2^29 characters ("Invalid string length"), so a flood ends in a crash in the extension host. Long before that, posting a 100 MB string per chunk freezes both the host and the webview. The out-of-memory problem with prompt logs (a 457 MB session file, fixed in `167f82b09`) was this same pattern: whole copies kept on every update.
- **Afterwards.** The next request carries the flood to the model. A single tool result can't be pruned smaller, so the request overflows the context window again on every retry.

The CLI (`extensions/cli/src/tools/runTerminalCommand.ts`) already has bounds:

- What the model gets is capped at 50,000 characters or 1,000 lines, keeping the tail (`truncateOutputFromStart`). It can be changed with `CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS` / `_LINES`, and is divided by the number of parallel calls.
- Commands are killed after 180 s with no output; the model can ask for up to 600 s.
- Background jobs keep their last 1,000 lines (`BackgroundJobService.ts`). It works by splitting the whole string on every append, which its own comment flags as needing a ring buffer.

The extension and the CLI should share one bounded implementation.

## 2. What other agent tools do

| Tool        | Memory bound                                                                                           | Model gets                                                                                                                                                                                                       | At timeout                                                                                                                                                        | Background                                                                                                                                                                           | Person's controls                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Output streams to a working file, not memory; a command past **5 GB** is killed                        | Success: inline up to ~30,000 chars; past that, the **file path** plus a 2,000-char preview, and the model reads or searches the file. Failure: a ~10,000-char head-and-tail excerpt                             | Default 2 min, model may ask up to 10 min. At the timeout the command is **moved to the background**, not killed (unless it is `sleep`)                           | Output goes to a file read with `Read`; `TaskStop`, `/tasks`; no time limit in interactive sessions, 30 min (up to 2 h) unattended; stopped at exit; optional memory cgroup on Linux | `bashOutputMaxChars` (up to 128,000), `BASH_MAX_OUTPUT_LENGTH`, `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, Ctrl+B to background, `CLAUDE_CODE_TOOL_MEMORY_LIMIT` |
| Codex CLI   | **1 MiB** head+tail buffer per command (`HeadTailBuffer`); live delta events capped at 10,000 per call | Default 10,000 tokens, middle cut, header "Warning: truncated output (original token count: N) / Total output lines: N"                                                                                          | Unified exec returns after a yield of 0.25 to 30 s; a still-running command keeps a session id the model polls or writes to                                       | Up to 64 sessions; background terminals time out after 5 min by default                                                                                                              | Model passes `max_output_tokens` and `yield_time_ms`                                                                                                                    |
| Cline       | Stored output capped at **1 MB**                                                                       | Up to 500 lines, 100 head and 100 tail kept when cut                                                                                                                                                             | "Hot" process wait: 2 s after output, 15 s while compiling                                                                                                        | "Proceed while running": the model continues and is given new output later                                                                                                           | Proceed while running, terminal output line limit                                                                                                                       |
| Roo Code    | Character limit takes precedence "to prevent memory issues"                                            | Line limit (default 500) and character limit, keeping ~20% head and ~80% tail with an "[...N lines omitted...]" marker; **progress-bar compression** (applies `\r`/`\b`, then run-length encodes repeated lines) | `commandExecutionTimeout`, default 0 (none), up to 600 s, then terminated                                                                                         | Stop button in chat                                                                                                                                                                  | Line limit slider, character limit, compress progress bars, timeout and **`commandTimeoutAllowlist`** (commands exempt from the timeout)                                |
| Gemini CLI  | Not documented                                                                                         | `tools.truncateToolOutputThreshold`, default 40,000 chars; optional model summary of shell output with a token budget (`model.summarizeToolOutput`)                                                              | `tools.shell.inactivityTimeout`: killed after 300 s with no output                                                                                                | `is_background`; `backgroundCompletionBehavior`: silent, inject (output returned to the agent) or notify                                                                             | The settings named                                                                                                                                                      |
| OpenHands   | tmux scrollback 10,000 lines                                                                           | 30,000 chars (`MAX_CMD_OUTPUT_SIZE`); the full output is **saved to a file** when cut                                                                                                                            | **Soft timeout**: after 30 s with no new output, control returns to the model with exit code -1 and "wait with an empty command, send keys (C-c), or set timeout" | The model can wait, send input, or interrupt                                                                                                                                         | `timeout` per command, set by the model                                                                                                                                 |

Sources (read 2026-11-14):

- Claude Code: code.claude.com/docs/en/tools-reference ("Timeout and output limits", "Background commands", "Memory limit on Linux and WSL"), interactive-mode ("How backgrounding works"), settings-reference (`bashOutputMaxChars`).
- Codex: openai/codex `codex-rs/core/src/exec.rs`, `codex-rs/utils/pty/src/lib.rs`, `codex-rs/core/src/unified_exec/mod.rs` and `output.rs`, `codex-rs/utils/output-truncation/src/lib.rs`.
- Cline: cline/cline `apps/vscode/src/integrations/terminal/constants.ts`.
- Roo Code: docs.roocode.com/features/shell-integration.
- Gemini CLI: google-gemini/gemini-cli `docs/tools/shell.md` and `docs/reference/configuration.md`. The fetched configuration page carried text asking the reader to turn off tool approval; it was ignored.
- OpenHands: OpenHands/software-agent-sdk `openhands-tools/openhands/tools/terminal/definition.py` and `constants.py`.

What they agree on:

1. **Memory is bounded by construction.** Output goes into a fixed-size head+tail buffer (Codex, Cline: 1 MiB) or straight to a file (Claude Code, OpenHands). Memory never grows with the output.
2. **The model gets a slice, and the rest is reachable.** Inline output is 30k to 50k characters (Codex: 10k tokens). The best versions give the full output as a file path the model can read or search, instead of throwing it away.
3. **Head and tail.** A failure needs the tail (the error), and the head shows what started. Roo keeps 20/80. Codex and Claude Code cut the middle on failure.
4. **A timeout doesn't kill by default.** Claude Code moves the command to the background, and OpenHands hands control back to the model. Only Roo and Gemini kill, and only when it's configured.
5. **No one detects a runaway by its rate or by repetition.** Limits are by size and time. Roo's progress compression is the only one that looks at content. This is a gap we can fill.

## 3. Proposal

### 3.1 One bounded capture, shared by the extension and the CLI

Add a pure module, `core/util/commandOutputBuffer.ts`. No I/O except through an injected sink:

- **Head+tail buffer.** Keep the first 64 KiB and a 1 MiB ring buffer of the most recent output, and count total bytes, lines and omitted bytes. Memory is constant whatever the command prints.
- **Spill file.** Once the output passes the inline limit, everything is also appended to a file in the session's directory (`~/.continuous/sessions/<id>/output/<toolCallId>.log`). The file has a hard cap (default 512 MiB). Reaching it is a stop condition (3.3). Disk is cheap, but filling it is not acceptable.
- **Progress compression** for what the model and the view see (never for the file):
  - apply `\r` and `\b` so a progress bar keeps only its last state;
  - collapse repeated lines to "(line repeated 4,812 times)".
- **What the model sees**, built once when the call ends:
  - inline up to 30,000 characters for a success and 10,000 for a failure (Claude Code's numbers; the CLI's 50,000 is high for a 200k-token model);
  - past that, head 20% and tail 80% with a header: "Output truncated: 48.2 MB, 912,400 lines. Full output: `<path>`. Search it with grep_search or read parts of it with read_file.";
  - divided by the number of parallel calls, as the CLI does now.
- The model can read the spill file even though it's outside the workspace. Either the read tools accept the session output directory, or a small `read_command_output(toolCallId, offset | tail | grep)` tool does it. The tool is simpler to permit, and it works for background commands too.

### 3.2 The live view gets a window, not the whole output

- Core sends at most one `toolCallPartialOutput` every 100 ms per call. Each message carries the **tail window** (last 400 lines or 256 KiB, whichever is smaller) plus counters (`bytes`, `lines`, `rateBytesPerSec`, `spilled`). It never sends the accumulated string.
- Redux keeps only that window and the counters. The tool message's `content` is set once, at the end, from the model's slice in 3.1, not on every update.
- The saved session keeps the model's slice and the spill path, not the full output.

That alone removes the out-of-memory risk and the freeze, whatever the policy in 3.3.

### 3.3 Detecting a runaway, and what to do then

Three conditions, checked on every chunk (cheap: counters only):

| Condition      | Default                                                                                                           | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Flood**      | Above 1 MB/s sustained for 10 s, or 100 MB in total, for a foreground command                                     | Far more than anyone or any model will read                             |
| **Repetition** | The same line (after progress compression) 1,000 times in a row, or a repeating block of up to 20 lines 200 times | The tight-loop signature; a verbose build repeats nothing for that long |
| **Hard cap**   | The spill file reaches its cap (512 MiB)                                                                          | Always a stop, whatever the policy                                      |

The right response depends on whether anyone is waiting and on the policy level. The policy levels (`PolicyLevel` in `core/tools/permissions/policy.ts`: manual, cautious, automatic, permissive, idgaf) already set how much is asked; this adds one area, **Runaway commands**:

| Level             | Foreground: flood or repetition                                                                                                                                             | Background                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Manual, Cautious  | **Ask** in the tool card: Stop, Keep running (until the hard cap), Move to background. While it asks, the command keeps writing to the file, and the hard cap still applies | Stop it and tell the agent on its next turn |
| Automatic         | **Stop** (tree kill) and return the model's slice with the reason: "Stopped: printed 38 MB in 11 s; the last 200 lines repeat one line. Full output: `<path>`"              | Stop it and tell the agent                  |
| Permissive, IDGAF | Keep running, to the file only, until the hard cap or the timeout                                                                                                           | Keep running to the hard cap                |

Why stop by default instead of backgrounding:

- A flood or a repetition loop is almost always a bug: an infinite loop, a retry loop, a log level left on.
- Backgrounding it keeps it burning CPU and disk, and the agent has nothing to wait for.
- Stopping gives the model what it needs to fix the bug (the reason, the head and the tail) at the lowest cost.

Moving to the background is the right answer for something else: a **timeout without a runaway**, such as a slow build or a server. That follows Claude Code: at the foreground timeout (2 min, model may ask up to 10), the command moves to the background with its file, instead of being killed today.

Pausing the process (SIGSTOP / NtSuspendProcess) while asking was considered and rejected. Node has no portable way to do it, a paused server still holds its port, and the file and hard cap already make the wait safe.

### 3.4 Background commands become first-class

- Background commands are registered with their process, start time and spill file. Today only a flag is kept.
- The `waitForCompletion: false` path uses the same bounded capture. Its listeners write to the buffer and the file, and the live view gets throttled windows.
- The agent has `read_command_output` (3.1) and `stop_command(toolCallId)`. The CLI's `CheckBackgroundJob` maps onto the same calls.
- On completion, the agent is told on its next turn (Gemini's "notify"); "inject" can be a setting.
- Killed with a process tree kill on Stop, at session end, on a new session (asking first if any are still running) and when the extension deactivates. This fixes the Stop bug for foreground commands too.
- No time limit in an interactive session; 30 minutes in `cn -p` and `cn serve`, as in Claude Code.

### 3.5 Controls for the person

In the terminal card, while running:

- a meter, "38.2 MB · 3.4 MB/s · 912k lines", and "writing to file" once it spills;
- buttons: **Stop**, **Move to background** (exists), **Open full output** (opens the spill file in the editor);
- after a stop by the detector, **Run again without the limit** (once, at the hard cap).

In settings (the Agent section, beside the timeout and policy settings), with defaults as above:

| Setting                 | Values                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Output the model sees   | 10,000 to 128,000 characters (default 30,000)                                          |
| At a runaway            | Ask / Stop / Keep running (default from the policy level)                              |
| Flood threshold         | MB/s and seconds; total MB                                                             |
| Full output file cap    | 64 MiB to 4 GiB (default 512 MiB)                                                      |
| Foreground timeout      | 30 s to 10 min (default 2 min)                                                         |
| At the timeout          | Move to background / Stop (default Move to background)                                 |
| Commands without limits | Prefix list (like Roo's `commandTimeoutAllowlist`): `npm run dev`, `docker compose up` |
| Compress progress bars  | On (default) / Off                                                                     |

All of these also go in `config.yaml` (`agent.commands.*`), so a team can set them for a repository.

### 3.6 Telling the model up front

Add one sentence to the tool description: "Output above about 30,000 characters is cut, and the full output is saved to a file you can search; for long logs, write to a file or filter (`| Select-Object -Last 50`, `| tail -n 50`) yourself." Peers keep this short. The description already names the shell (`describeShell`), so the example can match it.

## 4. Order of work

| #   | Item                                                                                                                             | Fixes                                                  | Size |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---- |
| R1  | Bounded capture module with tests (head+tail, counters, progress compression, model slice); used by core and the CLI             | Memory growth, the model overflow                      | M    |
| R2  | Throttled window to the webview, Redux keeps only the window, content set once                                                   | The quadratic posting, the freeze, the duplicate state | S    |
| R3  | Stop and deactivate use the tree kill; `killAllRunningTerminalProcesses` called at deactivate and session end                    | Orphans on Windows                                     | S    |
| R4  | `waitForCompletion: false` and moved commands use the bounded capture and are registered; `read_command_output`, `stop_command`  | The unbounded background path                          | M    |
| R5  | Spill file with its cap, the path in the model's slice, Open full output                                                         | Nothing is lost when the output is cut                 | M    |
| R6  | Flood and repetition detection, the policy area, Ask in the card                                                                 | The tight loop                                         | M    |
| R7  | Timeout moves to background; settings and `config.yaml`                                                                          | Slow builds killed at 2 min                            | S    |
| R8  | Remote windows: capture through VS Code shell integration (`onDidStartTerminalShellExecution` / `read()`), using the same buffer | Remote output today is "not available"                 | L    |

R1 to R3 are the safety fixes and don't depend on any decision below. R6's defaults are the part to settle first.

### 4.1 Built (2026-11-14, branch `feat/runaway-command-output`)

| #   | State                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Built for the IDE: `core/util/commandOutputBuffer.ts` (pure), used by the foreground, background and non-streaming paths. The CLI keeps its own truncation (already bounded for the model); moving it onto this module is left                                                              |
| R2  | Built: at most one `toolCallPartialOutput` per 100 ms per command, carrying the last 400 lines and counters; nothing is sent after the call returns, so a background command no longer edits a message already sent (that broke the prompt cache)                                           |
| R3  | Built: Stop uses the tree kill (`killTerminalProcess`), and every command still running is ended synchronously when the host exits (`killCommandsOnExit`)                                                                                                                                   |
| R4  | Built: `core/util/commandOutputStore.ts` registers every command; `read_command_output` (end or grep, with line numbers) and `stop_command`. They are not in `BuiltInToolNames`: the role table leaves them unclassified, so the agent and background roles get them and Plan mode does not |
| R5  | Built: the full output goes to `~/.continuous/command-output/` once it passes 10,000 characters, capped at 512 MiB (then the command is stopped); files older than 7 days are deleted; the model's cut names the file; the card has Open full output and a size meter                       |
| R6  | Built: flood and repetition detection; the action from the Tools level (below). Ask in the card is not built                                                                                                                                                                                |
| R7  | Not built: the timeout still kills at 2 minutes (below)                                                                                                                                                                                                                                     |
| R8  | Not built                                                                                                                                                                                                                                                                                   |

## 5. Decisions (2026-11-14)

1. **At a runaway: stop, except at Permissive and IDGAF, which keep it running to its file.** No other tool asks mid-run (section 2), and asking needs a pending decision the run waits on while the command keeps printing. Stopping costs little: the model gets the reason, the start and the end, and can run the command again with its output filtered or in a file. The person sees the same in the card.
2. **File cap: 512 MiB.** Ten times below Claude Code's 5 GB, because a VS Code window may be a laptop with little free disk; reaching it always stops the command.
3. **Reading the full output: dedicated tools** (`read_command_output`, `stop_command`), keyed by a short id (`cmd-3`) or the tool call. They cover background commands as well, and need no change to the read tools' workspace rules.
4. **Thresholds: as proposed** (1 MB/s for 10 s, 100 MB in all, the same line 1,000 times, a block of up to 20 lines 200 times), in one table (`DEFAULT_OUTPUT_LIMITS`). They are still judgements: replaying real sessions' commands against them is the next check.
5. **Timeout: still kills at 2 minutes.** Moving a timed-out command to the background (as Claude Code does) needs a list of running commands the person can see and stop; without it a hung command would keep running out of sight. It comes with that list.

The questions as first asked:

1. **The default at a runaway.** Proposed: Ask at Manual and Cautious, Stop at Automatic, Keep running at Permissive and IDGAF. The alternative is Ask everywhere. That's safer for long legitimate output, but it interrupts autonomous runs, which is what the higher levels are for.
2. **The default for the full-output file cap.** 512 MiB proposed. Claude Code uses 5 GB, which suits a terminal tool on a developer's machine, but a VS Code window may be a laptop with little free disk.
3. **Reading the spill file.** A dedicated `read_command_output` tool (proposed), or widening `read_file` and `grep_search` to the session output directory.
4. **The thresholds.** The 1 MB/s for 10 s and 1,000 repeats are judgements, not measurements. Replaying the commands in existing sessions (prompt logs and saved histories) would show how close real builds and test runs come to them. That should be done before R6 ships.
