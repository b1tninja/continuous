# Research: a review of agent guidance and the agent system prompt

Date: 2026-11-21. Code read in the working tree at `01dc47fce` (branch `fix/open-issues-981-982-988`; its uncommitted changes touch none of the files cited here). Nothing was built. This note is evidence and proposed rows.

## What this note is

"Guidance" is the text the agent loop gives the model when something goes wrong or is unexpected: a failed tool call, a malformed or unknown call, a refused or held action, a stuck loop, a cut-off reply, a lint finding. This note lists every such text and the system prompt, checks it against the failures that happen, and proposes what to add, remove, repair mechanically and measure.

Evidence marks:

- **V**: read in code, or counted from the data on disk.
- **R**: read in a plan only, or a count whose cause is not confirmed.

## Inputs and limits

Inputs:

- Code: `core/`, `gui/src`, `extensions/cli/src`, `packages/openai-adapters`.
- Plans: tracks S, Y, RF, Q, UJ, UR, NI, T and the RQ queue in `ROADMAP.md`, and the plans and research notes behind them. EV and ENV were searched, not read in full.
- Data on one Windows machine: `~/.continuous/sessions` (26 files, 25 session ids), `audit/` (8 files, 9,401 events) and `dev_data/0.2.0/toolUsage.jsonl`. Counts only.
- Upstream issues read with `gh` from `continuedev/continue`.

Limits:

