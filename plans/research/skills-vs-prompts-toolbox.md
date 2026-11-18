# Research: skills, prompts, commands, rules, hooks and the toolbox drawer

Last updated: 2026-11-11. Status: research and design, docs only. Nothing here was run against a model or a GPU. Web pages were fetched on 2026-11-11 and are cited by URL. Fetched text is treated as data. Built state was read from origin/main at ac7eb7839.

Companion: `plans/research/toolbox-default-catalogue.md` (the 32 default entries with their prompt text).

Not found: the branch `research/security-audit-skill` and its report `plans/research/security-audit-skill.md` did not exist at the time of writing (no such file in `M:/temp/wt-auditskill`, no matching remote branch, no PR in `gh pr list --repo b1tninja/continuous`). Section 6 therefore states the contract this design needs from that work instead of building on its text. Reconcile when the report lands.

## 1. The answer

**Should every installed skill be exposed in the toolbox? No.** Expose a skill in the drawer only when it says it is meant to be picked by a person. List every installed skill in a separate Skills view (the `/skills` list, with a Skills tab in the drawer that is a catalogue, not a row of launch buttons). Launch everything through one action registry.

Why, in four lines:

1. The Agent Skills spec and every product that implements it make a skill a thing the model discovers by `description` (a metadata line loaded for all skills at start, the body loaded on activation). A button implies "a person decides this is the moment"; the skill's own text says "the model decides". Both are valid, but they are different promises, and the frontmatter already has the switch that tells them apart.
2. Claude Code treats the two as one file with two flags (`user-invocable`, `disable-model-invocation`); Codex does it with `allow_implicit_invocation` and a `$` mention. So "also launchable by a person" is a per-skill property, not a property of all skills.
3. Skill counts grow without bound (Codex caps the listing at 2% of the context window and drops descriptions first; Claude Code truncates at 1,536 characters per entry). A drawer of 60 buttons is a worse slash menu.
4. Third-party skills carry instructions and scripts from someone else. A button on a third-party skill reads as endorsed. An explicit enable plus a source badge is the honest minimum.

The difference between a canned prompt and a skill is real but small at the moment of use: both end up as text the model reads. The differences that matter are who starts it, what rides with it (files, scripts, tool grants) and what it costs when idle. The unified registry hides the first from the person (one click) and keeps the other two visible as badges.

## 2. What each mechanism is, with sources

|                            | Canned prompt card (our toolbox)     | Slash command / custom command                                           | Agent Skill                                                     | Rule                                                      | Hook                                     |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| Started by                 | The person, by click or `/`          | The person, typed                                                        | The model by `description` match, or the person by name         | Always on, or by path glob, or invoked                    | An event the harness raises              |
| Idle cost                  | Zero (not in the prompt)             | Zero to a name and one-line description in a menu                        | Name and description of every installed skill, in every request | The whole text, every request (always-on) or when matched | Zero tokens; runs outside the model      |
| Loaded when used           | The card text becomes a user message | The file body becomes a user message, with arguments substituted         | `SKILL.md` body, then files on demand                           | Already there                                             | Its output may be added as context       |
| Can carry files or scripts | No                                   | Gemini: `@{file}` and `!{shell}` injection; Claude Code: only as a skill | Yes: `scripts/`, `references/`, `assets/`                       | Imports (Claude Code)                                     | Is a script or HTTP call                 |
| Can grant tools            | No                                   | Claude Code: `allowed-tools` for the turn                                | `allowed-tools` (experimental in the spec)                      | No                                                        | Can block or allow tool calls            |
| Trust question             | Text only; low                       | Text; Gemini `!{}` asks first                                            | Third-party text plus scripts; highest                          | Text that shapes every turn                               | Runs code on the user's machine; highest |
| Discoverability            | Drawer, shelf, search                | `/` menu                                                                 | `/skills`, model listing, menu if user-invocable                | Settings, files                                           | Settings, files                          |

### 2.1 Primary sources (all fetched 2026-11-11)

