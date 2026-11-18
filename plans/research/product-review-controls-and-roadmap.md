# Product review: controls, coherence and the roadmap

Date: 2026-11-12. Code reviewed at `origin/main` 729d912 (merge of #725). The document was written on 162ef6c5d; the commits between the two touch only research notes and the onboarding Local tab, and none of the findings below depend on them. Nothing was built or run: every finding comes from reading the code, the docs and `plans/`.

**Evidence marks.**

- **V**: I re-read the cited lines at 729d912.
- Unmarked: a read-only sweep traced the code and cited the lines. Line numbers can be a few lines off.
- **unverified**: not traced end to end.

Releases use even minors. 2.16.0 is being cut now, so "next release" in this document means **2.18.0**. Where other research notes say "2.15.0", "2.16.0 candidate", "2.17.0" or "2.19.0", this document reads them as 2.18.0 or later (section 3.4).

## Summary

The product has a strong safety core: five levels per area, protections that are always on, project trust, pins, an audit trail, and user-only `allow`. Around that core it has three kinds of debt.

1. **Defaults outside the core do not match the core.**
   - Headless runs (`-p`, `serve`) allow Bash and every unlisted tool.
   - `serve` runs a shell command from a repository file with no trust check.
   - An `--agent` file replaces the user's lists with a final `*: allow`.
   - The `git-ai` integration always runs a binary resolved through `PATH`.
2. **There is no single place that says why a control has its current value.** Five areas × five levels, presets, `--auto` / `--auto-review` / `--readonly` / `--policy`, `permissions.yaml`, `config.yaml`, globalContext, VS Code settings, about 45 environment variables and per-surface loop budgets combine into an effective policy that nobody can see whole. Only `doctor network` exists.
3. **Names and documents drift.**
   - "Auto" means three things.
   - YOLO is still in five docs pages.
   - `CONTINUE_*` and `CONTINUOUS_*` are mixed.
   - The JetBrains plugin is entirely upstream-branded.
   - Telemetry settings default to `true` and do nothing.
   - The ROADMAP has 834 rows in 38 tracks. 439 are not started, 155 have no state column at all, and no track table has an acceptance column.

The ten most important findings are in section 2.1. The proposed rows (track **CO**, an unused prefix on `main` and in every open research PR checked) are in section 6.

## 1. Control inventory

Who sets each control, in the "Who" column:

- **U**: user-level files only (`~/.continuous/...`).
- **P**: a project file can set it.
- **G**: GUI.
- **C**: CLI flag.
- **E**: environment variable.
- **–**: nobody (fixed in code).

"Docs" names the page, or says none. "Tests" names a test file, or says none.

### 1.1 Permission levels, presets and modes

| Control                                                                                                            | Defined                                                      | Default                                                                                          | Who                                                           | Docs                                                            | Tests                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Five areas (context, tools, edits, plan, questions) × five levels (manual, cautious, automatic, permissive, idgaf) | `core/tools/permissions/policy.ts:11-31`                     | context permissive, tools cautious, edits manual, plan cautious, questions cautious (`:217-223`) | U (`permissions.yaml` `levels`), G, C (`--policy`, `/policy`) | `ide-extensions/agent/permissions-page.mdx` (still says YOLO)   | `levelAliases.vitest.ts`, `idgafMode.vitest.ts`, `policyLevels.test.ts` |
| `yolo` read as `idgaf` with a deprecation note                                                                     | `policy.ts:39-41`, `cli/permissions/policyLevels.ts:173-190` | –                                                                                                | –                                                             | partly                                                          | `levelAliases.vitest.ts`                                                |
| Presets careful, acceptEdits, handsOff, reviewer, idgaf                                                            | `policy.ts:225-276`                                          | careful                                                                                          | G, C                                                          | permissions-page                                                | `PolicyControls.test.tsx`                                               |
| IDGAF never written to disk                                                                                        | `settingsFile.ts:84-93,167`                                  | –                                                                                                | –                                                             | plans only                                                      | `settingsFile.vitest.ts`                                                |
| Automatic with no reviewer model runs as Cautious                                                                  | `policy.ts:406-413`                                          | –                                                                                                | –                                                             | plans only                                                      | unverified                                                              |
| `--auto` (IDGAF on the three tool areas, plan at least permissive)                                                 | `cli/shared-options.ts:15`, `policyLevels.ts:136-142` **V**  | off                                                                                              | C                                                             | `reference.mdx`; help says "all tools allowed"                  | `ToolPermissionService.modes.test.ts`                                   |
| `--auto-review` (Cautious becomes Automatic)                                                                       | `shared-options.ts:16-19`, `policyLevels.ts:143-147`         | off                                                                                              | C                                                             | `model-roles/reviewer.mdx`                                      | `coreRules.test.ts`                                                     |
| `--readonly` (Plan mode)                                                                                           | `flags/flagProcessor.ts:31-47`                               | off                                                                                              | C                                                             | plan-mode docs                                                  | modes tests                                                             |
| `--policy <spec>`                                                                                                  | `shared-options.ts:20`, `policyLevels.ts:197`                | the file's levels                                                                                | C                                                             | **none**                                                        | parser only                                                             |
| `--allow` / `--ask` / `--exclude`                                                                                  | `precedenceResolver.ts:65-95`                                | –                                                                                                | C                                                             | CLI help, `spec/permissions.md`                                 | `precedenceResolver.test.ts`                                            |
| Headless defaults: Bash and `*` allow                                                                              | `cli/permissions/defaultPolicies.ts:34-37` **V**             | allow in `-p` and `serve`                                                                        | – (only per-tool flags)                                       | `spec/permissions.md:97` (says the run stops; the code goes on) | `defaultPolicies.test.ts`                                               |
| Agent file `tools:` replaces the lists and ends with `*: allow`                                                    | `ToolPermissionService.ts:160-163,206-212` **V**             | –                                                                                                | C (`--agent` file or slug)                                    | none                                                            | `ToolPermissionService.agentfile.test.ts`                               |
| Organisation ceiling                                                                                               | `plans/policy-areas.md:185,298`                              | **not built**                                                                                    | –                                                             | plans                                                           | –                                                                       |
| Loop autonomy supervised / auto / unattended / idgaf                                                               | `core/util/loopMode.ts:188-248`                              | auto, or derived from the policy (`:310`)                                                        | G, TUI, serve `loopAutonomy`                                  | loop docs                                                       | `loop*.vitest.ts`                                                       |

**Precedence (CLI).** Levels come from `permissions.yaml`, then `--policy` (`flagProcessor.ts:85-95`). Mode overrides follow:

- `--auto` sets IDGAF on the three tool areas.
- `--auto-review` raises Cautious to Automatic.
- `--readonly` with `--auto` is an error.

Tool lists come from CLI flags, then the `permissions.yaml` lists, then defaults (`precedenceResolver.ts:33-60`). Plan and auto modes replace the lists. PreToolUse hooks run next, then the core engine (`helpers.ts:353-375`).

**Precedence (IDE).** The webview holds the levels in redux. A save that raises a level waits for a native modal (`VsCodeMessenger.ts:489-506`).

### 1.2 Rule sources, built-ins and trust

| Control                                                                                                                                                                           | Defined                                                             | Default                   | Who                                                                                              | Docs                                             | Tests                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| `permissions.yaml`: `levels`, `plan.maxNewItems`, `questions.*`, `builtin`, `floor`, `mcpServers: trusted`, `plan.mcpTools`, `plan.allowTerminal`; `sandbox` reserved, not parsed | `settingsFile.ts:47-139`; location `permissionsYamlLoader.ts:12-14` | built-ins on, floor empty | U only                                                                                           | partly (`mcpServers` and `plan.*` only in plans) | `settingsFile.vitest.ts`                            |
| 11 built-in rules, each can be switched off                                                                                                                                       | `policy.ts:94-174`                                                  | on                        | U, G                                                                                             | `agent/command-checks.mdx`                       | `askProtections`, `protected`, `fetchAndRun` vitest |
| Locked `protect-policy-files`                                                                                                                                                     | `policy.ts:180-191`, `selfProtect.ts`                               | always on                 | –                                                                                                | permissions-page "Locks"                         | `selfProtect*.vitest.ts`                            |
| `toolPermissions.allow` honoured only from the user's own `config.yaml`                                                                                                           | `ruleTrust.ts:30-51`                                                | –                         | U                                                                                                | permissions-page                                 | `ruleTrust.vitest.ts`                               |
| Workspace files cannot set allow, guidance, trustedDomains, envNames.allow, largeChangeLines or fetch limits                                                                      | `trust.ts:16-27`, `loadYaml.ts:69-89`                               | stripped, with a notice   | –                                                                                                | permissions-page                                 | `trust.vitest.ts`                                   |
| Project trust: scopes mcp, models, data, providers, catalog, rc, worktree                                                                                                         | `core/config/projectTrust.ts:37-55`                                 | held until trusted        | U (`continuous project trust`, VS Code dialog, `--trust-project-config`)                         | `customize/workspace-trust.mdx`                  | `projectTrust.vitest.ts`                            |
| Audit trail                                                                                                                                                                       | `core/tools/permissions/audit/global.ts:12-69`                      | on                        | U (`audit.enabled`, `audit.retentionDays`, **not in the schema**), E (`CONTINUE_AUDIT=off` wins) | `audit-trail.mdx`                                | `audit*.test.ts`                                    |

### 1.3 Command checks, taint, network, files

| Control                                                                       | Defined                                                    | Default                                                   | Off switch                                                              | Docs               | Tests                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------ | ---------------------------------------------- |
| Command lint (errors block; a warning blocks once)                            | `core/.../commandLint.ts:453-470`                          | on                                                        | E only (`CONTINUE_COMMAND_LINT=off`)                                    | command-checks     | `commandLint*.vitest.ts`                       |
| Missing-binary gate                                                           | `missingBinaryGate.ts:107-115`                             | on (skipped in a container)                               | E only (`CONTINUE_MISSING_BINARY_CHECK=off`)                            | command-checks     | `missingBinary.vitest.ts`                      |
| Safety floor, obfuscation refusal, env-assignment check, read-only classifier | `evaluate.ts:239-269,394-460`                              | on                                                        | U `builtin.refuse-dangerous-commands: off`                              | command-checks     | many                                           |
| Tainted-session rule                                                          | `taint/taintRule.ts:42-66`, `evaluate.ts:185-191`          | **off**                                                   | U (`toolPermissions.auto.environment.taintedSessionRule`); `/untaint`   | **none**           | `taintedSession.vitest.ts`, `cliTaint.test.ts` |
| Unknown-host ask (`trustedDomains`)                                           | `askProtections.ts:141-158`                                | active only if the list is non-empty                      | U                                                                       | command-checks     | `userTrustedDomains.vitest.ts`                 |
| Private or local URL fetch asks                                               | `evaluate.ts:433-440`                                      | on; IDGAF passes it                                       | level                                                                   | command-checks     | unverified                                     |
| Spotlight markers on fetched content                                          | `fetchUrlContent.ts:48-50`                                 | off                                                       | U `experimental.spotlightUntrusted`, E `CONTINUOUS_SPOTLIGHT_UNTRUSTED` | command-checks     | `spotlight.vitest.ts`                          |
| Egress allowlist (static source check)                                        | `core/egress/egress-allowlist.json`                        | CI test                                                   | –                                                                       | `PRIVACY.md`       | `egressAllowlist.vitest.ts`                    |
| Jail egress policy none / allowlist / open                                    | `core/util/egressPolicy.ts`                                | **not enforced** (preview in `continuous sandbox status`) | –                                                                       | none               | vitest                                         |
| Outside-path ask, protect-secrets, protect-config, UNC                        | `policy.ts:112-167`, `protectedPaths.ts`, `deputyPaths.ts` | on; IDGAF passes it                                       | level                                                                   | command-checks:186 | vitest                                         |
| `.continuousignore` / `.continueignore` (indexing only, not access control)   | `core/indexing/walkDir.ts:311-347`                         | –                                                         | –                                                                       | –                  | `shouldIgnore.test.ts`                         |

### 1.4 MCP, hooks, isolation

| Control                                                                                       | Defined                                                                                          | Default                                                            | Who                                                      | Docs                                   | Tests                                                        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| Workspace MCP servers held until trust; a name collision keeps the user's server              | `workspaceMcpPolicy.ts:110-155`                                                                  | held                                                               | U, C                                                     | workspace-trust                        | `workspaceMcpPolicy.vitest.ts`                               |
| Tool and launch pins; a changed definition asks (IDGAF passes it)                             | `mcpToolPins.ts:164`, `evaluate.ts:441-446`                                                      | on                                                                 | –                                                        | `mcp-tool-changes.mdx` (YOLO)          | `mcpToolPins.vitest.ts`                                      |
| `readOnlyHint` believed                                                                       | IDE `doLoadConfig.ts:65-76` **V**; CLI `tools/index.tsx:254` **V**, `readOnlyMcp.ts:12-17` **V** | IDE: any non-workspace server; CLI: any server                     | U `mcpServers: trusted` (Plan role only)                 | `plan/how-it-works.mdx`                | `mcpReadOnly.vitest.ts`; **fix in flight #740 (TR22, TR23)** |
| `continuous.shareMcpServersWithVSCode`, `shareModelsWithVSCode`, `accountsFromVSCode`         | `extensions/vscode/package.json` **V**                                                           | true, true, false; scope `window`, so **a workspace can set them** | U, P (`.vscode/settings.json`)                           | package.json only                      | unverified                                                   |
| Hooks from `~/.claude/settings.json` and `<global>/settings.json` always run                  | `cli/hooks/hookConfig.ts:81-88` **V**                                                            | on                                                                 | U                                                        | `agent/hooks-trust.mdx`                | `hooks.test.ts`                                              |
| Project hooks need fingerprint trust; a project hook's `allow` is ignored; `managedHooksOnly` | `hookConfig.ts:94-230`, `hookRunner.ts:499-503`                                                  | not run                                                            | U, C (`--trust-project-hooks`, `continuous hooks trust`) | hooks-trust                            | `hookTrust.test.ts`, `projectHookHardening.test.ts`          |
| Terminal shell default / wsl / container (+ distro, runtime, image)                           | `vscode/package.json:160-198`                                                                    | host shell; scope `machine`                                        | U                                                        | terminal-in-wsl, terminal-in-container | `containerExecutor.vitest.ts`                                |
| Container runs with `--network none`                                                          | `containerArgs.ts:57-58`                                                                         | on                                                                 | –                                                        | yes                                    | yes                                                          |
| Terminal environment scrub / inherit / allowlist                                              | `core/util/terminalEnvironment.ts:70-155`                                                        | scrub                                                              | U, G, E (`CONTINUE_TERMINAL_ENV` wins)                   | `terminal-environment.mdx`             | `terminalEnvironmentTrust.vitest.ts`                         |
| `environment.json` `install`, run by `serve`                                                  | `cli/environment/environmentHandler.ts:17-72` **V**, `commands/serve.ts:339` **V**               | runs if present                                                    | **P only, no trust gate, no off switch**                 | none                                   | none                                                         |
| `git-ai` checkpoint integration                                                               | `cli/services/GitAiIntegrationService.ts:28-81` **V**                                            | `isEnabled: true` hard-coded                                       | –                                                        | none                                   | unverified                                                   |

### 1.5 CLI surface

| Group              | Items                                                                                                                                                                                                                                                                              | Defined                                                | Docs / tests                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Root flags         | `-p`, `--format json`, `--silent`, `--resume`, `--fork`, `--config`, `--org`, `--rule`, `--prompt`, `--mcp`, `--model`, `--agent`, `--verbose`, `--beta-subagent-tool`, `--beta-status-tool` (**read nowhere**, **V**), `--trust-project-hooks`, `--trust-project-config`          | `index.ts:155-178`, `shared-options.ts:4-99`           | README, spec; `--fork`, `--trust-*` untested                            |
| Run limits         | `--max-budget-usd`, `--max-turns`, `--max-duration`, `--budget-allow-unpriced`; user `runLimits` in `~/.continuous/settings.json` (a flag can only tighten it); exit codes 20, 21, 22; the interactive chat refuses them                                                           | `budget/runLimits.ts:31-197`, `runBudget.ts:22-26`     | `docs/cli/run-limits.mdx`; `runLimits.test.ts`                          |
| Subcommands        | `ls`, `serve` (**hidden**), `acp`, `review`, `project`, `hooks`, `doctor [network]`, `reviewer eval`, `terminal-env`, `permissions`, `secrets`, `clean`, `plan list/build`, `sandbox`, `agents`, `audit list/show/inbox/suggest/shadow/prune`, `test-connection`, `dismiss-notice` | `index.ts:281-522`                                     | most have docs and tests; `review` flags, `project`, `hooks`: no tests  |
| `serve`            | `--port` 8000, `--host` 127.0.0.1, `--timeout` 300, `--token` / `CONTINUOUS_SERVE_TOKEN` (optional on loopback, required off loopback, at least 16 characters), `--allow-origin` none                                                                                              | `serve.auth.ts:17-50` **V**, `serve.helpers.ts:42-160` | `guides/cn-serve.mdx`; `--host`, `--timeout`, `--allow-origin` untested |
| TUI slash commands | help, clear, update, info, model, config, mcp, init (writes AGENTS.md), compact, resume, fork, title, rename, exit, jobs, untaint, policy, loop, sessions, skills, import-skill, export, import                                                                                    | `commands/commands.ts:25-143`                          | `slashCommands*.test.ts`                                                |
| GUI slash commands | Init (writes **CONTINUE.md** under `.continuous/rules`, `core/promptFiles/initPrompt.ts:81`), YAML prompts, prompt files, invokable rules, MCP prompts; the legacy built-ins only from config.json                                                                                 | `core/commands/slash/`                                 | –                                                                       |

### 1.6 Environment variables

| Prefix              | Names                                                                                                                                                                                                                                                                                                                                                                                                                                            | Docs                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Both spellings      | `CONTINUOUS_GLOBAL_DIR` / `CONTINUE_GLOBAL_DIR` (new name wins, `core/util/paths.ts:181`)                                                                                                                                                                                                                                                                                                                                                        | reference               |
| `CONTINUOUS_*` only | `SERVE_TOKEN`, `OTEL`, `LOOP_FALLBACK_CHECK` (undocumented), `SPOTLIGHT_UNTRUSTED`, `TERMINAL_SHELL`, `WEB_SEARCH_URL`, `WEB_SEARCH_KEY`, `<PROVIDER>_API_KEY` (undocumented), `IGNORE_CWD_ENV` (internal)                                                                                                                                                                                                                                       | partly                  |
| `CONTINUE_*` only   | `AUDIT`, `COMMAND_LINT`, `MISSING_BINARY_CHECK`, `TERMINAL_ENV`, `TOOL_SEARCH`, `STABLE_TOOL_ORDER`, `RECOVER_TEXT_TOOL_CALLS`, `NUDGE_LEAKED_CALLS`, `HISTORY_AGEING`, `SURFACE_FACTS`, `DUMP_REQUESTS`, `BEDROCK_REPAIR_STREAMED_TOOL_INPUT`, `USE_BEDROCK`, `PROMPT_PROFILE`, `PROMPT_SEGMENTS`, `PROJECT_DIR` (passed to hooks), `REMOTE`, `USER_ID`, `VERSION`, `CLI_DISABLE_STUCK_NOTES`, `CLI_*_MAX_OUTPUT_*` (seven), `CLI_AUTO_UPDATED` | about half undocumented |
| Dead or test-only   | `CONTINUOUS_AUDIT_DIR` (a test refers to it, `secretScan.vitest.ts:232`; no code reads it), `CONTINUE_USE_AI_SDK`, `CONTINUE_USE_WEB_FETCH`                                                                                                                                                                                                                                                                                                      | –                       |

`PRIVACY.md` documents both prefixes (`:11` and `:15`). PV10 counts about 40 `CONTINUE_*` names.

### 1.7 config.yaml, GUI settings, IDE settings

| Surface                                                                       | Keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Stored                                                              | Scope rules                                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `config.yaml` top level (`packages/config-yaml/src/schemas/index.ts:288-350`) | `name`, `version`, `schema`, `metadata`, `modeModels`, `rulesByMode`, `toolPermissions` (`allow`, `ask`, `deny`, `auto.environment.*`, `auto.reviewerPrompt`, `auto.guidance`, `auto.limits`), `terminal`, `env`, `requestOptions` (`timeout`, `connectTimeout`, `verifySsl`, `useSystemCa`, `caBundlePath`, `proxy`, `headers`, `noProxy`, `clientCertificate`, ...), `models`, `context`, `data`, `mcpServers`, `rules`, `prompts`, `docs`                                                           | user or profile file                                                | block folders can come from a workspace `.continuous/` once trusted; `allow`, `terminal.*`, `auto.*` are user-only                    |
| Read but not in the schema                                                    | `audit.enabled`, `audit.retentionDays`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | user `config.yaml`                                                  | no editor completion, not in `reference.mdx`                                                                                          |
| Settings tab (`gui/.../UserSettingsSection.tsx`)                              | session tabs, code wrap, chat scrollbar, TTS, session titles, format Markdown, font size, multiline autocomplete, autocomplete timeout 150, **autocomplete debounce shown as 250 while core uses 350** (**V**: `UserSettingsSection.tsx:73`, `core/util/parameters.ts:8`), disable autocomplete in files; Experimental: current file as context, experimental tools, system-message tools only, @Codebase tool calling only, reviewer auto approval, stream after rejection, nudge leaked calls (true) | `~/.continuous/index/globalContext.json` (`core/util/paths.ts:264`) | user only; the CLI reads none of them                                                                                                 |
| sharedConfig keys nobody can set                                              | `toolSearch` (the CLI uses `CONTINUE_TOOL_SEARCH`), `useChromiumForDocsCrawling`, `enableStaticContextualization`, `useAutocompleteCache`, `promptPath`, `codeBlockToolbarPosition`, `allowAnonymousTelemetry`                                                                                                                                                                                                                                                                                         | globalContext                                                       | only `migrateSharedConfig.ts:204` writes them                                                                                         |
| Other GUI                                                                     | rules by mode, per-mode models, model roles, provider accounts, terminal environment, shadow review, MCP toggles and auth, config profiles, indexing (on by default under a "deprecated" banner)                                                                                                                                                                                                                                                                                                       | the selected local YAML, `providers.yaml`, globalContext            | per-mode writes go to "the selected local YAML", which may be a workspace agent file (unverified)                                     |
| VS Code (`continuous.*`)                                                      | 19 settings: telemetryEnabled (true, "Has no effect"), enableTabAutocomplete, enableNextEdit, enableConsole, remoteConfigServerUrl, userToken, remoteConfigSyncPeriod (VS Code has no sync job), terminal.\*, share\*, ...                                                                                                                                                                                                                                                                             | VS Code                                                             | only terminal.\* (machine) and remoteConfig/userToken (application) are user-only; the rest are `window`, so a workspace can set them |
| JetBrains                                                                     | enableTabAutocomplete, displayEditorTooltip, showIDECompletionSideBySide, remoteConfigServerUrl, userToken, remoteConfigSyncPeriod (syncs a Bearer token and may write `config.js`)                                                                                                                                                                                                                                                                                                                    | IDE state                                                           | `ContinueExtensionSettingsService.kt:82-156`                                                                                          |

### 1.8 Loop mode

| Control                                                                                           | Defined                                       | Default                                                                                     | Surfaces                                                                                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Strategy finish / check-in / fix-forward                                                          | `loopMode.ts:449-474`                         | supervised: finish; others: fix-forward                                                     | G, TUI, serve                                                                                                 |
| Budget: rounds, tokens, wall time, attempts, no-progress rounds, consecutive failures, item turns | `DEFAULT_LOOP_BUDGET` `loopMode.ts:148`       | 5, 10M, 2 h, 2, 2, 3, 60 (per-level overrides at `:195-238`)                                | GUI and TUI: rounds, tokens, minutes. Serve: five fields. **No surface for no-progress rounds or item turns** |
| Per-item budgets (turns, tokens, minutes, USD)                                                    | `core/util/planBudget.ts:227`                 | plan `budget:` lines                                                                        | plan file, GUI budget step                                                                                    |
| Parallel waves                                                                                    | `loopMode.ts:898`                             | off, at most 3                                                                              | G, TUI, serve                                                                                                 |
| Questions and auto-answer (IDGAF takes the labelled, first or best answer; approvals refused)     | `loopMode.ts:378-406`, `loopAutoAnswer.ts:24` | not IDGAF                                                                                   | permissions.yaml, G, `/policy`; **undocumented** in docs/                                                     |
| Stop reasons                                                                                      | `core/index.d.ts:618-629`                     | done, rounds, tokens, time, no_progress, failures, error, stopped, left_loop, replan_failed | **undocumented**                                                                                              |
| Fallback check                                                                                    | `loopMode.ts:782`                             | off                                                                                         | E `CONTINUOUS_LOOP_FALLBACK_CHECK`, serve; **no GUI input**                                                   |
| Stuck detection thresholds (ten signals)                                                          | `core/util/stuckSignals.ts:84-115`            | fixed                                                                                       | E `CONTINUE_CLI_DISABLE_STUCK_NOTES` only; `stuckNotes.ts:19` says the setting "does not exist yet"           |
| Refusal cap                                                                                       | `core/util/turnEnd.ts:35`                     | 3 rounds in a row, 20 per turn                                                              | –                                                                                                             |

## 2. Coherence review

### 2.1 Findings ranked by user impact and risk

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Evidence                                                                                                         | Risk                                                                               | Row  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---- |
| F1  | **A repository file runs a shell command under `serve` with no trust check.** `.continuous/environment.json` or `.continue/environment.json` `install` goes to `execAsync` after startup. Messages are at debug level; there is no off switch, no doc and no test. `workspace-trust.mdx` lists the gated files and this one is not among them.                                                                                                                                                                                                                                                                       | `environmentHandler.ts:17-72` **V**; `serve.ts:339` **V**                                                        | P0: code execution on clone-and-serve; it bypasses every level, including Manual   | CO1  |
| F2  | **Headless runs allow Bash and every unlisted tool by default.** `-p` and `serve` push `Bash: allow` and `*: allow`, and the spec says a headless run "stops" instead. Serve on loopback needs no token, so any local process can drive an agent that runs commands. Claude Code's `-p` starts in Manual mode and denies what needs approval ([headless docs](https://code.claude.com/docs/en/headless), fetched 2026-11-12). Codex recommends `codex exec --sandbox workspace-write`, with network off by default ([agent approvals](https://learn.chatgpt.com/docs/agent-approvals-security), fetched 2026-11-12). | `defaultPolicies.ts:34-37` **V**; `spec/permissions.md:95-97` **V**; `serve.auth.ts:17-28` **V**                 | P0: the most surprising default in the product; the opposite of the IDE's Cautious | CO2  |
| F3  | **When the core engine throws, the CLI fails open whenever the levels and rules are at their defaults.** It returns `undefined`, so the headless allow of F2 decides the call with no protected-path check.                                                                                                                                                                                                                                                                                                                                                                                                          | `streamChatResponse.helpers.ts:267-274` **V**                                                                    | P0 with F2                                                                         | CO3  |
| F4  | **An `--agent` file loosens everything.** Its policies "take full precedence" over the user's `permissions.yaml` lists and end with `*: allow`. A third-party slug or a repository `.md` file is enough.                                                                                                                                                                                                                                                                                                                                                                                                             | `ToolPermissionService.ts:160-163,206-212` **V**                                                                 | P0: trust boundary (third-party text loosens user policy)                          | CO4  |
| F5  | **`git-ai` always runs a binary found through `PATH`.** `exec("git-ai --version")` at startup and `spawn("git-ai", ...)` with `cwd` set to the workspace on file-tool use. `isEnabled` is hard-coded to `true` and nothing documents it. On Windows, `exec` goes through `cmd.exe`, so a `git-ai.cmd` planted in the current directory could run (unverified).                                                                                                                                                                                                                                                       | `GitAiIntegrationService.ts:28-81` **V**                                                                         | P0/P1: an undisclosed integration, possible planted binary                         | CO5  |
| F6  | **`/policy` in the CLI raises levels with no confirmation and no audit, and the change reaches the IDE.** The IDE's native "Raise" modal guards only webview saves. The audit records rule edits, but not level or preset changes, built-in switch-offs, `floor` edits, project or hook trust grants, or `mcpServers: trusted`.                                                                                                                                                                                                                                                                                      | `slashCommands.ts:118-131` **V**; `VsCodeMessenger.ts:489-506`; `audit/record.ts:179-206`                        | P1: the most consequential changes leave no trace                                  | CO6  |
| F7  | **The "you decide" question floor is not a floor.** At Permissive and Automatic only a user-written `youDecide` list is honoured, so Hands off auto-answers irreversible, security and cost questions. The spec calls the default list a floor. `access` (always asked, per spec) is not a question type.                                                                                                                                                                                                                                                                                                            | `policy.ts:545-559` **V**, `:70-80` **V**; `plans/policy-areas.md:102`                                           | P1: an agent decides irreversible questions under a preset named for convenience   | CO7  |
| F8  | **MCP `readOnlyHint` is believed without user trust**: IDE servers from outside the workspace and every CLI server. A read-only tool skips the catch-all ask and lands in Context (Permissive).                                                                                                                                                                                                                                                                                                                                                                                                                      | `doLoadConfig.ts:65-76` **V**; `tools/index.tsx:254` **V**; `readOnlyMcp.ts:12-17` **V**                         | P0, but **#740 fixes it** (TR22, TR23); merge it before 2.18.0                     | TR22 |
| F9  | **Subcommand flags are swallowed and parent options are dropped.** No `enablePositionalOptions`, so root `--prompt`, `--model`, `--format` and `--verbose` never reach `reviewer eval`, `test-connection`, `review` or `audit`. `inheritableOptions` lacks `policy` and `trustProjectHooks` and lists a `tools` flag that does not exist, so `continuous --policy careful serve` runs with the file's levels.                                                                                                                                                                                                        | `shared-options.ts:106-131` **V**; no `enablePositionalOptions` in `extensions/cli/src` **V**; `plan.ts:140-145` | P1: a safety flag that silently does nothing                                       | CO8  |
| F10 | **There is no "why is this the value" view.** Effective levels come from up to seven inputs (file, preset, `--policy`, `--auto`, `--auto-review`, `--readonly`, agent file, headless). Tool lists from four. Loop budgets from three surfaces with different field sets. Env vars override files case by case (`CONTINUE_TERMINAL_ENV`, `CONTINUE_AUDIT`). `doctor` has one topic, `network`. Claude Code shows loaded sources in `/status` and rejected entries in `claude doctor` ([settings docs](https://code.claude.com/docs/en/settings), fetched 2026-11-12).                                                 | `doctor.ts:180-185` **V**                                                                                        | P1: every other finding is harder to notice without it                             | CO9  |

### 2.2 More findings

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                       | Priority      | Row  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---- |
| F11 | "Auto" means three things: CLI `--auto` is IDGAF, "Auto mode" or `toolPermissions.auto` is the reviewer, and loop autonomy `auto` is a third ladder. `--auto` help says "all tools allowed" but IDGAF also lifts built-in asks.                                                                                                                                                                                                                                                                                                                                     | `shared-options.ts:15`; `schemas/index.ts:223`; `loopMode.ts:188`                                                                                                                                                                                                                                                                                                                                              | P1            | CO10 |
| F12 | Two ladders for one idea: policy levels (5) and loop autonomy (4, with `idgaf` in both). A person cannot tell which wins inside a loop item. `syncRunningLoopPolicy` exists (`slashCommands.ts:126`), but the docs do not explain the mapping.                                                                                                                                                                                                                                                                                                                      | `loopMode.ts:188-310`                                                                                                                                                                                                                                                                                                                                                                                          | P1            | CO10 |
| F13 | Dead telemetry settings look enabled: `allowAnonymousTelemetry` defaults to `true` (`core/config/load.ts:144` **V**) and nothing consumes it; `continuous.telemetryEnabled` defaults to `true` and says "Has no effect" (**V**). VS Code tells extensions to respect `isTelemetryEnabled` and tag any own setting `telemetry` ([telemetry guide](https://code.visualstudio.com/api/extension-guides/telemetry), fetched 2026-11-12).                                                                                                                                | as cited                                                                                                                                                                                                                                                                                                                                                                                                       | P1 (trust)    | CO11 |
| F14 | No single egress-off switch. Provider setup fetches `ollama.com/library` (by scraping the HTML) and `openrouter.ai/api/v1/models`. JetBrains syncs remote config with a Bearer token. `remoteConfigServerUrl` feeds an upstream `ContinueServerClient` stub (`CodebaseIndexer.ts:163`). The jail egress policy is not enforced.                                                                                                                                                                                                                                     | `core/llm/fetchModels.ts:85,151`; `ContinueExtensionSettingsService.kt:112-156`                                                                                                                                                                                                                                                                                                                                | P1            | CO12 |
| F15 | Window-scoped VS Code settings can be set from `.vscode/settings.json`: `accountsFromVSCode`, `shareMcpServersWithVSCode`, `shareModelsWithVSCode`, `enableConsole` (which logs model inputs and outputs). `scope: machine` or `application` is the documented way to keep a workspace out ([contribution points](https://code.visualstudio.com/api/references/contribution-points), fetched 2026-11-12).                                                                                                                                                           | `vscode/package.json` **V**                                                                                                                                                                                                                                                                                                                                                                                    | P1            | CO13 |
| F16 | Tainted-session rule: off by default, undocumented, configurable only in a nested user key. Instruction files (`AGENTS.md`, `CLAUDE.md`, rules) load with no trust gate, which makes taint the compensating control.                                                                                                                                                                                                                                                                                                                                                | `core/tools/permissions/taint/taintSetting.ts:23-46`; `instructionFiles.ts:12-20`                                                                                                                                                                                                                                                                                                                              | P1            | X17  |
| F17 | User-level `~/.claude/settings.json` hooks run inside Continuous with no opt-in. This is a cross-product surprise: a hook written for Claude Code runs here.                                                                                                                                                                                                                                                                                                                                                                                                        | `hookConfig.ts:81-88` **V**                                                                                                                                                                                                                                                                                                                                                                                    | P1            | CO14 |
| F18 | Command lint, missing-binary gate and stuck notes can be turned off only by environment variable; there is no config key or GUI.                                                                                                                                                                                                                                                                                                                                                                                                                                    | 1.3 and 1.8                                                                                                                                                                                                                                                                                                                                                                                                    | P2            | CO15 |
| F19 | The GUI shows the autocomplete debounce default as 250 while core uses 350; `reference.mdx` shows both (`:194`, `:722`).                                                                                                                                                                                                                                                                                                                                                                                                                                            | **V**                                                                                                                                                                                                                                                                                                                                                                                                          | P2 quick      | CO16 |
| F20 | Hub leftovers. Hub loading always throws (`hubLoader.ts:54-60`), yet help for six flags says "from the hub". The `-p` usage suggests `cn -p --prompt my-org/my-prompt`, which exits 1 (`index.ts:259-268` **V**). The README lists `cn login`, `cn logout` and `cn remote`, which do not exist (`README.md:111-113` **V**). `--beta-status-tool` is read nowhere (**V**).                                                                                                                                                                                           | as cited                                                                                                                                                                                                                                                                                                                                                                                                       | P2 quick      | CO17 |
| F21 | Upstream names in the product.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | permissions.yaml header "Continue CLI ... should not be edited manually" while the docs say to edit it (`policyWriter.ts:55-56` **V**); hook trust error "Continue directory ... CONTINUE_GLOBAL_DIR" (`hookTrust.ts:264-266` **V**) versus "Continuous ... CONTINUOUS_GLOBAL_DIR" in project trust; `renderReport.ts:126` "Continue CI"; `config_schema.json` has 32 `docs.continue.dev` links shown on hover | P2            | PV10 |
| F22 | JetBrains is entirely upstream-branded: `<name>Continue</name>`, vendor `continue-dev` with `https://www.continue.dev/` (`plugin.xml:4-5` **V**), about 15 "Continue: ..." actions, and an upstream "Enter Enterprise License Key" action. Yet `jetbrains-release.yaml` publishes on every pre-release. The Marketplace requires that a vendor "not misrepresent themselves" ([approval guidelines](https://plugins.jetbrains.com/docs/marketplace/jetbrains-marketplace-approval-guidelines.html), via search 2026-11-12; text of v2.x not retrieved, unverified). | `.github/workflows/jetbrains-release.yaml` **V**                                                                                                                                                                                                                                                                                                                                                               | P1 (identity) | CO18 |
| F23 | GUI `/init` writes `CONTINUE.md` into `.continuous/rules`; the CLI's `/init` writes `AGENTS.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `initPrompt.ts:81`; `commands/init.ts:8`                                                                                                                                                                                                                                                                                                                                                                       | P2 quick      | CO17 |
| F24 | `isServe()` is true for any argv element equal to `serve`, so `cn -p serve` counts as serve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `util/cli.ts:15-16` **V**                                                                                                                                                                                                                                                                                                                                                                                      | P2 quick      | CO8  |
| F25 | `audit.*` is read from `config.yaml` but is not in the schema. A test refers to `CONTINUOUS_AUDIT_DIR`, which no code reads.                                                                                                                                                                                                                                                                                                                                                                                                                                        | `audit/global.ts:33-69`; `secretScan.vitest.ts:232`                                                                                                                                                                                                                                                                                                                                                            | P2            | CO15 |
| F26 | Two trust stores (`trusted-hooks.json`, `trusted-project.json`), two commands and two flags, plus pins and `mcpServers: trusted`. There is no one place to see or revoke a grant. B20 covers this; it is restated here because F6 depends on it.                                                                                                                                                                                                                                                                                                                    | –                                                                                                                                                                                                                                                                                                                                                                                                              | P1            | B20  |
| F27 | The organisation ceiling is in the spec as one of the few things that bind at IDGAF, but nothing builds it. B19 and D9 split the managed tier between two tracks.                                                                                                                                                                                                                                                                                                                                                                                                   | `plans/policy-areas.md:185,298`                                                                                                                                                                                                                                                                                                                                                                                | P1 (design)   | CO19 |

### 2.3 Surface reachability

| Control                                          | GUI                                  | CLI                   | File               | Env                       |
| ------------------------------------------------ | ------------------------------------ | --------------------- | ------------------ | ------------------------- |
| Levels and presets                               | yes                                  | `--policy`, `/policy` | `permissions.yaml` | –                         |
| Reviewer auto approval                           | toggle                               | `--auto-review`       | –                  | –                         |
| Run limits (USD, turns, minutes)                 | **no**                               | flags                 | `settings.json`    | –                         |
| Loop no-progress rounds, item turns              | no                                   | no                    | no                 | no                        |
| Loop attempts, consecutive failures              | no                                   | no (serve HTTP only)  | no                 | no                        |
| Loop fallback check                              | no                                   | serve                 | –                  | yes                       |
| Tainted-session rule                             | **no**                               | `/untaint` only       | nested user key    | –                         |
| Command lint, missing-binary, stuck notes        | no                                   | no                    | no                 | only                      |
| UI and experimental toggles (nudge, titles, ...) | only                                 | not read              | globalContext      | –                         |
| Telemetry                                        | no (`disableTelemetryToggle` unused) | –                     | dead keys          | `CONTINUOUS_OTEL` (works) |

### 2.4 Terminology

| Idea                     | Code                                                   | UI                                    | Docs                        | Proposed single word                               |
| ------------------------ | ------------------------------------------------------ | ------------------------------------- | --------------------------- | -------------------------------------------------- |
| Top level                | `idgaf` (+ `yolo` alias)                               | IDGAF                                 | YOLO in 5 pages (#699 open) | IDGAF (owner decided)                              |
| Reviewer-decided level   | `automatic`, `toolPermissions.auto`                    | "Auto approval with a reviewer model" | "Auto mode"                 | Automatic (reviewer)                               |
| CLI everything-allowed   | `--auto`                                               | –                                     | "all tools allowed"         | `--policy idgaf`; `--auto` an alias with a warning |
| Locked rules             | `floor`                                                | "Always on"                           | "Floor" / "Locks"           | owner (UX12)                                       |
| Rule-list verbs          | CLI `allow`/`ask`/`exclude`; YAML `allow`/`ask`/`deny` | Never / Ask / Always                  | mixed                       | `deny` everywhere; `exclude` an alias              |
| Project instruction file | AGENTS.md (CLI), CONTINUE.md (GUI)                     | –                                     | –                           | AGENTS.md                                          |

## 3. ROADMAP review

### 3.1 Shape, measured

I parsed every track table under "Next" (script in the review session, not committed).

| Measure                              | Value                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| File                                 | 1,487 lines, 178 KB                                                                                               |
| Rows under Next                      | 834 in 37 tracks plus the research queue                                                                          |
| By state                             | about 439 not started or planned, 129 shipped, 31 partly built or open, 10 parked, 8 decided, 62 in other wording |
| Rows with **no state column**        | 155: Tracks C (81), E (9), F (8), part of W (16) and the research queue (41)                                      |
| Tables with an acceptance column     | only the Next 20 list ("Measure or acceptance"); no track table has one                                           |
| Rows naming the owner as the blocker | 51                                                                                                                |
| Dependency cycles                    | none found; no dependency points to a missing id                                                                  |
| Most-depended rows                   | B8 (17 direct), then B9, B35, G0, CI1, PL1 and X16 (9 each)                                                       |
| Odd-minor release labels             | "not in 2.15.0" in 26 states, 28 mentions of 2.15.0 in the ROADMAP; 2.17.0 and 2.19.0 in five research notes      |

### 3.2 Duplicates and overlaps

| Topic               | Rows                                                                                                  | Proposal                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Branch protection   | CI1, CI14, CI16, SB9, DR11, Next 20 piece 4, the 2026-11-11 Findings table, Suggested #1, CI30 (#732) | one row (CI1) and one owner action in Open decisions; the rest point to it                   |
| Actions freeze      | CI23, the In progress row, the Findings row                                                           | close all three: runs report again (3 successes at 2026-11-13T00:26Z, checked with `gh api`) |
| Tainted session     | X4, X17, Suggested #10                                                                                | X4 is the feature and X17 its measurement; drop the Suggested line                           |
| MCP read-only trust | TR2, TR22 (research), Suggested #12, #740                                                             | TR22 closes with #740; TR2 keeps the Plan filter                                             |
| Managed tier        | B19, D9 (administrator path), the organisation ceiling in `policy-areas.md`                           | one row B19 (CO19 is its design)                                                             |
| Identity            | PV10, PV11, PV16 (#732), Branding (Shipped), F21, F22                                                 | PV10 owns strings and env vars; CO18 owns JetBrains                                          |
| Vocabulary          | UX7, UX12, #699                                                                                       | UX7 owns it; UX12 is its owner question                                                      |
| Owner decisions     | Open decisions table, Track DR, `tr-owner-decisions.md`, `open-decisions-memo.md` (#622 draft)        | one table, each decision listing the rows it unblocks                                        |
| Release planning    | In progress "Patch release 2.12.1 (planned)" and "Next release (planned)"                             | both released (`v2.12.1-vscode`, `v2.14.0-vscode`); move to Shipped                          |

### 3.3 Stale rows (checked 2026-11-12)

| Row or line                               | Says                              | Fact                                                                     |
| ----------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| In progress: Egress fix (#627, open)      | open                              | merged                                                                   |
| In progress: Docs consistency pass (#619) | open                              | merged                                                                   |
| In progress: Desk research (#623)         | listed                            | merged                                                                   |
| In progress: Masking follow-up            | "In flight" plus "Update: merged" | merged (#591); remove                                                    |
| In progress: Wave-7 pull requests, merged | in progress                       | merged; remove                                                           |
| In progress: GitHub Actions froze (CI23)  | no result since 20:23Z            | runs succeed again                                                       |
| PL27                                      | "parked as draft PR #661"         | #661 closed **unmerged**                                                 |
| 26 states "Planned; not in 2.15.0"        | an odd minor                      | 2.15.0 cannot exist; read it as "after 2.14.0", plan for 2.18.0 or later |
| Next 20, piece 6                          | "at YOLO"                         | IDGAF                                                                    |

### 3.4 Release-label normalisation

| Note                                                                                                                                                                                          | Says                | Normalised                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| ROADMAP (26 rows), `area-ci-privacy-release.md` (9), `area-budgets-stuck-memory.md`, `area-caching-cost-visibility.md`                                                                        | 2.15.0              | 2.16.0 if already merged for the cut, otherwise 2.18.0                       |
| `area-isolation-sandbox-gate.md` (16), `area-caching-cost-visibility.md` (10), `area-hooks-upstream-imports.md` (6), `area-loop-planning-waves-reliability.md`, `area-index-interop-later.md` | 2.17.0              | 2.18.0                                                                       |
| `enterprise-network-auth.md`                                                                                                                                                                  | 2.19.0              | 2.20.0                                                                       |
| Nine `area-*` notes                                                                                                                                                                           | "2.16.0 candidates" | 2.18.0 candidates, unless the change is already on `main` for the 2.16.0 cut |

CI40 (#732) proposes a PR-time guard for the even-minor rule in the product version. A docs lint for odd-minor strings in `plans/` would catch the same mistake in planning text (CO20).

### 3.5 Owner decisions ranked by rows unblocked

"Downstream" counts every row that depends on the decision's rows, directly or through other rows, in any state. It measures blast radius, not effort.

| Rank | Decision                                                     | Gating rows                           | Downstream                                              | Recommended, pending owner                                                                                       |
| ---- | ------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1    | Permissions vocabulary and the rule editor's written dialect | B8, UX7, UX12                         | 41 (B10 to B27, B55 to B69, ...)                        | "Always on" for locks; Never / Ask / Always; one dialect (`deny`)                                                |
| 2    | Reviewer measurement spend and the relabelled cases          | B4, B46, B53, DR5, Q44                | 33                                                      | approve about USD 2 for B53 and Q44; review the B46 labels in one sitting                                        |
| 3    | Branch protection on `main`                                  | CI1 (and duplicates)                  | 26                                                      | apply now; Actions are reporting again                                                                           |
| 4    | **Headless default policy** (new)                            | CO2, CO3, H5                          | every `-p` and `serve` user, the bench harness (H-rows) | Cautious in headless; asks are refused; `--policy handsOff` or `--auto` to opt in, with a one-line stderr notice |
| 5    | Managed policy tier: location and scope                      | B19, D9, CO19                         | 3 now; every enterprise row later                       | design now (section 4.2), build after 2.18.0                                                                     |
| 6    | Environment-variable alias policy                            | PV10, CO21                            | about 40 variables, every doc that names them           | `CONTINUOUS_*` canonical; `CONTINUE_*` read with a once-per-process warning for two even minors, then removed    |
| 7    | JetBrains: ship, park or rebrand                             | CO18, UX54                            | UX21, UX54 and every JetBrains promise                  | park (stop pre-release publishing) until rebranded                                                               |
| 8    | Enterprise auth set                                          | PL15, PL16, PL23, PL25, PL26, K26     | 6                                                       | as `enterprise-network-auth.md`                                                                                  |
| 9    | Web gates                                                    | WB3, WB6, WB7, WB10, WB11, B55 (#625) | 0 downstream, 6 direct                                  | refuse on secrets, ask on unseen URLs, spotlight on                                                              |
| 10   | Telemetry settings: delete or deprecate                      | CO11                                  | trust claim in `PRIVACY.md`                             | deprecate with a message now, delete in 2.20.0                                                                   |

PL1 (provider layer, 35 downstream) and X9 (25 downstream) are the biggest structural blockers, but neither waits on the owner.

### 3.6 A leaner structure

1. **Split by purpose, not by history.**
   - `plans/ROADMAP.md` keeps five headings: Now (the 2.18.0 train, at most 15 rows), Next (at most 30, sequenced), Later (one line each), Decisions (one table), How to use.
   - Shipped moves to a `plans/SHIPPED.md` log.
   - The research queue moves to `plans/research/QUEUE.md`.
   - Track tables move to `plans/tracks/<theme>.md`.
   - The "Last updated" header holds one line; wave history goes to git history.
2. **Ten themes instead of 38 tracks.**
   - Safety and permissions: B, H, P, R, X, TR, CO safety rows.
   - Isolation: W, SB.
   - Loop and agents: F, N, S, T, Y, RF, O, U.
   - Models and providers: A, K, M, PL, Q.
   - Context and cost: C, J, Z, L, V.
   - Hooks, MCP and interop: D, G, E, MCPW.
   - UX: UX.
   - Release, CI and privacy: CI, PV.
   - Measurement: I, RQ.
   - Lab: MR, which moves to `continuous-lab` per MR7.

   DR folds into Decisions. Row ids stay as they are; only the headings change.

3. **One table shape:** `Id | Scope | Size | Depends on | Acceptance | State | Target`. State is one of Not started, Building (#PR), Shipped (version), Parked (reason), Dropped. Target is an even minor or "later".
4. **A check, not a convention.** `scripts/ci/roadmap-lint.mjs` runs on docs PRs. It fails on:
   - a row with no state;
   - an odd-minor target;
   - a duplicate id;
   - a dependency on a missing id;
   - an "open" PR number that GitHub reports merged or closed (optional, network).

### 3.7 Recommended 2.18.0 sequence

Each step is small enough to land in one or two PRs. The order puts safety first and keeps each change reviewable.

| Step | Work                                                                                                                     | Rows                                | Why now                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------- |
| 0    | Owner: branch protection; decisions 4, 6 and 7 of section 3.5                                                            | CI1                                 | gates everything else                           |
| 1    | Merge the safety fixes in flight                                                                                         | #740 (TR22, TR23), #739             | already written                                 |
| 2    | Trust boundary bundle: `environment.json` behind project trust; agent files capped at the user's policy; `git-ai` opt-in | CO1, CO4, CO5                       | P0, each S                                      |
| 3    | Headless default and fail-closed                                                                                         | CO2, CO3, H5                        | P0; behaviour change, needs a release-note line |
| 4    | `/policy` confirmation, policy-change audit events, question floor                                                       | CO6, CO7                            | closes the audit gap the next step reports      |
| 5    | `continuous doctor config` v1 (levels, lists, budgets with their sources)                                                | CO9                                 | makes 2 to 4 visible and testable               |
| 6    | CLI flag hygiene and quick wins                                                                                          | CO8, CO16, CO17                     | S each, low risk                                |
| 7    | Env alias step 1 and telemetry deprecation                                                                               | CO21, CO11, PV10 (env part)         | identity and trust claims                       |
| 8    | VS Code setting scopes and egress inventory                                                                              | CO13, CO12 (inventory and doc only) | small, closes F14 and F15                       |
| 9    | ROADMAP restructure and lint                                                                                             | CO20                                | by the integrator, after this train is listed   |

Already in the Next 20 and still worth 2.18.0: K22 to K24 (dated model retirements), O23 (MCP 2026-07-28), WB1 with WB3. Defer:

- CO19 (design only).
- CO18 (decision only).
- X17 (measure first).
- Everything in MR.

## 4. Research continued

### 4.1 Effective settings and `continuous doctor config`

- **Problem.** See F10. A person cannot answer "why did this run without asking?" without reading code.
- **Evidence.**
  - `doctor` has only the `network` topic (`doctor.ts:180-185` **V**).
  - Claude Code lists the loaded sources in `/status` and says that the line "doesn't show which file supplied each key". Rejected entries are listed by `claude doctor` ([settings](https://code.claude.com/docs/en/settings), fetched 2026-11-12).
  - `git config --show-origin` is the familiar model for a per-key source.
- **Design.**
  1. A core function `explainEffective()` returns, for each control, `{value, source, overriddenBy[], lockedBy?}`. Sources: default, user file, project file (trusted or held), CLI flag, env var, agent file, headless default, preset, managed (later).
  2. `continuous doctor config [--json] [--area tools]` prints it.
  3. The GUI Permissions page shows the same source as a badge (B21's source enum).
  4. A `--why <tool> <args>` mode runs the decision without executing and prints the rule chain. `permissions test` already exists; reuse it.
- **Risks.** It must use the same code path as enforcement, or it lies. Test it by asserting `explainEffective(x).value === enforce(x)` over the golden corpus.
- **Size.** M.
- **Dependencies.** B21 (source badges); none blocking.
- **Acceptance.**
  - For every row in sections 1.1 to 1.4, the output names a source.
  - A test sets each source in turn and checks that the named source changes.
  - Headless output says "headless default".
- **Owner questions.** Should the output include env vars that are not set? Recommended: no, only set ones, plus `--all`.

### 4.2 Managed policy tier (B19, D9, organisation ceiling)

- **Problem.** See F27. Nothing binds above the user. Enterprises need a file a developer cannot edit.
- **Evidence.**
  - Claude Code puts managed settings at the top. "Nothing in your own settings files or `--settings` overrides a managed key". A few restrictive values are honoured from any scope ([settings](https://code.claude.com/docs/en/settings), fetched 2026-11-12).
  - Codex separates `requirements.toml` ("admin-enforced constraints that users can't override", with keys such as `allowed_approval_policies` and `allowed_sandbox_modes`) from `managed_config.toml` (starting values a user can change) ([managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration), fetched 2026-11-12; OS paths not read, unverified).
  - VS Code policies use the registry `Software\Policies\Microsoft\VSCode` (ADMX since 1.69), `.mobileconfig` on macOS (sample since 1.99) and `/etc/vscode/policy.json` on Linux (since 1.106) ([policies](https://code.visualstudio.com/docs/enterprise/policies), fetched 2026-11-12). The page documents no extension-contributed policy mechanism (unverified whether one exists).
- **Design.**
  - Two files under a system directory:
    - `requirements.yaml` is a ceiling: `maxLevel` per area, `builtinLocked: [...]`, `allowedMcpServers`, `managedHooksOnly`, `headless: cautious`, `egress: allowlist`.
    - `defaults.yaml` holds starting values.
  - Paths: `%ProgramData%\Continuous\`, `/Library/Application Support/Continuous/`, `/etc/continuous/`.
  - Read by core and the CLI. Shown as "Locked by your organisation" with the file path. `doctor config` names it.
  - The ceiling is applied after every other source, including `--auto`, IDGAF and agent files.
- **Risks.**
  - A ceiling that silently changes behaviour. Mitigation: always show it.
  - A path writable by the user on Windows. Mitigation: check the ACL and refuse a file the user owns (unverified that this is feasible on every OS).
- **Size.** M for the loader and ceiling; L with the GUI.
- **Dependencies.** CO9 (to show it); B21.
- **Acceptance.**
  - With `maxLevel.tools: cautious`, `--auto` yields Cautious and says so.
  - A user-owned managed file is refused.
  - Golden tests for each key.
- **Owner questions.** Is enterprise a target audience at all in 2026? Recommended, pending owner: design and reserve now, build when one real request arrives.

### 4.3 Headless and serve defaults

- **Problem.** See F2 and F3.
- **Evidence.**
  - Claude Code: "With Claude Code v2.1.302 or later, `claude -p` runs start in Manual mode", and a call that needs approval is denied. Without `--bare`, a `-p` session "runs the hooks in a project's `.claude/settings.json` ... even in a folder you've never trusted" ([headless](https://code.claude.com/docs/en/headless), fetched 2026-11-12). That is a warning we already avoid for hooks, but not for `environment.json`.
  - Codex: network off by default in `workspace-write`; the recommendation for non-interactive runs is `--sandbox workspace-write` ([agent approvals](https://learn.chatgpt.com/docs/agent-approvals-security), fetched 2026-11-12).
- **Design.**
  1. Headless starts at the user's levels, with asks refused (today's refusal path).
  2. The Bash and `*` allows are removed.
  3. `--policy handsOff` or `--auto` opt in, and stderr prints `headless: running at <levels>; asks are refused` once.
  4. `serve` binds as today. Without a token it refuses `/message` from a process whose Origin or Host checks pass but which sends no token, unless `--no-token` is given. That is a stricter option; the owner chooses.
  5. The CLI catch at `streamChatResponse.helpers.ts:267` returns ask (and therefore refuse when headless) unconditionally.
- **Risks.** It breaks scripts that rely on the allow default. Mitigation: a release-note line, a one-release `CONTINUOUS_HEADLESS_LEGACY_ALLOW=1` escape hatch, and the bench harness passing `--policy` explicitly.
- **Size.** S (code) plus M (docs and harness).
- **Dependencies.** H5 (user-config allow in serve).
- **Acceptance.**
  - `cn -p "run ls"` with no policy refuses Bash and exits 0 with a refusal line.
  - The same with `--policy handsOff` runs it.
  - A thrown engine error in headless refuses.
- **Owner questions.**
  - Is the default the user's levels or a fixed Cautious? Recommended: the user's levels, capped at Permissive unless `--auto`.
  - Is a token required for loopback serve? Recommended: no, keep loopback tokenless but print the risk at start.

### 4.4 Configuration, environment names and deprecation policy

- **Problem.** About 40 `CONTINUE_*` variables, `.continue` and `.continuous` folders, `.continuerc.json` and `.continuousrc.json`, `yolo` and `idgaf`, config.json still loaded when no YAML exists, and sharedConfig keys only migration can set. There is no written rule for how a name dies.
- **Evidence.**
  - Node's deprecation ladder: Documentation-only, then Application or Runtime (a warning the first time it is used), then End-of-Life. Codes are stable even when a deprecation is revoked ([deprecations](https://nodejs.org/api/deprecations.html), fetched 2026-11-12).
  - VS Code settings take `deprecationMessage` and `markdownDeprecationMessage`. A deprecated setting is hidden from the Settings UI unless the user has configured it ([contribution points](https://code.visualstudio.com/api/references/contribution-points), fetched 2026-11-12).
- **Design.**
  - A table `docs/reference/deprecations.mdx` with ids `CDEP001...`: old name, new name, stage, first even minor, removal even minor.
  - Rule: documentation-only for one release, a once-per-process warning for two even minors, then removal. Every alias goes through one helper, `readEnvAlias(new, old)`, which records the hit for `doctor config`.
  - Apply it to the env vars, `.continue/` folders, `yolo`, `--auto`, `continuous.telemetryEnabled` and `allowAnonymousTelemetry`.
  - Mark `continuous.telemetryEnabled` with `deprecationMessage` now.
- **Risks.** Warning noise in CI. Mitigation: once per process and `--silent` respected.
- **Size.** S (helper and policy), M (migration of call sites).
- **Dependencies.** PV10.
- **Acceptance.**
  - A test fails when `process.env.CONTINUE_` appears outside the helper.
  - Every deprecated name is in the table.
- **Owner questions.**
  - How long is the window? Recommended: two even minors.
  - Is config.json support itself deprecated? Recommended: yes, CDEP for 2.20.0.

### 4.5 Telemetry and diagnostics posture

- **Problem.** See F13 and F14. The product claims no telemetry and the code matches, but the settings say the opposite, and diagnostics for a bug report are ad hoc.
- **Evidence.**
  - No PostHog or Sentry SDK in the code. OTel is off unless `CONTINUOUS_OTEL=1` and an exporter are set (`telemetryService.ts:68-92`).
  - VS Code: when `isTelemetryEnabled` is false, "telemetry must not be sent", and any custom setting should be tagged `telemetry` and `usesOnlineServices` ([telemetry guide](https://code.visualstudio.com/api/extension-guides/telemetry), fetched 2026-11-12).
- **Design.**
  1. Delete the `allowAnonymousTelemetry` default and deprecate the VS Code setting (4.4).
  2. Tag every setting that makes a network call (`remoteConfigServerUrl`, `shareModelsWithVSCode` if it does, the catalogue fetch once PL27 lands) with `usesOnlineServices`.
  3. `continuous doctor bundle` writes a local zip: `doctor config --json`, versions, the last N audit rows with secrets masked by the existing masker, and the log tail. Nothing is sent.
  4. `PRIVACY.md` gains a table "every outbound host, when, and the off switch", generated from the egress allowlist.
- **Risks.** A bundle that leaks. Mitigation: a canary test with the secret scanner (X10a pattern).
- **Size.** S (1, 2), M (3, 4).
- **Dependencies.** CO9, X10a.
- **Acceptance.**
  - No setting claims telemetry.
  - The bundle passes the canary test.
  - The `PRIVACY.md` table lists `ollama.com`, `openrouter.ai` and the JetBrains remote config.
- **Owner questions.** Is a crash-report opt-in ever wanted? Recommended: no, keep "nothing leaves", and keep the bundle manual.

### 4.6 Fork identity and the JetBrains decision

- **Problem.** See F21 and F22. VS Code is rebranded, but JetBrains publishes as "Continue" by "continue-dev". `config_schema.json` hovers link to `docs.continue.dev`.
- **Evidence.**
  - `plugin.xml:4-5` **V**. `jetbrains-release.yaml` runs on `release: prereleased` **V**.
  - Marketplace guidelines say the vendor must not misrepresent itself, and the name must not contain "Plugin", "IntelliJ" or a JetBrains product name. That is from v1.2, via search; the current v2.x text was not retrieved, unverified ([guidelines](https://plugins.jetbrains.com/docs/marketplace/jetbrains-marketplace-approval-guidelines.html)).
  - `area-ux-surfaces.md` finds the JCEF browser always off-screen (`ContinueBrowser.kt:29`). Several promises there are predicted, not measured.
- **Design.** Choose one of three:
  - (a) Park: disable the `release` trigger, keep `workflow_dispatch` build-only, and say "JetBrains: not shipped" in the README.
  - (b) Rebrand: plugin id, name, vendor, actions, and remove the licence-key action.
  - (c) Drop the directory.

  Recommended: (a) now. Choose (b) only if a JetBrains user base is wanted, because the package `com.github.continuedev.*` rename is L.

- **Risks.**
  - (a) loses nothing that ships today; whether a JetBrains build was ever published from this fork is unverified.
  - (b) needs a new Marketplace listing and a new plugin id.
- **Size.** S (a), L (b).
- **Dependencies.** none.
- **Acceptance (a).** No workflow publishes JetBrains on a release; the docs say what is supported.
- **Owner questions.** Park, rebrand or drop? Recommended, pending owner: park.

### 4.7 Upgrade and rollback safety

- **Problem.** Five releases in four days (2.6.1 to 2.14.0, 2026-11-09 to 11-12). A setting written by version N+1 (a new `permissions.yaml` key, a migrated globalContext key) may confuse version N after a rollback.
- **Evidence.** `area-ci-privacy-release.md` §6 already verifies that the Marketplace does not allow republishing a version, and keeps a rollback target in the release PR template. Unknown keys in `permissions.yaml` are ignored silently (unverified for every loader).
- **Design.**
  1. Every user-level file Continuous writes carries `schemaVersion`.
  2. A newer version reading an older file migrates and keeps a `.bak`.
  3. An older version reading a newer file keeps the keys it does not know when it writes the file back, and warns once.
  4. A downgrade test in CI installs N-1 over N's files and checks that safety keys survive a round trip (levels, `floor`, `builtin` off-switches, trust stores).
- **Risks.** A preserving writer is more code than a rewriting one; `policyWriter.ts` rewrites today.
- **Size.** M.
- **Dependencies.** CI5 (release checklist).
- **Acceptance.**
  - Round-trip golden tests per file.
  - The release template names the downgrade check.
- **Owner questions.** None blocking.

### 4.8 Testing strategy and a flaky budget

- **Problem.** The `KeyboardShortcuts` e2e test times out now and then (In progress, "Test reliability"), and the cause is not diagnosed. Merges were unchecked during the Actions freeze.
- **Evidence.** Google reports that almost 16% of its tests have some flakiness. A GTAC 2016 talk estimates reruns cost 2 to 16% of CI compute (secondary sources via search, 2026-11-12; the original post's body did not load, so treat the numbers as unverified): [Google Testing Blog label page](https://testing.googleblog.com/search/label/John%20Micco), [GTAC 2016 summary](https://rosetta.to/u/googletechtalks/gtac-2016-how-flaky-tests-in-continuous-integration).
- **Design.**
  - A quarantine list `scripts/ci/flaky.json`: test id, first seen, owner row, expiry 14 days.
  - `merge-gate` retries a quarantined test once and records the retry.
  - A test past expiry fails the gate.
  - The budget is at most 3 quarantined tests at a time.
  - Safety tests (`core/tools/permissions/**`) can never be quarantined.
- **Risks.** Quarantine becoming a graveyard. The expiry prevents that.
- **Size.** S.
- **Dependencies.** CI1.
- **Acceptance.** The gate fails on an expired entry, and on any entry under `core/tools/permissions/`.
- **Owner questions.** Is the budget 3? Recommended: 3.

## 5. Improvements, prioritised

**P0, safety and correctness:**

- CO1: environment.json behind trust.
- CO2: headless default.
- CO3: CLI fails closed.
- CO4: agent files capped.
- CO5: git-ai opt-in.
- Merge #740.

**P1, high value:**

- CO6: policy changes confirmed and audited.
- CO7: question floor.
- CO8: flag hygiene.
- CO9: `doctor config`.
- CO10: one word per idea.
- CO11: telemetry settings.
- CO12: egress inventory.
- CO13: VS Code scopes.
- CO14: `~/.claude` hooks opt-in.
- CO18: JetBrains decision.
- CO19: managed tier design.
- CO21: env alias policy.
- CO22: downgrade safety.

**P2, nice to have:**

- CO15: config keys for env-only switches.
- CO16: debounce default.
- CO17: hub and README leftovers.
- CO20: ROADMAP lint and restructure.
- CO23: flaky budget.

**Quick wins** (S or XS, low risk, suitable for one PR each):

- CO5, CO8 (the inheritable list and `isServe`).
- CO11 (`deprecationMessage`).
- CO13.
- CO16.
- CO17.
- The permissions.yaml header text and the hook-trust message (PV10).
- Deleting `--beta-status-tool`.
- Fixing `spec/permissions.md:97`.

## 6. Proposed ROADMAP changes

Do not apply these from this PR. The integrator applies them. New rows use the unused prefix **CO** (track "CO: controls coherence"). I checked that it appears nowhere on `main` or in the patches of open PRs #622, #655, #699, #719 and #730 to #733.

### 6.1 New track and rows

`### Track CO: controls coherence` (Plan: `research/product-review-controls-and-roadmap.md`). Problem: the safety core is strong, but the defaults outside it, the surfaces that show it and the names around it do not agree.

| Id   | Scope                                                                                                                                                                                                                                                                                                                                          | Size | Depends on | Acceptance                                                                                            | State       | Target                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- | ----------------------------------------------------------------------------------------------------- | ----------- | ------------------------------ |
| CO1  | `serve`'s `environment.json` `install` runs only in a trusted project (a new `environment` scope in `projectTrust.ts`); it logs the command at info level before running it; it is listed in `workspace-trust.mdx`                                                                                                                             | S    | none       | an untrusted folder with the file runs nothing and says why; trusted runs it; tests for both          | Not started | 2.18.0                         |
| CO2  | Headless (`-p`, `serve`) default: drop the `Bash` and `*` allows in `defaultPolicies.ts`; run at the user's levels with asks refused; `--policy` or `--auto` opt in; one stderr line names the levels; `spec/permissions.md` matches; one-release escape hatch `CONTINUOUS_HEADLESS_LEGACY_ALLOW=1`                                            | S    | H5         | `cn -p` with no policy refuses Bash; `--policy handsOff` runs it; the bench harness passes `--policy` | Not started | 2.18.0                         |
| CO3  | The CLI rule-check catch (`streamChatResponse.helpers.ts:267`) always returns ask, and so refuses when headless                                                                                                                                                                                                                                | XS   | none       | an injected engine error asks in TUI and refuses headless                                             | Not started | 2.18.0                         |
| CO4  | Agent-file `tools:` can narrow the user's policy but not widen it: no trailing `*: allow`, the user's ask and exclude lists kept, levels never above the user's                                                                                                                                                                                | S    | none       | an agent file listing `Bash: allow` still asks at Cautious; test                                      | Not started | 2.18.0                         |
| CO5  | `git-ai` integration off by default; opt-in with a user setting; resolves an absolute path, never the current directory; documented                                                                                                                                                                                                            | XS   | none       | no `git-ai` process without the setting; test                                                         | Not started | 2.18.0                         |
| CO6  | Level and preset changes from any surface (`/policy`, `--policy` when saved, GUI), built-in switch-offs, `floor` edits, project or hook trust grants and `mcpServers: trusted` write audit events; CLI `/policy` asks for confirmation before raising a level (IDGAF: type the word)                                                           | M    | B8         | each change type appears in `continuous audit list`; a raise without confirmation is not saved        | Not started | 2.18.0                         |
| CO7  | Questions: the default `youDecide` list (irreversible, security, cost) is a floor at Permissive and Automatic; add the `access` type, always asked                                                                                                                                                                                             | S    | none       | Hands off still asks an irreversible question; tests for each level                                   | Not started | 2.18.0                         |
| CO8  | CLI flag hygiene: `enablePositionalOptions`, or per-subcommand names, so `--prompt`, `--model`, `--format` and `--verbose` reach `reviewer eval`, `test-connection`, `review` and `audit`; add `policy` and `trustProjectHooks` to `inheritableOptions`, drop `tools`; `isServe()` checks the subcommand position; delete `--beta-status-tool` | S    | none       | a commander test per subcommand flag; `continuous --policy careful serve` runs at careful             | Not started | 2.18.0                         |
| CO9  | `continuous doctor config [--json] [--area]`: every control's effective value and its source (default, user, project, flag, env, agent file, headless, preset, managed); the GUI Permissions page shows the same source badge                                                                                                                  | M    | B21        | value equals enforcement over the golden corpus; each source flips its named source in a test         | Not started | 2.18.0                         |
| CO10 | One word per idea: `--auto` becomes an alias of `--policy idgaf` with a warning; "Auto mode" becomes "Automatic (reviewer)" everywhere; the loop autonomy ladder is documented against the policy levels; YOLO leaves the five docs pages (with #699)                                                                                          | S    | UX7        | the terminology table in section 2.4 holds in code, UI and docs; a docs lint for `YOLO`               | Not started | 2.18.0                         |
| CO11 | Telemetry settings: remove the `allowAnonymousTelemetry: true` default and the unused `disableTelemetryToggle`; `continuous.telemetryEnabled` gets `deprecationMessage` (CDEP); settings that call the network get the `usesOnlineServices` tag                                                                                                | XS   | none       | no setting defaults to telemetry on; a package.json check for tags                                    | Not started | 2.18.0                         |
| CO12 | Egress inventory: `PRIVACY.md` table of every outbound host, trigger and off switch, generated from the allowlist plus user-configured hosts (Ollama library, OpenRouter models, JetBrains remote config, `remoteConfigServerUrl`); remove the `ContinueServerClient` stub                                                                     | S    | PV3        | the table is generated and checked in CI                                                              | Not started | 2.18.0                         |
| CO13 | VS Code setting scopes: `accountsFromVSCode`, `shareMcpServersWithVSCode`, `shareModelsWithVSCode` and `enableConsole` move to `application` or `machine`; `remoteConfigSyncPeriod` removed in VS Code (no sync job)                                                                                                                           | XS   | none       | a test reads package.json scopes                                                                      | Not started | 2.18.0                         |
| CO14 | `~/.claude/settings.json` hooks run only with a user setting `hooks.readClaudeSettings: true` (default false), announced once                                                                                                                                                                                                                  | S    | D9         | a Claude hook file is ignored by default; test                                                        | Not started | 2.18.0                         |
| CO15 | Config keys (user-only) for the env-only switches: command lint, missing-binary gate, stuck notes, tool output caps; add `audit.*` to the schema; remove the `CONTINUOUS_AUDIT_DIR` test reference                                                                                                                                             | S    | CO21       | each key in `reference.mdx` and the schema; env still wins and `doctor config` says so                | Not started | later                          |
| CO16 | GUI autocomplete debounce default reads core's 350; `reference.mdx` shows one value                                                                                                                                                                                                                                                            | XS   | none       | a test compares the GUI fallback with `DEFAULT_AUTOCOMPLETE_OPTS`                                     | Not started | 2.18.0                         |
| CO17 | Hub and README leftovers: help text for `--config`, `--rule`, `--mcp`, `--model`, `--prompt` and `--agent` without "hub"; the `-p` usage drops `--prompt my-org/...`; README without `cn login`, `logout`, `remote`; GUI `/init` writes AGENTS.md like the CLI                                                                                 | S    | none       | a snapshot test of `--help`; README lint                                                              | Not started | 2.18.0                         |
| CO18 | JetBrains decision (recommended: park): remove the `release: prereleased` trigger from `jetbrains-release.yaml`, keep build-only dispatch, state support in the README and docs; rebranding (plugin id, name, vendor, actions, licence-key action) only if the owner chooses it                                                                | S    | owner      | no release publishes a JetBrains build                                                                | Not started | 2.18.0                         |
| CO19 | Managed tier design (B19, D9, organisation ceiling as one): `requirements.yaml` (ceiling) and `defaults.yaml` in a system directory per OS, ownership check, applied after every other source, shown as locked; design document only                                                                                                           | S    | CO9        | the design is reviewed; the key list is fixed                                                         | Not started | 2.18.0 (design), later (build) |
| CO20 | ROADMAP restructure and `scripts/ci/roadmap-lint.mjs` (no row without state, even-minor targets only, unique ids, known dependencies); split Shipped and the research queue out; a uniform table shape with Acceptance and Target                                                                                                              | M    | none       | the lint passes on the restructured file and fails on a planted odd minor                             | Not started | 2.18.0                         |
| CO21 | Environment and name deprecation policy: `readEnvAlias(new, old)` with a once-per-process warning, `docs/reference/deprecations.mdx` (CDEP ids), two even minors per stage; applied to `CONTINUE_*`, `.continue/`, `yolo`, `--auto`                                                                                                            | M    | PV10       | a lint fails on `process.env.CONTINUE_` outside the helper                                            | Not started | 2.18.0 (step 1)                |
| CO22 | Upgrade and downgrade safety: `schemaVersion` in user files, a preserving writer (`policyWriter.ts` rewrites today), `.bak` on migration, and an N-1-over-N round-trip test for levels, floor, built-ins and trust stores                                                                                                                      | M    | CI5        | the round-trip test in the release checklist                                                          | Not started | later                          |
| CO23 | Flaky budget: `scripts/ci/flaky.json` quarantine with a 14-day expiry, at most 3 entries, never under `core/tools/permissions/`; `merge-gate` retries quarantined tests once                                                                                                                                                                   | S    | CI1        | the gate fails on an expired or forbidden entry                                                       | Not started | 2.18.0                         |

### 6.2 Edits to existing rows and sections

| Where                                                                  | Change                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In progress                                                            | Remove: Patch release 2.12.1, Next release (planned), Masking follow-up, Wave-7, Egress fix #627, Docs consistency #619, Desk research #623, GitHub Actions froze; add "Release 2.16.0 (cut in progress)" |
| CI14, CI16, SB9, DR11, Next 20 piece 4, the Findings row, Suggested #1 | Replace with "see CI1" and keep CI1 as the one row; record the owner action once in Open decisions                                                                                                        |
| CI23                                                                   | State: "Resolved 2026-11-12: runs report again (Main Branch Build success 2026-11-13T00:26Z)"                                                                                                             |
| PL27                                                                   | State: "#661 closed unmerged; re-open or redo"                                                                                                                                                            |
| All "Planned; not in 2.15.0" states                                    | "Planned; target 2.18.0 or later"                                                                                                                                                                         |
| B19                                                                    | Scope adds "absorbs D9's administrator path; design in CO19"                                                                                                                                              |
| D9                                                                     | State: "user-level part built (#633); administrator path moves to B19 or CO19"                                                                                                                            |
| H5                                                                     | Depends on: add CO2 (they ship together)                                                                                                                                                                  |
| X4                                                                     | Scope adds "configurable from the Permissions page; documented in `command-checks.mdx`"                                                                                                                   |
| PV10                                                                   | Scope adds the strings in F21 and "env alias mechanism in CO21"                                                                                                                                           |
| TR2                                                                    | Note: "TR22 and TR23 closed by #740"                                                                                                                                                                      |
| Open decisions                                                         | Add rows: headless default (CO2), env alias window (CO21), JetBrains (CO18), managed tier (CO19), telemetry settings (CO11); each with "Unblocks: ..."                                                    |
| Suggested next improvements                                            | Replace with a pointer to section 3.7 of this note, or keep at most 10 items, each naming a row                                                                                                           |

## Open questions for the owner

Each has a default marked "recommended, pending owner".

1. **Headless default (CO2).** Run at the user's levels with asks refused, capped at Permissive unless `--auto`? Recommended, pending owner: yes, with a one-release escape hatch and a release-note line.
2. **Loopback `serve` token.** Require one? Recommended, pending owner: no; print the risk at startup and keep `--host` beyond loopback token-only.
3. **Agent files (CO4).** May an agent file widen permissions at all? Recommended, pending owner: no, it can only narrow.
4. **`git-ai` (CO5).** Keep it as an opt-in, or delete it? Recommended, pending owner: opt-in, off by default.
5. **Vocabulary (B8, UX7, UX12, CO10).** "Always on" for locks; Never / Ask / Always; `deny` as the written verb; "Automatic (reviewer)"; `--auto` as a deprecated alias. Recommended, pending owner: all five.
6. **Environment names (CO21).** `CONTINUOUS_*` canonical, `CONTINUE_*` warned for two even minors (2.18.0, 2.20.0), removed in 2.22.0. Recommended, pending owner: yes.
7. **JetBrains (CO18).** Park, rebrand or drop? Recommended, pending owner: park now.
8. **Managed tier (CO19).** Design now, build on the first real request? Recommended, pending owner: yes.
9. **Telemetry settings (CO11).** Deprecate now, delete in 2.20.0? Recommended, pending owner: yes.
10. **`~/.claude` hooks (CO14).** Opt-in? Recommended, pending owner: yes; existing users see a one-time notice.
11. **ROADMAP restructure (CO20).** Split into Now, Next, Later and Decisions with theme files? Recommended, pending owner: yes, done by the integrator in one docs PR after 2.16.0 is cut.
12. **Flaky budget (CO23).** Three entries, 14 days? Recommended, pending owner: yes.
13. **Branch protection (CI1).** Apply now that Actions report again? Recommended, pending owner: yes.

### Proposed ROADMAP changes (summary)

- Add Track CO with rows CO1 to CO23 (section 6.1).
- Apply the edits in section 6.2: stale In progress rows removed, branch-protection duplicates folded into CI1, CI23 resolved, PL27 corrected, odd-minor labels normalised, B19 absorbs D9's administrator path, H5 depends on CO2, new Open decisions rows.
- Adopt the structure in section 3.6 and the 2.18.0 sequence in section 3.7.
