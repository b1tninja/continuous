# Research: a review of our own usage and sessions

Date: 2026-11-21. Code read at `origin/main` (the commit is in the branch this note ships on). Nothing here was built except the one fix named in section 2.1; the rest is evidence and proposed rows.

## What this note is

A look at what the product recorded about itself: errors, blocked attempts, stalls and other problems, from one person's use over four days. It asks what is going wrong that no ROADMAP row covers, and what the data cannot see.

Inputs, all on one Windows machine:

- 20 session files in `~/.continuous/sessions` (67 MB). Ten are earlier saves of one conversation (93 to 100% of their messages are in the largest file) and five are end-to-end test fixtures, so there are about three real conversations. Counts below are **de-duplicated by tool call id or message id**.
- The audit trail in `~/.continuous/audit` (2,972 calls, every allow, ask and deny).
- The long usage log `dev_data/0.2.0/toolUsage.jsonl` (2,338 rows, 2026-11-18 to 11-21, seven client versions).
- The roadmap and `plans/research/`, read first so that a finding already tracked is not reported as new.

Evidence marks:

- **V**: re-read in code or reproduced by running it.
- **R**: read from the data only; the cause is not confirmed.

## Limits of this data

- **One person, who is also the developer.** Heavy use of the agent on the product itself, mostly shell and edit tools. It says little about other users.
- **Four days, about 126 distinct messages, 2,397 distinct tool calls.** Rates on small groups (for example 21 calls) are shown with their counts.
- **A gap between two requests includes the person being away.** Only one stall below is proven to be the model.
- **The "read-only" labels in 2.5 come from a pattern match on the command text**, not from running it.

## 1. Summary

| #   | Finding                                                                             | Evidence | Tracked?      |
| --- | ----------------------------------------------------------------------------------- | -------- | ------------- |
| 1   | "Steer now" removed the message the model was answering                             | V        | Fixed, #991   |
| 2   | A model stream can go silent for up to two hours with no sign                       | V        | Fixed, #993   |
| 3   | The tools that run in the webview (`multi_edit`, `subagent`) leave no audit outcome | V        | No            |
| 4   | The usage log records every edit as successful                                      | V        | No            |
| 5   | Command lint still refuses commands whose bash or cmd text is a launcher's argument | V        | No            |
| 6   | Most "protected path" asks were for read-only commands                              | R        | No            |
| 7   | Three signing attempts failed before the card's PIN counter was read                | R        | No            |
| 8   | Reviews like this one take eight scripts and a de-duplication step                  | R        | Partly (NI12) |
| 9   | `multi_edit` failed on Windows: Node's `path` is empty in the chat page             | V        | Fixed, #995   |
| 10  | Nothing watched for new Node modules in the chat page                               | V        | Built, #996   |
| 11  | Checkpoints saved no content for any edited file (`unreadable`, error swallowed)    | V        | PR #997       |

Rows 9 to 11 were found after the first version of this note, and are in section 2.9. Already fixed and confirmed by the data: the edit-race fix cut `multi_edit` errors from 32% to 6% (2.1 below), and the subagent call limit that stopped 6 of 16 runs was raised in #986.

## 2. Findings

### 2.1 A steer removed the prompt, after a stall (V)

The session log shows the model beginning to think about a prompt and saving 28 characters (`"This new request shifts dire"`). The next model request is **30.3 minutes later**. In between, a follow-up was queued and then sent. The history had been cut back past the person's original message, which went back into the input box, and the follow-up was written where it had been. The model answered the follow-up and never saw the request.

Cause: `interruptStream` ("Steer now") called `clearDanglingMessages()` with no marker. A retry also passes no marker, and a retry must drop the message so it can be sent again. The two need opposite things. The fix gives a steer its own value, `"steered"`, which is never stored. PR #991 has the reducer and store tests, and putting the bug back makes 4 of 6 store tests fail.

Why it matters beyond one prompt: nothing on screen told the person the stream had stopped (2.2), so they sent a follow-up into a turn that was already dead, and the recovery path then lost data.

### 2.2 No deadline on a silent model stream (V)