- **Agent Skills specification**, https://agentskills.io/specification. A skill is a directory with `SKILL.md` and optional `scripts/`, `references/`, `assets/`. Required frontmatter `name` (1 to 64, lowercase, digits, hyphens, equals the directory name) and `description` (1 to 1024, "what the skill does and when to use it"). Optional `license`, `compatibility` (max 500), `metadata` (string-to-string map "clients can use this to store additional properties not defined by the Agent Skills spec"), `allowed-tools` ("Experimental. Support for this field may vary between agent implementations"). Progressive disclosure: metadata about 100 tokens "loaded at startup for all skills"; body under 5000 tokens recommended, loaded on activation; files "only when required"; keep `SKILL.md` under 500 lines. The spec has no field for user invocation; that part is left to each product.
- **Claude Code skills**, https://code.claude.com/docs/en/skills. "Custom commands have been merged into skills": a file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` "both create `/deploy` and work the same way". All frontmatter is optional and only `description` is recommended: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `hooks`, `paths`, `shell`; `metadata`, `license`, `compatibility` are accepted but not acted on. The invocation table on that page, quoted:

  | Frontmatter                      | You can invoke | Claude can invoke | When loaded into context                                     |
  | -------------------------------- | -------------- | ----------------- | ------------------------------------------------------------ |
  | (default)                        | Yes            | Yes               | Description always in context, full skill loads when invoked |
  | `disable-model-invocation: true` | Yes            | Not on its own    | Description not in context, full skill loads when invoked    |
  | `user-invocable: false`          | No             | Yes               | Description always in context, full skill loads when invoked |

  Also: `user-invocable: false` "hides it from the `/` menu and blocks `/name`"; the combined `description` and `when_to_use` is truncated at 1,536 characters in the listing; skill content stays in context once invoked and is re-attached after compaction within a 5,000-token-each and 25,000-token-combined budget; and `allowed-tools` grants clear on the next message. So in Claude Code today the slash menu shows every skill that is not `user-invocable: false`: the default is to expose everything a person can run, and the author opts a skill out. That default suits a text menu that people type into; it does not suit a drawer of buttons (section 3). (The page text was 119,051 characters; the first 100,000 were read.)

- **Codex skills**, https://learn.chatgpt.com/docs/build-skills (redirect target of developers.openai.com/codex/skills). Locations: repo `.agents/skills`, user `$HOME/.agents/skills`, admin `/etc/codex/skills`, system. Explicit use: `/skills` or `$` mention; implicit: the model matches `description`. `agents/openai.yaml` with `policy.allow_implicit_invocation: false` stops implicit use while "explicit `$skill` invocation still works". The initial list is capped at 2% of the context window (8,000 characters if unknown); "Codex shortens skill descriptions first" and may omit skills with a warning.
- **Codex custom prompts**, https://learn.chatgpt.com/docs/custom-prompts. "Custom prompts are deprecated. Use skills for reusable instructions." Markdown in `~/.codex/prompts` only (not shared through a repository), `description` and `argument-hint` frontmatter, `$1`..`$9`, `$ARGUMENTS`, `KEY=value` named placeholders, invoked as `/prompts:name`.
- **Cursor**, https://cursor.com/docs/context/commands (the page that resolved covers rules, skills and migration; it does not document `.cursor/commands` itself). Skills in `.cursor/skills/<name>/SKILL.md` are "invoked on demand with `/skill-name` or `@skill-name`"; `paths` frontmatter scopes them; `/migrate-to-skills` converts user and workspace commands into skills "preserving their explicit invocation behavior". Rules carry `alwaysApply` and `globs`. Cursor is converging commands into skills, as Claude Code did.
- **Roo Code slash commands**, https://roocodeinc.github.io/Roo-Code/features/slash-commands. Markdown in `.roo/commands/` (project) and `~/.roo/commands/` (global); frontmatter `description` ("appears in the command menu"), `argument-hint` (visual placeholder only), `mode` (switches mode first, then runs). Built-ins such as `/init`, `/code`, `/ask`; custom modes appear as slash commands. Project overrides global; built-ins cannot be overridden. Relevant here: a command can carry a mode, and the menu merges built-in, mode, project and global entries in one list.
- **Cline workflows**, via a web search summary citing https://docs.cline.bot/features/slash-commands/workflows and https://docs.cline.bot/core-workflows/using-commands (the direct page fetches returned 404 or off-topic content; the points below are lower confidence). Workflows are markdown in `.clinerules/workflows/` (global in the Cline Workflows documents folder), invoked as `/name.md`, project over global, each with an enable toggle plus edit and delete. Their stated contrast: workflows are procedural ("execute this process now"), rules behavioural ("always behave this way").
- **Gemini CLI custom commands**, https://geminicli.com/docs/cli/custom-commands/. TOML in `~/.gemini/commands/` or `<project>/.gemini/commands/`; path gives the name with `:` for namespaces (`git/commit.toml` is `/git:commit`); `prompt` required, `description` shown in `/help`; `{{args}}`, `!{shell}` (confirmation first), `@{file}` injection; `/commands list` and `/commands reload`. The page does not relate commands to skills.
- **Claude Code hooks**, https://code.claude.com/docs/en/hooks-guide. Hooks are "user-defined shell commands" run "at specific points in its lifecycle", giving "deterministic control: certain actions always happen rather than relying on the LLM to choose"; command, prompt-based and agent-based handlers exist.
- **Claude Code memory and rules**, https://code.claude.com/docs/en/memory. CLAUDE.md is "context, not enforced configuration" and "to block an action regardless of what Claude decides, use a PreToolUse hook instead"; under 200 lines recommended; path-scoped rules "load only when Claude works with matching files".
- **This repository**: `docs/customize/deep-dives/prompts.mdx` (a markdown file with `invokable: true` becomes a prompt available when typing `/` in Chat, Plan and Agent) and `docs/customize/rules.mdx`. Code: `core/commands/slash/promptBlockSlashCommand.ts` and `ruleBlockSlashCommand.ts` (source tags `yaml-prompt-block`, `invokable-rule`), `core/config/markdown/loadMarkdownSkills.ts` (validates only `name` and `description`), `core/tools/definitions/readSkill.ts`, `extensions/cli/src/slashCommands.ts` (`/skills`, `/import-skill`, `/policy`, `/loop`, `/compact`, `/fork`, `/rename`, `/export` already exist), `core/util/toolboxCards.ts`, `gui/src/components/mainInput/Toolbox/`. The design note cited by `toolboxCards.ts`, `policy-areas-toolbox.md`, is not in the repository (it lives in the policy-areas session notes); `plans/policy-areas.md` refers to it. The card text and groups were read from the code instead.

