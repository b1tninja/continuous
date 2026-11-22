# Research: a review of the policy and sandbox area

Date: 2026-11-21. Code read at `main` 01dc47fce (tags up to `v2.38.5-vscode`). Nothing was built, run or changed. `plans/ROADMAP.md` is not touched; section 6 proposes rows and does not apply them.

## 1. What this note is

A check of what the product ships for tool permissions (locks, protections, rules, levels, the reviewer), command analysis and lint, and running agent commands somewhere confined. It asks three things: does the code match what the roadmap rows say, where is the area weak or unfinished, and what do comparable agents do that we could take.

Evidence marks:

- **V**: read in the code at the commit above, with the file and line.
- **R**: read in a plan, a research note or an outside source only.

## 2. Inputs and limits

Inputs:

- `plans/ROADMAP.md`: the headings, "How to use this file", and tracks B, H, P, R, W, SB, X, CO and UR. PAR and DS were read too, because they hold the IDE and CLI rows.
- Plans and notes: `research/os-sandbox-for-agent-commands.md` and `research/usage-review-2026-11-21.md` in full; the others named in the task by their summaries, state tables and proposed rows.
- Code: `core/tools/permissions/`, `core/util/` (executor, container, sandbox, egress, probes), `core/core.ts`, `extensions/cli/src/permissions/`, `extensions/cli/src/stream/streamChatResponse.helpers.ts`, `extensions/cli/src/subagent/`, `gui/src/redux/thunks/`, `extensions/vscode/src/extension/`.
- `gh` for the state of the pull requests the rows cite, and for the five upstream reports.
- Vendor pages fetched on 2026-11-21 (section 5).

Limits:

- **Read, not run.** No test, probe or command was run against the product. A finding marked V means the code says so, not that the behaviour was reproduced.
- **Tracks B and X have about 290 KB of row text.** Each row was read to its first 380 characters and its state. A detail deep in a long row may have been missed.
- **The long plans (about 885 KB) were not read in full.** A design point may already be written there. Every proposed row was searched for in `ROADMAP.md` and `plans/research/` first.
- **Windows host only.** Nothing here was checked on macOS or Linux.
- **Peer facts are from the vendor's own page on one day.** A page that was cut off by the fetch is said so.

## 3. Summary

| #   | Finding                                                                                                              | Evidence | Tracked?                              |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------- |
| 1   | The roadmap is eight days and about 390 commits behind the code in this area; at least 20 row states are wrong       | V        | No (CO20 lints shape, not state)      |
| 2   | Since 2.16.2 IDGAF runs every call, locks and Never rules included; the vocabulary table and the W invariants say no | V        | Partly (B99 says "Proposed"; DS16)    |
| 3   | Nothing is confined on any OS: no sandbox executor, the egress proxy and the prompt-skip have no caller              | V        | W4b, W6, W8c, W7h                     |
| 4   | IDE Loop checks run with `child_process.exec` on the host, outside the executor, the env scrub and the audit         | V        | No                                    |
| 5   | The webview can ask the extension host to run any command text (`subprocess`); the only check is its own             | V        | Partly (PAR8 names `tools/call` only) |
| 6   | Core runs a `tools/call` without checking that a decision exists; levels and base policy come from the webview       | V        | PAR8, PAR5, DS7                       |
| 7   | The terminal UI shows no reason for most engine asks                                                                 | V        | No                                    |
| 8   | A broken `permissions.yaml` stops a headless run, but the TUI and the IDE go on at the defaults                      | V        | Partly (B23 for the page)             |
| 9   | In a remote window a `container` or `wsl` setting is not applied and nothing says so                                 | V        | Partly (SH2, EV42)                    |
| 10  | The container executor mounts the whole workspace read-write, `.git/hooks` and `.vscode` included                    | V        | No (W7 records the probe result)      |
| 11  | CLI "always allow" still saves a bare tool name for file and MCP tools, and a dead rule for a chained command        | V        | DS4, B97                              |
| 12  | With `plan.allowTerminal` on, the CLI has no hold like the IDE's `holdInPlanMode`                                    | R        | Partly (PAR5, P6)                     |
| 13  | Escape probes are bash only and their results are stored nowhere, so "Confined (with a date)" has nothing to read    | V        | W7h, W4c, W29                         |
| 14  | Upstream reports: four of five do not affect the fork; `npx -y mcp-remote` does                                      | V        | PL16, UJ7                             |