The HTTP layer has a connect timeout of 10 seconds (`packages/fetch/src/connectTimeout.ts:5`) but an inactivity timeout of **7,200 seconds** (`packages/fetch/src/getAgentOptions.ts:12`). The loop that reads the model's chunks, `streamNormalInput.ts:488` and `:589`, is a bare `await gen.next()`. The only `setTimeout` near it is a retry delay. So a connection that stays open and sends nothing can show "Generating…" for up to two hours.

Of 729 gaps between requests, 17 were over 5 minutes and 6 over 30. Most of those will be the person away; **only the 30.3-minute one is proven a stall**, because the thought stops mid-word.

Not covered by the roadmap: NI3 is retry ownership, NI4 is deadlines on panel-to-extension requests, and NI16's "drop after first chunk" is a closed connection. A connection that stays open and silent is none of these. O39 is only a slow first token for local models.

### 2.3 The webview-run tools are invisible to the audit (V)

Of 2,967 allowed calls, 208 (7%) have no recorded outcome. **`multi_edit`: 187 of 187. `subagent`: 16 of 16.** `run_terminal_command`: 5 of 1,420.

Audit outcomes are written only in core's `handleToolCall` (`core/core.ts:2945` and `:2960`). `multi_edit` runs as a client tool in the GUI (`gui/src/util/clientTools/callClientTool.ts:62`), and subagents run there too, so neither goes through that path. This is the same kind of hole as the terminal exit code (709 of 710 outcomes had none), now for the most failure-prone tool.

Consequence: the stuck detection, which reads the audit, cannot see an agent that keeps failing the same edit.

### 2.4 The usage log cannot see edit failures (V)

The log shows `multi_edit` with **0 failures in 205 calls**. The sessions show 65 of 218 errored. `logToolUsage` takes `success` as a parameter, and the accepted path passes the constant `true` (`gui/src/redux/thunks/callToolById.ts:196`, `handleApplyStateUpdate.ts:45` and `:80`). So `succeeded` means "the call finished", not "the edit worked". Any dashboard built on it (NI12 plans one) would report edits as healthy.

### 2.5 Protected-path asks that were read-only (R)

The person answered 39 asks and **allowed all 39**. Of the 16 asks from the protected-path and floor rules, 12 look read-only by a pattern match: listing `~/.continuous/sessions` is described as one that "would change your permission or policy files", and several only set `AWS_PROFILE` before a read. An ask that is always allowed trains the person to click through, which is the opposite of what the floor is for.

One cause is already fixed: asks on `$PWD` ("can hold credentials") appear in the data and were fixed in #977. Setting `AWS_PROFILE` may be a correct ask. The over-broad one is the product's own data folder, where the rule cannot tell a listing from a write. Relaxing a floor is a safety decision, so the row needs the owner.

### 2.6 Command lint on the payload of a launcher (V)

Ten distinct refusals: CL042 seven times, CL041 twice, CL043 once. Most are bash sent on purpose to WSL (`wsl -d Ubuntu -- bash -c "…"`). I re-ran the **current** lint on eight reconstructed commands from those sessions: `~/` and `curl -fsSL` are now clean (earlier fixes), but **six of eight are still flagged**, all because the quoted text is judged as PowerShell: `cmd /c "…"` (CL043), `chmod`, `xargs`, `2>/dev/null` and a `for` loop inside `wsl … bash -c` (CL041, CL042). A real PowerShell mistake should still be caught.

The roadmap has SH7 (what an allow rule on a launcher means) and a note about suggesting WSL after repeated rejections. Neither lints the payload.

### 2.7 Signing attempts and a locked card (R, a hypothesis)

One session ended with the signing card's user PIN counter at 0 of 3. The record shows three signing attempts with a working `gpg` (#685, #688, #691) before the counter was first read (#699). A hardware key counts wrong PINs, and a non-interactive attempt cannot show the prompt, so the retries may have used the three attempts. The counter was never read before them, so this is not proven.

A small guard would be a result hint when the output says `gpg failed to sign` or `Bad PIN`: stop, do not vary and retry, ask the person. The cost of being wrong is a locked key, which is not recoverable without the admin PIN.

### 2.8 The review itself (R)

This note took eight throwaway scripts, a de-duplication by id (ten files are repeats), and a join to the client version from the usage log. NI12 plans usage over time and cost. A "problems" view, with tool error rate by client version, outcome coverage, request gaps and refusals by rule, would make this a command and not a project.

