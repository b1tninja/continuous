# Custom policy: one editor for the levels, the lists and the settings (2026-11-13)

Status: DRAFT. Slice 1 is built in this PR (section 6). Guards, detectors, the objection disposition and the test panel are designed here as **provisional**, pending the concept review (`plans/research/custom-policy-concept-review.md`, PR #818) and the IDGAF hotfix. Code read at `main` 62277ea.

Owner request: "a 'Custom' option for each policy control knob where it opens the settings wizard and allows defining a custom policy based on one of the built-ins, and allows an easy way for the user to edit the allow or deny lists." Clarified: the first priority is a UI to view, augment and configure the **existing** controls and `permissions.yaml` keys; new guards are secondary.

## 1. What exists (file:line at 62277ea)

### 1.1 The knobs

- Six controls in the mode bar: the preset picker `PresetSelect` (`gui/src/components/PolicyControls/PresetSelect.tsx:103`) and one `AreaLevelSelect` per area (`PolicyControls.tsx:76`, levels listed at `:142`). The same two components render in Settings > Tools through `PolicyCard` (`PolicyCard.tsx:47`, variant `row` / placement `settings`).
- Areas: Context use, Tool use, File edits, Plan edits, Questions (`core/tools/permissions/policy.ts:11-19`). Terminal, MCP and web are kinds inside Tool use; there is no terminal or MCP area.
- Levels: Manual, Cautious, Automatic, Permissive, IDGAF (`policy.ts:22-31`). Presets set all five levels and nothing else (`policy.ts:225-276`); `presetOf` (`policy.ts:282`) names the preset a set of levels matches.
- "Custom" today: a set of levels that matches no preset. The preset chip then says "Custom" in a neutral tone (`PresetSelect.tsx:57-80`), and its menu had a non-selectable note "Custom: set the five areas one by one" (`PresetSelect.tsx:227`). Nothing stores which preset a custom set came from. A hand-edited `permissions.yaml` whose levels match no preset reads as Custom the same way.

### 1.2 Where things are stored

| What                                                             | File                                 | Read                                      | Written by                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Levels, `plan.maxNewItems`, `questions.*`, `builtin.*`           | global `permissions.yaml`            | `parsePolicyFile` (`settingsFile.ts:67`)  | `applyPolicyUpdate` (`:158`) through `writePolicyFile` (`:209`): YAML document edit, temp file and rename (`:219`); IDGAF never written (`:24-25, 85-93`)                                                       |
| `floor`, `mcpServers`, `plan.mcpTools`, `plan.allowTerminal`     | same                                 | same                                      | **by hand only** before this PR                                                                                                                                                                                 |
| CLI `allow` / `ask` / `exclude` (Bash dialect)                   | same                                 | `permissionsYamlLoader.ts`                | CLI "always allow" (`extensions/cli/src/permissions/policyWriter.ts:81, 121`, temp+rename `:148`)                                                                                                               |
| Rule lists `toolPermissions.allow/ask/deny` (core dialect)       | the person's own `config.yaml`       | `readUserConfigFile`                      | `editToolRule` (`core/tools/permissions/ruleEditor.ts:430`): hash conflict check, validation, refusal, friction (confirm / typed phrase), comment-preserving edit (`:552`), read-back verification, undo, audit |
| `auto.environment.*`, `taintedSessionRule`, `guidance`, `limits` | `config.yaml` `toolPermissions.auto` | `rules.ts:37-55`, `taint/taintSetting.ts` | by hand                                                                                                                                                                                                         |

The IDE's Permissions page writes only `config.yaml` and says so for CLI-file rules (`EditableRules.tsx:116`). `policy/save` (`core/core.ts:747`) writes `permissions.yaml` and records what moved in the audit trail (`settingChanges.ts`).

### 1.3 Workspace cannot widen

- `permissions.yaml` is read from the global folder only; no workspace copy is read (`docs/reference/permissions-yaml.mdx`, "Only this one file is read").
- Allow rules survive only from the person's own `config.yaml` (`ruleTrust.ts:30`); a workspace or assistant may add deny and ask. Loosening keys from untrusted sources are dropped (`trust.ts:16, 62`).

### 1.4 The Permissions page

`PermissionsSection` (`permissions/PermissionsSection.tsx:188`) shows each area's rules by source with Add / Change / Remove / Adopt (`EditableRules.tsx:45`), the locks (`Locks.tsx:26`), the first-run overview (`FirstRunOverview.tsx:38`), the audit figures with "most asked" suggestions (`AuditOverviewPanel.tsx:90`) and a tester that runs the real evaluator (`RuleTester.tsx`). There was no single place to start from a preset, and `floor`, MCP trust, `plan.mcpTools` and `plan.allowTerminal` could not be edited anywhere in the UI.

### 1.5 Existing wizard

The MCP add wizard (#798) is core-only so far (`core/config/mcpWizard/*`, `continuous mcp add`); there is no GUI wizard component to reuse. Onboarding cards are not a stepper. The Custom policy editor is therefore its own small stepper.

## 2. Coverage: every key, and where it is edited

| Key                                                                                                          | Custom policy editor (this PR)                        | Elsewhere                                    | Not covered, why                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `levels.*` (5)                                                                                               | Step 2                                                | toolbar, Settings > Tools                    |                                                                                          |
| `builtin.<id>` (11)                                                                                          | Step 2                                                | Settings > Tools                             |                                                                                          |
| `plan.maxNewItems`                                                                                           | Step 2                                                | Settings > Tools                             |                                                                                          |
| `questions.youDecide`, `agentDecides`                                                                        | Step 2                                                | Settings > Tools                             |                                                                                          |
| `questions.delivery`                                                                                         | Step 2 (new in the UI)                                |                                              |                                                                                          |
| `floor`                                                                                                      | Step 3, list "Always-on Never" (new in the UI)        |                                              |                                                                                          |
| `toolPermissions.deny/ask/allow` (config.yaml)                                                               | Step 3                                                | Permissions page rule rows                   |                                                                                          |
| `mcpServers.<name>: trusted`                                                                                 | Step 4 (new in the UI)                                |                                              |                                                                                          |
| `plan.mcpTools`                                                                                              | Step 4 (new in the UI)                                |                                              |                                                                                          |
| `plan.allowTerminal`                                                                                         | Step 4 (new in the UI)                                |                                              |                                                                                          |
| CLI `allow` / `ask` / `exclude`                                                                              | shown read-only on the page with the "CLI file" badge | CLI "always allow"                           | different dialect (`Bash(...)`) and the CLI writer rewrites the file; follow-up F6       |
| `sandbox`                                                                                                    |                                                       |                                              | reserved, nothing reads it                                                               |
| `auto.environment.trustedDomains`, `productionMarkers`, `envNames`, `largeChangeLines`, `taintedSessionRule` |                                                       |                                              | in `config.yaml` under `toolPermissions.auto`, no core writer for them yet; follow-up F3 |
| `auto.guidance`, `auto.limits`                                                                               |                                                       |                                              | reviewer settings, follow-up F3                                                          |
| `audit.shadowReviewer`                                                                                       |                                                       | its own settings (`audit/setShadowSettings`) |                                                                                          |

## 3. Design

### 3.1 Entry points

Every knob gets a selectable **Custom…** option, last in its menu:

```
Preset ▾                          Tool use ▾
 ✓ Careful                          Manual
   Accept edits                   ✓ Cautious
   Hands off                        Automatic   (not available)
   Reviewer                         Permissive
   IDGAF                            IDGAF
   ─────────                        ─────────
   ⚙ Custom…                        ⚙ Custom…
     Open the policy editor,          Open the policy editor,
     starting from Careful.           starting from what is set now.
```

Choosing it navigates to `/config?tab=permissions&custom=<base>[&area=<area>]`. `base` is the preset the current levels match, or `current`. From an area's knob the editor opens at step 2 with that area's control focused. The Permissions page also has a **Custom policy…** button. Cancel closes it and leaves everything as it was.

### 3.2 The editor

```
┌ Custom policy  based on Careful ───────────────────────── [Cancel] ┐
│ [1. Start from] [2. Levels and settings] [3. Rules]                 │
│ [4. Read-only and trust] [5. Review and save]                       │
│                                                                      │
│ 3. Rules                                                             │
│ Add a rule  [Never ▾] [runTerminalCommand(git *)        ] [Add]      │
│   Matches 7 of the last 42 calls.                                    │
│     runTerminalCommand: git push origin main                         │
│     runTerminalCommand: git status                                   │
│                                                                      │
│ Never (2)       Refused. Saved in your config.yaml.                  │
│  ⛔ runTerminalCommand(terraform apply*)  [Move to… ▾] [Remove]       │
│ Ask (1)         Asks you first.                                      │
│  ? runTerminalCommand(git push*)          [Move to… ▾] [Remove]       │
│ Always (1)      Only your own file may allow.                        │
│  ✓ runTerminalCommand(npm test*)          [Move to… ▾] [Remove]       │
│ Always-on Never (0)  Refused below IDGAF (floor:).                   │
│                                                                      │
│ From the audit trail                                                 │
│  runTerminalCommand(ls*)    5× always          [Add to Always]       │
│  runTerminalCommand(git push origin main)      [Use]                 │
│                                                       [Back] [Next] │
└──────────────────────────────────────────────────────────────────────┘
```

1. **Start from**: a radio list of the five presets and "What is set now". Choosing one sets the five levels; the lists and settings start from what the person has now (a preset has no rules of its own, so there is nothing else to copy). IDGAF shows: "IDGAF is for one session: it is never saved."
2. **Levels and settings**: one select per area with the level's sentence, whether the set matches a preset ("the chip will say Custom"), the 11 built-in switches, `plan.maxNewItems`, `questions.delivery` and who decides each question type.
3. **Rules**: the four lists. Add (list, pattern, Enter or Add), Remove, Move to another list. The input is validated as typed with the rule editor's own check (`validateRuleText`), and previewed against the last 50 calls of the audit trail with the engine's matchers (`matchTerminalCommand`, `matchToolCall`; `customPolicy.ts` `ruleMatchesSample`). No new matching semantics. Suggestions come from the audit overview's "most asked" rows and from recent calls ("Use" puts the exact call in the input so the person widens it themselves). Workspace, assistant and CLI-file rules are not in these lists: they stay on the page, read-only, with their badges.
4. **Read-only and trust**: what counts as read-only is the product's classification, said in words (tool `readonly`, a command `classifyReadOnly` vouches for moves to Context use `policy.ts:513`, an MCP tool's `readonly` hint for a trusted server). Editable: trusted MCP servers, `plan.mcpTools`, `plan.allowTerminal`.
5. **Review and save**: every `permissions.yaml` key that changes, old → new, marked "(loosens)" where it does; every `config.yaml` change in words, each dry-run through `editToolRule` (warnings, refusal, friction); how a call is decided (the engine's own `decisionOrder` sentence); "A workspace file may only add Never and Ask"; "Ask means Deny when nobody can answer"; "Terminal commands, scripts and MCP servers are not contained: no sandbox is active." Save needs the typed phrase when a rule change needs it, and an acknowledgement when anything loosens.

Save writes `permissions.yaml` once (`policy/save`, core's writer: temp file and rename, comments and other keys kept, invalid entries refused before anything is written), then each `config.yaml` change through `config/addToolRule` / `updateToolRule` / `removeToolRule`, in the order remove, move, add, each with the previous change's `afterHash` as its base so a concurrent edit stops the save. A failure stops at that change and says how many were saved. Each change is in the audit trail and on the page's Undo stack, exactly as a single edit is.

### 3.3 Validation and messages

| Input                 | Check                            | Message                                                                                                                                                                                     |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A rule                | `validateRuleText`               | "Write a rule as toolName(pattern), or just toolName. A pattern in brackets cannot be empty." / "A rule cannot hold control or invisible characters." / "A rule is at most 500 characters." |
| A rule already listed | the four lists                   | "That rule is already in this list." / "That rule is already in the Ask list. Move it instead."                                                                                             |
| `plan.mcpTools` entry | one slash at most, no empty part | "Write server/tool, server/* or server."                                                                                                                                                    |
| A server name         | non-empty, no control characters | "Write the server's display name."                                                                                                                                                          |
| Writer (host)         | `policyUpdateProblem`            | "Not saved: floor: "…": …" — nothing is written                                                                                                                                             |
| config.yaml change    | `editToolRule` dry run           | the editor's own sentences (refusal, conflict, broken file)                                                                                                                                 |

### 3.4 Storage, and the label

- Levels and settings: the person's global `permissions.yaml`; rule lists: the person's own `config.yaml`. Nothing is written to a workspace file, and nothing read from a workspace is copied into the person's lists, so a save cannot turn a workspace Always into the person's own (tested).
- Label (provisional, follows the review's correction 2): the chip keeps the preset name when the five levels match one exactly, else "Custom". **"Custom (from X)"** needs the base stored: proposed `custom: { from: careful }` in `permissions.yaml`, provenance only, never behaviour (F1). Recalling a custom set after switching to a preset needs the custom set stored too (`custom: { from, levels }`, F1). Both need `custom` added to `POLICY_FILE_KEYS`, which an older CLI reads as an unknown key and so treats the whole file as broken: owner decision O3. **Built (F1):** stored at `levels.custom: { from, levels }` instead, nested under an accepted key. Every release reads `levels` and only the five area names inside it (`normalizePolicy` since the file's first commit), and the CLI checks only top-level keys, so an older build ignores it. UI state was the other option; it was not taken because it would not follow the person between windows, IDEs or a reinstall, and the chip's "from" would disagree with the file. A set with IDGAF in it, or started from IDGAF, is not stored (O2). The label is "Custom (from X)" only while the levels in force equal the stored set.

### 3.5 CLI and JetBrains

- CLI: `/policy` and `--policy` already take a preset or `area=level` pairs (`policyLevels.ts`). Proposed `continuous policy edit` (F5): prints the same review (key changes plus rule changes) and saves through the same two writers; `continuous permissions add|remove` already cover single rules. `/policy custom` in the TUI opens a text form of steps 2 to 5.
- JetBrains: the GUI is the same webview; `policy/save` and `config/*ToolRule` already pass through. Nothing JetBrains-specific, but it needs a manual run (F8).

### 3.6 Accessibility

- Custom… is a real listbox option: reachable with arrows, Home/End, Enter (tested).
- Steps are buttons with `aria-current="step"`; moving between steps puts focus on the step heading (`tabIndex=-1`). Opening from an area focuses that area's select.
- Every input has a label; errors are `role="alert"` and the input gets `aria-invalid` and `aria-describedby` pointing at the error and the live preview. Additions, removals and moves are announced in a polite live region.
- Move is a native select per rule, so it works without drag and drop.

## 4. Read and write per area (owner addition 2; provisional)

Follow the review: no new areas. Reads and writes are already split where the classification exists:

| Kind               | Read goes to                                                   | Write goes to | Classification                    | Too coarse                                                                                                                      |
| ------------------ | -------------------------------------------------------------- | ------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Files (file tools) | Context use                                                    | File edits    | tool name (`policy.ts:473-495`)   | no                                                                                                                              |
| Terminal           | Context use when `classifyReadOnly` vouches (`policy.ts:513`)  | Tool use      | `readOnlyCommand.ts`              | a write by a script or interpreter is unseen; "writes only in the workspace" for commands is best-effort until the sandbox (W8) |
| MCP                | Context use when the tool is `readonly` and the server trusted | Tool use      | server's hint, trusted per server | the hint is the server's claim                                                                                                  |
| Fetch / web search | never Context (`policy.ts:479`)                                | Tool use      | —                                 | a GET is still egress                                                                                                           |

"Reads anywhere, writes only in the workspace" is therefore: Context use Permissive, File edits Permissive, built-in `ask-outside-paths` on, and (provisional guard) "no edits outside the workspace" for file tools.

## 5. Guards, detectors, disposition (provisional, design only)

Pending #818 and the IDGAF hotfix. Corrections from the review applied:

- Plain IDGAF is record-only. Once any check can ask or deny, the policy is "Custom (from IDGAF) · N guards", never "IDGAF".
- Precedence: every matching check is evaluated, strictest wins (deny > ask > record > allow); a workspace file may only tighten; every match is audited.
- Unattended ask: held in a loop with an inbox, denied otherwise, never approved.
- When any guard is on, the policy-file lock is forced to deny.
- A custom policy based on IDGAF is session-only by default (O2).

| Guard / detector                             | Reuses                                                                                  | Enforcement class (UI label)                                                                                       | New code                                    | False-positive risk, corpus                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------- |
| No edits outside the workspace               | `deputyCallHit` outside-workspace check, as `outsideTargetNote` uses it (`evaluate.ts`) | Enforced for file tools; best-effort for terminal                                                                  | a check beside `floor:`                     | low; existing outside-paths corpus            |
| No reads outside the workspace               | same                                                                                    | same                                                                                                               | same                                        | low                                           |
| Secret files                                 | `protectedPaths.ts`, `protect-secrets`                                                  | enforced for file tools; best-effort for terminal (names only)                                                     | action `deny` instead of ask                | medium on fixtures named like secrets         |
| Network only to listed hosts                 | `ask-unknown-host`, `trustedDomains`, `destinationsOf`                                  | enforced for the fetch tool once every redirect hop is checked (gap); best-effort for terminal; MCP not controlled | redirect-hop check                          | medium; needs a host corpus                   |
| Never run these commands                     | `floor:` (built)                                                                        | best-effort                                                                                                        | none                                        | low                                           |
| Destructive commands                         | `destructiveCommands.ts`, `ask-destructive-commands`                                    | best-effort                                                                                                        | action                                      | literal forms only                            |
| Exfiltration shape                           | tainted-session rule (`taint/*`)                                                        | enforced for recognised sinks                                                                                      | action and `egress-after-secret-read` label | medium                                        |
| Secrets in arguments / outputs               | `util/secretScan`, `audit/mask.ts`                                                      | best-effort (known shapes)                                                                                         | a check                                     | medium; needs a corpus of real-looking tokens |
| Prompt-injection signals                     | `injection.ts` (hint)                                                                   | "signal", never "protection"; may raise a sink, never taint alone                                                  | wiring                                      | high on security text                         |
| New dependency                               | `dependencyChange.ts`                                                                   | enforced (lockfile diff)                                                                                           | action                                      | low; no typosquat claim                       |
| Spend and run caps                           | loop budgets, shadow ledger                                                             | enforced                                                                                                           | per-session cap outside Loop                | low                                           |
| "When a stricter preset would have objected" | a second pass of the evaluator with the reference preset's levels (`testToolCall.ts`)   | deterministic presets only                                                                                         | disposition setting and per-class override  | as the reference preset                       |

A prototype of the first guard (`guards: { edits-outside-workspace: on }`, refused at every level with a reason, 10 tests) was written and set aside when the owner moved guards to design-only; it is kept on the branch `custom-policy-guard-wip` (not a PR). It does not yet force the policy-file lock (review D4) or use a `guard` decision source.

Per-rule actions (approve-and-record) and the "test this policy" replay panel follow the review: `record` is a fourth action on a check, never on an allow rule; the replay uses `testToolCall` over `audit/list` and shows "replayed from a masked record" with a count of calls it could not replay exactly (F4).

## 6. Built in this PR (slice 1)

- Custom… on the preset and on each area's control (toolbar and Settings > Tools), keyboard reachable.
- The editor on the Permissions page, prefilled from the base, five steps as above.
- The list editor (add, remove, move, live preview with the engine's matchers, suggestions from the audit trail).
- `permissions.yaml` writer: `floor`, `mcpServers` trust, `plan.mcpTools`, `plan.allowTerminal` (lists edited in place so kept entries keep their comments), with `policyUpdateProblem` refusing what cannot be read back.
- Save: one `permissions.yaml` write, then the rule editor's own checked edits for `config.yaml`.
- Tests: `core/tools/permissions/customPolicy.vitest.ts`, `settingsFileLists.vitest.ts`, `gui/src/pages/config/sections/permissions/custom/CustomPolicy.test.tsx`.

## 7. Owner decisions

| #   | Question                                                                                                                                 | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | May the UI write `floor:`, MCP trust and `plan.mcpTools` (until now "by hand")? Removing a floor rule or trusting a server loosens.      | Yes. Built behind the review step's "loosens" acknowledgement, and `policy/save` records floor and trust changes in the audit trail. The acknowledgement is a page checkbox, which `permissions-page.mdx` says is not a confirmation (page text can send a click); rule changes in `config.yaml` do get the editor's native dialog. Add the native dialog to loosening `policy/save` writes (F10), which also covers switching a built-in rule off today. **Done (F10):** the checkbox is gone; core's `policy/save` asks through `confirmInIde`. |
| O2  | Save a custom policy based on IDGAF?                                                                                                     | Session-only by default, as IDGAF is today; the definition may be saved once guards exist (review D2).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| O3  | A new top-level key (`custom:` for the base and the recallable set, or `guards:`) makes an older CLI treat `permissions.yaml` as broken. | Accept, and say so in the release notes; or nest under an accepted key. **Decided for F1: nested, `levels.custom`** (section 3.4). `guards:` is still open.                                                                                                                                                                                                                                                                                                                                                                                       |
| O4  | Save is two writers (`permissions.yaml`, then `config.yaml` one rule at a time); a failure part-way leaves `permissions.yaml` saved.     | Keep, with the message saying exactly what was saved; one transaction across two files is not available.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| O5  | The CLI's `Bash(...)` lists: edit them here too?                                                                                         | Not in the editor; convert to core rules with "Adopt" later (F6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 8. Follow-ups

| #   | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Size         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| F1  | Store the base (`custom.from`) and the custom levels; chip "Custom (from X)"; Custom recallable after choosing a preset. **Built** (`levels.custom`, section 3.4)                                                                                                                                                                                                                                                                                                                                                                                         | S (needs O3) |
| F2  | Review step: show the exact resulting `permissions.yaml` diff (a host dry-run message). **Built** (`policy/preview`, `policySave.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                     | S            |
| F3  | Writers and UI for `auto.environment.*` (trusted domains, env names, large-change lines, `taintedSessionRule`), `guidance`, `limits`                                                                                                                                                                                                                                                                                                                                                                                                                      | M            |
| F4  | "Test this policy": replay recent calls through `testToolCall` with the draft lists and levels, show what changes (needs a draft-sources input on `policy/test`)                                                                                                                                                                                                                                                                                                                                                                                          | M            |
| F5  | `continuous policy edit` and `/policy custom`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | M            |
| F6  | CLI `allow` / `ask` / `exclude`: adopt into core rules from the editor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | S            |
| F7  | Guards and the disposition, after #818 and the hotfix (section 5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | L            |
| F8  | Manual pass in JetBrains and a narrow side panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | S            |
| F9  | Preview samples: also from the inbox's open asks and the hotfix's "would have objected" records                                                                                                                                                                                                                                                                                                                                                                                                                                                           | S            |
| F10 | Native confirmation for a `policy/save` that loosens (floor removed, server trusted, `plan.mcpTools` added, built-in off, level raised), as `config/*ToolRule` already has. **Built** in core for every caller (toolbar, Settings, editor), also `plan.allowTerminal` on; VS Code's own raise-only modal removed; JetBrains now routes `policy/load`, `policy/save`, `policy/preview`. `plan.maxNewItems` raised and question types moved to the agent are marked "loosens" in the review but not confirmed natively (a number field saves per keystroke) | S            |