## 4. Findings by area

### 4.1 Roadmap rows whose state looks wrong (V)

The file says "Last updated: 2026-11-13". `git log --since=2026-11-13 --no-merges` has 394 commits. Rows found wrong by reading the code or `gh pr view`:

| Row                  | Roadmap says                 | Code or PR says                                                                                               |
| -------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| B99                  | Proposed                     | Built: `d5995cd5b`, `core/tools/permissions/idgafRunsEverything.vitest.ts`                                    |
| B89, H23             | Not started                  | Moot: `IDGAF_NO_ASK_REASON` and `noAskAtIdgaf` are no longer in the code; IDGAF refuses nothing               |
| B92                  | Not started                  | Built: `9941fb1e7`, `b7ed1637e`, `taint/secretEgress.vitest.ts`                                               |
| B55, B56             | "#625 (draft)"               | #625 merged 2026-11-18; `builtinExemptions.ts`                                                                |
| B69, B70, B75        | Not started                  | Built in part: `b72e74680`, `audit/auditIndex.ts`, `audit/auditOverview.ts`                                   |
| B102                 | Proposed                     | Built in part: `1291740be`, `227db6dac`, `customPolicy.ts`                                                    |
| B18                  | PowerShell profiles open     | Built: `9941fb1e7`                                                                                            |
| CO2                  | "PR #896 open"               | Merged 2026-11-15; `extensions/cli/src/permissions/defaultPolicies.ts:43-50`                                  |
| CO6, CO8, CO17, DS11 | "PR #755 open"               | Merged 2026-11-13                                                                                             |
| CO14                 | Not started                  | Built: `5fa7d3b3a`, `hooks/claudeSettingsOptIn.test.ts`                                                       |
| PAR6, PAR7, PAR17    | "PR #787 open"               | Merged 2026-11-13                                                                                             |
| W17                  | "PR #738 open"               | Merged 2026-11-13                                                                                             |
| DS9                  | "PR #758 open (draft)"       | #758 closed; `4e2cb4efa` did the same thing another way                                                       |
| X12                  | Not started                  | Built in part: `227db6dac` (native confirmation for loosening saves)                                          |
| X24                  | Not started                  | Built: `cecaed77e`                                                                                            |
| X32, X34             | Proposed                     | Built in part: `189d45f7b` (`secret` label), `f88991d36` (per-server labels, `/untaint`), `7138c9b06` (audit) |
| X20, X22             | Not started                  | Built in part: `ad7dc8434` (one hidden-character set)                                                         |
| W7                   | `scripts/runEscapeProbes.ts` | The file is `extensions/cli/scripts/runEscapeProbes.ts`                                                       |
| W8c                  | "the sandbox skip as built"  | `sandboxAutoApproval` has no caller outside its own file; it skips nothing today                              |

Rows checked and found right: W0 (still no `toHostPath`, no properties), W1, W2, W4a, W4b (not started), W6 (pure code, not wired), W27 and W28 (`core/util/commandSpawn.sites.vitest.ts`, `commandExecutor.ts:179-182`), W21 (still `-v`, `core/util/containerArgs.ts:76-77`), PAR8 (not started), B8a, B29, P12 (no hash chain), R0, R2 (still only `CONTINUE_COMMAND_LINT=off`, `commandLint.ts:469`), CO3.

Not in the roadmap at all: the decision timer (`decisionTimer.ts`, `holdProposal.ts`, eight commits on 2026-11-20) and the Web policy area's rows are under WB, outside the tracks read here.

### 4.2 IDGAF and the words (V)

`evaluateToolPolicyWithRules` at IDGAF returns allow with `source: "idgaf"` for a `floor:` rule, the policy-file lock, the run-time write lock and a Never rule, and records what would have objected in `idgafOverride` (`idgafRunsEverything.vitest.ts:59-98`). Picking the IDGAF preset also switches every check off (`safetyDegrees.ts:37-42`). The CLI lifts its own `ask` and `exclude` lists the same way (`coreRules.ts:577-590`).

The roadmap's vocabulary table still says of Locks: "always win; no rule, repository, model, sandbox or level turns one into a yes". The Track W invariants say a sandbox "never loosens a lock". B6 and B31 say "refused at Automatic and YOLO". These are no longer true at IDGAF.

Two consequences:

- At IDGAF the only bound left on a command is where it runs. Nothing confines it (4.4). So the sandbox executor is now the only thing that could make IDGAF bounded, which raises W4b.
- B94 (`disableIdgaf`) and B19a (an organisation cannot cap IDGAF) are the only ways to keep a lock a lock. Both are not started.

### 4.3 The IDE and the CLI decide in different places (V)

- **The webview is the enforcement point in the IDE.** `tools/evaluatePolicy` takes `approval` (the levels, the checks, the floor) and `basePolicy` from the message (`core/core.ts:2682-2760`). `handleToolCall` then runs any `tools/call` with the comment "A call that reaches here was allowed, or asked and was approved" (`core/core.ts:2912-2914`); it does not look for a decision. `allowOutsideWorkspace` and `allowSecretFiles` are flags on the same message. Tracked as PAR8, PAR5 and DS7, all not started.
- **`subprocess` is a second way in.** `VsCodeMessenger.ts:391-403` accepts a `subprocess` message from the webview when the command is a non-empty string and `cwd` is inside the workspace (`webviewMessageGuard.ts:56-65`), then calls `child_process.exec(command, { cwd })` (`VsCodeIde.ts:720-730`). The command text is not checked by core. PAR8's wording covers `tools/call` only.
- **IDE Loop checks use that path.** `gui/src/redux/thunks/loopChecks.ts:144` runs a plan's `check:` command through `ide.subprocess`. The policy is evaluated in the webview first (`:75-103`), and with the shell of the executor. But the command then runs under `exec`'s default shell (`cmd.exe` on Windows, `/bin/sh` elsewhere), on the host, with the extension host's whole environment. It skips: the `container` or `wsl` setting, the fail-closed `unavailable` rule, the secret-name scrub (`terminalEnvironment`), the command lint, and the audit outcome. The timeout is a `Promise.race`; the process is not killed. The CLI's Loop checks were moved to the executor (`extensions/cli/src/loop/loopChecks.ts:113-133`), and `commandSpawn.sites.vitest.ts` guards four files, none of them this one.
- **A broken policy file.** Headless refuses to start with exit 2 (`extensions/cli/src/util/configFileGate.ts:66-80`, called from `commands/chat.ts:407` and `serve.ts`). The TUI prints a notice and loads no CLI rules (`permissionsYamlLoader.ts:85-88`). Core returns the defaults and a notice (`core/tools/permissions/settingsFile.ts:131-147`, `:567-577`). The defaults are the Careful preset, so the person's `floor:` entries, their stricter levels and their CLI `exclude` rules are gone until the file is fixed. B23 covers showing the error on the page; it does not change what runs.
- **Plan mode.** The IDE holds any call that would run without asking in Plan mode unless it is read-only (`gui/src/redux/thunks/evaluateToolPolicies.ts:87-116`). The engine has no such step (the string `plan-mode` is only in `testToolCall.ts` and the GUI). The CLI drops the terminal in Plan mode (`tools/roleGate.ts:93`, `core/tools/roleTools.ts:187-189`), so the gap opens only when `plan.allowTerminal` is on: then Plan mode's `Bash: ask` goes to the engine with the person's ordinary levels (`streamChatResponse.helpers.ts:587-603`), and an allow from a level or a rule is taken (`:816-818`). Not reproduced; marked R.

### 4.4 Where commands run, and what "Confined" rests on (V)

- **Executor kinds are `local`, `wsl` and `container`** (`core/util/commandExecutor.ts:35`). There is no sandbox kind. `@anthropic-ai/sandbox-runtime` is not a dependency; `srtStatus.ts` only detects it. `continuous sandbox status` ends with "Nothing is sandboxed yet" (`extensions/cli/src/commands/sandbox.ts:103`).
- **Built and not connected:** `compileSandboxConfig` (called only by the status command), `sandboxAutoApproval` (no caller), `egressPolicy.ts` and `egressProxy.ts` (no caller outside tests), `escapeProbes.ts` and `escapeProbeRunner.ts` (called by one dev script).
- **Unavailable fails closed, for the places that exist.** A missing WSL distribution or container runtime makes the executor `unavailable`, and the tools return that text without running anything (`core/tools/implementations/runTerminalCommand.ts:197-202`, `extensions/cli/src/tools/runTerminalCommand.ts:120`, `loop/loopChecks.ts:119`). The setting is machine-scoped in VS Code (`extensions/vscode/package.json:173`), so a workspace file cannot turn it off.
- **Remote windows are outside all of it.** When `remoteName` is not local, the command goes to the editor's terminal (`runTerminalCommand.ts:191-196`, `:822`). The `container` or `wsl` setting is not applied, the environment is not scrubbed, and no line tells the person. The OS-sandbox note lists this under "do not claim"; no row makes the tool say it.
- **The container is not clean for host-executed files.** One bind mount, the workspace, read-write (`containerArgs.ts:76-77`). A command inside can write `.git/hooks`, `.git/config`, `.vscode/tasks.json` or `.devcontainer`, which the host later runs. W7 records the failed probe; no row fixes the mount.
- **Per OS, what a "Confined" claim could rest on today:**

