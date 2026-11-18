# Research: competitive gap analysis (2026-11-12)

Status: research only, read from `origin/main` at `63e6e122d`. No code was changed, no model was called and `plans/ROADMAP.md` is not edited. Every proposed row is under a new prefix, `GAP`, which does not occur on `origin/main` (checked with `git grep`). Releases use even minors; "2.18.0" below means the next release.

## 1. Summary

Sixteen peers were inventoried from their own documentation, changelogs and release pages, all fetched on 2026-11-12. Every notable capability was then mapped to one of four states here: (a) shipped, (b) a ROADMAP row, (c) researched without a row, (d) absent.

1. **The peer set has changed under us.** Five of the sixteen are no longer what the ROADMAP's comparison tables assume (section 3): Roo Code is archived, upstream Continue is frozen at 2.0.0 after an acquisition, Windsurf is now Devin Desktop, Gemini CLI is in maintenance behind Antigravity CLI, and Aider has not released since February 2026.
2. **Most of what peers shipped in the last six months needs a hosted service** (cloud agents, hosted review bots, share links, mobile relays, marketplaces, chat connectors). That is the bulk of the "deliberately not building" list in section 7, and it is where a local-first tool should stay different.
3. **Fifteen capabilities are absent and fit our principles** (section 6). The top five are small and local: checkpoints in the CLI with one rewind picker, a CI recipe for headless runs, a streamed and schema-checked headless output, a sanitised transcript export, and attention notifications.
4. **On thirteen existing rows a peer's design is better than what the row says** (section 5): memory with provenance and expiry (V9), worktree hygiene (N6, N7, O3), sandbox grants and credential placeholders (W4b, W5, W8), managed policy shape (B19), skill and agent definition formats (O4, O25, O26) and session spend caps (T10).
5. **We are ahead in places that matter for this product**: rule trust and locks, the audit trail with a shared masker, per-area permission levels, loop budgets with checks, prompt-cache controls, hook fail-closed defaults and a no-default-backend web search. Three peers ship weaker defaults that we should keep refusing (section 7.2).

Proposed: 29 rows, `GAP1` to `GAP29` (section 8); 12 owner questions with defaults (section 9).

## 2. Method and limits

- **Sources.** Primary only: vendor documentation, changelogs, release pages and repositories. Each inventory line in section 4 points at a source key from section 11. Pages without a date are marked "undated" there and count as "as fetched on 2026-11-12".
- **How pages were read.** Through a fetch tool that summarises the page. Setting keys, flag names and frontmatter fields are as the summary reported them. Spot-check any key before it is quoted in a specification.
- **Coverage is uneven.** Several large pages were read in part: the Claude Code changelog (only 2.1.317 to 2.1.323), Cursor release notes (first 100k of 480k characters), the Copilot CLI reference (first 200k of 449k), Codex changelog entries before 2026-10-15 and the Cline changelog before 3.25.
- **"None found" is not proof of absence.** It means the pages fetched showed nothing.
- **Our side** was read from the tree and from `plans/`: the ROADMAP row tables, the Shipped table and the notes named in each line. The ROADMAP is 1.5 MB, so rows were located by keyword and not by reading every row; a capability marked (d) had no matching row id and no matching note for the keywords listed in section 12.
- **Not run.** No peer product was installed or executed. Nothing here is a measurement.

## 3. Peer status on 2026-11-12

| Peer              | Status                                                                                                                                                                            | Source                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Claude Code       | Active; version 2.1.323 on 2026-11-12                                                                                                                                             | CC changelog                    |
| OpenAI Codex      | Active; CLI 0.167.2 on 2026-11-11; docs moved to `learn.chatgpt.com/docs`                                                                                                         | OA changelog                    |
| Gemini CLI        | Maintenance. Its own banner says free and Google One users moved to Antigravity CLI on 2026-06-18 and that it is "not optimized for Gemini 4"; last release v0.64.0 on 2026-10-13 | GC changelog, repository README |
| Cursor            | Active; Background Agents are now Cloud Agents; own git host (Origin)                                                                                                             | CU changelog                    |
| GitHub Copilot    | Active; VS Code's Local harness is deprecated for removal in February 2027; the cloud product is "Copilot in the cloud"                                                           | VS 1.146 notes, GH docs         |
| Cline             | Active; extension rebuilt on a shared SDK runtime in v4.0.0 (26 June)                                                                                                             | CL releases                     |
| Roo Code          | **Archived on 2026-05-15**; the team moved to a cloud product; a community fork continues                                                                                         | RO repository                   |
| Kilo Code         | Active; the CLI is a fork of OpenCode and the extension was rebuilt on it                                                                                                         | KI README, docs                 |
| Zed               | Active, weekly; **removed agent checkpoints in 1.27.0 (2026-11-04)** because they slowed large repositories                                                                       | ZD releases                     |
| Windsurf, Devin   | Windsurf became Devin Desktop in v3.0.12 (2026-06-02); Cascade was removed in v3.9.19 (2026-09-08)                                                                                | DV changelog                    |
| Aider             | **Dormant**: last PyPI release 0.86.2 on 2026-02-12, last commit on `main` 2026-05-22                                                                                             | PyPI, repository                |
| OpenHands         | Active, but its CLI is "no longer actively maintained"; the product is a browser UI plus an agent server and SDK                                                                  | OH docs                         |
| Amp               | Active; rebuilt in May 2026; dropped its editor extension, custom commands, fork, to-do list and public threads                                                                   | AM chronicle                    |
| Goose             | Active, weekly; moved to `aaif-goose/goose`; removed CLI planning mode, MCP sampling and background subagents in September and October 2026                                       | GS releases                     |
| JetBrains         | Active; Junie CLI, AI Assistant 2026.3 and a new surface, Air, which hides AI Assistant when switched to                                                                          | JB docs                         |
| Upstream Continue | **Frozen**: the repository says it is read-only; 2.0.0 is the final release; the homepage says it was acquired by Cursor; the hosted hub, checks and login are gone               | UP README, homepage, commits    |

Consequence for our own documents: `feature-comparison.md` still marks our checkpoints and hooks as missing and treats Aider, Roo and upstream as moving targets. `agent-ux-parity.md` already notes the first two are out of date.

## 4. Inventory matrix

Peer columns: CC Claude Code, CX Codex, GM Gemini CLI, CU Cursor, CP Copilot, CL Cline, RO Roo Code (frozen feature set), KI Kilo Code, ZD Zed, DV Devin (was Windsurf), AI Aider, OH OpenHands, AM Amp, GS Goose, JB JetBrains (Junie, AI Assistant, Air), UP upstream Continue (frozen).

Cells: `Y` documented, `P` partial or a weaker form, `R` removed in 2026, `-` none found, `?` not verified.

The last column is our state: (a) shipped with the file or note, (b) a row, (c) researched without a row, (d) absent. `NB` marks an item on the not-building list in section 7.

### 4.1 Sessions, checkpoints and planning