- **One person, who is the developer, and one model family.** Every attributable call in the data is a local Qwen variant. The data says nothing about Claude, GPT, Gemini, Nova or Llama.
- **The data is IDE sessions.** CLI guidance (39 points) has no usage data here.
- **The counts come from one script pass, de-duplicated by tool call id.** It found 6,371 distinct tool calls from 2026-11-08 to 11-21. `usage-review-2026-11-21.md` counted 2,397 over four days with a different file set. The two notes are not comparable row by row. I did not re-run the script.
- **Failure classes are pattern matches on result text.** 442 of 1,188 failures are "other" (mostly a command's own non-zero exit).
- **"Next call" is the first tool call after the failure, before any user message.** It shows whether the model changed course, not why.
- Much of the CLI inventory and the upstream checks were read by delegated readers. I re-opened a sample (`parseArgs.ts`, `streamChatResponse.helpers.ts`, `editImpl.ts`, `turnEnd.ts`, `evaluateToolPolicies.ts`, `truncatedJson.ts`) and it matched. Lines I did not re-open are as reported.
- "Tested" means a test file asserts on the wording or the behaviour. A wording with no phrase match in any test is marked no, even if the code path runs in some test.

## 1. Summary

| #   | Finding                                                                                                                                                                                                       | Evidence | Tracked?                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------ |
| 1   | 84 guidance points: 23 shared, 22 IDE-only, 39 CLI-only. 53 have a test. The two surfaces word the same event differently in at least 9 cases                                                                 | V        | Partly (PAR11, UJ11, UJ12)                       |
| 2   | The IDE's most common edit failure text gives no cause: "Failed to edit `<file>`" was 67 of 82 edit failures. After it, a re-read then edit worked 9 of 27 times; 13 files were rewritten whole               | V        | No (UR2 and UR3 cover logging only)              |
| 3   | An unknown tool name gets "Tool X not found" on both surfaces, with no list and no alias. 23 calls in the data used the CLI's names (`Read`, `Bash`, `List`)                                                  | V        | Partly (H16: the list, CLI only)                 |
| 4   | A string sent where the schema wants an array, boolean or number is not repaired on structured calls. The repair exists, but only for calls recovered from text                                               | V        | No (upstream 13350)                              |
| 5   | Held-for-approval results do not change behaviour: 302 approval or policy results, 103 followed by another of the same class; 162 said the question cap was reached                                           | V        | Partly (RF7, UJ19)                               |
| 6   | The CLI turns unparseable arguments into `{}` without telling the model. The IDE refuses the call and says why                                                                                                | V        | Partly (H16: prefix repair)                      |
| 7   | The stuck notes, the act nudge and the invalid-round guard exist only in the CLI. The truncated-call lines exist only in the IDE                                                                              | V        | Partly (S12, PAR11)                              |
| 8   | The prompt promises "The result says who stopped it and what to do next". Five results do not: CLI `exclude`, "Permission denied by user", "Tool X not found", raw exception text, and the IDE's generic tail | V        | Partly (UJ12)                                    |
| 9   | No signing-failure line exists in code                                                                                                                                                                        | V        | Tracked as UR6                                   |
| 10  | Nothing replays a recorded failure and scores the model's next call. `eval:turns` is the closest tool                                                                                                         | V        | No                                               |
| 11  | Lint findings work as guidance: 113 refusals, 85 next calls succeeded, 10 hit lint again                                                                                                                      | V        | n/a                                              |
| 12  | Three copies of the "carry on" refusal tail, and two copies of "Please try something else or request further instructions"                                                                                    | V        | Partly (`turn-prompt-eval.md` section 5, no row) |

## 2. The system prompt

All V.

| Part                                                                                                       | Where                                                             | Surfaces | Test                                                   |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| Act turn, full (Work, Stopping, Refusals, Questions, Report)                                               | `core/llm/prompts/turns.ts:51`                                    | both     | `usePrompts.vitest.ts`, `eval:turns`                   |
| Act turn, short (ten bullets), for ids matching `/qwen/i`                                                  | `turns.ts`, `actTurnShort`                                        | both     | same                                                   |
| "Tool calls" group (tailored), Qwen coder and next                                                         | `turns.ts`, `toolCallsGroup`                                      | both     | same                                                   |
| Plan turn, full and short                                                                                  | `turns.ts`, `planTurn`, `planTurnShort`                           | both     | same                                                   |
| Turn tail on every user message: "Act until the request is done. A reply with no tool call ends the turn." | `turns.ts`, `ACT_TURN_TAIL`                                       | both     | `usePrompts.vitest.ts`, `SystemMessageService.test.ts` |
| IDE wrapper                                                                                                | `core/llm/defaultSystemMessages.ts:75`                            | IDE      | not checked                                            |
| CLI wrapper: `<env>` preamble, headless line, JSON format, user rules                                      | `extensions/cli/src/systemMessage.ts:188`, `:264`, `:269`, `:278` | CLI      | `systemMessage.test.ts`                                |
| Shell sentence in the Bash tool description                                                                | `extensions/cli/src/tools/runTerminalCommand.ts:97-113`           | CLI      | not checked                                            |
| Output note in the terminal tool description                                                               | `core/tools/definitions/runTerminalCommand.ts:31`                 | IDE      | not checked                                            |

Observations:

- The short profile carries the only rules about bad calls: "Call only the tools listed. Give every required parameter. If a call fails twice the same way, do something else or report." The full profile has none of the three. (V)
- The Refusals bullet depends on results that say what to do next. Section 4.8 lists results that do not. Fix the results, not the bullet. (V)
- Sizes and budgets are in `prompt-segments.md`: CLI `turn.act@full` 586 tokens, tools 1,846; IDE turn 687, tools 2,640. (R)

## 3. The inventory

P column: does the person see the text. "row" means the CLI shows a one-line summary of the result. Quotes are shortened.

### 3.1 Shared (core text, both surfaces)

| #   | Trigger                                         | Text                                                                                                                 | Where                                                                 | Test                  | P       |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------- | ------- |
| 1   | Tool turned off while the cache is warm         | "is turned off for this session…" + "Do not retry this call or reach the same result another way."                   | `core/tools/toolListHold.ts:141`, `:149`                              | yes                   | yes     |
| 2   | Tool not in the mode's role                     | "The X tool is not available in Y, so it was not run."                                                               | `core/tools/roleTools.ts:384`                                         | yes                   | yes     |
| 3   | Person declined while a timer ran               | "The person declined X. Do not retry it unchanged; ask what they…"                                                   | `core/tools/permissions/decisionTimer.ts:218`                         | yes                   | yes     |
| 4   | No answer in the timer window                   | "No answer to X within N s, so it was refused…"                                                                      | `decisionTimer.ts:211`                                                | yes                   | yes     |
| 5   | Reply is a tool call written as text            | "Your last reply wrote a tool call as plain text, so nothing was run."                                               | `core/util/turnEnd.ts:95`                                             | CLI yes               | unknown |
| 6   | Loop item ended with no report                  | "You ended without reporting. Call finish_item now…"                                                                 | `turnEnd.ts:99`                                                       | yes                   | unknown |
| 7   | Re-plan ended with no plan                      | "You ended without presenting the plan."                                                                             | `turnEnd.ts:104`                                                      | no                    | unknown |
| 8   | Loop holds an ask as a question                 | "This call needs the person's approval, so it was not run. It is held as question N…"                                | `core/util/loopMode.ts:3991`                                          | not checked           | yes     |
| 9   | Loop question caps                              | "The loop already holds N questions. Continue on a stated assumption."                                               | `loopMode.ts:2740`, `:2746`                                           | not checked           | yes     |
| 10  | Same call again in a loop item, no file change  | "was not run: the same call has run … with no file change in between"                                                | `loopMode.ts:535-540`                                                 | yes                   | yes     |
| 11  | Item reported stuck                             | "Recorded as stuck. End your turn now."                                                                              | `loopMode.ts:3958`                                                    | no                    | yes     |
| 12  | Item at 80% of a budget                         | "Note: this item has used 80% of its…"                                                                               | `core/util/itemBudget.ts:251`                                         | yes                   | row     |
| 13  | Result reads like instructions                  | "[Security notice: the tool result below contains wording that looks like instructions…"                             | `core/tools/permissions/injection.ts:180`                             | yes                   | yes     |
| 14  | Command lint (CL000 to CL045)                   | "The command was not run: it has a mistake the shell would only report after running."                               | `core/tools/permissions/commandLint.ts:445`                           | codes yes, wording no | yes     |
| 15  | Shell cannot parse the command                  | "The command was not run: PowerShell cannot parse it. … Fix it and call again."                                      | `core/tools/permissions/shellHints.ts:1160`                           | not checked           | yes     |
| 16  | Program not on PATH                             | "The command was not run, so nothing in it took effect. Use another program, or ask the person to install this one." | `core/tools/permissions/missingBinary.ts:445`                         | yes                   | yes     |
| 17  | `cwd` outside the workspace                     | "cwd \"X\" is outside the workspace. Use a folder inside it, or run the command with cd in it."                      | `core/tools/implementations/terminalCwd.ts:102`                       | yes                   | yes     |
| 18  | Edit: old string not found                      | "Edit at index N: string not found in file" + closest region                                                         | `core/edit/searchAndReplace/performReplace.ts:199`                    | yes                   | yes     |
| 19  | Edit: old string not unique                     | "appears N times in the file. Either provide a more specific string…"                                                | `performReplace.ts:225`                                               | no                    | yes     |
| 20  | Edit: same, empty or blank strings              | "old_string and new_string must be different"                                                                        | `core/edit/searchAndReplace/findAndReplaceUtils.ts:20-44`             | not checked           | yes     |
| 21  | Web refusals (ten sentences)                    | "Refused: robots.txt on H disallows this URL… Do not retry it."                                                      | `core/tools/permissions/webPolicy.ts:327-513`                         | not checked           | yes     |
| 22  | A call with no result when the request is built | "Tool cancelled"                                                                                                     | `core/util/messageConversion.ts:354`, `conversationCompaction.ts:150` | no                    | no      |
| 23  | An old result replaced to save space            | "[tool result masked: … Call recall with handle … to read it again]"                                                 | `core/util/contextAgeing.ts:127`                                      | yes                   | no      |

### 3.2 IDE-only

| #   | Trigger                                                        | Text                                                                                                                                | Where                                                                                                                                            | Test        | P           |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ----------- |
| 24  | Any tool throws                                                | "X failed with the message: E. Please try something else or request further instructions."                                          | `gui/src/redux/thunks/callToolById.ts:160`                                                                                                       | no          | yes         |
| 25  | Preprocessing fails; also an unknown tool name                 | "X failed because the arguments were invalid, with the following message: Tool X not found…"                                        | `gui/src/redux/thunks/preprocessToolCallArgs.ts:108`; thrown at `core/core.ts:2817`                                                              | no          | yes         |
| 26  | Call cut off at the output limit                               | "Your X call was cut off at the output limit, so it was not run and nothing was written. Send it again in smaller pieces…"          | `core/util/truncatedJson.ts:60`                                                                                                                  | yes         | yes         |
| 27  | Arguments incomplete, reply ended normally                     | "Your X call's arguments arrived incomplete… Send the same call again."                                                             | `truncatedJson.ts:55`                                                                                                                            | yes         | yes         |
| 28  | Stream closed mid-call                                         | "\"Premature Close\" error: this tool call was aborted mid-stream… Please re-attempt by breaking the operation into smaller chunks" | `gui/src/redux/thunks/streamNormalInput.ts:687`                                                                                                  | no          | yes         |
| 29  | Person skipped a call (only with `continueAfterToolRejection`) | "The user skipped the tool call." + three conditional lines                                                                         | `gui/src/redux/thunks/cancelToolCall.ts:12`                                                                                                      | no          | no (hidden) |
| 30  | Reviewer model refused                                         | "A reviewer model refused this call: R. … Do not retry this call or reach the same result another way."                             | `gui/src/redux/thunks/evaluateToolPolicies.ts:420`                                                                                               | no          | yes         |
| 31  | Deny rule, and the default branch                              | "This command has been disabled by security policy:" + command + carry-on tail                                                      | `evaluateToolPolicies.ts:425`, `:440`                                                                                                            | yes         | yes         |
| 32  | Tool turned off in settings                                    | "Do not work around this. Do what else the request needs, then say what you could not do and why."                                  | `evaluateToolPolicies.ts:430`                                                                                                                    | no          | yes         |
| 33  | Apply failed after an edit tool call                           | "Failed to edit F. To continue working with the file, read it again to see the most up-to-date contents"                            | `gui/src/redux/thunks/handleApplyStateUpdate.ts:168`                                                                                             | no          | yes         |
| 34  | Editor auto-formatted after an edit                            | "Along with your edits, the editor applied the following auto-formatting:"                                                          | `handleApplyStateUpdate.ts:115`                                                                                                                  | no          | yes         |
| 35  | Create on an existing file                                     | "File F already exists. Use the edit tool to edit this file"                                                                        | `core/tools/implementations/createNewFile.ts:72`                                                                                                 | no          | yes         |
| 36  | Create outside the workspace                                   | "F is outside the workspace, and files outside it can't be written at this permission level."                                       | `createNewFile.ts:53`                                                                                                                            | not checked | yes         |
| 37  | Read a missing file                                            | "File \"F\" does not exist or is not accessible. You might want to check the path and try again."                                   | `core/tools/implementations/readFile.ts:18`                                                                                                      | no          | yes         |
| 38  | Runaway output stopped                                         | "[Stopped by Continuous: … If the output was expected, write it to a file or filter it…"                                            | `core/tools/implementations/runTerminalCommand.ts:263`                                                                                           | yes         | yes         |
| 39  | Command timed out                                              | "[Timeout: process killed after 2 minutes]"                                                                                         | `runTerminalCommand.ts:472`, `:636`                                                                                                              | yes         | yes         |
| 40  | Command moved to the background                                | "Command is running in the background (id N). Its output is kept: read it with read_command_output…"                                | `runTerminalCommand.ts:501`                                                                                                                      | yes         | yes         |
| 41  | Non-zero exit                                                  | status "Command failed with exit code N"                                                                                            | `runTerminalCommand.ts:288`, `:693`                                                                                                              | not checked | yes         |
| 42  | Truncation notices (grep, glob, ls, fetch, web search, diff)   | "The above search results were truncated because… try refining your search query."                                                  | `core/tools/implementations/grepSearch.ts:130`, `globSearch.ts:36`, `lsTool.ts:50`, `fetchUrlContent.ts:88`, `searchWeb.ts:37`, `viewDiff.ts:45` | no          | yes         |
| 43  | Subagent call needs approval                                   | "X needs the person's approval, and nobody can give it during this run."                                                            | `gui/src/util/subagents/runSubagent.ts:678`                                                                                                      | not checked | unknown     |
| 44  | Container runtime missing                                      | "…`docker` is not installed. … The command was not run."                                                                            | `core/util/containerStatus.ts:127`                                                                                                               | not checked | yes         |
| 45  | Stream silent past the deadline                                | "The model stopped sending its reply and was silent for N…" (for the person; the model gets nothing)                                | `gui/src/util/streamDeadline.ts:57`                                                                                                              | yes         | yes         |

### 3.3 CLI-only

All in `extensions/cli/src` unless a core path is given.

| #   | Trigger                                      | Text                                                                                               | Where                                                                            | Test | P       |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---- | ------- |
| 46  | Unknown tool name                            | "Tool X not found"                                                                                 | `stream/streamChatResponse.helpers.ts:1264`                                      | yes  | row     |
| 47  | Required argument missing                    | "Required parameter \"p\" missing for tool…"                                                       | `tools/index.tsx:421`                                                            | yes  | row     |
| 48  | Third round of invalid calls                 | "…round in a row of tool calls with invalid arguments. Read the error, then send a complete call…" | `stream/repeatGuard.ts:119`                                                      | yes  | row     |
| 49  | Third identical call, earlier ones failed    | "was not run: this call already failed … with the same arguments"                                  | `repeatGuard.ts:140`                                                             | yes  | row     |
| 50  | Third identical call, earlier ones worked    | "was not run: it is identical to the last…"                                                        | `repeatGuard.ts:142`                                                             | yes  | row     |
| 51  | Task list resent unchanged                   | "was not run: the task list is already as you sent it"                                             | `repeatGuard.ts:137`                                                             | yes  | row     |
| 52  | Stuck signal reaches `note` (eight wordings) | "[Stuck check] …different calls have failed with the same error."                                  | `core/util/stuckNotes.ts:15`, `:27-42`; added at `stream/handleToolCalls.ts:199` | yes  | row     |
| 53  | Another agent is repeating                   | "Agent W (not the main agent) is…"                                                                 | `core/util/stuckNotes.ts:109`                                                    | yes  | row     |
| 54  | Tool throws                                  | "Error executing tool X: " + raw message                                                           | `helpers.ts:1575`                                                                | yes  | row     |
| 55  | Permission phase throws                      | "Error checking permissions for X: " + raw                                                         | `helpers.ts:1618`                                                                | no   | row     |
| 56  | Person said no                               | "Permission denied by user"                                                                        | `helpers.ts:158`                                                                 | yes  | yes     |
| 57  | Rule, protected path or reviewer denies      | "Command blocked by security policy: R Do not retry it…"                                           | `helpers.ts:138`                                                                 | yes  | row     |
| 58  | `--exclude`                                  | "Command blocked by security policy"                                                               | `helpers.ts:137`                                                                 | yes  | row     |
| 59  | Rule engine throws                           | "The permission rules could not be checked (internal error)…"                                      | `helpers.ts:704`                                                                 | yes  | row     |
| 60  | Call would ask in a headless run             | "Running headless, so it was refused: nobody can be asked…"                                        | `permissions/headlessPolicy.ts:53`                                               | yes  | stderr  |
| 61  | PreToolUse hook blocks                       | "Blocked by a hook: R"                                                                             | `helpers.ts:1426`                                                                | yes  | row     |
| 62  | Hook rewrote arguments badly                 | "A hook changed the arguments of X to something the tool rejects"                                  | `stream/toolHooks.ts:58`                                                         | no   | row     |
| 63  | PostToolUse hook flags                       | "[Hook output]" / "A hook flagged this result: "                                                   | `toolHooks.ts:89`, `:93`                                                         | yes  | yes     |
| 64  | Stop hook asks to continue                   | "Stop hook feedback:"                                                                              | `hooks/lifecycleHooks.ts:89`                                                     | yes  | unknown |
| 65  | Prompt hook adds context                     | "[Hook context]"                                                                                   | `hooks/promptHook.ts:24`                                                         | yes  | unknown |
| 66  | Headless reply names a step and stops        | "You named the next step and then stopped. Take it now: call the tool."                            | `core/util/turnEnd.ts:76`; sent at `stream/streamChatResponse.ts:312`            | no   | n/a     |
| 67  | No output for 180 s                          | "[Command timed out after 180 seconds of no output]"                                               | `tools/runTerminalCommand.ts:361`                                                | yes  | row     |
| 68  | Person backgrounds a command                 | "Command moved to background. Job ID: …"                                                           | `runTerminalCommand.ts:336`                                                      | no   | row     |
| 69  | Non-zero exit with stderr                    | "Error (exit code N): " + stderr                                                                   | `runTerminalCommand.ts:462`                                                      | yes  | row     |
| 70  | Output over the caps                         | "(previous N lines truncated)"                                                                     | `util/truncateOutput.ts:70`, `:219`                                              | yes  | row     |
| 71  | File too large to read                       | "File is too large to read: … Consider using terminal commands like 'head'…"                       | `tools/readFile.ts:105`                                                          | no   | row     |
| 72  | Read a missing file                          | "File does not exist: F"                                                                           | `readFile.ts:81`                                                                 | no   | row     |
| 73  | Edit before read                             | "You must use the Read tool to read F before editing it."                                          | `tools/edit.ts:74`                                                               | yes  | row     |
| 74  | Headless write outside the working directory | "was not run: … A headless run writes only inside the working directory"                           | `tools/workspaceBoundary.ts:104`                                                 | yes  | n/a     |
| 75  | Search results capped                        | "[Results truncated: showing N of …"                                                               | `tools/searchCode.ts:202`                                                        | yes  | row     |
| 76  | Fetch empty or capped                        | "Could not fetch content from U"                                                                   | `tools/fetch.ts:173`, `:187`                                                     | yes  | row     |
| 77  | Subagent returns                             | `<task_metadata>` block; "(the subagent returned no text)"                                         | `subagent/result.ts:52`                                                          | yes  | yes     |
| 78  | Subagent ended after a tool call             | "The subagent stopped after a tool call without giving a final answer."                            | `subagent/executor.ts:525`                                                       | yes  | row     |
| 79  | Unknown subagent name                        | "Unknown agent type: … Available agents: "                                                         | `tools/subagent.ts:50`                                                           | yes  | row     |
| 80  | Question answered by policy                  | "Nobody was asked; go on with it and say so in your summary."                                      | `tools/askQuestion.ts:72`                                                        | yes  | row     |
| 81  | Plan saved                                   | "Plan saved to … End your turn now."                                                               | `tools/presentPlan.ts:189`                                                       | yes  | row     |
| 82  | Compaction request                           | "Please provide a concise summary of our conversation so far…"                                     | `compaction.ts:45`                                                               | yes  | no      |
| 83  | Turn would end after a compaction            | "continue"                                                                                         | `stream/streamChatResponse.compactionHelpers.ts:275`                             | yes  | unknown |
| 84  | Two MCP servers offer the tool               | "is offered by more than one MCP server"                                                           | `services/MCPService.ts:305`                                                     | yes  | row     |

Totals: 84 points. Shared 23 (13 tested), IDE-only 22 (7 tested), CLI-only 39 (33 tested). 53 of 84 tested.

Asked for and not found in code (V): a signing-failure line; a stream-stall line for the model; an empty-reply nudge; "file changed since you read it"; a cap on MCP results in the CLI; an act nudge or stuck note in the IDE's main loop.

## 4. Gaps by failure class

The table is the data, all Qwen, all IDE. "Same again" is the next call failing in the same class.

| Class                       | n   | Next: same tool, new arguments | Next: other tool | Next succeeded | Same again |
| --------------------------- | --- | ------------------------------ | ---------------- | -------------- | ---------- |
| Approval, policy or refusal | 302 | 160                            | 135              | 180            | 103        |
| Command lint, not run       | 113 | 64                             | 46               | 85             | 10         |
| Edit did not apply          | 82  | 8                              | 73               | 62             | 10         |
| File or path not found      | 75  | 45                             | 28               | 66             | 3          |
| Argument validation         | 45  | 41                             | 3                | 25             | 17         |
| Create on an existing file  | 45  | 3                              | 42               | 40             | 0          |
| PowerShell parser error     | 42  | 32                             | 10               | 38             | 0          |
| Command timed out           | 16  | 15                             | 1                | 13             | 0          |

### 4.1 Wrong tool name, or a tool from another product

- IDE: the model gets point 25, which calls a wrong name "arguments were invalid". No list, no alias. (V)
- CLI: point 46, then the invalid-round guard (48). The only alias is the checklist tool (`tools/index.tsx:239`). (V)
- Data: 23 calls used the CLI's names in IDE sessions (`Read` 11, `List` 4, `Bash` 4, four others once). Some may be fixtures. (R)
- Tracked as H16 for the CLI list. The IDE half and the alias are not tracked.

### 4.2 Arguments as a string, or an array sent as a string (upstream 13350)

- **The fork has the bug.** `coerceArgsToSchema` (`core/tools/parseArgs.ts:34-63`) only turns an object into a string for string-typed parameters. Nothing turns a string into an array, boolean or number. (V)
- The CLI passes MCP arguments through untouched (`extensions/cli/src/tools/index.tsx:316-322`) and checks only that required top-level keys exist (`:413`). (V)
- A string-to-type coercer exists: `packages/openai-adapters/src/dialects/schemaCheck.ts:61`, `:102` (Q16). Only the text-recovery dialects import it. (V)
- The CLI repairs one case by hand: `items` as a string in the task list (`tools/taskList.ts:20-27`). (V)
- Data: 45 argument failures, 17 followed by another. 4 calls had arguments that do not parse as JSON. (V)
- This is a mechanical fix, not a guidance line. Not tracked.

### 4.3 Edit tools failing to match

- Core's not-found text (18) is good: it shows the closest region and the first differing line. It was 14 of 82 failures. (V)
- The IDE's apply failure (33) was 67 of 82. It names no cause. (V)
- After an edit failure, following the same file: re-read then edit 27 (9 succeeded), edit with no re-read 19 (4 succeeded), full-file write 13 (9 with no re-read), re-read only 5, nothing more 18. (V)
- So the "read it again" advice was taken in about half the cases, and the re-read alone did not make the next edit work. The model needs the cause.
- Silent recoveries: a trimmed, case-insensitive or whitespace-ignored match is applied without a note (`core/edit/searchAndReplace/findSearchMatch.ts:304-307`, `performReplace.ts:184-191`). Tracked as Q19.
- `usage-review-2026-11-21.md` shows the race fix cut `multi_edit` errors from 32% to 6%. The 67 here cover a longer window and may be mostly before that fix. (R)

### 4.4 Full-file overwrite when an edit has no anchors (upstream 13307)

- **The fork has the bug in the IDE.** `gui/src/util/clientTools/editImpl.ts:16-20`, `:48-54` passes `changes` to apply with no anchor check. `core/edit/lazy/deterministic.ts:155-167` diffs the whole file when the snippet has no marker; the only brake is a 30% removed-lines limit (`:101-108`). (V)
- Tracked as E3 (U6): "open in the IDE".
- Related, from 4.3: 13 full-file writes after a failed edit. No guidance line says not to.

### 4.5 A JSON value where text was expected (upstream 13362, 13363)

- **The fork has both.** 13363: `getStringArg` writes compact `JSON.stringify(value)` (`core/tools/parseArgs.ts:84`), used by `core/tools/implementations/createNewFile.ts:44`, so a JSON file lands on one line. Tests pin the compact form (`parseArgs.vitest.ts:149-180`). (V)
- 13362: the preview interpolates the object (`gui/src/pages/gui/ToolCallDiv/FunctionSpecificToolCallDiv.tsx:25`, `CreateFile.tsx:15`). (V, delegated read)
- The CLI throws "New file content must be a string" (`extensions/cli/src/tools/writeFile.ts:70`). (V, delegated read)
- Mechanical. Not tracked.

### 4.6 Parallel fragments mixed up (upstream 13223) and calls with no id (13225)

- 13223: **fixed.** The IDE matches deltas by index (`gui/src/redux/slices/sessionSlice.ts:169-175`; test `sessionSlice.test.ts:607`). The CLI keys by index (`streamChatResponse.helpers.ts:964-973`). Point 27 is the guidance for the case that slips through. (V)
- 13225: **the CLI has the bug.** A delta with no id and no mapped index is dropped with a log line (`helpers.ts:974-979`). No id is synthesised. The IDE gives the call an empty id and drops it from the next request (`gui/src/redux/util/constructMessages.ts:64-68`); `core/llm/normalizeTurns.ts:121-126` synthesises ids in outgoing history only. (V; whether the IDE runs such a call was not traced)
- The data has no call with an empty id. (V)
- Mentioned in `tool-dialect-reference.md` (F4, F10). No roadmap row.

### 4.7 The user turn pruned from a tool loop (upstream 13383)

- **Fixed in core** (`core/llm/countTokens.ts:665-695`; test `countTokens.pruning.vitest.ts:31`). Tracked as E2, shipped.
- The CLI does not use that code. `pruneLastMessage` (`extensions/cli/src/compaction.ts:207-232`) removes from the end and can remove a user message (`:227`). Its effect in a tool loop was not traced. (R)

### 4.8 Prose instead of a call, or a call written as text

- Leak nudge (5) on both surfaces; recovery behind a switch (Q5). (V)
- Act nudge (66): headless CLI only. The IDE has none. In an interactive session the person is there, so this may be intended. In the data, 17 of 19 bare "retry" or "continue" messages followed a turn that ended in text (`usage-review-2026-11-21.md` section 4). (R)
- Data: 3 turn-ending replies with call markup in text; 3 empty turn-ending replies. Small. (V)
- Empty reply: no model text on either surface. Tracked as NI6 (a line for the person).

### 4.9 A command that hangs, prints megabytes, or waits for input

- IDE: runaway stop (38), 2-minute kill (39), background (40). CLI: 180 s of silence (67), caps (70). Both tell the model. (V)
- No line names "waiting for input". A prompt for input shows as a timeout. Data: 16 timeouts, 13 next calls succeeded. (V)
- CLI non-zero exit (69) drops stdout when stderr exists, and a non-zero exit with empty stderr returns output with no exit code (`runTerminalCommand.ts:462`, `:476-488`). (V, delegated read)
- Data: 63 `read_file` results over 50 KB reached the model. The IDE read cap was not checked. (R)

### 4.10 A path outside the workspace

- Covered: points 17, 36 and 74. Data: 4 cases. No gap seen.

### 4.11 The wrong shell dialect on Windows

- Before the run: lint (14) and the shell hint (15). After: nothing; the model reads PowerShell's own error.
- Data: 113 lint refusals with 85 next calls succeeding; 42 parser errors and 11 command-not-found errors got past the lint, and 47 of those 53 next calls succeeded. (V)
- The reactive path works but costs a call each time. Tracked as H17 and UR4.

### 4.12 Retrying a refused action in variations

- The refusal texts say "do not retry … or reach the same result another way". The CLI adds a refusal cap.
- Data: 302 approval or policy results; 103 followed by the same class. 162 of them said the question cap was reached, so the model kept calling tools that need approval after being told no more would be held. (V)
- Audit: 20 denies; 12 followed by another deny within three decisions; none with identical arguments. (V)
- `stuck-calibration.md` 2.3 saw a "do not retry" result ignored over 70 times in one session. (R)
- A line does not fix this. The harness has to end the item. Partly tracked: RF7, UJ19.

### 4.13 Empty or cut-off response

- IDE: points 26 and 27 are specific and tested.
- **The CLI has neither.** A `JSON.parse` failure leaves `arguments` as `{}` (`helpers.ts:1004-1013`); the model sees only "Required parameter missing", and a tool with no required parameters runs with `{}`. The stored turn has `"{}"`, so the model cannot see what it sent. `finish_reason: length` produces a line for the person only (`stream/streamChatResponse.ts:249-257`). (V, delegated read)
- H16 tracks a prefix repair for one Bedrock case. The refusal and its text are not tracked.

### 4.14 Context overflow mid-loop

- No text for the model on either surface. The CLI throws to the person (`streamChatResponse.ts:449`, `:644`). After a compaction the CLI sends "continue" (83). (V)
- No proposal. S9 tracks a context-growth signal.

### 4.15 MCP failures in the CLI

- An MCP result is `JSON.stringify(result?.content)`; `isError` is ignored, so a failure arrives as a normal result (`extensions/cli/src/tools/index.tsx:322`). Core checks it (`core/tools/callTool.ts:127`). (V)
- Tracked as TR27.

## 5. Proposed wording

New or replacement lines. Each says what happened, what state was kept and what to do next.

| For                                          | Proposed text                                                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown tool (25, 46)                        | "There is no tool named X, so nothing was run. The tools you can call are: A, B, C. Call one of them."                                                                                          |
| IDE edit failure (33)                        | "X did not change F: CAUSE. Nothing was written. Read F again, then send the edit with old text copied from that read. Do not rewrite the whole file."                                          |
| Edit applied by a near match (Q19)           | "Applied. The old text matched after ignoring WHAT; the file now holds your new text."                                                                                                          |
| Wrong argument type, when repair is not safe | "P must be TYPE and you sent a string, so X was not run. Send P as TYPE, not as text in quotes."                                                                                                |
| CLI: arguments not valid JSON                | Use core's lines 26 and 27 as they are.                                                                                                                                                         |
| Person declined, no timer (29, 56)           | "The person declined this call. Do not retry it or reach the same result another way. Do what else the request needs, or ask what they want instead."                                           |
| CLI `exclude` (58)                           | "X is excluded for this run, so it was not run. Do not retry it or reach the same result another way. Do what else the request needs, then say what you could not do."                          |
| Question cap (9), final time                 | "No more calls will be held for approval in this item. Stop calling tools that need approval. Finish what needs none, then call finish_item with outcome waiting and name what needs approval." |
| Shell rejected the command after it ran      | "PowerShell rejected this as a syntax error, so nothing ran. This shell is not bash. Rewrite the command in PowerShell."                                                                        |
| Signing failure (UR6)                        | "Signing failed. A hardware key counts wrong PINs and locks. Do not sign again. Tell the person and stop."                                                                                      |
| CLI non-zero exit (69)                       | "Exit code N." then stdout and stderr under the same cap. No advice line.                                                                                                                       |

Remove or merge:

- **"Please try something else or request further instructions."** (24, 25). It adds about 12 tokens to every IDE failure and names no next step. Remove it where the error already says what to do; keep nothing in its place.
- **Three copies of the carry-on tail**: `core/tools/toolListHold.ts:140`, `core/util/web/outcomes.ts:120`, `gui/src/redux/thunks/evaluateToolPolicies.ts:446`. One export from core. The CLI's "Do not retry it…" (57) should use it too.
- **The four-line skip text** (29). Replace with the declined line above.
- **"Premature Close"** (28). Fold into line 27; it is the same event with a worse name.
- **"You might want to check the path and try again."** (37). Replace with what the CLI's bench oracle does: name the nearest existing paths, or say nothing.
- Keep the turn tail. It is measured (`model-benchmark.md` 10.1) and does not move the cached prefix.

Should be mechanical, not guidance:

- String to array, boolean or number on structured calls, using the existing schema coercer, with the repair noted on the call (4.2).
- An alias for the other surface's tool names, only where the parameters map one to one (4.1).
- Pretty-printed JSON when `contents` arrives as an object, and a preview that renders it (4.5).
- A synthesised id for an id-less streamed call in the CLI (4.6).
- Refusing an unanchored `changes` payload (4.4; tracked as E3).
- Ending a loop item at the question cap instead of answering each further call (4.12).
- The exit code in every CLI command result (4.9).

Rules for any new line, from the plans (R): a note goes on the newest result only and is never added to an older one (`stuck-detection.md`, "Cost and the cache"); it carries information the model lacks (`stuck-calibration.md` 7); it never tries to talk a refusing model round (`research/loop-refusal-detection.md` 6).

## 6. Measurement

What exists (V):

- `core/llm/prompts/evaluation/` (`npm run eval:turns` in `core/`): a fixed conversation, one next reply scored against a bar. Five scenarios, one of them `act-after-refusal`. Stub and live modes, `--runs N`, `--profile`.
- `core/edit/searchAndReplace/editFailureCorpus.ts`: 14 synthesised edit failures.
- `core/llm/toolDialects/corpus/`: the text-call corpus. `bench/rq7/scan.mjs` scans replies with no model.
- `bench/runner.mjs` and `score.mjs`: live scenarios through `cn serve`; `stuck-decoy.json`; Wilson intervals in `bench/src/wilson.mjs`; sample sizes in `bench/src/sampleSize.mjs`.
- `eval/` holds only a `.gitignore`.
- Nothing loads a recorded failure and scores the next call.

Proposal: a guidance replay built on `eval:turns`.

- **A case** is a short history that ends in a failed tool result, plus a small scripted project so the next call can be run against it. One case per failure class and tool. Cases are synthesised, or taken from bench runs (I40 for edits, ENV40 for commands). No text from private sessions enters the corpus; the local data supplies shapes and rates only.
- **Arms** are the text of the last result: today's wording, the proposed wording, and for stuck notes, no note.
- **The metric**, per model family: did the next call change (other tool or other arguments), was it valid, and did it succeed against the scripted project. Also: did it fail in the same class again, and tokens added by the line.
- **Statistics**: the arms share cases, so use the paired test in `bench/lab/lib` and Wilson intervals. Under 10 per arm is screening. A wording becomes the default at 33 per arm for a 0.3 lift (RQ10).
- **The free baseline** is section 4's table. It should be a command, not a script: add "next call after a failure, by class" to UR7's problems view.
- **A cache check**: the prompt-segment golden files must show the same prefix with and without a line.

Start with three classes where the data shows a problem: IDE edit failure (9 of 27 succeed after a re-read), question cap (103 of 302 repeat) and unknown tool.

## 7. Upstream issues, in one place

| Issue | Verdict                                   | Evidence                                                                                |
| ----- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| 13350 | Has the bug                               | `core/tools/parseArgs.ts:34-63`; `extensions/cli/src/tools/index.tsx:316-322`           |
| 13307 | Has the bug in the IDE; tracked as E3     | `gui/src/util/clientTools/editImpl.ts:48-54`; `core/edit/lazy/deterministic.ts:155-167` |
| 13362 | Has the bug                               | `gui/src/pages/gui/ToolCallDiv/FunctionSpecificToolCallDiv.tsx:25`                      |
| 13363 | Has the bug in the IDE; the CLI throws    | `core/tools/parseArgs.ts:84`; `core/tools/implementations/createNewFile.ts:44`          |
| 13223 | Fixed                                     | `gui/src/redux/slices/sessionSlice.ts:169-175`                                          |
| 13225 | Has the bug in the CLI; partly in the IDE | `extensions/cli/src/stream/streamChatResponse.helpers.ts:974-979`                       |
| 13383 | Fixed in core; the CLI path not traced    | `core/llm/countTokens.ts:665-695`; `extensions/cli/src/compaction.ts:207-232`           |

`plans/research/user-use-cases-2026-11-21.md` (untracked, another session's work) also lists these issues. I did not reconcile with it.

## 8. Not understood, not checked

- Whether the 23 calls with CLI tool names are real wrong-name calls or test fixtures.
- Whether the 67 "Failed to edit" results are mostly from before the race fix in 2.38.3.
- Whether the IDE runs a streamed call that has no id.
- Whether the CLI's `pruneLastMessage` can drop the user turn inside a tool loop.
- The IDE wrapper's own text (`defaultSystemMessages.ts`) and the reasons the policy engine passes into refusals were not read line by line.
- Any family but Qwen. Every rate here may be different on another model.
- EV and ENV were searched for overlaps, not read in full.

## 9. Proposed rows

Track **AG** ("agent guidance") is a placeholder. Ids are placeholders.

| ID   | Scope                                                                                                                                                                                         | Size | Needs                       | Acceptance                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AG1  | Guidance replay on `eval:turns`: a case format (history ending in a failed result, a scripted project), arms by result text, and the metric "next call changed, valid, succeeded", per family | M    | I36 for the bench arm; RQ10 | Three classes (IDE edit failure, question cap, unknown tool) run in stub mode in CI and live on one local model; a report with Wilson intervals                   |
| AG2  | Coerce a string to the schema's array, boolean or number on structured calls in core and the CLI, with the existing schema coercer; the call records the repair (upstream 13350)              | S    | none                        | A `multi_edit` whose `edits` is a JSON string runs; an MCP call with `"true"` for a boolean runs; a string-typed parameter is never changed; one test per surface |
| AG3  | The IDE's apply failure says the cause and what was kept, and tells the model not to rewrite the file                                                                                         | S    | UR2                         | A fixture with a failed apply yields a result naming the cause; AG1 shows the edit-after-re-read rate above today's 9 of 27                                       |
| AG4  | Unknown tool: one text in core that lists the offered tools, used by both surfaces; an alias for the other surface's names where the parameters map                                           | S    | H16 (the CLI half)          | `Read` in the IDE and `read_file` in the CLI either run or return the list; the IDE no longer calls a wrong name "invalid arguments"                              |
| AG5  | The CLI refuses a call whose arguments did not parse, with core's truncated and incomplete lines, and keeps the raw text in the stored turn                                                   | S    | none                        | A stream cut at the output limit yields the "cut off" line; no tool runs with `{}` after a parse failure                                                          |
| AG6  | One refusal module in core: the carry-on tail, the declined line and the exclude line; the IDE's and CLI's copies removed; the generic "Please try something else" tail removed               | S    | UJ11, UJ12                  | One export; a snapshot test of every refusal sentence; no result ends in the generic tail                                                                         |
| AG7  | At the loop's question cap the harness ends the item as waiting instead of answering each further call                                                                                        | S    | RF7                         | A scripted item that keeps calling a held tool ends after the cap with one result; the audit shows no run of cap results                                          |
| AG8  | `create_new_file` writes pretty-printed JSON when `contents` is an object, and the preview renders it (upstream 13362, 13363)                                                                 | S    | none                        | A test with object `contents`; the preview shows text                                                                                                             |
| AG9  | The CLI synthesises an id for a streamed call that has an index and no id (upstream 13225)                                                                                                    | S    | none                        | A stream with id-less deltas yields one call that runs and pairs with its result                                                                                  |
| AG10 | Every CLI command result carries the exit code, and stdout is kept beside stderr under one cap                                                                                                | S    | none                        | Non-zero exit with empty stderr shows the code; a failing test run shows its stdout                                                                               |
| AG11 | Tests for the untested wordings: 10 shared, 15 IDE-only, 6 CLI-only                                                                                                                           | M    | AG6                         | Each point in section 3 has a test that names it                                                                                                                  |
| AG12 | "Next call after a failure, by class" in the problems view                                                                                                                                    | S    | UR7, UR2, UR3               | Section 4's table comes out of one command on a fixture                                                                                                           |

Already tracked, not proposed again: stuck notes in the IDE (S12), the step-by-step move of guards into core (PAR11), the signing line (UR6), the unanchored edit (E3), the near-match note and a syntax check after an edit (Q19), the tool list in the CLI's not-found result and the prefix repair (H16), the Windows shell tax (H17), launcher payload lint (UR4), the empty-reply line (NI6), MCP `isError` and caps in the CLI (TR27), the refusal reason reaching the model (UJ12), headless refusal clarity (UJ19), recorded edit failures (I40).