| OS      | Backend that exists                  | Probes                                                | Verdict                                  |
| ------- | ------------------------------------ | ----------------------------------------------------- | ---------------------------------------- |
| Windows | WSL (a shell, not a jail); container | Bash scripts only; no PowerShell probe (W29 proposed) | Nothing to verify on the native host     |
| Linux   | Container                            | 22 bash probes, run by hand                           | Fails `host-executed-files` (R, from W7) |
| macOS   | Container                            | Not run (R)                                           | Unknown                                  |

No probe result is stored. The strings "Confined", "not confined" and `IsolationProperties` do not occur in `core`, `gui`, the CLI or `docs`. The vocabulary row is a plan with no code behind it yet (W7h, W4c).

### 4.5 Rules that match more or less than the person meant (V)

- **Chained commands are handled.** A CLI prefix allow covers a command only when every segment matches and the text hides no substitution or redirect (`permissionChecker.ts:72-149`, `:270-281`). Core does the same by shell (`allowGrammar.vitest.ts`).
- **CLI "always allow" is still coarse.** `generatePolicyRule` returns the bare tool name for every tool but Bash and Fetch (`policyWriter.ts:21-39`), so one "always" on a `Write` allows every later write, and one on an MCP tool allows that tool with any arguments. For Bash it saves the exact text: a chained command becomes a rule that can never match (each segment is tested against the whole text), and a command with `*` or `?` in it becomes a glob. The IDE's `suggestAllowRule` refuses these cases (`core/tools/permissions/suggest.ts:93-123`). Tracked as DS4 and B97, both not started.
- **A user-level PreToolUse hook's `allow` turns a CLI ask into an allow before the engine runs** (`streamChatResponse.helpers.ts:729-737`, `:803`). At the default levels with no rules the engine then only tightens for a deny, a floor or a protected path (`coreRules.ts:597-621`). This is the decided design (D3a); it is noted because the audit record does not yet say a hook allowed the call (D17, not started).
- **Read-only actions that ask** and **lint on a launcher's payload** are UR5 and UR4. Nothing to add.

### 4.6 Subagents and MCP (V)

- **CLI subagents never get more than the parent.** `subagentPermissions` keeps the parent's policies in order, turns `ask` into `exclude` when nobody can be asked, and ends with `*: ask` or `*: exclude` (`extensions/cli/src/subagent/permissions.ts:43-70`). A change the parent makes during the run is re-derived (`executor.ts:230-268`).
- **IDE subagents call the same `evaluateToolPolicy` as the parent** (`gui/src/util/subagents/runSubagent.ts:657-712`). Their outcomes are missing from the audit (UR2).
- **MCP.** Tool and launch definitions are pinned and a change asks (`mcpDefinitionChange`, `coreRules.ts:375-377`). A server's `readOnlyHint` is believed only for a server the person marked trusted (`core/context/mcp/mcpTrust.ts:44-53`). Path arguments under unlisted names are B77.

### 4.7 How a person learns why, and fixes it

- **IDE:** the decision carries `source`, `reason` and the rule, and the blocked call names the check that owns it (`checkOfProtection.ts`). The one-step fix on offer is to switch that check off, which is the widest fix. DS16 already notes the hint "coaches a loosening".
- **CLI (V):** the prompt gets the engine's reason only when the source is `shell-hint` or the text contains "This looks like" (`streamChatResponse.helpers.ts:851-857`). `ToolPermissionSelector.tsx` has no reason line. So an ask from a protected path, an ask rule, a taint label or a floor looks the same as an ordinary ask. The audit has the reason; the person does not see it at the moment they decide.
- **Both:** `continuous permissions test` and the page's tester answer "why" after the fact. Nothing at the prompt offers the narrowest rule that would stop this ask.