### 2.2 What each tool shows and how people trigger

| Tool         | Where a person picks                                     | What the list shows                                                                                 | Other triggers                                  |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code  | `/` menu                                                 | Name, description, `argument-hint`; skills and commands in one list; `user-invocable: false` hidden | Name at the start of the message; model-invoked |
| Codex        | `/` (prompts as `/prompts:name`), `/skills`, `$` mention | Name plus `description`                                                                             | Implicit match on description                   |
| Cursor       | `/` or `@` skill name                                    | Skill names                                                                                         | Rules by glob or always                         |
| Roo          | `/`                                                      | Name, description, argument hint; built-in, mode, project and global merged                         | Mode switch via the command                     |
| Cline        | `/` and a toggle panel                                   | Workflow names with enable toggles                                                                  | Rules always on                                 |
| Gemini CLI   | `/`, `/commands list`                                    | Name (namespaced) and description                                                                   | `@` and `!` injection in the prompt             |
| This product | `/` (IDE and CLI), drawer glyph                          | Slash menu: invokable prompts and rules; drawer: 23 fixed cards in 5 groups                         | `/skills` list; model-invoked `read_skill`      |

Every comparable product gives one typed list and no button drawer; none was found showing model-only skills as launch buttons. The drawer is our difference, and it is valuable precisely because it is curated and short.

### 2.3 Cost and cache, in this codebase

- `readSkillTool` puts every skill's name and description in the tool description, sorted. The tool list is part of the cached prefix, so adding, removing or editing a skill changes the prefix and misses the cache on the first request after the change. Listing every skill the person ever installed in that registry is a recurring cost, not only a token cost. See `plans/research/caching-context-cost.md` for the rates and warm windows.
- A prompt card costs nothing until clicked; it then adds one user message at the end of the conversation, which does not touch the cached prefix. A skill launched by a person can do the same: send the body as the next user message (what Claude Code does for a skill run by name) instead of asking the model to call `read_skill`, which costs an extra tool round trip.
- A skill marked `disable-model-invocation: true` should be left out of the `read_skill` listing: this is the one change that makes drawer-only skills free when idle. It follows the Claude Code table above (description not in context).