### 2.9 Node modules that are empty in the chat page (V)

The chat page is a browser build, where Node's `path`, `path/posix`, `os`, `url` and others are replaced by empty modules. Code that calls into one throws in the page and nowhere else. The unit tests run in Node, where the module is real, so they cannot see it. Two bugs came out of this, found in the order below, and a third class was looked for and not found.

- **`multi_edit` and `single_find_and_replace` failed on Windows (UR8).** `ideUtils.ts` called `path.win32.relative`; the installed bundle defines that module as `t.exports={}`. It shipped in 2.38.4 (`afda18f42`, 11-19) and is in 2.38.5. Before 2.38.4 the data has none of these errors; the only two `multi_edit` calls I could date after it was installed both failed with it. Reproduced with an empty `path`: against the old code 9 of 12 tests fail with the exact message. Fixed in #995.
- **The guard (UR9).** Vite names every Node module it stubs and the file that imported it: 63 pairs in 26 files, 25 pairs in our own sources (23 after #997). A script compares them with a baseline and fails on a new one. With the import put back, the real build made it exit 1. #996.
- **Checkpoints saved nothing for an edited file (UR10).** The stub list showed `protected.ts` using `os` and `path/posix`, in the built page. I first called it likely unreachable; that was wrong. `snapshotFile`, which the page runs before an agent edit, reaches `protectedPathHit` through `checkpointHoldsSecret`, and its `catch` turned the throw into `unreadable`. In the saved sessions: 163 distinct file snapshots, 124 `unreadable`, none with content, and the 19 taken since 2.38.4 are all new files, which return before the failing code. So it is older than the `multi_edit` bug, and it was not noticed because the error was swallowed (UR11). The check that made it throw was added on 11-10; the earliest snapshot in the data is from 11-18, so how long it was broken before that is not known. Fixed in #997.
- **The secret check still works in the page.** It exists so that keys are not copied into the session file, so a fix that only stopped the throw could have made it stop matching. With `path`, `path/posix`, `os` and `url` all emptied, 13 file URIs of secret shapes are held as secrets and an ordinary file is not, the same answers core gives. I first emptied three of the four modules and not `url`; adding it changed nothing, but my first test did not match the page.
- **Not found.** `readOnlyCommand.ts` is in the page's bundle and calls `path.join`. The page imports only constants and labels from `policy.ts`, and the function that reaches it (`readOnlyClaim`) is called from `approval.ts` and `policy.ts`, which are policy decisions that run in core. That is a reading of the imports and not a run, so UR12 asks for a test.

## 3. Corrections to my first pass

- **Double counting.** My first totals counted every saved copy of a conversation. The de-duplicated numbers above replace them: `multi_edit` is 65 of 218 (not 111 of 426), and the 22% `ls` error rate was an artifact (1 of 10).
- **"14% after the fix" was wrong.** It split by commit date, but the build in use was 2.38.2 until 2.38.3 shipped. By client version: **2.38.2, 30 of 94 errored (32%), 15 of them `Failed to edit undefined`; 2.38.3, 5 of 90 (6%), none.** `v2.38.3-vscode` is the first tag containing `3d5d93fc5`. 36 `multi_edit` calls have no known client version and are left out.
- **Lint count.** I first said five of eight were still flagged; it is six.
- **The cut-off thought.** I first told the person the phrase was not in the session. It was, at item 4433, twice. My search had excluded its own matches and I read that as absence.

## 4. Not understood, not checked

- **Why ten session files are earlier saves of one conversation.** It may be how a session is saved under a new id; it costs disk and I did not trace it.
- **Whether the other long gaps were stalls.** Only the proven one is treated as one.
- **Other users' data.** None was available.
- **IntelliJ and the CLI.** The sessions are VS Code; the CLI's `Bash` time-limit recording was not in this data.
- **Why the person sent a bare "retry" or "continue" in 19 of 126 messages (15%).** Seventeen follow a turn that ended in plain text; two follow an empty reply (NI6). I cannot say whether they wanted the next step or a restart, so I propose nothing.

## 5. Proposed rows

Track **UR** ("usage review"), unused on `main`. The rows are in `plans/ROADMAP.md` as written.