### 4.8 Upstream reports against the fork (V)

| Upstream       | Report                                                 | Fork                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #13461         | Invalid `permissions.yaml` read as no policy, headless | Not affected headless: `util/configFileGate.ts:64-80` exits 2. The TUI and IDE still go on at defaults (4.3)                                                                                                                                    |
| #13288         | `Bash(prefix*)` allow matches chained commands         | Not affected: `permissions/permissionChecker.ts:72-149`, `:270-281`. The "allow stands over the evaluator's ask" half remains by design (`:310-315`), and a `disabled` from the evaluator still wins                                            |
| #13289         | Subagent replaces permissions with allow-all           | Not affected: `subagent/permissions.ts:43-70`, `subagent/executor.ts:230-268`                                                                                                                                                                   |
| #13290         | Plan mode allows arbitrary shell; headless `*: allow`  | Not affected by default: `permissions/defaultPolicies.ts:60-82` (Bash asks), `tools/roleGate.ts:93` (terminal dropped unless `plan.allowTerminal`), `defaultPolicies.ts:43-50` (headless allow only under `CONTINUOUS_HEADLESS_LEGACY_ALLOW=1`) |
| #13453, #13429 | `npx -y mcp-remote`, no version pin                    | **Affected**: `extensions/cli/src/services/MCPService.ts:592-613`. Interactive only. Tracked as PL16 and UJ7                                                                                                                                    |

## 5. What peers do

Fetched 2026-11-21 unless marked. A claim marked R is from `research/os-sandbox-for-agent-commands.md` (fetched 2026-11-13) and was not re-fetched.