### 2.4 Security posture

- Prompt cards, user prompt files and project toolbox files are text. The risk is a project file that places an instruction in the person's input. Mitigation: a click inserts or sends it, the filled text is always visible before sending (as the drawer already does), nothing sends on open or on load.
- Skills add `scripts/` and `allowed-tools`. The permission engine still governs every tool call. A skill or toolbox entry must not widen permissions: `allowed-tools` in a third-party skill is shown to the person as a request, never applied silently (Claude Code applies it for the turn; we do not copy that).
- Hooks run code on events with no click. They stay in settings, never in the toolbox. The toolbox may show that a hook exists (read-only) but not create or run one.
- Rules are always-on text. Not toolbox material, except an `invokable` rule, which is already a prompt.

## 3. Alternatives evaluated

| Option                                                                  | For                                                                             | Against                                                                                                                                                   | Verdict                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A. Every installed skill is a drawer button                             | Maximum discoverability; no new metadata                                        | Clutter; mislabels model-only skills; third-party text looks endorsed; unbounded; a button on a model-only skill does something its author never designed | Reject                                                                                                         |
| B. Drawer shows only built-in cards; skills stay in `/skills`           | Simple; no change                                                               | The owner's goal (built-in functionality through the pull-out menus) needs entries that launch skills, such as a security audit                           | Reject as final; fine as phase 0                                                                               |
| C. Drawer shows built-in plus skills that opt in; Skills view lists all | Uses the spec's `metadata` extension point and Claude Code's two flags; bounded | One new key to learn                                                                                                                                      | **Recommend**                                                                                                  |
| D. Turn prompt cards into skills (the Codex and Cursor direction)       | One format                                                                      | A card is one short prompt with `{facts}` filled from the session; a directory per card is heavy; skills add a description to every request               | Reject for cards; keep the same loader and frontmatter so a card file can become a skill by adding a directory |
| E. Separate toolbox with no registry                                    | Least work                                                                      | Three launch paths (slash, drawer, CLI) and three codepaths for prompts                                                                                   | Reject                                                                                                         |

Recommendation C, details:

- A skill appears as a drawer entry when its frontmatter has `metadata.toolbox: <shelf-id>` (a string, valid under the spec's string-to-string map and ignored by other tools, so the same skill folder stays portable). Without it the skill is in the Skills view only.
- The fork also honours the Claude Code flags it can: `disable-model-invocation: true` (left out of the `read_skill` listing; person-only; in the drawer only if `metadata.toolbox` is set, otherwise only in `/skills`), `user-invocable: false` (never offered as a launcher), `argument-hint` (placeholder in the launcher field). Reading these keys is one schema change in `loadMarkdownSkills.ts`.
- Third-party and imported skills (`/import-skill`, bundled ones from other authors) start disabled in the drawer; the person enables each one once, and the entry shows a source badge and the list of files and scripts it carries. A bundled skill (for example the security audit from the parallel task) is enabled from the start but still carries the third-party badge, because the text is not ours.

## 4. The unified action registry

One in-memory registry in `core/`, filled from: the built-in catalogue (code), the user folder, the project folder, and skills. Every launcher (drawer, `/` menu, CLI `toolbox` command, command palette) reads it and calls `runAction(id, args)`.

### 4.1 Entry shape

```ts
type ActionKind = "prompt" | "command" | "skill";
type ActionSource = "built-in" | "user" | "project" | "third-party";

interface ToolboxAction {
  id: string; // stable, kebab-case, unique within a source; a project id replaces a user or built-in id only through an explicit "replaces:" key
  shelf: string; // a shelf id
  title: string;
  method: string; // method name for the person; never sent to the model
  when: string; // one line, shown under the title
  kind: ActionKind;
  mode: "insert" | "send"; // what the primary button does; the other is the secondary button
  prompt?: string; // kind "prompt": text with {facts}
  command?: string; // kind "command": one of the built-in harness action ids (4.4)
  skill?: string; // kind "skill": the skill name
  args?: { name: string; hint: string; required?: boolean }[];
  cost?: string; // note for the person: "one model turn", "runs git diff (read-only)", "no model call"
  source: ActionSource;
  sourcePath?: string; // file shown in the badge tooltip
  enabled: boolean;
  disabledReason?: string; // "needs a git repository", "third-party: not enabled", "no check has run yet"
}
```

`enabled` and `disabledReason` come from a pure function of session state, not from the file: a disabled entry stays visible with its reason (a button that vanishes teaches nothing). A `needs:` key in file frontmatter names facts or conditions (`lastCheck`, `git`, `plan`) so the reason is generated, not hand-written.

### 4.2 Shelves

Keep the five problem-solving groups as they are (Understand, Diagnose, Decide, Check, Ask the agent). Add built-in shelves **Review**, **Audit**, **Git**, **Tests**, **Docs**, **Release** and **Session** (harness actions), plus **Skills** (a catalogue view, not a shelf of buttons) and **Recent** (local use counts, 4.8). Project and user shelves come from files. The drawer shows shelf tabs; past about nine, the least used collapse under a "More" tab. Recent and Search come first.

### 4.3 Files: `.continuous/toolbox/*.md` and the user folder

One markdown file per entry, parsed by the same frontmatter parser as skills and invokable prompts (`parseMarkdownRule`), so there is one parser, one set of error messages and one lock-list entry (`lock-list-from-loaders`, PR 543). Folders: `<repo>/.continuous/toolbox/` and the user's `~/.continuous/toolbox/`. A subfolder is a shelf (`.continuous/toolbox/release/cut.md` is shelf `release`) unless the file sets `shelf`.

```markdown
---
id: bump-and-tag
shelf: release
title: Prepare the release PR
method: Release checklist # optional, for the person
when: A version is ready to ship.
kind: prompt # prompt (default) | command | skill
mode: insert # insert (default) | send
needs: [git]
args:
  - name: version
    hint: 2.13.0
    required: true
---

Prepare release {version}: update the version fields, add the changelog entry from the commits since the last tag, and stop before pushing.
```

Rules for the loader:

- The body is the prompt text; `{version}` is an argument, and `{request}`, `{lastCheck}` and the other facts are filled as `fillToolboxCard` does today.
- `kind: skill` needs `skill:` naming an installed, enabled skill; `kind: command` needs `command:` naming a built-in action id from 4.4. Anything else is a load error shown in the drawer's problems row, not a silent drop.
- Unknown keys are ignored and reported once. At most 8 KiB per entry and 200 entries per folder.
- Project entries are `source: project`; entries from an untrusted workspace (see `docs/customize/workspace-trust.mdx`) are listed but disabled until the workspace is trusted.

### 4.4 Command actions (harness)

A closed list in code; files may name them but not define them. Each runs with the permission engine in front: a command action that would run a tool goes through the same approval path as a model call. Ids for v1: `compact`, `show-cost`, `run-last-check`, `open-policy`, `open-loop-inbox`, `open-audit`, `plan-build`, `fork-session`, `rename-session`, `export-session`, `list-skills`. Several map to existing CLI handlers (`compact`, `policy`, `loop`, `skills`, `fork`, `rename`, `export`); `show-cost`, `run-last-check`, `open-audit` and `plan-build` need new code (the catalogue says where).

### 4.5 Skill launchers

`kind: skill` sends the skill body as the next user message (arguments substituted) rather than asking the model to call `read_skill`. Reasons: no tool round trip, nothing added to the cached prefix, and the person sees what was sent. The skill's `scripts/` and `references/` stay reachable through the usual file tools, under permissions. `allowed-tools` is displayed but not applied (2.4).

### 4.6 Trust rules

1. Nothing in a project or third-party file is sent without a click; there is no auto-run key, and no frontmatter key that grants a permission, sets a policy level, changes a model or turns a hook on.
2. The filled text is shown before sending (already true of the drawer cards).
3. A third-party skill needs an explicit enable, once, with its file list and any `scripts/` shown. Enabling is the person's action in the Skills view, stored in user settings, never in the repository.
4. Project entries cannot use `kind: command` to change settings (`open-policy` opens the page; it does not change it).
5. Entry text and file lists are masked on the way to any log, as the existing secret masking does.
6. The lock list (PR 543) includes `.continuous/toolbox/` so a file changed after review is flagged.

### 4.7 The drawer (GUI)

- Shelf tabs across the top (a tablist; arrow keys move, Home and End go to the ends); a search field filters across shelves by title, method, `when` and prompt text; a list of entries below. Each row: title, method (muted), `when`, source badge, cost note, and the two buttons used today (Insert, Send). A disabled row shows its reason as text, not only a dimmed colour.
- Keyboard: `/` or Ctrl+K inside the drawer focuses search; Up and Down move through rows; Enter inserts; Shift+Enter sends; Escape closes and returns focus to the glyph (as today). Every control is at least 24 CSS px (WCAG 2.5.8), the same `CHIP` rule as `gui/src/components/PolicyControls/levelStyle.ts`.
- Glyph and tone language reused from `levelStyle.ts`: a glyph says what happens, a tint says how far trust goes, and the label stays the foreground colour because tinted text fails contrast. Proposed mapping: insert-only prompt (pencil, no tint), sends a message (paper plane, no tint), runs a harness action (cog, blue), launches a skill (sparkles, blue), third-party (shield with a question mark, amber), disabled (dashed outline, muted). Never colour alone.
- Accessibility conventions of PR 639 (live regions): a polite live region announces "Inserted: Why chain" or "Sent: Review my diff" and the result count while searching; the open drawer is a dialog named "Toolbox"; reduced motion is respected; the axe-core screenshot gate covers the drawer in both themes. (PR 639 was open when this was written; read its final conventions before building.)
- Test ids extend the existing set: `toolbox-shelf-<id>`, `toolbox-search`, `toolbox-card-<id>-badge`, `toolbox-card-<id>-reason`.

### 4.8 Local use counts and last used

A small JSON file in the user data folder: `{ id: { count, lastUsedAt } }`, local only, never sent anywhere (consistent with the privacy rows in `plans/ROADMAP.md`). Ids of built-in and user entries are stored as they are; project entry ids are stored as a salted hash so a project title never lands in the file. "Recent" shows the last five distinct entries, "Frequent" the top five by count with a recency decay. The drawer remembers the last shelf and search text for the session. A setting clears the file; there is no telemetry channel, and the count is used for ordering only.

### 4.9 CLI parity

- Slash: `/toolbox` lists shelves and entries (id, title, shelf, source, enabled); `/toolbox <id> [args]` runs one (a prompt is sent; `--insert` puts it in the input); `/toolbox search <text>`.
- Command line: `continuous toolbox list [--shelf <id>] [--json]`, `continuous toolbox show <id>` (prints the filled text without sending) and `continuous toolbox run <id> [args]`. In headless mode `run` sends the text as the prompt under the normal permission policy and adds no approval flag.
- The `/` menu in the GUI and CLI lists registry entries marked `slash: true` (default for user and project entries, off for built-ins so they do not collide with real slash commands), so a person can type `/review-diff` as well as click it. One registry means one definition.

## 5. Decision summary

| Question                        | Decision                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| Expose all skills in the drawer | No. Opt in by `metadata.toolbox`, plus an explicit enable for third-party             |
| Where do all skills show        | `/skills` and a Skills catalogue tab (name, description, source, enabled, file count) |
| Are cards skills                | No. Same loader and frontmatter; a card is one file, a skill is a directory           |
| How a person launches a skill   | Body sent as a user message, arguments substituted, no `read_skill` call              |
| Drawer-only skills              | Honour `disable-model-invocation: true`: leave them out of the `read_skill` listing   |
| Declaring entries               | `.continuous/toolbox/*.md` and the user folder; one parser                            |
| Permissions                     | Entries cannot grant; the permission engine governs every resulting call              |
| Hooks                           | Not in the toolbox                                                                    |

## 6. Contract needed from the security-audit-skill work

The report was not available (see the top). To fit this design, the bundled audit needs: a spec-valid `SKILL.md` directory (validated in CI with `skills-ref`, item 8 of the interop report) with `license: MIT` and a `metadata` map recording the upstream repository and the pinned ref; `metadata.toolbox: audit` and `disable-model-invocation: true`, so it is a person's choice and costs nothing idle; a `third-party` badge; its `scripts/` listed in the Skills view before the first run; its `allowed-tools` shown, not applied. The catalogue's Audit shelf has a `security-audit` entry of kind `skill` that points at it, and `dependency-audit` as a prompt-only entry that works without it.

## 7. Phased plan

| Phase | Content                                                                                                                                                                                                    | Effort                                        | Depends on            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------- |
| 0     | Put the five groups and 23 cards behind the registry type (no visible change); add Recent and local counts                                                                                                 | S (2 to 3 days)                               | none                  |
| 1     | Default catalogue: built-in shelves Review, Git, Tests, Docs, Release, Audit with the prompt-only entries; shelf tabs, search, keyboard, live region                                                       | M (about 1 week)                              | 0, PR 639 conventions |
| 2     | Loader for `.continuous/toolbox/*.md` and the user folder; problems row; lock-list entry; workspace-trust gating                                                                                           | M (4 to 5 days)                               | 1                     |
| 3     | Command actions: wire the existing CLI handlers, add `show-cost`, `run-last-check`, `open-audit`, `plan-build`                                                                                             | M (about 1 week; `plan-build` follows PR 643) | 1                     |
| 4     | Skill launchers: read `metadata.toolbox`, `disable-model-invocation`, `user-invocable`, `argument-hint`; Skills catalogue tab; third-party enable flow; drawer-only skills out of the `read_skill` listing | M (about 1 week)                              | 2                     |
| 5     | CLI parity: `/toolbox`, `continuous toolbox list, show, run`                                                                                                                                               | S (3 days)                                    | 1                     |
| 6     | Bundled security audit as a skill launcher (the parallel task)                                                                                                                                             | S once its PR lands                           | 4                     |

Risks: (1) a new `metadata.toolbox` key no other product knows (low: ignored elsewhere); (2) cache churn if the skill listing changes mid-session (the listing is already sorted; drawer-only skills leave it); (3) project files placing misleading text in the person's input (visible before send, trust gating, lock list); (4) catalogue bloat (a cap, search, Recent); (5) harness actions growing into a second slash-command system (closed list, reuse CLI handlers); (6) the Cline details are lower confidence and Cursor commands were not documented on the page fetched (2.1).

## 8. Open owner decisions

| #   | Decision                                                                                                                         | Default proposed                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| D1  | `metadata.toolbox` as the opt-in key, or a top-level `toolbox:` key (other tools ignore unknown keys too)                        | `metadata.toolbox`, because it is valid under the spec                             |
| D2  | A person-launched skill runs through `read_skill` (the model sees a tool result) or is sent as the user message                  | User message                                                                       |
| D3  | Built-in entries also as `/` slash commands                                                                                      | Off by default; on for user and project entries                                    |
| D4  | Read `.agents/skills` and `.claude/skills` for the Skills view (the Codex and Claude Code paths; `.claude/skills` is read today) | Add `.agents/skills`, with a source badge; tracked as item 8 of the interop report |
| D5  | Whether `allowed-tools` in a third-party skill is ever applied                                                                   | Never in v1                                                                        |
| D6  | Keep use counts at all, given the no-telemetry stance                                                                            | Yes: local file, salted ids for project entries, a clear button                    |

## 9. Proposed ROADMAP rows (ids TBD; plans/ROADMAP.md is not edited)

| Id  | Item                                                                                                                               | Effort | Depends on                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------- |
| TBD | Action registry type; move the 23 cards behind it                                                                                  | S      | none                                    |
| TBD | Default catalogue shelves Review, Git, Tests, Docs, Release, Audit, Session (prompt-only entries)                                  | M      | registry                                |
| TBD | Drawer: shelf tabs, search, keyboard, live region, 24 px targets, axe gate                                                         | M      | registry, PR 639                        |
| TBD | `.continuous/toolbox/*.md` and user-folder loader, problems row, lock list, trust gating                                           | M      | registry                                |
| TBD | Command actions (`show-cost`, `run-last-check`, `open-audit`, `plan-build` new; the rest reuse handlers)                           | M      | catalogue, PR 643                       |
| TBD | Skill keys (`metadata.toolbox`, `disable-model-invocation`, `user-invocable`, `argument-hint`) and the `read_skill` listing filter | S      | none                                    |
| TBD | Skill launcher and Skills catalogue tab, third-party enable flow                                                                   | M      | loader, skill keys                      |
| TBD | CLI `/toolbox` and `continuous toolbox list, show, run`                                                                            | S      | registry                                |
| TBD | Local use counts and the Recent shelf                                                                                              | S      | registry                                |
| TBD | Bundled security-audit entry (kind skill)                                                                                          | S      | skill launcher, security-audit-skill PR |