| Capability                                            | CC  | CX  | GM  | CU  | CP  | CL  | RO  | KI  | ZD  | DV  | AI  | OH  | AM  | GS  | JB  | UP  | Here                                                                                                     |
| ----------------------------------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | -------------------------------------------------------------------------------------------------------- |
| File checkpoints for agent edits                      | Y   | P   | Y   | Y   | Y   | Y   | Y   | Y   | R   | Y   | Y   | -   | -   | -   | P   | -   | (a) IDE only: `plans/checkpoints.md`, `ResponseActions.tsx`; the CLI has none: (d), GAP1                 |
| One rewind picker (files, conversation or both), redo | Y   | -   | Y   | P   | Y   | Y   | Y   | Y   | -   | Y   | P   | P   | -   | -   | -   | -   | (d): redo and conversation restore are out of scope in `checkpoints.md`; GAP2                            |
| Checkpoints cover files changed by shell commands     | -   | -   | -   | ?   | ?   | Y   | -   | Y   | -   | ?   | Y   | -   | -   | -   | -   | -   | (d), stated out of scope in `checkpoints.md`; GAP3                                                       |
| Resume and fork a session                             | Y   | Y   | Y   | Y   | Y   | P   | P   | Y   | P   | Y   | P   | Y   | P   | Y   | Y   | Y   | (a) `/resume`, `/fork`, `--fork` in `extensions/cli/src/index.ts`                                        |
| Export a transcript as Markdown or HTML               | P   | Y   | P   | ?   | Y   | Y   | -   | Y   | Y   | Y   | P   | Y   | Y   | Y   | P   | -   | (a) JSON only (`/export`); (c) `research/copy-as-markdown.md`; a sanitised export is (d), GAP8           |
| Hosted share link for a session                       | P   | -   | -   | Y   | Y   | -   | -   | Y   | P   | Y   | -   | Y   | Y   | R   | -   | -   | NB                                                                                                       |
| Import sessions from another agent                    | -   | -   | -   | -   | -   | Y   | -   | Y   | Y   | -   | -   | -   | -   | -   | -   | -   | (d), GAP14                                                                                               |
| Plan mode with a plan file                            | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | Y   | -   | -   | R   | Y   | Y   | (a) `docs/ide-extensions/agent/plan-files.mdx`; (b) F7                                                   |
| Run until a stated condition (`/goal`)                | Y   | Y   | -   | Y   | -   | -   | -   | Y   | -   | Y   | -   | Y   | -   | Y   | Y   | -   | (a) Loop mode with per-item checks and budgets (stronger: the check is a command, not a model's opinion) |
| Side question outside the history                     | Y   | Y   | -   | Y   | -   | -   | -   | -   | -   | Y   | -   | -   | -   | -   | -   | -   | (d), GAP13                                                                                               |
| Queued messages and steering                          | Y   | Y   | -   | Y   | -   | Y   | Y   | -   | Y   | -   | -   | -   | Y   | -   | -   | -   | (a) `plans/agent-ux-parity.md` Q1, Q4; Q2, Q3 open there                                                 |

### 4.2 Agents, parallel work and automation

| Capability                                             | CC  | CX  | GM  | CU  | CP  | CL  | RO  | KI  | ZD  | DV  | AI  | OH  | AM  | GS  | JB  | UP  | Here                                                                              |
| ------------------------------------------------------ | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --------------------------------------------------------------------------------- |
| Subagents                                              | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | Y   | Y   | Y   | -   | (a) CLI beta (`tools/subagent.ts`); (b) O4, K8                                    |
| Custom agent definition files                          | Y   | Y   | Y   | Y   | Y   | -   | Y   | Y   | Y   | Y   | -   | Y   | Y   | Y   | Y   | -   | (b) O4                                                                            |
| Worktree per parallel agent                            | Y   | Y   | P   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | Y   | -   | Y   | -   | (a) Loop waves (`core/util/worktree.ts`); (b) O3, O8, N3 to N7                    |
| Same task on several models, pick one                  | -   | -   | -   | Y   | P   | -   | -   | Y   | P   | -   | -   | -   | -   | -   | -   | -   | (b) O8                                                                            |
| Cloud agents on vendor machines                        | Y   | Y   | -   | Y   | Y   | Y   | R   | Y   | P   | Y   | -   | Y   | Y   | -   | Y   | R   | NB                                                                                |
| Hosted PR review bot                                   | Y   | Y   | -   | Y   | Y   | -   | -   | Y   | -   | Y   | -   | -   | P   | -   | -   | R   | NB                                                                                |
| CI recipe or GitHub Action the person runs             | Y   | Y   | Y   | ?   | Y   | Y   | -   | Y   | -   | -   | -   | Y   | -   | -   | Y   | P   | (d), GAP6, GAP7                                                                   |
| Local review command                                   | Y   | Y   | -   | Y   | Y   | -   | -   | Y   | -   | P   | -   | -   | ?   | Y   | Y   | -   | (a) `extensions/cli/src/commands/review.ts`                                       |
| Review instruction file                                | Y   | Y   | -   | Y   | Y   | -   | -   | Y   | -   | Y   | -   | -   | -   | -   | -   | -   | (a) partly: `.continue/agents/*.md` review agents; base-branch read is (d), GAP29 |
| Scheduled runs on the person's machine                 | Y   | Y   | -   | -   | Y   | Y   | -   | P   | -   | -   | -   | Y   | -   | Y   | -   | -   | (d), GAP10                                                                        |
| Event-triggered automations (webhooks, chat, trackers) | Y   | Y   | -   | Y   | Y   | Y   | -   | Y   | -   | Y   | -   | Y   | Y   | -   | Y   | -   | NB                                                                                |
| Chat connectors (Slack, Teams, Telegram, Linear)       | Y   | -   | -   | Y   | Y   | Y   | -   | Y   | -   | Y   | -   | Y   | Y   | P   | Y   | -   | NB                                                                                |
| Mobile app or vendor-relayed remote control            | Y   | Y   | -   | Y   | Y   | P   | -   | Y   | P   | Y   | -   | P   | Y   | P   | Y   | -   | NB                                                                                |
| Attention notifications (OS, sound, terminal bell)     | ?   | Y   | Y   | ?   | ?   | Y   | -   | Y   | Y   | Y   | Y   | -   | Y   | Y   | -   | -   | (b) hook event only (D4); native notices are (d), GAP9                            |

### 4.3 Customisation and memory

| Capability                                    | CC  | CX  | GM  | CU  | CP  | CL  | RO  | KI  | ZD  | DV  | AI  | OH  | AM  | GS  | JB  | UP  | Here                                                          |
| --------------------------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ------------------------------------------------------------- |
| Skills (`SKILL.md`)                           | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | Y   | Y   | Y   | -   | (a) `readSkill.ts`, `/skills`, `/import-skill`; (b) O25, TR17 |
| Plugin bundles                                | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | -   | Y   | -   | Y   | Y   | Y   | P   | -   | (d), GAP15                                                    |
| Hosted marketplace or registry                | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | P   | Y   | -   | Y   | -   | -   | P   | R   | NB                                                            |
| Slash-command or prompt files                 | Y   | P   | Y   | P   | Y   | P   | Y   | Y   | P   | P   | -   | Y   | R   | Y   | Y   | Y   | (a) prompt files; (c) `research/skills-vs-prompts-toolbox.md` |
| `AGENTS.md`, nested                           | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | Y   | Y   | Y   | Y   | (a); (b) O26                                                  |
| Auto-memory across sessions                   | Y   | Y   | Y   | P   | Y   | -   | -   | Y   | -   | Y   | -   | Y   | -   | ?   | -   | -   | (b) V9, opt-in                                                |
| Output styles                                 | Y   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | NB: `modeModels.<use>.prompt` already does this               |
| Status line or footer customisation           | Y   | Y   | Y   | P   | P   | -   | -   | -   | -   | -   | -   | -   | -   | P   | -   | -   | (d), GAP16                                                    |
| Keybindings file, vim mode, themes (terminal) | Y   | Y   | Y   | P   | P   | -   | -   | Y   | -   | Y   | Y   | -   | P   | P   | Y   | -   | (d), GAP17                                                    |
| Settings import from other tools              | -   | Y   | -   | P   | P   | -   | -   | Y   | -   | Y   | -   | -   | -   | -   | Y   | -   | (a) Cline and Roo MCP import; (b) Track G                     |
| Hooks                                         | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | -   | Y   | -   | Y   | Y   | Y   | P   | -   | (a) CLI, with trust and fail-closed defaults; (b) D4 to D9    |

### 4.4 Input, tools and models

| Capability                                  | CC  | CX  | GM  | CU  | CP  | CL  | RO  | KI  | ZD  | DV  | AI  | OH  | AM  | GS  | JB  | UP  | Here                                                                                                      |
| ------------------------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --------------------------------------------------------------------------------------------------------- |
| Voice dictation                             | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | -   | Y   | Y   | Y   | Y   | Y   | Y   | -   | (d), GAP12                                                                                                |
| Image input                                 | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | (a); (b) UX23 to UX25                                                                                     |
| Web search and fetch tools                  | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | Y   | Y   | P   | ?   | ?   | Y   | Y   | Y   | (a) fetch; (b) WB1 to WB12                                                                                |
| Built-in browser automation or computer use | Y   | Y   | Y   | Y   | Y   | P   | R   | Y   | -   | Y   | -   | Y   | Y   | Y   | Y   | -   | NB as a built-in; (b) MCPW6 ships a pinned Playwright MCP template                                        |
| Notebook cell editing                       | ?   | -   | P   | ?   | ?   | Y   | -   | Y   | ?   | Y   | -   | -   | -   | -   | Y   | -   | (d), GAP11                                                                                                |
| Model fallback chain                        | Y   | -   | Y   | P   | ?   | P   | -   | Y   | -   | Y   | -   | Y   | Y   | -   | -   | -   | (c) `research/providers-models-import.md` maps it to catalog routes; RF4 covers Loop refusals only; GAP20 |
| Automatic per-request model router          | -   | -   | Y   | Y   | Y   | -   | -   | Y   | -   | Y   | -   | Y   | -   | -   | P   | -   | NB as a classifier service; (a) per-mode and per-to-do models                                             |
| Cost and context display                    | Y   | Y   | Y   | Y   | Y   | P   | Y   | Y   | P   | Y   | P   | Y   | Y   | Y   | Y   | Y   | (a) `plans/usage-display.md`; (b) Track J                                                                 |
| Hard spend cap for a session                | Y   | P   | -   | P   | Y   | -   | -   | Y   | -   | Y   | -   | Y   | -   | -   | -   | -   | (a) Loop budgets; (b) T10 headless; interactive is (d), GAP25                                             |
| MCP client: OAuth, elicitation, resources   | Y   | P   | P   | Y   | Y   | P   | P   | P   | P   | Y   | -   | P   | Y   | Y   | P   | P   | (a) OAuth, `mcpElicitation.ts`; (b) O23, MCPW24, UX30                                                     |
| MCP Apps (server-supplied UI)               | -   | -   | -   | Y   | Y   | -   | -   | -   | -   | -   | -   | -   | -   | Y   | -   | -   | (a) `MCPAppRenderer.tsx`; hardening proposed as X26 in `research/area-injection-tool-exposure-web.md`     |
| Language-server tools for the agent         | Y   | -   | -   | ?   | Y   | -   | -   | -   | P   | -   | -   | -   | -   | -   | Y   | -   | (b) L2, L5, L6                                                                                            |
| Lint or test command re-run after edits     | P   | -   | -   | -   | -   | -   | -   | -   | -   | -   | Y   | -   | -   | P   | -   | -   | (a) inside Loop (`check:`); outside Loop (c) `research/area-loop-planning-waves-reliability.md`           |
| Watch files for `AI!` comments              | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | Y   | -   | -   | -   | -   | -   | (d), GAP19                                                                                                |

### 4.5 Safety, policy and integration surfaces

| Capability                                        | CC  | CX  | GM  | CU  | CP  | CL  | RO  | KI  | ZD  | DV  | AI  | OH  | AM  | GS  | JB  | UP  | Here                                                                                                |
| ------------------------------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --------------------------------------------------------------------------------------------------- |
| Permission modes and rules                        | Y   | Y   | Y   | Y   | Y   | P   | Y   | Y   | Y   | Y   | P   | P   | P   | Y   | Y   | Y   | (a) five levels per area, `toolPermissions`, `permissions test`                                     |
| Model reviewer for approvals                      | Y   | Y   | Y   | Y   | Y   | -   | -   | -   | -   | Y   | -   | Y   | P   | Y   | -   | -   | (a) reviewer role and Auto (B3, B4)                                                                 |
| OS sandbox for commands                           | Y   | Y   | Y   | Y   | Y   | ?   | -   | Y   | Y   | Y   | -   | P   | P   | P   | Y   | -   | (a) container and WSL executors; (b) W4b, W4c, W8                                                   |
| Native Windows sandbox                            | -   | Y   | Y   | -   | P   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | (b) W9, W15, W16 research                                                                           |
| Credential placeholders inside the sandbox        | ?   | -   | -   | -   | Y   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | (b) W5 for the model key only; general form (c) `plans/jail-network.md`; GAP24                      |
| Managed, administrator-level settings             | Y   | Y   | Y   | Y   | Y   | Y   | -   | Y   | P   | Y   | -   | P   | Y   | P   | Y   | -   | (b) B19, D9                                                                                         |
| Local audit trail of decisions                    | -   | -   | -   | P   | P   | -   | -   | P   | -   | -   | -   | P   | -   | -   | -   | -   | (a) `continuous audit`, `docs/ide-extensions/agent/audit-trail.mdx`; peers mostly offer hosted logs |
| OpenTelemetry export                              | Y   | Y   | Y   | Y   | ?   | Y   | -   | Y   | -   | Y   | -   | Y   | -   | Y   | -   | -   | (a) opt-in, `CONTINUOUS_OTEL=1` in `telemetryService.ts`                                            |
| Headless run with JSON output                     | Y   | Y   | Y   | Y   | Y   | Y   | Y   | Y   | -   | P   | P   | P   | Y   | Y   | Y   | Y   | (a) `-p --format json`                                                                              |
| Streamed JSON events, schema-checked final output | Y   | Y   | Y   | Y   | P   | Y   | Y   | P   | -   | ?   | -   | -   | P   | Y   | Y   | -   | (d), GAP4, GAP5                                                                                     |
| SDK in TypeScript or Python                       | Y   | Y   | -   | Y   | Y   | Y   | -   | -   | -   | -   | P   | Y   | Y   | Y   | -   | -   | (d), GAP18; `cn serve` exists and is hidden                                                         |
| ACP agent (an editor drives the CLI)              | ?   | -   | Y   | Y   | Y   | Y   | -   | Y   | -   | Y   | -   | P   | -   | Y   | Y   | -   | (a) first slice (O10, #473); (b) O24                                                                |
| ACP client (drive other agents)                   | -   | -   | -   | -   | P   | P   | -   | -   | Y   | -   | -   | Y   | -   | Y   | Y   | -   | (b) O17, reserved shape only                                                                        |
| Per-change accept and reject in the editor        | Y   | P   | Y   | ?   | Y   | P   | P   | P   | Y   | ?   | -   | -   | P   | -   | Y   | Y   | (a) Edit mode, inherited from upstream; agent edits not verified here                               |
| Autocomplete and next edit                        | -   | -   | -   | Y   | Y   | -   | -   | P   | Y   | Y   | -   | -   | R   | -   | Y   | Y   | (a) `core/autocomplete`, `core/nextEdit`                                                            |
| Background shell jobs                             | Y   | Y   | Y   | ?   | Y   | Y   | -   | Y   | -   | Y   | -   | -   | -   | -   | -   | Y   | (a) CLI `/jobs`, `BackgroundJobService.ts`                                                          |
| Commit message and PR text generation             | P   | -   | -   | ?   | Y   | P   | -   | Y   | Y   | Y   | Y   | -   | Y   | -   | Y   | -   | (a) legacy `/commit`; (c) `research/toolbox-default-catalogue.md`                                   |

## 5. Existing rows where a peer's design is better

Each line names the row, what the peer does and what to take. None of these needs a new track; GAP rows are proposed only where the change is more than a sentence in the existing row.

| Row                                         | Peer design                                                                                                                                                                                                                                                                                                                                                                                                   | What to take                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V9 (opt-in repository notes)                | Copilot checks a memory's citation against the code before using it, lets it expire (90 days by default) and marks subagents read-only (CP-MEM). OpenHands injects only an index, capped near 6,000 characters and wrapped as untrusted content (OH-MEM). Kilo keeps typed files, a secret filter and a cheap separate memory model (KI-MEM). Devin tags each entry with its source session and date (DV-MEM) | Provenance, expiry, index-only injection wrapped as untrusted, and a check that a cited path still exists. V9 has the load budget and scrub already. GAP21                                             |
| N6, N7, O3 (worktrees)                      | `.worktreeinclude` in gitignore syntax copies untracked files into a new worktree (CC, CX, RO). Cursor caps worktrees at 25 and removes the oldest; Codex keeps 15 and snapshots a worktree before deleting it; Zed saves a worktree's git state when its thread is archived (CU-WT, CX-WT, ZD-PAR)                                                                                                           | N6 proposes linking `node_modules`; a declarative include file is the wider answer. Add a count cap and a snapshot before removal to N7. GAP22                                                         |
| O8 (best of N)                              | Cursor `/best-of-n` and Kilo's multi-version mode run one prompt on up to four models, one worktree each, and the person applies one (CU-WT, KI-AM)                                                                                                                                                                                                                                                           | Cap N at four, show diffs side by side, charge the shared budget (T4). Note in O8                                                                                                                      |
| W4b, W8 (sandbox executor and policy)       | Zed grants are narrow and named (hosts, write paths), the agent must give a reason and the person picks once, thread or always; `.git` is never writable (ZD-SB). Kilo lets project config only tighten the sandbox and gives `.git` a one-shot escalation (KI-SB)                                                                                                                                            | Our W8a compiler already derives a config from rules. Take the grant prompt with a reason and three scopes, and the tighten-only rule for project files. GAP23                                         |
| W5 (key outside the jail)                   | VS Code replaces secret environment values with placeholders inside the sandbox and injects the real value only on HTTPS requests to listed hosts through a local CA (CP-SB)                                                                                                                                                                                                                                  | W5 does this for the model key only. The general form protects registry tokens and cloud keys too. Large. GAP24                                                                                        |
| B19 (managed policy layer)                  | Codex `requirements.toml` constrains by allow-list (allowed approval policies, sandbox modes, web-search modes, MCP servers) and is read from a system path or MDM (CX-ENT). Cline has `allowedMCPServers` and `blockPersonalRemoteMCPServers` (CL-ENT). Cursor has an admin switch to disable headless mode (CU-HL)                                                                                          | Shape B19 as constraints (allowed values) over locked values, and include an MCP server allow-list and a headless switch. Note in B19                                                                  |
| O4 (agent definitions)                      | Nine peers read Markdown agent files with frontmatter; several read `.claude/agents` and `.agents/agents` as well as their own folder (CU-SA, JB-SA, GS-AG). Codex states that an agent file cannot override sandbox mode, approval policy or MCP servers (CX-SA)                                                                                                                                             | Read `.agents/agents` and `.claude/agents`; adopt the Codex rule in our words: a definition can remove permissions and never add them. `agent-ux-parity.md` decision 7 already says this for subagents |
| O25 (skills)                                | `.agents/skills` is the shared path in ten peers. Kilo runs a skill's embedded shell only from trusted global locations (KI-SK). Gemini asks consent when a skill activates (GM-SK). Amp lets a skill carry MCP servers whose tools stay hidden until the skill loads (AM-SK). Cursor and OpenHands add `paths` frontmatter (CU-SK, OH-SK)                                                                    | O25 has discovery and a validator. Add `disable-model-invocation`, `paths`, and skill-scoped MCP servers hidden until load, which also serves Track Z. GAP26                                           |
| O26 (`AGENTS.md`)                           | Gemini, Amp, Goose and Kilo load a subdirectory's file lazily when a file under it is touched; Cursor de-duplicates identical `AGENTS.md` and `CLAUDE.md` content (GM-MEM, AM-MEM, GS-MEM, KI-MEM, CU-RN)                                                                                                                                                                                                     | Lazy loading keeps the cached prefix stable (C55). Note in O26                                                                                                                                         |
| T10 (caps outside loops)                    | Claude Code `--max-budget-usd`; Copilot `/limits set` with a notice at 90 percent; Codex budget reminders (CC-CLI, CP-REF, CX-CFG)                                                                                                                                                                                                                                                                            | T10 covers headless flags. The interactive session has no cap. GAP25                                                                                                                                   |
| D4, D7 (hook events and filters)            | Cursor's `stop` hook returns a follow-up message under a `loop_limit`; OpenHands accepts both its own snake case and Claude Code's Pascal case; three peers have an `mcp_tool` handler (CU-HK, OH-HK, CC-HK)                                                                                                                                                                                                  | D4 already proposes a continuation cap of three. Add the `mcp_tool` handler only after TR1 decides role access. Note in D4                                                                             |
| WB6, WB10 (URL provenance, provider search) | VS Code approves a URL in two steps: trust the domain, then review the fetched content before it reaches the model (CP-SEC). Codex names web-search modes `cached`, `live` and `disabled` and lets an administrator restrict them (CX-SEC)                                                                                                                                                                    | The second step (review before the model reads it) is stronger than WB6's ask. Note in WB6                                                                                                             |
| O24, O10 (ACP)                              | ACP stabilised session list, resume, close and delete, a usage update and elicitation during 2026, and a registry lists 45 agents that editors install in one click (ACP-UP, ACP-REG)                                                                                                                                                                                                                         | O24 covers list and resume. A registry entry is a separate, small decision. GAP27                                                                                                                      |

## 6. Absent capabilities, ranked

Ranked by value to a privacy-first, local-first tool over cost. Size: S under two days, M three to five, L more.

### 6.1 Checkpoints in the CLI, one rewind picker, redo

- **What.** Twelve peers snapshot files before agent edits. The stronger ones offer one picker: restore files, restore the conversation, or both, and a redo.
- **Who.** Claude Code `/rewind` with five actions (CC-CKPT); Kilo "Revert to here" with Redo and Redo All (KI-CKPT); Cline's three restore modes (CL-CKPT); Copilot CLI `/rewind` (CP-REL); Devin `/revert` and `/steps` (DV-CMD).
- **Here.** The IDE restores files per turn. The CLI has no checkpoints (`agent-ux-parity.md`), conversation restore is separate from file restore, and `checkpoints.md` puts redo out of scope.
- **Value.** High. An undo that needs no git and no network is what makes higher permission levels reasonable to use. W8c already depends on "a checkpoint before the command".
- **Fit.** Good. Keep our per-file snapshots: Zed removed checkpoints on 2026-11-04 because whole-repository snapshots hung large repositories (ZD-REL), and shadow git repositories (Cline, Kilo, Gemini) conflict with our no-git requirement.
- **Size and dependencies.** M for the CLI (GAP1), M for the picker and redo (GAP2); builds on #185 and the session format (V4).
- **Recommendation.** Build in 2.18.0.

### 6.2 Files changed by shell commands

- **What.** A checkpoint that also covers what a terminal command changed.
- **Who.** Cline and Kilo (whole-tree shadow git), Aider (commits).
- **Here.** Out of scope in `checkpoints.md`, and said so in the confirm dialog.
- **Value.** Medium to high: the gap is exactly where the agent is least predictable.
- **Fit.** Only in a bounded form. Snapshot the targets the command analysis names as writes (Track P), and after the command list what else changed as "not restorable". Never a whole-tree snapshot.
- **Size and dependencies.** M; GAP1, Track P, X18.
- **Recommendation.** Later, after GAP1. GAP3.

### 6.3 A CI recipe for headless runs

- **What.** A documented workflow that runs the CLI on a pull request and posts a review.
- **Who.** Claude Code, Codex (`openai/codex-action`), Gemini (`run-gemini-cli`), Junie, OpenHands and Kilo ship actions; Cline documents a workflow in two jobs, where a read-only job writes the review as an artifact and a separate write-scoped job posts it, and fork pull requests are skipped (CL-PR).
- **Here.** `continuous review` exists; there is no CI page and `docs/cli` holds one file.
- **Value.** High for teams: the review runs on their runner, with their key, against the model host they chose. No vendor app reads the repository.
- **Fit.** Good as documentation and a sample. A hosted bot is on the not-building list.
- **Size and dependencies.** S for the recipe (GAP6) once GAP4 and T10 exist; CI22 for pinned actions. A published composite action (GAP7) is an owner decision.
- **Recommendation.** Build the recipe in 2.18.0; the action later.

### 6.4 Streamed events and a schema-checked result in headless mode

- **What.** A line-delimited event stream (start, message, tool call, tool result, permission decision, result), a final message validated against a JSON Schema, and documented exit codes.
- **Who.** Claude Code `--output-format stream-json` and `--json-schema`; Codex `codex exec --json` and `--output-schema`; Gemini `stream-json` with exit codes; Cline NDJSON; Goose `stream-json`; Amp states it copies Claude Code's stream format (CC-CLI, CX-EXEC, GM-HL, CL-CLI, GS-RUN, AM-SJ).
- **Here.** `-p --format json` gives one object at the end.
- **Value.** High. It is the base for CI, for scheduled runs and for any client library, and it lets a script see a refusal or a denied tool as it happens.
- **Fit.** Good. Events must go through the audit masker so a stream is no wider than the audit trail.
- **Size and dependencies.** S each (GAP4, GAP5); T10, H5, TR9.
- **Recommendation.** Build in 2.18.0.

### 6.5 Sanitised transcript export

- **What.** Export a session as Markdown or self-contained HTML, with a switch that masks secrets and paths.
- **Who.** Kilo `kilo export --sanitize` (KI-SESS); Goose Markdown, JSON, YAML and an HTML viewer (GS-CLI); OpenHands Markdown or HTML (OH-CONV); Codex `/export`; Cline HTML.
- **Here.** `/export` writes JSON. `research/copy-as-markdown.md` covers copying a reply.
- **Value.** High for a tool whose users cannot use share links: a file they inspect and send themselves is the local-first answer to sharing.
- **Fit.** Good. The masker and its canary suite exist (#544 and after).
- **Size and dependencies.** S; the audit masker, `copy-as-markdown.md`.
- **Recommendation.** Build in 2.18.0. GAP8.

### 6.6 Attention notifications

- **What.** A terminal bell or OS notice when a turn ends, an approval waits or a loop stops.
- **Who.** Codex (`tui.notifications`, a `notify` program), Gemini (`osc9`, `osc777`, `bell`), Zed, Aider, Goose, Cline. Kilo's rules are the careful ones: errors wait until the turn closes, repeats are dropped and subagents never alert (KI-NOT).
- **Here.** A `Notification` hook event is planned in D4; nothing native.
- **Value.** Medium to high for Loop mode, where the person leaves and comes back.
- **Fit.** Good: local, no network. The text must carry names and states only, as the inbox does (O18).
- **Size and dependencies.** S; D4, O18.
- **Recommendation.** Build in 2.18.0, off by default. GAP9.

### 6.7 Scheduled runs on the person's machine

- **What.** Run a saved prompt or plan on a schedule.
- **Who.** Cline `cline schedule` inside a hub daemon with one catch-up run (CL-SCHED); Goose `goose schedule` with cron and recipes (GS-CLI); Claude Code `/loop` and desktop tasks; Copilot local automations with cron (VS-145). Devin's automations add a preflight script that decides whether to run before any model cost (DV-AUT).
- **Here.** Nothing; `feature-comparison.md` lists it as "no".
- **Value.** Medium: nightly dependency checks and audits without a cloud scheduler.
- **Fit.** Good only without a daemon. Write an entry for the OS scheduler (Task Scheduler, launchd, a systemd timer) that calls the headless CLI; every run needs a budget and keeps the deny floor.
- **Size and dependencies.** M; GAP4, T10, O18.
- **Recommendation.** Later. GAP10.

### 6.8 Notebook cell editing

- **What.** Read and edit `.ipynb` by cell, so an edit cannot corrupt the JSON and outputs do not flood the context.
- **Who.** Devin `notebook_read` and `notebook_edit` (DV-CLG); Cline's cell-aware editing (CL-NB); JetBrains AI Assistant; Kilo Desktop. Gemini only stopped "correcting" notebook JSON (GM-REL).
- **Here.** Nothing; the edit tools treat a notebook as text.
- **Value.** Medium, and specific: data and ML users are a natural audience for local models.
- **Fit.** Good. Outputs can hold data, so they are stripped from the request with a size note.
- **Size and dependencies.** M; checkpoints.
- **Recommendation.** Later. GAP11.

### 6.9 Voice dictation with a local backend

- **What.** Push-to-talk that fills the input.
- **Who.** Thirteen peers. Two designs suit us: Gemini's local Whisper backend (GM-CFG) and Kilo's "any OpenAI-compatible `/audio/transcriptions` endpoint" (KI-STT). Goose has a local option too.
- **Here.** Nothing.
- **Value.** Medium; an accessibility gain as well as a convenience.
- **Fit.** Only with no default backend, as WB1 does for search: the feature is absent until the person names an endpoint, the host goes through the egress allowlist, and the text lands in the input for review and is never sent on its own.
- **Size and dependencies.** M; PV3, the WB1 pattern.
- **Recommendation.** Later; owner decision. GAP12.

### 6.10 Side question

- **What.** Ask about the current context without adding the exchange to the history.
- **Who.** Claude Code `/btw`, Codex `/side`, Cursor `/side`, Devin side chats.
- **Here.** Nothing.
- **Value.** Medium, and cheap for us in particular: the answer reads the cached prefix and writes nothing, so the cache ledger stays warm.
- **Fit.** Good; no tools in the side turn.
- **Size and dependencies.** S; the cache ledger.
- **Recommendation.** Later. GAP13.

### 6.11 Import sessions from another agent

- **What.** Read another tool's saved sessions.
- **Who.** Cline Desktop and Kilo import Claude Code and Codex sessions; Zed imports threads over ACP (CL-DESK, KI-SESS, ZD-EXT).
- **Here.** Track G imports settings, not sessions.
- **Value.** Medium for people arriving from archived or frozen tools (Roo, upstream).
- **Fit.** Good under the G10 adapter contract: transcript only, tool results kept as text, nothing re-executed, credentials never read.
- **Size and dependencies.** M; G0, G10, V4.
- **Recommendation.** Later. GAP14.

### 6.12 Plugin bundles without a marketplace

- **What.** A folder with a manifest that carries skills, agents, hooks and MCP servers together.
- **Who.** Claude Code, Codex, Cursor, Copilot, Devin, OpenHands, Goose, Gemini, Kilo, Cline. Several read each other's manifests: Devin and OpenHands fall back to `.claude-plugin/plugin.json`, Cursor reads a root `plugin.json` (DV-PLG, OH-PLG, CU-PL).
- **Here.** Each piece exists on its own; nothing bundles them. `feature-comparison.md` skipped "plugin marketplace".
- **Value.** Medium: one reviewable unit for a team's setup.
- **Fit.** Only as a local format. Installed from a path or a git URL the person types; every component passes the trust gate it already has (hook trust, MCP launch pins, rule trust); code plugins that run in-process (Claude Code mods, Cline and Kilo TypeScript plugins) are out.
- **Size and dependencies.** M; O25, D2, Track MCPW, the toolbox loader.
- **Recommendation.** Later; owner decision. GAP15.

### 6.13 A configurable CLI footer

- **What.** Choose what the status line shows, or have a command print it.
- **Who.** Claude Code (a custom status line), Codex `/statusline`, Gemini `ui.footer.items`.
- **Here.** A fixed footer; V1 plans a memory segment.
- **Value.** Low to medium. We have more to show than most: level, cache state, budget.
- **Fit.** Good; a command-driven line gets a timeout and no secrets on stdin.
- **Size and dependencies.** S; V1, J6.
- **Recommendation.** Later. GAP16.

### 6.14 Keybindings file and vim mode in the CLI

- **What.** A user file that rebinds keys; modal editing in the input.
- **Who.** Claude Code, Codex (`/keymap`, `/vim`), Gemini (`keybindings.json`, `/vim`), Amp (`amp.keymap`), Aider (`--vim`).
- **Here.** Nothing found.
- **Value.** Low to medium; terminal users ask for it.
- **Fit.** Neutral.
- **Size and dependencies.** M; UX31.
- **Recommendation.** Later. GAP17.

### 6.15 A client library for `cn serve`

- **What.** A typed client so scripts drive a session without parsing terminal output.
- **Who.** Claude Code, Codex, Cursor, Cline, Amp and OpenHands ship TypeScript or Python SDKs; Codex's Python SDK is a thin client of its app server (CX-SDK), which is the shape that fits us.
- **Here.** `cn serve` has a token check (#438) and is hidden from help.
- **Value.** Medium for integrators; none for most users.
- **Fit.** Good, but it turns the serve routes into a public contract.
- **Size and dependencies.** M; H5, O2, a versioned route schema.
- **Recommendation.** Later; owner decision. GAP18.

### 6.16 Lower-ranked

- **Watch files for marked comments** (Aider `--watch-files`, `AI!` and `AI?`). Local and cheap, but the IDE already gives a closer loop. Later, low. GAP19.
- **Deep links** to open a session or plan in the editor (Claude Code `claude-cli://`, Junie `junie://sessions/<id>`). Later, low. GAP28.

## 7. Deliberately not building

### 7.1 Capabilities

| Capability                                                  | Who has it                                                                                      | Why not                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloud agents on vendor machines                             | Claude Code, Codex, Cursor, Copilot, Cline, Kilo, Devin, Amp, OpenHands, JetBrains Air          | Needs a hosted service that receives the repository. The local answers are worktrees (O3, O8) and the container and sandbox executors (Track W)                                                                                |
| Hosted PR review bot or GitHub App                          | Claude Code, Codex, Cursor Bugbot, Copilot, Kilo, Devin                                         | Same. The recipe in GAP6 gives the review on the person's runner                                                                                                                                                               |
| Hosted share links and public threads                       | Cursor, Copilot, Kilo, Devin, Amp, OpenHands Cloud                                              | A transcript on our server is the opposite of the product. GAP8 gives a file. Note that Goose and Amp both withdrew public sharing in 2026                                                                                     |
| Hosted marketplace or registry                              | Most peers                                                                                      | A catalogue we operate is egress, moderation and supply-chain duty. GAP15 keeps bundles local                                                                                                                                  |
| Mobile apps and vendor-relayed remote control               | Claude Code, Codex, Cursor, Copilot, Kilo, Devin, Amp                                           | Needs a relay. `cn serve` with a token on the person's own network or tunnel is the supported form                                                                                                                             |
| Chat connectors (Slack, Teams, Telegram, Linear)            | Cline, Cursor, Copilot, Kilo, Devin, Amp, OpenHands                                             | Each one is a standing outbound channel carrying task text. An MCP server the person configures can do this under the existing rules                                                                                           |
| Event-triggered cloud automations                           | Cursor, Codex, Devin, OpenHands, Copilot                                                        | Needs an inbound endpoint. GAP10 covers the local schedule                                                                                                                                                                     |
| Cloud memory, nightly consolidation, memory from other apps | Devin "dreaming", Codex "Computer History", Copilot repository memory shared with collaborators | Memory stays a local file the person can read and delete (V9)                                                                                                                                                                  |
| Built-in browser automation and computer use                | Claude Code, Codex, Cursor, Copilot, Gemini, Kilo, Devin, Amp, Junie                            | A browser driven by the model is the widest injection surface there is (Track X). The pinned Playwright MCP template (MCPW6) is the route, under tool rules and the tainted-session rule. Roo removed its browser tool in 3.48 |
| Classifier-based automatic model router                     | Cursor Router, Kilo auto, Devin Adaptive, Gemini's router                                       | Sends each request to a classifier, usually hosted, and makes cost and cache behaviour unpredictable. We let the person say which model does what (Track M)                                                                    |
| Telemetry on by default                                     | Kilo's CLI ships OpenTelemetry on by default; Roo used PostHog on by default                    | Ours is opt-in (`CONTINUOUS_OTEL=1`) and stays so                                                                                                                                                                              |
| Desktop app                                                 | Claude Code, Codex, Cline, Kilo, Copilot, Devin                                                 | A third surface to secure and release. The extension and the CLI are the product                                                                                                                                               |
| Image generation                                            | Cursor, Cline, Kilo, Amp                                                                        | Not a coding-assistant need; another model host                                                                                                                                                                                |
| Prompt suggestions and unprompted side-agent notes          | Claude Code, Devin Coach                                                                        | Extra model calls nobody asked for: cost, cache writes and more text to trust                                                                                                                                                  |
| Code mode (the model writes a script that calls its tools)  | Claude Code (experimental), Codex, Goose                                                        | One approval covers many tool calls, which breaks per-call policy and the audit record. Revisit only if each inner call is mediated; `plans/tool-call-styles.md` mentions it                                                   |
| In-process code plugins                                     | Claude Code mods, Cline and Kilo TypeScript plugins, Amp plugins                                | Third-party code inside the process that holds the keys. Hooks and MCP servers are the extension points                                                                                                                        |
| Output styles as a separate mechanism                       | Claude Code                                                                                     | `modeModels.<use>.prompt` and `prompts:` blocks already do it; a second mechanism would be a second cache segment                                                                                                              |
| Own git host, hosted app publishing                         | Cursor Origin and Live Apps, Zed Delta                                                          | Out of scope                                                                                                                                                                                                                   |

### 7.2 Defaults we should keep refusing

- **A queued message that implicitly approves the pending action** (Roo, RO-MQ). `agent-ux-parity.md` decision 3 already forbids it.
- **Approving a subagent spawn approves everything it does** (Cline, CL-SUB). `feature-comparison.md` says to avoid it; K8 and O4 keep "ask" as "ask".
- **Tools run without asking by default** (Amp: "By default, Amp runs tools without asking you first", AM-TOOLS) and **headless runs default to auto-approve** (Cline CLI, CL-CLI). Our headless runs keep deny, the floor and protected paths.
- **A reviewer that fails open** (Goose adversary mode, GS-ADV). Ours fails closed.
- **ACP permission requests auto-approved** when driving an external agent (OpenHands, OH-ACP). Any future ACP client (O17) must forward them to the person.

## 8. Proposed ROADMAP rows

For the integrator; this note does not edit `plans/ROADMAP.md`. Columns follow Track RF. "Release" is a recommendation pending the owner.

### Track GAP: gaps found by the competitive review of 2026-11-12

Plan: [`research/competitive-gap-analysis.md`](./competitive-gap-analysis.md).

| ID    | Scope                                                                                                                                                                                                                                                                                                   | Size | Depends on                                       | State                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------ | ------------------------------- |
| GAP1  | Checkpoints in the CLI: per-file snapshots before `Edit`, `MultiEdit` and `Write`, on the core checkpoint module with the same caps, saved with the session; no git and no whole-tree snapshot                                                                                                          | M    | #185, V4                                         | Proposed; 2.18.0                |
| GAP2  | One rewind picker in the IDE and the CLI: restore files, restore the conversation, or both, with the list of files that will change; redo until the next edit (checkpoints after the target are kept until a new turn writes)                                                                           | M    | GAP1                                             | Proposed; 2.18.0                |
| GAP3  | Shell-changed files: before a terminal command, snapshot the write targets the command analysis names; afterwards list other changed files as "not restorable"; bounded by the checkpoint caps                                                                                                          | M    | GAP1, Track P, X18                               | Proposed; later                 |
| GAP4  | Headless output contract: `--format stream-json` (start, message, tool call, tool result, permission decision, result) through the audit masker, documented exit codes (done, error, refused, over budget, permission needed), `--max-turns`                                                            | S    | T10, H5                                          | Proposed; 2.18.0                |
| GAP5  | `--output-schema <file>`: the final message validated against a JSON Schema, one repair turn, a distinct exit code on failure                                                                                                                                                                           | S    | GAP4, TR9                                        | Proposed; 2.18.0                |
| GAP6  | CI recipe: `docs/cli/ci.mdx` and a sample workflow in two jobs (a read-only job runs `continuous review` and uploads the result; a write-scoped job posts it), fork pull requests skipped, actions pinned by SHA, the person's own key and model host, a budget required                                | S    | GAP4, T10, CI22                                  | Proposed; 2.18.0                |
| GAP7  | A composite action in this repository that wraps GAP6, published only after the recipe has run on our own pull requests for one release                                                                                                                                                                 | S    | GAP6                                             | Proposed; later; owner decision |
| GAP8  | Sanitised export: `/export --format md` and `html`, and an IDE "Export session" action, with `--sanitize` passing text, tool arguments and results through the audit masker; a canary test proves a planted secret does not reach the file                                                              | S    | the audit masker, `research/copy-as-markdown.md` | Proposed; 2.18.0                |
| GAP9  | Attention notifications, off by default: terminal bell, OSC 9 or OSC 777 in the CLI and a VS Code notification when a turn ends, an approval waits or a loop stops; names and states only; sent at the end of the turn, repeats dropped, never from a subagent                                          | S    | D4, O18                                          | Proposed; 2.18.0                |
| GAP10 | Scheduled runs without a daemon: `continuous schedule add, list, remove, run-now` writes an entry for the OS scheduler that calls the headless CLI; a budget is required, the deny floor holds, an optional preflight command decides whether to run, one catch-up after downtime, results in the inbox | M    | GAP4, T10, O18                                   | Proposed; later                 |
| GAP11 | Notebook tools: read and edit `.ipynb` by cell; outputs are left out of the request with a size note; edits count as file edits for permissions and checkpoints                                                                                                                                         | M    | #185                                             | Proposed; later                 |
| GAP12 | Voice dictation with no default backend: push-to-talk that sends audio only to an OpenAI-compatible transcription endpoint the person configured (a local server is the documented case); the host is on the egress allowlist; the text lands in the input and is never sent on its own                 | M    | PV3, WB1 pattern                                 | Proposed; later; owner decision |
| GAP13 | Side question (`/btw`): one answer from the current context with no tools, not written to the history, reading the cached prefix and writing none                                                                                                                                                       | S    | the cache ledger                                 | Proposed; later                 |
| GAP14 | Import sessions from Claude Code and Codex as read-only transcripts under the Track G adapter contract: tool results kept as text, nothing re-executed, credential files never read                                                                                                                     | M    | G0, G10, V4                                      | Proposed; later                 |
| GAP15 | Local plugin bundles: read a folder with a `plugin.json` (the `.claude-plugin/plugin.json` location accepted) holding skills, agents, hooks and MCP servers; installed from a path or a git URL the person types; each component passes its existing trust gate; no catalogue and no in-process code    | M    | O25, D2, Track MCPW                              | Proposed; later; owner decision |
| GAP16 | CLI footer: a setting that picks the items (model, effort, mode, level, cost, context, cache state, branch) and an optional command that receives JSON on stdin, with a timeout                                                                                                                         | S    | V1, J6                                           | Proposed; later                 |
| GAP17 | CLI keybindings file and a vim mode for the input                                                                                                                                                                                                                                                       | M    | UX31                                             | Proposed; later                 |
| GAP18 | A typed TypeScript client for `cn serve`, generated from a versioned route schema; `serve` shown in help once the schema is frozen                                                                                                                                                                      | M    | H5, O2, #438                                     | Proposed; later; owner decision |
| GAP19 | Opt-in `continuous watch`: act on `AI!` and answer `AI?` comments in saved files                                                                                                                                                                                                                        | S    | none                                             | Proposed; later (low)           |
| GAP20 | Model fallback: `modeModels.<use>.fallback` as an ordered list used on overload and transient errors only; never from a local host to a remote one unless the person listed it; the turn shows the model that answered (M7) and the cache cost of the switch                                            | S    | M7, C58, RF4                                     | Proposed; 2.18.0                |
| GAP21 | Repository notes, added to V9: each entry carries its source session and date, expires (90 days by default), is injected as an index wrapped as untrusted content, and is dropped when the path it cites no longer exists                                                                               | S    | V9                                               | Proposed; with V9               |
| GAP22 | Worktree hygiene: `.worktreeinclude` in gitignore syntax for untracked files to copy, a cap on kept worktrees with oldest-first removal, and the worktree's diff saved before it is removed                                                                                                             | S    | N6, N7, O3                                       | Proposed; 2.18.0                |
| GAP23 | Sandbox grants: a confined command that needs a host or a path asks with the name and a reason, scoped once, this session or always; project files can only tighten the sandbox; `.git` is read-only with a one-shot escalation                                                                         | M    | W4b, W8, W8a                                     | Proposed; with W8               |
| GAP24 | Credential placeholders in the sandbox: secret environment values are replaced inside the jail and the egress proxy injects the real value only for the hosts listed for that secret                                                                                                                    | L    | W5, W6                                           | Proposed; later                 |
| GAP25 | A spend cap for interactive sessions: `/limits` and a setting, a note at 80 percent, stop or ask at the limit, the same pre-call check as T11                                                                                                                                                           | S    | T10, T11                                         | Proposed; 2.18.0                |
| GAP26 | Skill frontmatter: `disable-model-invocation`, `paths`, and MCP servers declared by a skill whose tools stay out of the tool list until the skill loads; embedded shell in a skill runs only from the user-level folder                                                                                 | M    | O25, TR1, Track Z                                | Proposed; later                 |
| GAP27 | List `continuous acp` in the ACP agent registry once session list and resume exist                                                                                                                                                                                                                      | S    | O10, O24                                         | Proposed; later; owner decision |
| GAP28 | Deep links that open a session or a plan file in the editor                                                                                                                                                                                                                                             | S    | none                                             | Proposed; later (low)           |
| GAP29 | `continuous review` reads its instruction file from the base ref, so a pull request cannot change its own review policy; an option to report only high-severity findings                                                                                                                                | S    | none                                             | Proposed; 2.18.0                |

Recommended for 2.18.0: GAP1, GAP2, GAP4, GAP5, GAP6, GAP8, GAP9, GAP20, GAP22, GAP25, GAP29 (eleven rows, nine of them S).

Notes for existing rows, as sentences and not new rows: O8 (cap N at four, shared budget), B19 (constraints by allow-list, an MCP allow-list, a headless switch), O4 (read `.agents/agents` and `.claude/agents`; a definition never adds permissions), O26 (lazy subdirectory loading, de-duplicate identical files), D4 (`mcp_tool` handler after TR1), WB6 (review fetched content before the model reads it).

## 9. Open owner questions

Each has a default marked "recommended, pending owner".

1. **Is a CI recipe in scope?** It sends a diff to the model host the person configured, on their runner. Recommended, pending owner: yes, as documentation and a sample (GAP6); no hosted app.
2. **Do we publish a GitHub Action?** Recommended, pending owner: not until the recipe has run on our own pull requests for one release (GAP7).
3. **May checkpoints use git when it is present?** `checkpoints.md` says not to rely on it. Recommended, pending owner: keep that; snapshot named targets only (GAP3).
4. **Is voice input wanted at all?** Recommended, pending owner: later, only with an endpoint the person configures, no default (GAP12).
5. **Scheduled runs: the OS scheduler or our own daemon?** Recommended, pending owner: the OS scheduler; no daemon (GAP10).
6. **Do we read other tools' plugin manifests?** Recommended, pending owner: yes, read-only and local; no catalogue (GAP15).
7. **May a fallback cross from a local model to a remote one?** Recommended, pending owner: never implicitly; only when the person lists the remote model (GAP20).
8. **Do we list the CLI in the ACP registry, a third-party catalogue?** Recommended, pending owner: yes, after O24 (GAP27).
9. **Do we commit to `cn serve` as a public API?** Recommended, pending owner: not in 2.18.0; freeze a schema first (GAP18).
10. **Notifications default.** Recommended, pending owner: off, opt-in (GAP9).
11. **Do we change the peer set in our own comparison documents?** Recommended, pending owner: yes; replace Roo Code, upstream Continue and "Windsurf" with ZooCode, Antigravity CLI, OpenCode and Devin Desktop, and mark Aider as dormant.
12. **Does the 2.18.0 list above displace anything on the critical path?** Recommended, pending owner: no; the eleven rows are small and none touches the sandbox gate (Track SB).

## 10. Further research

1. Antigravity CLI and OpenCode were outside the stated peer set and were not inventoried. Kilo's CLI is a fork of OpenCode.
2. ZooCode, the community continuation of Roo Code: what it kept and what it ships now.
3. Whether our IDE offers per-change accept and reject for agent edits, not only Edit mode. Not verified in the tree for this note.
4. The Claude Code, Copilot and Cursor GitHub Action pages, and Claude Code's tools reference (a notebook tool and `claude mcp serve` are unverified).
5. Zed's reasons for removing checkpoints, from the pull request and not only the release note, before GAP3 is sized.
6. Windows sandbox mechanisms in Codex ("MXC") and VS Code ("BaseContainer"), for W9 and W16.
7. The Agent Plugins manifest at agent-plugins.org, cited by Cursor; whether it is a real cross-vendor format before GAP15 reads it.
8. ACP v2 draft and the registry's submission rules, for GAP27.
9. A stream-json event schema that Claude Code, Amp and Gemini clients can all read, before GAP4 fixes field names.
10. How many of our users arrive from Roo Code and upstream Continue, to size GAP14 and the Track G adapters.

## 11. Sources

All fetched on 2026-11-12. A key ending in a product page is undated unless a date is given.

| Key                 | URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Date                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| CC (prefix)         | `https://code.claude.com/docs/en/` (pages: changelog, checkpointing, sessions, permission-modes, sandboxing, hooks, mcp, skills, sub-agents, workflows, routines, vs-code, model-config, cli-reference, plugins/overview)                                                                                                                                                                                                                                                                                                                                                                                                       | changelog 2.1.317 to 2.1.323, 2026-11-03 to 2026-11-12; others undated                  |
| CX, OA (prefix)     | `https://learn.chatgpt.com/docs/` (pages: changelog, developer-commands, config-reference, non-interactive-mode, codex-sdk, app-server, agent-approvals-security, sandboxing/auto-review, agent-configuration/subagents, agent-configuration/rules, enterprise/managed-configuration, environments/git-worktrees, automations, customization/memories, github-action, third-party/github, hooks, extend/mcp) and `https://github.com/openai/codex/releases`                                                                                                                                                                     | CLI 0.163.0 to 0.167.2, 2026-10-15 to 2026-11-11; others undated                        |
| GM, GC (prefix)     | `https://geminicli.com/docs/` (pages: changelogs/latest, cli/rewind, cli/checkpointing, cli/plan-mode, cli/skills, cli/sandbox, cli/headless, cli/enterprise, cli/telemetry, cli/model-routing, core/subagents, reference/configuration, reference/policy-engine, hooks, tools/mcp-server), `https://github.com/google-gemini/gemini-cli`, `https://github.com/google-github-actions/run-gemini-cli`                                                                                                                                                                                                                            | v0.41.0 to v0.64.0, 2026-05-05 to 2026-10-13; others undated                            |
| CU (prefix)         | `https://cursor.com/changelog`, `https://cursor.com/docs/` (pages: release-notes, agent/overview, agent/plan-mode, rules, subagents, hooks, skills, plugins, mcp, bugbot, cloud-agent, cloud-agent/automations, cursor-router, configuration/worktrees, cli/using, cli/headless, cli/reference/slash-commands, agent/security/run-modes, enterprise/opentelemetry-export)                                                                                                                                                                                                                                                       | changelog 2026-09-02 to 2026-11-06; others undated                                      |
| CP, VS, GH (prefix) | `https://code.visualstudio.com/updates` (1.146, 2026-11-11), `/updates/v1_145` (2026-11-04), `https://code.visualstudio.com/docs/copilot/` (chat/chat-checkpoints, agents/overview, customization/hooks, customization/custom-agents, security), `https://code.visualstudio.com/docs/agents/run/agent-sandboxing`, `https://docs.github.com/en/copilot/` (concepts/agents/copilot-cli/about-copilot-cli, reference/copilot-cli-reference/cli-command-reference, concepts/agents/code-review, concepts/agents/copilot-memory, concepts/agents/coding-agent/about-coding-agent), `https://github.com/github/copilot-cli/releases` | CLI 1.0.108 to 1.0.111-0, 2026-11-09 to 2026-11-13 as shown on the page; others undated |
| CL (prefix)         | `https://docs.cline.bot/` (pages: core-workflows/checkpoints, core-workflows/plan-and-act, features/subagents, features/auto-approve, features/jupyter-notebooks, cli/cli-reference, cli/scheduling, cli/connectors, cli/samples/github-pr-review, usage/cline-desktop, usage/cloud-agents, usage/kanban, sdk/plugins, customization/skills, enterprise-solutions/…), `https://github.com/cline/cline/releases`                                                                                                                                                                                                                 | v4.0.0, 26 June; v4.1.26, 26 October (the pages show no year); others undated           |
| RO (prefix)         | `https://github.com/RooCodeInc/Roo-Code`, `https://roocodeinc.github.io/Roo-Code/` (features/checkpoints, features/boomerang-tasks, features/worktrees, features/custom-modes, features/message-queueing, features/auto-approving-actions)                                                                                                                                                                                                                                                                                                                                                                                      | archive notice 2026-05-15; docs undated                                                 |
| KI (prefix)         | `https://kilo.ai/docs/` (code-with-ai/features/checkpoints, agents/session-history, collaborate/sessions-sharing, automate/agent-manager, automate/code-reviews/overview, customize/skills, customize/context/memory, getting-started/settings/sandboxing, getting-started/settings/notifications, code-with-ai/features/speech-to-text, code-with-ai/agents/auto-model, platforms/cli-reference), `https://github.com/Kilo-Org/kilocode/releases`                                                                                                                                                                              | v7.8.20 to v7.8.28, 27 October to 7 November (no year shown); others undated            |
| ZD (prefix)         | `https://zed.dev/releases/stable`, `https://zed.dev/docs/ai/` (agent-panel, parallel-agents, sandboxing, tool-permissions, skills, instructions, external-agents, agent-settings, edit-prediction, mcp)                                                                                                                                                                                                                                                                                                                                                                                                                         | 1.24.2 to 1.28.1, 2026-10-14 to 2026-11-11; others undated                              |
| ACP                 | `https://agentclientprotocol.com/updates`, `/get-started/registry`, `/get-started/clients`, `/community/governance`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | updates 2026-02-18 to 2026-11-06; others undated                                        |
| DV (prefix)         | `https://docs.devin.ai/` (desktop/changelog, release-notes/overview, cli/changelog/stable, cli/reference/commands, cli/reference/permissions, cli/sandbox, cli/subagents, cli/extensibility/…, product-guides/memory, product-guides/automations, work-with-devin/devin-review, desktop/devin-local/worktrees)                                                                                                                                                                                                                                                                                                                  | changelogs 2026-04-15 to 2026-11-11; others undated                                     |
| AI (prefix)         | `https://aider.chat/docs/` (git, usage/modes, usage/lint-test, usage/watch, config/options, scripting, more/analytics), `https://pypi.org/project/aider-chat/#history`, `https://github.com/Aider-AI/aider/commits/main`                                                                                                                                                                                                                                                                                                                                                                                                        | 0.86.2 on 2026-02-12; last commit 2026-05-22                                            |
| OH (prefix)         | `https://docs.openhands.dev/` (overview/introduction, overview/skills, overview/plugins, openhands/usage/agent-canvas/…, openhands/usage/automations/…, openhands/usage/customization/hooks, sdk/guides/security, sdk/guides/persistent-memory, sdk/guides/llm-fallback, sdk/guides/agent-acp, sdk/guides/github-workflows/pr-review), `https://github.com/OpenHands/OpenHands/releases`                                                                                                                                                                                                                                        | v1.32.0 to v1.40.0, 2026-10-23 to 2026-11-12; others undated                            |
| AM (prefix)         | `https://ampcode.com/docs/markdown/` (threads, cli, cli/settings, cli/streaming-json, tools, plugin-api, customize/skills, customize/agents-md, customize/mcp, customize/model-routing, orbs, orbs/automations, sdk), `https://ampcode.com/news`, `https://ampcode.com/chronicle`                                                                                                                                                                                                                                                                                                                                               | news posts January to 12 November (years inferred as 2026); docs undated                |
| GS (prefix)         | `https://goose-docs.ai/docs/guides/` (goose-cli-commands, sessions/session-management, context-engineering/hooks, context-engineering/plugins, context-engineering/subagents, recipes/recipe-reference, security/adversary-mode, security/prompt-injection-detection, managing-tools/goose-permissions, running-tasks, acp-providers, usage-data), `https://github.com/aaif-goose/goose/releases`                                                                                                                                                                                                                               | v1.51.0 to v1.59.0, 17 September to 10 November (no year shown); others undated         |
| JB (prefix)         | `https://junie.jetbrains.com/docs/` (junie-cli, junie-cli-subagents, junie-cli-configuration, parameters, slash-commands, custom-slash-commands, guidelines-and-memory, junie-on-github, junie-ide-plugin), `https://www.jetbrains.com/help/ai-assistant/` (feature-set, agents, acp), `https://www.jetbrains.com/help/air/`                                                                                                                                                                                                                                                                                                    | pages dated 2026-07-14 to 2026-11-12                                                    |
| UP (prefix)         | `https://www.continue.dev/`, `https://raw.githubusercontent.com/continuedev/continue/main/README.md`, `https://github.com/continuedev/continue/releases`, `https://github.com/continuedev/continue/commits/main`, `https://docs.continue.dev/`                                                                                                                                                                                                                                                                                                                                                                                  | commits 2026-06-06 to 2026-07-21; `v2.0.0-vscode` on 19 June                            |

Suffixes used in section 5 to 7 name the page under the prefix: for example `KI-SB` is Kilo's sandboxing page, `CL-PR` Cline's `cli/samples/github-pr-review`, `CP-SB` the VS Code agent-sandboxing page, `ZD-REL` Zed's stable releases, `CX-ENT` Codex managed configuration.

## 12. Not verified

- **Peer details.** Flag names, setting keys and frontmatter fields are as a summarising fetch reported them and were not opened raw. Release years on Cline, Kilo, Goose and Continue release pages are inferred (the pages show day and month).
- **Claims left out because only secondary sources carried them:** the Continue acquisition date and terms, the Roo shutdown announcement date, the Goose foundation donation date, Copilot's OpenTelemetry settings, the GitHub Copilot desktop app's details and the JetBrains Air launch post (the blog returned 403).
- **Pages read in part:** listed in section 2. A `?` in section 4 often means the page that would answer it was not reached.
- **Our side.** Keywords used to decide (d): checkpoint, rewind, redo, fork, resume, export, share, transcript, worktree, GitHub Action, review, cron, schedule, skill, plugin, marketplace, slash command, memory, output style, status line, voice, dictation, image, browser, notebook, fallback, managed, OpenTelemetry, SDK, headless, stream-json, schema, notification, mobile, remote, commit message, vim, keybinding, theme, side question, queue, steer, best of N, watch, lint, recipe, MCP Apps, import session, teleport, credential mask, goal, language server, hunk, autocomplete, deep link, desktop, Slack, code mode, elicitation. A row that uses none of these words for the same idea would have been missed.
- **Shipped state** was read from the Shipped table, the notes and file names; no feature was run. Whether Edit mode's per-change accept also applies to agent edits is open (section 10, item 3).
- **Sizes** are estimates from reading, not from a spike.