**Claude Code** ([permissions](https://code.claude.com/docs/en/permissions), [permission modes](https://code.claude.com/docs/en/permission-modes), [sandboxing](https://code.claude.com/docs/en/sandboxing)):

- Modes: default, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. `permissions.denyInsteadOfPrompting` denies what would prompt, in any mode.
- A Bash allow rule needs every subcommand of a compound command to be allowed. Deny and ask rules apply when any subcommand matches, including inside a substitution. Approving a compound command saves "a separate rule for each subcommand".
- A fixed list of wrappers is stripped before matching (`timeout`, `nice`, `nohup` and others). The page says a deny rule "isn't a security boundary around the program".
- Auto mode: the classifier sees user messages and tool calls; "Tool results are stripped". It pauses after a block "3 times in a row or 20 times total". On entering auto mode, allow rules that grant arbitrary code execution (blanket `Bash(*)`, wildcarded interpreters, a wrapper plus a wildcard) are dropped and restored on leaving. A subagent's task is checked before it starts and its report after it ends.
- `bypassPermissions` still honours deny rules and explicit ask rules, and still stops recognised critical-path `rm`.
- Sandbox: Seatbelt on macOS, bubblewrap on Linux and WSL2, and "On native Windows, Claude Code runs commands unsandboxed". When unavailable it runs unsandboxed unless `sandbox.failIfUnavailable` is set. A failed command may be retried outside with `dangerouslyDisableSandbox`, which `allowUnsandboxedCommands: false` turns off. Allowed domains start empty. Hooks, local MCP servers and the file tools are outside the sandbox. The fetch cut the page before its security-limits section.

**Codex** ([approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)):

- Two axes: sandbox mode (`read-only`, `workspace-write`, `danger-full-access`) and approval policy (`on-request`, `never`, `granular`). `untrusted` is retired.
- Inside a writable workspace `.git`, `.agents`, `.codex` and `.aws` are read-only, recursively. Network is off by default.
- macOS Seatbelt, Linux `bwrap` plus `seccomp`, Windows MXC with "elevated and unelevated as legacy fallbacks".
- `approvals_reviewer = "auto_review"` sends requests that need approval to a reviewer agent; "Prompt-build, review-session, and parse failures fail closed".
- The page did not explain how execpolicy prefix rules match. Unsourced here: anything about `justification`, `match` and `not_match` in B93 is from an earlier note (R).

**Cursor** ([run modes](https://cursor.com/docs/agent/security/run-modes)):

- Modes: Auto-review (the default), Allowlist, Run Everything. Ask Every Time was removed in 3.5.
- Sandbox: Seatbelt on macOS; Landlock plus seccomp on Linux (kernel 6.2 or later), else it asks. The page names no Windows mechanism.
- Protected inside the workspace: `.git/config`, `.git/hooks`, `.vscode`, `.cursorignore`. Network "Blocked by default", with a default allowlist of package registries.
- A command that fails on a sandbox restriction can be rerun outside; the classifier reviews the rerun. The page says "Auto-review is not a security boundary".

**VS Code** ([agent sandboxing](https://code.visualstudio.com/docs/agents/run/agent-sandboxing)):

- macOS 15 or later; bubblewrap and `slirp4netns` on glibc Linux and WSL2; Windows 11 BaseContainer, marked Experimental.
- Off by default. Outbound network is allowed by default. "commands don't silently run without sandboxing" when a dependency is missing.
- "Allow all" does not turn an enabled sandbox off. Managed MCP and language servers are sandboxed by default.
- A path-access prompt offers the scopes session, workspace, user or skip. `credentials.envVars` gives tools placeholders and injects real values only for listed hosts.

**Gemini CLI** ([sandbox](https://geminicli.com/docs/cli/sandbox/)):

- Off unless enabled. Seatbelt profiles on macOS (default `permissive-open`: writes confined, reads and network open); Docker, Podman, gVisor or LXC elsewhere; on Windows `icacls` sets a "Low Mandatory Level" on folders, and the change persists.
- The page did not say what YOLO mode does to the sandbox.

What we already do better (V in our code, compared with the pages above):

- **Unavailable fails closed by default.** Claude Code's default is to run unsandboxed.
- **Rules are read by the shell that will run the command**, PowerShell and cmd included, and no allow rule applies when the shell is unknown. The peers' pages describe POSIX matching plus, for Claude Code, a PowerShell AST.
- **Only the person's own config can add an allow rule** (B6), and reviewer guidance from a repository is ignored (B5). Cursor reads `permissions.json` and `sandbox.json` from the project, with the project's `sandbox.json` taking priority.
- **An audit trail of every decision**, with what IDGAF ran past.
- **MCP tool and launch pinning**, and `readOnlyHint` believed only from a trusted server.
- **A deterministic handler after the reviewer** (B84) and an injection pre-filter before it (B34).

What we could adopt:

- **A sandbox at all.** Every peer has one on macOS and Linux. We have the compiler, the proxy and the probes, and no executor (W4b).
- **Pause broad allow rules while a reviewer decides** (Claude Code auto mode). Not tracked; PS8.
- **Protected sub-paths inside the writable workspace** for the container we already ship (Codex, Cursor, Claude Code all do). PS7.
- **One rule per subcommand when a compound command is approved** (Claude Code). Tracked as B97 and DS4.
- **Scoped grants for a sandbox denial** (VS Code). Tracked as GAP23.
- **Credential placeholders injected per host by the proxy** (VS Code). Tracked as GAP24.
- **A check of a subagent's task before it starts and its report after** (Claude Code). Not proposed here: it is a second reviewer job, and H10 was parked for that reason.

## 6. Proposed rows

Placeholders. Each was searched for in `ROADMAP.md` and `plans/research/`; the Needs column names the nearest existing row.

| ID   | Scope                                                                                                                                                                                                                                                       | Size   | Needs             | Acceptance                                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PS1  | State sweep of tracks B, H, W, X, CO, PAR and DS against the table in 4.1, and a check in the roadmap lint (CO20) that a row saying "PR #n open" or "draft" matches `gh pr view`                                                                            | S      | CO20              | The lint, run with network, reports no row whose cited pull request is merged or closed; the 4.1 rows are corrected in the same PR                                                                                                                                    |
| PS2  | IDE Loop checks start through the command executor in core (a core message that returns exit code and output), not `ide.subprocess`; the timeout kills the process tree; the outcome is audited                                                             | S to M | W27 (done)        | With `terminal.shell: container` and no runtime, an IDE Loop check returns the `unavailable` text and starts no process; a test shows a secret-named variable is absent from the check's environment; `commandSpawn.sites.vitest.ts` lists the GUI file's replacement |
| PS3  | The webview may not send `subprocess` or `runCommand` with free text: remove them from the webview protocol once PS2 lands, or require the id of a recorded decision. Extends PAR8 to these two messages                                                    | S      | PS2, PAR8         | A `subprocess` message from the webview with no recorded decision is refused and written to the audit trail; a guard test per message                                                                                                                                 |
| PS4  | The terminal prompt shows why: the engine's reason, the source (rule text and file, or the check id) on every ask, and one key that previews the narrowest rule that would stop this ask (core's `suggestAllowRule`, as DS4 needs)                          | S      | DS4               | An ink test renders the reason for a protected-path ask, an ask rule and a taint ask; the preview equals the IDE's suggestion for the same call                                                                                                                       |
| PS5  | A policy file that exists and does not load, outside headless: the TUI and the IDE run at "ask for everything" (tool areas Manual, every check on) with a banner and "open file", not at the defaults                                                       | S      | B23, owner        | With a malformed `permissions.yaml`, a read-only command that the defaults would run asks in both products; fixing the file restores the levels without a restart; one test per surface                                                                               |
| PS6  | Words after IDGAF-records: the vocabulary row for Locks, the Track W invariants, the B6 and B31 texts and the docs say that IDGAF runs and records; B99, B89 and H23 are closed; B91's matrix gets the IDGAF column as "runs, recorded"                     | S      | owner, B91, DS16  | A docs lint finds no sentence saying a lock holds at every level; the golden matrix asserts `source: "idgaf"` with `idgafOverride` for each lock                                                                                                                      |
| PS7  | Container executor: `.git/hooks`, `.git/config`, `.vscode`, `.idea`, `.devcontainer` and the rest of the `protect-config` list are mounted read-only over the read-write workspace mount; a path that does not exist is not created                         | S      | W21               | `containerExecutor.vitest.ts` asserts the mounts; the `host-files.writable` probe passes through the container on a Linux runner; `git commit` still works inside                                                                                                     |
| PS8  | While a reviewer decides (Automatic), allow rules that hand over arbitrary execution are paused and shown as paused: a bare terminal rule, an interpreter with a wildcard, a wrapper or launcher followed only by a wildcard. Restored on leaving the level | M      | B8, SH7           | A table test of 12 rules (6 paused, 6 kept); the Permissions page and `continuous permissions list` mark them; a paused rule's command reaches the reviewer in a handler test                                                                                         |
| PS9  | Remote window with a non-default `terminal.shell`: the tool does not run the command and says the setting does not apply in a remote window, with the setting to change; the status line says where commands run                                            | S      | SH2 (independent) | A unit test with `remoteName: "ssh-remote"` and the `container` preference returns the refusal and calls `ide.runCommand` zero times                                                                                                                                  |
| PS10 | Plan-mode hold in the engine: a call that a level or an allow rule would run waits in Plan mode unless it is read-only, on every surface; the GUI's `holdInPlanMode` becomes a call into it. First slice of PAR5                                            | S      | PAR5              | A CLI test with `plan.allowTerminal`, Tool use at Permissive and `touch x` asks, and `git log` runs; the GUI expectations are unchanged                                                                                                                               |

Order: PS2 and PS3 first (a path around the policy and the executor), then PS1 and PS6 (so the next reader is not misled), then PS4, PS5, PS7, PS9, PS10, then PS8.

Not proposed, because tracked: core enforcing the decision (PAR8), argument hash (DS7), CLI "always allow" (DS4, B97), the sandbox executor and its probe table (W4b, W4c, W7h), Windows probes (W29), sandbox denial text (W25), `mcp-remote` (PL16, UJ7), read-only asks (UR5), launcher lint (UR4), webview tool outcomes (UR2), `disableIdgaf` (B94), sandbox grants (GAP23).

## 7. Not verified

- **Nothing was run.** Finding 12 (Plan mode with `plan.allowTerminal`) and the shell that `child_process.exec` picks for an IDE Loop check are read from the code and the Node documentation's known default, not observed.
- **JetBrains.** Whether its `subprocess` path has the same shape as VS Code's was not read.
- **A broken `config.yaml`** (as opposed to `permissions.yaml`) in a headless run: whether `toolPermissions` deny rules are lost silently was not traced.
- **macOS and Linux.** The container probe result is from the W7 row, not from a run.
- **The "Shipped" section of the roadmap** was not spot-checked row by row; only the tracks named above.
- **Peer pages cut by the fetch:** Claude Code's sandboxing page (the last 12,000 characters, which hold the security limits) and its permission-modes page (the last 22,000). Codex's Windows sandbox and execpolicy pages were not fetched today.
- **Whether a managed or organisation setting in any peer caps the bypass mode on Windows** was not looked up.
