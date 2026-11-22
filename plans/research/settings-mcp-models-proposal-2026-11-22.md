# Research and proposal: Settings layout, MCP servers, models and providers

Date: 2026-11-21. Code read at `origin/main` (`1723e47ab`). Web pages fetched 2026-11-21. Nothing here was built. No product code was changed. The note is evidence, a proposal and proposed roadmap rows.

## Summary

1. **The MCP list is the last thing on the Tools tab.** At 800 px it starts about 2,600 px down, after about 47 controls. At 300 px it starts about 3,800 px down. The `+` there opens a blank YAML file in the workspace. Move it to its own tab, first after Models.
2. **Core already has the hard parts of an MCP form.** `core/config/mcpWizard/` parses 14 paste formats, probes a server and saves to the user or the project. The GUI does not use it yet. No new format is needed, and no person should write YAML.
3. **Proposed tabs: Models, MCP servers, Tools, Permissions, Rules, Configs, General, Help.** Providers merges into Models. Approval levels, built-in rules and "Commands and secrets" move from Tools to Permissions. Indexing folds into General.
4. **95 settings were classified.** 40 have a concrete built-in value, 45 are unset by design, and 10 are chosen by code in a way the person cannot predict. For 34 the UI shows neither the value nor the rule, and for 24 more it shows a value but not whether the person set it. 12 of the 13 MCP settings are in the 34, because MCP has no form today.
5. **One rule fixes the wording.** Every field reads "Set by you: X" with a reset, or "Not set: what happens, and the value in use". Never the bare word "Default", never an unexplained blank. Today 9 controls say only "Default".
6. **Other tools mostly do not have this.** Of 19 tools read for MCP, 6 document a form or guided flow for a local server (VS Code, Zed, Goose, Kilo Code, the Codex app, Claude Desktop's bundles). Most hide defaults in environment variables or docs. Showing the unset state is where this product can be better, not only equal.
7. **Registry: not now.** The official registry is in preview and says to assume "minimal-to-no moderation". Ship paste, import from other tools and the pinned templates first.
8. **Scope is inconsistent.** The GUI `+` writes to the workspace, the CLI defaults to the user. Two docs pages disagree on which side wins a name clash. Tool policies live only in the webview. Proposed: one scope chip, one rule (yours wins), "Move to...".
9. **14 slices, each one pull request**, start with a measured baseline and the two moves that answer the scrolling complaint (ST0 to ST3, all S).
10. **11 owner questions** are at the end of Part 3, each with a recommendation.

## What this note is

The owner asked for an easier way to set up MCP servers for the user or the workspace, a cleaner Settings layout, a rework of models and providers, advanced features folded away, and no "unknown defaults". This note answers with three parts:

- **Part 1.** What Continuous has today, read from the code and drawn with the screenshot harness.
- **Part 2.** How 20 other tools configure MCP servers and models, from their own docs.
- **Part 3.** A layout and flow proposal, slices and roadmap rows.

A separate engineer is building the "Add/Edit MCP server" dialog and an "MCP servers" tab. Part 3 section 3 is written to check and extend that work, not to replace `plans/research/mcp-server-wizard.md`, which already holds the dialog design and its option inventory.

Evidence marks:

- **V**: read in the code at `1723e47ab`, seen in a screenshot made today, or read on a page I fetched myself.
- **H**: reported by a helper agent that fetched the cited page today. I did not read the page myself. Four of these pages were spot-checked and matched.
- **R**: inferred.

## Inputs and limits

- **Screenshots.** `bench/screenshots` ran with Edge 158. 13 pictures: 11 at 800 x 3000 and 2 at 300 x 4000, dark theme. Pixel distances are read off those pictures, so they are good to about 50 px.
- **The harness has no view of the Providers tab** and no view of the model Configure dialog. Those were read from code only.
- **The fixtures are small.** One model, one MCP server with five tools. A real config makes every page longer.
- **Web.** WebFetch returns a summary of each page, not the raw page. Menu labels are as the summary gave them.
- **Not run:** the extension in an editor, the CLI, any model, any MCP server.
- **The roadmap states for MCPW1 to MCPW7 say "Planned"** while the code for them is in `core/config/mcpWizard/` (V). The roadmap was not edited.

# Part 1. What Continuous has today

## 1.1 The Settings tabs

Tabs are defined in `gui/src/pages/config/configTabs.tsx:41-174`. With no `?tab=` the page opens on the tab named "Settings" (`gui/src/pages/config/index.tsx:46`). Below 640 px the tabs are one row of icons along the top (`index.tsx:81-86`).

| #   | Tab (id)                    | Sections, in order                                                                                                                                                                    | Controls (fixture) | Height at 800 px     |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------- |
| 1   | Models (`models`)           | Chat, Autocomplete, Edit rows; a card that links to Providers; "Which model does what"; Assign models; "Additional model roles" (folded); "Model information updates"                 | about 30           | about 1,320 px       |
| 2   | Providers (`providers`)     | Connections; Provider accounts                                                                                                                                                        | not drawn          | not drawn            |
| 3   | Rules (`rules`)             | Rules, with "Send rules in these modes" (5 switches) and the default agent system message; Prompts                                                                                    | 9                  | about 500 px         |
| 4   | Tools (`tools`)             | Approval; Built-in rules; Plans and questions; Decision timer; Shadow review; Commands and secrets; Built-in Tools; MCP Servers                                                       | about 55           | about 2,900 px       |
| 5   | Permissions (`permissions`) | "How permissions work" card; Custom policy; three views (Rules, Recent calls, Inbox); five area tabs; Locks; Built-in rules (read-only copy); Rules by Never, Ask, Always; Try a call | about 25           | about 2,400 px       |
| 6   | Configs (`configs`)         | The list of configs                                                                                                                                                                   | 1 and up           | about 180 px (empty) |
| 7   | Indexing (`indexing`)       | A "deprecated" notice with the Enable switch; @codebase index; Documentation                                                                                                          | 3                  | about 530 px         |
| 8   | Settings (`settings`)       | Chat (7 switches); Appearance (1); Autocomplete (4); Experimental (8, folded)                                                                                                         | 20                 | not measured         |
| 9   | Help (`help`)               | Resources; Tools (Token usage, Quickstart); Keyboard Shortcuts (13 rows, read-only)                                                                                                   | 3                  | about 1,080 px       |

Sources: the section components named in `configTabs.tsx`; pictures `settings-*-800-dark.png` (V).

Three things stand out:

- **A tab called "Settings" inside Settings.** It holds chat display, font size, autocomplete timings and experiments (`UserSettingsSection.tsx:104-340`).
- **Models and Providers are two tabs for one job.** The Models tab has a card whose only content is a button to the other tab (`ModelsSection.tsx:175-190`).
- **The Tools tab is mostly permissions.** Six of its eight sections decide what the agent may do without asking. The same built-in rules appear again, read-only, on the Permissions tab (pictures `settings-tools` and `settings-permissions`, V).

## 1.2 The Tools tab, top to bottom

This is the page the owner scrolls. Order from `ToolsSection.tsx:590-641`. Offsets are from `settings-tools-800-dark.png` (V).

| Order | Section                                             | Controls                                                                     | Starts at (800 px) |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| 1     | Approval (`PolicyCard`)                             | Preset; Context use; Tool use; File edits; Plan edits; Questions; 1 switch   | 90 px              |
| 2     | Built-in rules                                      | 11 switches and 1 locked rule                                                | 500 px             |
| 3     | Plans and questions                                 | 1 number, 6 selects                                                          | 1,250 px           |
| 4     | Decision timer                                      | 8 selects                                                                    | 1,580 px           |
| 5     | Shadow review (`ShadowReviewControl`)               | 1 switch, 2 inputs, Save                                                     | 1,780 px           |
| 6     | Commands and secrets (`TerminalEnvironmentControl`) | 3 radio options, a notice, a folded pattern list, 1 input, Add, "show names" | 2,050 px           |
| 7     | Built-in Tools                                      | 1 expander, 1 switch                                                         | 2,540 px           |
| 8     | MCP Servers                                         | `+`, Import from Cline, then one block per server                            | 2,590 px           |

- **About 47 controls sit above the MCP list.** In a 700 px panel that is about 3.7 screens of scrolling at 800 px wide.
- **At 300 px the MCP header is about 3,800 px down**, about 5.4 screens (`settings-tools-300-dark.png`; the view starts scrolled by about 150 px, which is added) (V, estimate).
- **The `+` does not open a form.** It sends `config/addLocalWorkspaceBlock` with `blockType: "mcpServers"` (`ToolsSection.tsx:559-563`). Core writes a new file in the workspace with a placeholder: `name: New MCP server`, `command: npx`, `args: ["-y", "<your-mcp-server>"]` (`core/config/workspaceBlocks.ts:74-83`). The person then edits YAML.
- **"Edit" on a server opens its file** (`ToolsSection.tsx:305-323`).

Adding one server today, counted from the code path (R): open Settings, open Tools, scroll, press `+`, read a YAML file, replace three values by hand, save, go back to Settings, answer the folder trust dialog (the file is in the workspace), approve the tools. That is at least 9 steps, one of them writing a format the person has never seen.

## 1.3 How a model gets configured today

| Path                      | Steps                                                                                                                                                                   | Where it writes                                                                                                       | Source                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| First-run onboarding      | A card with two tabs, "API Key" and "Local". Local shows Ollama's state and three `ollama pull` lines, then Connect or "Configure model"                                | The selected config                                                                                                   | `gui/src/components/OnboardingCard/`; picture `onboarding-local` (V)                              |
| "Set up models" (3 steps) | 1 Credentials: provider, API key, "Keep the key in", secret name, Test connection. 2 Models: a checklist with search. 3 Review. Nothing is written before the last step | `~/.continuous/providers.yaml` (the account), `~/.continuous/models.yaml` (each model), a `from:` entry in the config | `ProviderSetupFlow.tsx`; `docs/customize/model-setup.mdx`; `docs/customize/model-catalog.mdx` (V) |
| Configure dialog (gear)   | Six tabs: Connection, Capabilities, Generation, Templates, Context, Advanced (the entry as YAML). A review step shows the diff before saving                            | The model's entry, only the keys that changed (`modelConfigForm.ts:219-273`)                                          | `ModelConfigDialog.tsx:479-617` (V)                                                               |
| Roles                     | Models tab: Chat, Autocomplete, Edit rows; Apply, Embed, Rerank and Reviewer are folded. "Assign models" ticks roles per model                                          | The role pick is remembered per workspace; role lists go to the config                                                | `ModelsSection.tsx:83-261`; `docs/customize/configs.mdx` (V)                                      |
| Per-mode models           | "Which model does what": a table of models against Chat, Plan, Agent, Loop, Re-plan, Subagent, with rows for Reasoning effort, Prompt and Reminder                      | `modeModels` in the selected config                                                                                   | `ModeModelsTable.tsx:130-290` (V)                                                                 |
| By hand                   | Edit `config.yaml`, `models.yaml`, `providers.yaml`                                                                                                                     | Those files                                                                                                           | `docs/customize/providers.mdx` (V)                                                                |

What works well and should be kept:

- **The context length control is the model for everything else.** It names the source of the number in words: reported by the provider, published, set in your configuration, or not known with 32,768 in use (`ContextLengthControl.tsx:14-32`). It has "Use default" to unset (`:92-100`). Leaving it alone writes nothing (`modelConfigForm.ts:219-222`).
- **Most model fields already carry a default text** (`defaultText` in `core/config/modelEdit/modelEditFields.ts:40-41`), shown as a placeholder or in the option label (`ModelConfigDialog.tsx:819-870`).
- **"Commands and secrets" says where its value came from**: "Commands currently run in 'Hide secrets (recommended)' mode, from the default." (picture `settings-tools`, V).
- **A model is built from four layers**: account, catalog model, variant, config entry (`docs/customize/model-catalog.mdx`, "How the settings combine"). The UI shows none of this layering.

What is hard:

- **Three files and three words.** A connection, a provider account and a provider are different things on the Providers tab (`ProvidersCard.tsx:36-39`, `ProviderInstancesCard.tsx:179`).
- **Six tabs in the Configure dialog, about 60 fields**, with no first view that says what the model will actually do.
- **Nine controls say only "Default"**: Reasoning, Prompt caching, Cache the system prompt, Cache the conversation and Cache lifetime in the dialog (a field with no `defaultText` renders the bare word, `ModelConfigDialog.tsx:819-835`), the Reasoning effort, Prompt and Reminder rows of the per-mode table, and Thinking in the chat toolbar.

## 1.4 Where configuration can live

| Thing                               | Per user                                                                       | Per workspace                                              | Held until the folder is trusted | What the UI says today                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| Configs                             | `~/.continuous/config.yaml`, `~/.continuous/configs/*.yaml`                    | `.continuous/configs/*.yaml` (also `agents`, `assistants`) | no                               | The create form asks where (`docs/customize/configs.mdx`)                       |
| Provider accounts                   | `~/.continuous/providers.yaml`                                                 | `.continuous/providers.yaml`                               | yes                              | Add and Edit always write the user file (`docs/customize/providers.mdx`)        |
| Model catalog                       | `~/.continuous/models.yaml`                                                    | `.continuous/models.yaml`, `.continuous/models/*.yaml`     | yes                              | nothing                                                                         |
| MCP servers                         | `mcpServers` in a config; `~/.continuous/mcpServers/*.yaml` or `*.json`        | `.continuous/mcpServers/*.yaml` or `*.json`                | yes, and secrets are blanked     | A status dot; the scope is not shown (`ToolsSection.tsx:238-252`)               |
| Rules and prompts                   | global block folders                                                           | `.continuous/rules`, `.continuous/prompts`                 | no                               | not read for this note                                                          |
| Approval levels and rules           | `~/.continuous/permissions.yaml`                                               | none                                                       | n/a                              | "Saved in permissions.yaml, which the CLI reads too" (picture `settings-tools`) |
| Tool policies (Ask First and so on) | the webview's stored state only (`gui/src/redux/slices/uiSlice.ts:143-250`)    | none                                                       | n/a                              | nothing; the CLI and other editors do not see them                              |
| UI settings                         | `sharedConfig` in the global context file (`core/util/GlobalContext.ts:54`)    | none                                                       | n/a                              | nothing                                                                         |
| Secrets                             | the editor's secure storage, then `~/.continuous/.env`                         | `.continuous/.env`, `.env` (lookup only)                   | n/a                              | "Keep the key in" in setup (`docs/customize/model-setup.mdx`)                   |
| Folder trust                        | `trusted-project.json` in the global folder (`core/config/projectTrust.ts:33`) | never                                                      | n/a                              | a dialog that lists the files (`docs/customize/workspace-trust.mdx`)            |
| Editor settings                     | 24 `continuous.*` settings (`extensions/vscode/package.json`)                  | VS Code's own workspace settings                           | VS Code's rule                   | VS Code's settings editor, not the webview                                      |

Notes:

- **The global folder is `~/.continuous`**, or `CONTINUOUS_GLOBAL_DIR`; the legacy `~/.continue` is copied once and `.continue/` in a workspace is still read (`core/util/paths.ts:149-192`).
- **Secret lookup order:** secure storage, `~/.continuous/.env`, `<workspace>/.continuous/.env`, `<workspace>/.env`, process environment (`docs/customize/model-setup.mdx`, "Lookup order").
- **Precedence on a name clash is stated two ways.** `docs/customize/providers.mdx` says a workspace account "replaces a global account with the same name", and `core/config/providers/providerInstances.ts:158` has the same comment. `docs/customize/workspace-trust.mdx` says "Your own configuration always wins a name collision". For JSON MCP files the user's server is kept (`core/context/mcp/json/loadJsonMcpConfigs.ts:44-46`). Which holds at run time for accounts was not tested.
- **The two ways to add an MCP server choose different places.** The GUI `+` writes the workspace (`workspaceBlocks.ts`); `continuous mcp add` defaults to `--scope user` (`docs/customize/deep-dives/mcp.mdx:94`).
- **Hub profiles.** `ToolsSection.tsx:538-557` still reads `selectedProfile.rawYaml` and handles a `uses:` entry. Whether any hub source still loads was not checked.

## 1.5 The defaults table

Classes, as the owner defined them:

- **a**: a concrete built-in value. The UI should show the value.
- **b**: unset by design. Absence has its own meaning (the provider decides, inherit, detect, none). The UI should say in words what unset does, and must not write a value when the person leaves it alone.
- **c**: unknown today. Code picks something from inputs the person cannot see, and the UI neither shows the value nor states the rule. These are the defects.

"Shown" is **yes** when the UI gives the value or the rule in words, **partly** when it gives a current value with no source or a rule with no value, **no** otherwise.

### Models: connection

| Setting                            | Key                             | When not set                                               | Class | Source in code                           | Shown  |
| ---------------------------------- | ------------------------------- | ---------------------------------------------------------- | ----- | ---------------------------------------- | ------ |
| API base                           | `apiBase`                       | the provider's own endpoint                                | b     | `modelEditFields.ts:95-101`              | partly |
| API key                            | `apiKey`                        | no key is sent                                             | b     | `modelEditFields.ts:103-107`             | yes    |
| Where a new key is kept            | setup flow                      | secure storage, or `~/.continuous/.env` when there is none | a     | `docs/customize/model-setup.mdx`         | yes    |
| Secret name                        | setup flow                      | `CONTINUOUS_<PROVIDER>_API_KEY`                            | a     | `core/config/providerSecretName.ts`      | yes    |
| Region                             | `env.region`                    | not checked                                                | b     | `modelEditFields.ts:109-114`             | no     |
| AWS profile                        | `env.profile`                   | the default credential chain                               | b     | `modelEditFields.ts:116-122`             | yes    |
| Cross-region inference             | `env.crossRegionInference`      | off, the model id as written                               | b     | `modelEditFields.ts:146-154`             | yes    |
| Service tier                       | `env.serviceTier`               | `default`                                                  | a     | `modelEditFields.ts:156-164`             | yes    |
| Latency mode                       | `env.latency`                   | `standard`                                                 | a     | `modelEditFields.ts:166-174`             | yes    |
| Guardrail id                       | `env.guardrailIdentifier`       | none                                                       | b     | `modelEditFields.ts:176-182`             | yes    |
| Guardrail version                  | `env.guardrailVersion`          | `DRAFT`                                                    | a     | `modelEditFields.ts:184-190`             | yes    |
| Deployment (Azure)                 | `env.deployment`                | the model id                                               | b     | `modelEditFields.ts:199-205`             | yes    |
| Deployment id (watsonx)            | `env.deploymentId`              | none, the project id is used                               | b     | `modelEditFields.ts:207-213`             | yes    |
| API version                        | `env.apiVersion`                | not checked                                                | b     | `modelEditFields.ts:215-220`             | no     |
| Request timeout                    | `requestOptions.timeout`        | 7,200 s                                                    | a     | `modelEditFields.ts:229-236`             | yes    |
| Connect timeout                    | `requestOptions.connectTimeout` | 10 s                                                       | a     | `packages/fetch/src/connectTimeout.ts:4` | yes    |
| Proxy                              | `requestOptions.proxy`          | `HTTPS_PROXY` / `HTTP_PROXY` from the environment          | b     | `modelEditFields.ts:247-253`             | yes    |
| Hosts that skip the proxy          | `requestOptions.noProxy`        | none written; environment not checked                      | b     | `modelEditFields.ts:255-260`             | no     |
| Verify TLS certificates            | `requestOptions.verifySsl`      | on                                                         | a     | `modelEditFields.ts:262-267`             | yes    |
| Trust the system certificate store | `requestOptions.useSystemCa`    | on for Windows and macOS, off for Linux                    | a     | `modelEditFields.ts:269-274`             | yes    |
| CA bundle files                    | `requestOptions.caBundlePath`   | none                                                       | b     | `modelEditFields.ts:276-281`             | no     |
| Request headers                    | `requestOptions.headers`        | none                                                       | b     | `ModelConfigDialog.tsx:1157`             | yes    |

### Models: capabilities, generation, templates

| Setting                    | Key                                              | When not set                                                                                   | Class | Source in code                                                     | Shown  |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ | ------ |
| Roles                      | `roles`                                          | chat, edit, apply, summarize                                                                   | a     | `modelEditFields.ts:57`, `:284-290`                                | yes    |
| Tool calls written as text | `toolDialect`                                    | auto                                                                                           | b     | `modelEditFields.ts:292-298`                                       | yes    |
| How tools are sent         | `capabilities` (`tool_use`)                      | detected for the model                                                                         | b     | `ModelConfigDialog.tsx:1304-1360`                                  | partly |
| Image input                | `capabilities` (`image_input`)                   | detected for the model                                                                         | b     | `ModelConfigDialog.tsx:1361-1386`                                  | partly |
| Temperature                | `defaultCompletionOptions.temperature`           | not sent; the provider decides                                                                 | b     | `modelEditFields.ts:300-307`; `core/llm/index.ts:1984-1990`        | no     |
| Top P                      | `defaultCompletionOptions.topP`                  | not sent                                                                                       | b     | `modelEditFields.ts:308-316`                                       | no     |
| Top K                      | `defaultCompletionOptions.topK`                  | not sent                                                                                       | b     | `modelEditFields.ts:317-324`                                       | no     |
| Presence penalty           | `defaultCompletionOptions.presencePenalty`       | not sent                                                                                       | b     | `modelEditFields.ts:325-332`                                       | no     |
| Frequency penalty          | `defaultCompletionOptions.frequencyPenalty`      | not sent                                                                                       | b     | `modelEditFields.ts:333-340`                                       | no     |
| Stop sequences             | `defaultCompletionOptions.stop`                  | none                                                                                           | b     | `modelEditFields.ts:349-355`                                       | no     |
| Max output tokens          | `defaultCompletionOptions.maxTokens`             | the provider's or the published cap, at most a quarter of the window; 4,096 when none is known | c     | `core/llm/providerModelLimits.ts:67-88`; `core/llm/constants.ts:1` | no     |
| Reasoning                  | `defaultCompletionOptions.reasoning`             | depends on the provider and the model                                                          | c     | `modelEditFields.ts:356-361`                                       | no     |
| Reasoning budget           | `defaultCompletionOptions.reasoningBudgetTokens` | 2,048 on Anthropic and Bedrock                                                                 | a     | `core/llm/llms/anthropicThinking.ts:83`; `Bedrock.ts:1534`         | no     |
| Chat system message        | `chatOptions.baseSystemMessage`                  | the built-in text, shown as the placeholder                                                    | b     | `ModelConfigDialog.tsx:1483`                                       | yes    |
| Agent system message       | `chatOptions.baseAgentSystemMessage`             | the built-in text                                                                              | b     | same                                                               | yes    |
| Plan system message        | `chatOptions.basePlanSystemMessage`              | the built-in text                                                                              | b     | same                                                               | yes    |
| Chat template              | `promptTemplates.chat`                           | detected from the model id                                                                     | b     | `modelEditFields.ts:392-400`                                       | partly |
| Edit prompt template       | `promptTemplates.edit`                           | the built-in edit prompt                                                                       | b     | `modelEditFields.ts:401-407`                                       | yes    |
| Apply prompt template      | `promptTemplates.apply`                          | the built-in apply prompt                                                                      | b     | `modelEditFields.ts:408-414`                                       | yes    |
| Autocomplete template      | `promptTemplates.autocomplete`                   | the template detected for the model                                                            | b     | `modelEditFields.ts:415-421`                                       | partly |
| Tool overrides             | `chatOptions.toolOverrides`                      | none; each tool keeps its own description                                                      | b     | `ModelConfigDialog.tsx:1597-1651`                                  | yes    |

### Models: context, cache, price, per-mode

| Setting                               | Key                                       | When not set                                                                    | Class | Source in code                                              | Shown  |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------- | ------ |
| Context length                        | `contextLength`                           | from the server, then published, then 32,768 assumed                            | b     | `ContextLengthControl.tsx:14-32`; `core/llm/constants.ts:2` | yes    |
| Compact at this share                 | `contextManagement.autoCompactRatio`      | the CLI keeps the larger of 20% and the output limit (up to 15,000 tokens) free | b     | `modelEditFields.ts:433-442`                                | yes    |
| Compact at this many tokens           | `contextManagement.autoCompactTokens`     | the share rule above applies                                                    | b     | `modelEditFields.ts:443-451`                                | partly |
| Prepare the summary in the background | `contextManagement.plannedCompaction`     | on for a server on this machine or network, off for cloud                       | a     | `modelEditFields.ts:452-460`                                | yes    |
| Prompt caching                        | `defaultCompletionOptions.promptCaching`  | depends on the provider                                                         | c     | `modelEditFields.ts:461-467`                                | no     |
| Cache the system prompt               | `cacheBehavior.cacheSystemMessage`        | depends on the provider                                                         | c     | `modelEditFields.ts:468-473`                                | no     |
| Cache the conversation                | `cacheBehavior.cacheConversation`         | depends on the provider                                                         | c     | `modelEditFields.ts:474-479`                                | no     |
| Cache lifetime                        | `cacheBehavior.ttl`                       | not checked                                                                     | c     | `modelEditFields.ts:480-486`                                | no     |
| Subagent cache lifetime               | `cacheBehavior.subagentTtl`               | 5m                                                                              | a     | `modelEditFields.ts:487-495`                                | yes    |
| Input and output price                | `pricing.input`, `pricing.output`         | the price table's, if it has one                                                | b     | `modelEditFields.ts:496-511`                                | yes    |
| Cache read and write price            | `pricing.cacheRead`, `pricing.cacheWrite` | the input price                                                                 | b     | `modelEditFields.ts:512-527`                                | yes    |
| Models a mode offers                  | `modeModels.<mode>`                       | not stated in the UI                                                            | b     | `ModeModelsTable.tsx:133-141`                               | partly |
| Loop, Re-plan, Subagent model         | `modeModels.loop` and so on               | the Agent model, the Plan model, the starting turn's model                      | b     | `ModeModelsTable.tsx:135-138`                               | yes    |
| Reasoning effort per mode             | `modeModels.<mode>` effort                | the option reads "Default"                                                      | b     | `ModeModelsTable.tsx:21-27`                                 | no     |
| Prompt per mode                       | `modeModels.<mode>` prompt                | the option reads "Default"; Full or Short is picked by code                     | c     | `ModeModelsTable.tsx:30-33`                                 | no     |
| Reminder per mode                     | `modeModels.<mode>` reminder              | the option reads "Default"                                                      | b     | `ModeModelsTable.tsx:248-290`                               | no     |
| Thinking, in the chat toolbar         | session                                   | the option reads "Default"                                                      | b     | `ThinkingEffort.tsx:124`; picture `onboarding-local`        | no     |
| Model information updates             | `continuous.modelInformationUpdates`      | automatic                                                                       | a     | `extensions/vscode/package.json`                            | yes    |
| Refresh interval                      | `continuous.modelInformationRefreshHours` | 24 hours                                                                        | a     | `extensions/vscode/package.json`                            | no     |

### MCP servers

There is no form, so nothing here is shown except through the list. The defaults are in code and partly in `docs/customize/deep-dives/mcp.mdx`.

| Setting                               | Key                                    | When not set                                                                               | Class | Source in code                                                                       | Shown  |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------ | ------ |
| Transport for a URL                   | `type`                                 | Streamable HTTP is tried, then SSE                                                         | b     | `core/context/mcp/MCPConnection.ts:474-531`                                          | no     |
| Connect timeout                       | `connectionTimeout` (ms)               | 20,000 ms                                                                                  | a     | `MCPConnection.ts:84`, `:437`                                                        | no     |
| Tool call timeout                     | the same key                           | the SDK's 60 s; setting the connect timeout changes this too                               | c     | `core/tools/callTool.ts:120-127`; `core/config/yaml/yamlToContinueConfig.ts:39-45`   | no     |
| Working folder                        | `cwd`                                  | the workspace root; the home folder in a remote workspace                                  | c     | `MCPConnection.ts:756-793`                                                           | no     |
| Environment of a local server         | `env`                                  | a fixed short list of common variables, `PATH` from the user's shell, plus what is written | a     | `MCPConnection.ts:892-925`                                                           | no     |
| System certificates for Node servers  | `requestOptions.useSystemCa`           | on for Windows and macOS: `NODE_OPTIONS=--use-system-ca` is set                            | a     | `MCPConnection.ts:927-937`                                                           | no     |
| OAuth callback port                   | `oauth.callbackPort`                   | 3000                                                                                       | a     | `core/context/mcp/mcpOauthLoopback.ts:4`                                             | no     |
| OAuth redirect host                   | `oauth.redirectHost`                   | `localhost`                                                                                | a     | `mcpOauthLoopback.ts:18`                                                             | no     |
| OAuth client id                       | `oauth.clientId`                       | dynamic client registration is used                                                        | b     | `packages/config-yaml/src/schemas/mcp/index.ts:32-37`                                | no     |
| Whether read-only claims are believed | `permissions.yaml`                     | yes for a server in your own config or global folder, no for one from the open folder      | c     | `core/context/mcp/mcpTrust.ts:8-42`                                                  | no     |
| Policy of a new tool                  | webview state                          | Ask First; Automatic for a read-only tool of a believed server                             | a     | `gui/src/redux/slices/uiSlice.ts:143`; `core/config/profile/doLoadConfig.ts:327-330` | partly |
| Where `+` saves                       | none                                   | the workspace in the GUI, the user config in the CLI                                       | a     | `core/config/workspaceBlocks.ts:74-83`; `docs/customize/deep-dives/mcp.mdx:94`       | no     |
| Offered to VS Code's own chat         | `continuous.shareMcpServersWithVSCode` | on                                                                                         | a     | `extensions/vscode/package.json`                                                     | no     |

Shown today and worth keeping: the status dot with six states (`ToolsSection.tsx:49-65`), the "Not offered to the model until you approve" block for new and changed tools (`ToolsSection.tsx:383-444`), and the per-tool Ask First / Automatic / Excluded menus.

### Other tabs, per visible control

| Setting                                     | When not set                                                                                     | Class | Source in code                                                            | Shown  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------- | ------ |
| Preset                                      | Careful                                                                                          | a     | `core/tools/permissions/policy.ts:238-243`                                | partly |
| Five area levels                            | Permissive, Cautious, Manual, Cautious, Cautious                                                 | a     | `policy.ts:217-223`                                                       | partly |
| Skip the confirmation on permission changes | off                                                                                              | a     | picture `settings-tools`                                                  | partly |
| Built-in rules (11)                         | all on                                                                                           | a     | picture `settings-tools`                                                  | partly |
| New to-dos a re-plan may add                | 5                                                                                                | a     | picture `settings-tools` ("Default 5")                                    | yes    |
| Question types (6)                          | You decide for four, Questions level for one, Agent for one                                      | a     | `policy.ts:210-215`                                                       | partly |
| Decision timers (8)                         | Off                                                                                              | a     | `DecisionTimerCard.tsx:41`, `:70`                                         | partly |
| Shadow review                               | off                                                                                              | a     | picture `settings-tools`                                                  | yes    |
| Shadow review budget                        | no budget                                                                                        | b     | picture `settings-tools` ("No budget is set"; the placeholder reads 0.25) | partly |
| Shadow review timeout                       | 5,000 ms                                                                                         | a     | `ShadowReviewControl.tsx`                                                 | partly |
| Commands and secrets mode                   | Hide secrets                                                                                     | a     | `TerminalEnvironmentControl.tsx:54-55`                                    | yes    |
| Send rules in these modes (5)               | all on                                                                                           | a     | `RulesByModeToggles.tsx`                                                  | partly |
| Chat switches (7)                           | off, except Session Titles and Format Markdown                                                   | a     | `UserSettingsSection.tsx:52-63`                                           | partly |
| Font size                                   | from the editor                                                                                  | b     | `UserSettingsSection.tsx:86`                                              | partly |
| Multiline autocompletions                   | auto                                                                                             | a     | `core/util/parameters.ts:10`                                              | partly |
| Autocomplete timeout                        | 150 ms                                                                                           | a     | `core/util/parameters.ts:9`                                               | partly |
| Autocomplete debounce                       | 350 ms                                                                                           | a     | `core/util/parameters.ts:8`                                               | partly |
| Disable autocomplete in files               | none                                                                                             | b     | `UserSettingsSection.tsx:36-38`                                           | yes    |
| Experimental switches (8)                   | off, except "Ask again when a tool call is typed as text" and "Save chats as an append-only log" | a     | `UserSettingsSection.tsx:53-72`                                           | partly |
| Enable indexing                             | on                                                                                               | a     | `IndexingSettingsSection.tsx:51`                                          | partly |

### The count

Each table row is one setting (a row that covers a group, such as "Built-in rules (11)", counts once).

| Area        | Rows | a   | b   | c   | Shown: yes | partly | no  |
| ----------- | ---- | --- | --- | --- | ---------- | ------ | --- |
| Models      | 62   | 15  | 40  | 7   | 33         | 7      | 22  |
| MCP servers | 13   | 8   | 2   | 3   | 0          | 1      | 12  |
| Other tabs  | 20   | 17  | 3   | 0   | 4          | 16     | 0   |
| Total       | 95   | 40  | 45  | 10  | 37         | 24     | 34  |

Every class c row, the defects:

1. **Max output tokens.** A number is always sent. It is the smaller of a cap and a quarter of the window, or 4,096. The field is blank.
2. **Reasoning** (on or off). "Default" with no text.
3. **Prompt caching**, 4. **Cache the system prompt**, 5. **Cache the conversation**, 6. **Cache lifetime.** All four read "Default" or blank, and the behaviour differs by provider.
4. **Prompt per mode.** "Default"; the code picks Full or Short.
5. **MCP tool call timeout.** 60 s from a library, and it changes when the connect timeout is set.
6. **MCP working folder.** Depends on whether the workspace is remote.
7. **Whether an MCP server's read-only claims are believed.** Depends on which file defined the server.

The five worst, by how likely a person is to be hurt:

1. **MCP tool call timeout** (hidden, coupled to another key, and a slow tool fails with no setting to find).
2. **Max output tokens** (a 4,096 cap silently truncates long replies on a model nobody published a cap for).
3. **Where `+` saves an MCP server** (workspace in the GUI, user in the CLI, said nowhere).
4. **Prompt caching and its three companions** (they decide cost).
5. **Whether read-only claims are believed** (it decides whether a tool runs without asking).

The "partly" rows on the other tabs share one cause: the control shows the value in use but not whether the person set it. A switch that is on looks the same whether it is the built-in value or a choice.

Also found while reading:

- `DEFAULT_TEMPERATURE = 0.5` and `DEFAULT_ARGS` (`core/llm/constants.ts:3`, `:7-10`) are used only by `collectArgs` (`core/llm/index.ts:1984`), which nothing in `core/llm` calls. So no temperature is sent when unset. The constant reads as a default and is not one.
- `allowAnonymousTelemetry ?? true` is computed and never drawn (`UserSettingsSection.tsx:73`, `:100`). CO11 already tracks it.

# Part 2. How other tools do it

Every row cites a source key from the list in section 2.5. Rows marked H were fetched by a helper today; V were fetched by me.

## 2.1 MCP server configuration

| Tool                     | File and format                                                                                                   | Scopes and precedence                                                               | Form or wizard                                                                                                  | Import and paste                                                                                       | Secrets                                                                             | Sources     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------- |
| Claude Code              | JSON: `.mcp.json`, `~/.claude.json`                                                                               | local (default), project, user; local wins, then project, then user; no field merge | none; `claude mcp add` with flags                                                                               | `add-json`, `add-from-claude-desktop`                                                                  | `${VAR}`, `${VAR:-default}`; OAuth through `/mcp`                                   | CC-MCP (V)  |
| Claude Desktop           | JSON `claude_desktop_config.json`; `.mcpb` bundles                                                                | one, per user                                                                       | a generated form per extension from `user_config`; a dialog for remote connectors (name, URL, sign-in, headers) | drag a `.mcpb`; a directory of extensions                                                              | `sensitive` fields go to the OS keychain                                            | CD (H)      |
| VS Code                  | JSON; two formats: `servers` in `.vscode/mcp.json` and the profile, `mcpServers` in `.mcp.json` and `~/.copilot/` | user and workspace; precedence not stated                                           | "Add Server": type, then command or URL, then id, then where, then trust                                        | discovery from Claude Desktop, Cursor, Windsurf; `code --add-mcp`; a gallery; NPM, Pip, Docker pickers | `inputs` with `${input:id}`, asked once and stored; `${NAME}` in the portable files | VSC-MCP (V) |
| Cursor                   | JSON `mcp.json`                                                                                                   | `~/.cursor/` and `.cursor/`; precedence not stated                                  | none documented; a list with a switch per server                                                                | an install deeplink with base64 config; a marketplace                                                  | `${env:NAME}`                                                                       | CUR (H)     |
| Devin Desktop (Windsurf) | JSON `mcp_config.json`                                                                                            | project, local override, user; precedence not stated                                | none; an "Available" list with Install                                                                          | registries set by the team                                                                             | `${env:VAR}`                                                                        | DEV (V)     |
| Zed                      | `context_servers` in `settings.json`                                                                              | user settings; project not checked                                                  | "Add Server" with Local, Remote, or from Extensions                                                             | extensions                                                                                             | OAuth when no `Authorization` header is set                                         | ZED (H)     |
| JetBrains AI Assistant   | stored by the IDE                                                                                                 | global or project, changed in a "Level" column                                      | a dialog whose main field is a JSON box                                                                         | "Import from Claude"                                                                                   | not found                                                                           | JB (H)      |
| Junie                    | JSON `mcp.json`                                                                                                   | `.junie/mcp/` and `~/.junie/mcp/`                                                   | IDE: opens the file. CLI `/mcp`: registry search, scope, type, secrets, then verifies start                     | registry search in the CLI                                                                             | prompted in the CLI                                                                 | JUN (H)     |
| Cline                    | JSON `cline_mcp_settings.json`                                                                                    | one, per user                                                                       | a form for remote servers only: name, URL, transport                                                            | a marketplace where the agent follows the README to install                                            | plain text in `env` and `headers`                                                   | CLN (H)     |
| Roo Code                 | JSON `mcp_settings.json`, `.roo/mcp.json`                                                                         | global and project; project wins                                                    | none; two buttons open the two files                                                                            | none                                                                                                   | `${env:NAME}`                                                                       | ROO (H)     |
| Continue (upstream)      | YAML `mcpServers`; block files; JSON files dropped in a folder                                                    | config and workspace folder                                                         | none                                                                                                            | other tools' JSON files are read as they are                                                           | `${{ secrets.NAME }}`                                                               | CON (H)     |
| OpenCode                 | JSON `opencode.json`                                                                                              | global, project and more; the closer file wins                                      | none; `opencode mcp add`                                                                                        | none                                                                                                   | `{env:NAME}`, `{file:path}`; an unset variable becomes an empty string              | OC (H)      |
| Codex CLI                | TOML `config.toml`                                                                                                | user; project only in a trusted project                                             | `codex mcp add`; the desktop app has a form                                                                     | none                                                                                                   | the name of an environment variable; a keyring for OAuth                            | CX (H)      |
| Gemini CLI               | JSON `settings.json`                                                                                              | system, user, project; project over user                                            | none; `gemini mcp add`, default scope project                                                                   | none                                                                                                   | `$VAR`; secret-looking host variables are removed from the server's environment     | GM (H)      |
| Goose                    | YAML `config.yaml`                                                                                                | one, per user                                                                       | a form: type, id, name, description, command, timeout, environment variables                                    | a `goose://extension` deeplink                                                                         | the system keyring, with a plain-text fallback                                      | GS (H)      |
| LM Studio                | JSON `mcp.json`                                                                                                   | one, per user                                                                       | none; an in-app editor for the file                                                                             | an `lmstudio://add_mcp` deeplink with a generator                                                      | plain text in the file                                                              | LMS (H)     |
| Open WebUI               | admin settings                                                                                                    | the server                                                                          | a form for HTTP servers: type, URL, auth, headers                                                               | none                                                                                                   | stored server-side                                                                  | OW (H)      |
| LibreChat                | YAML `librechat.yaml`                                                                                             | the server; per-user values                                                         | a form for remote servers, with a required "I trust this application" box                                       | none                                                                                                   | per-user fields with Save and Revoke                                                | LC (H)      |
| Kilo Code                | JSON `kilo.jsonc`                                                                                                 | global and project; project wins                                                    | "Add Server": Local or Remote                                                                                   | none found                                                                                             | `{env:VAR}`                                                                         | KILO (H)    |

Trust, status and defaults:

| Tool           | Before a server starts                                               | Per tool                                                 | Status shown                                                                                      | Defaults                                                                  | Sources       |
| -------------- | -------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------- |
| Claude Code    | a prompt for project servers; none in non-interactive runs           | permission rules                                         | Connected, Needs authentication, Failed to connect, Pending approval, Rejected, Disabled, Blocked | environment variables only; the tool timeout is about 28 hours when unset | CC-MCP (V, H) |
| Claude Desktop | a preview before installing a bundle                                 | "Always allow"; "Blocked"                                | not found                                                                                         | auto-detected sign-in options are labelled "Detected"                     | CD (H)        |
| VS Code        | Workspace Trust for workspace servers; a trust prompt for the others | Allow Once, Skip, Always Allow; a tool picker            | a list with Show Output, Start, Stop, Restart                                                     | `chat.mcp.autostart` default documented                                   | VSC-RUN (H)   |
| Cursor         | not found                                                            | asks before a tool runs; expandable arguments            | a logs panel                                                                                      | not found                                                                 | CUR (H)       |
| Junie CLI      | "Approval required" when a project server's command or URL changed   | an allowlist                                             | Starting, Active, Inactive, Disabled, Failed, Authorization required, Approval required           | `timeout` in ms                                                           | JUN (H)       |
| Roo Code       | none                                                                 | `alwaysAllow`, `disabledTools`                           | not described                                                                                     | a "Network Timeout" menu, 1 to 3,600 s, 60 s when unset                   | ROO (H)       |
| Cline          | none                                                                 | `autoApprove` list                                       | not described                                                                                     | a timeout is mentioned with no value                                      | CLN (H)       |
| Codex CLI      | project config only in a trusted project                             | `approval_mode` per server and per tool                  | `/mcp` lists servers                                                                              | `startup_timeout_sec` 10, `tool_timeout_sec` 60, both documented          | CX (H)        |
| Gemini CLI     | a folder trust dialog; untrusted means no servers                    | once, always this tool, always this server               | CONNECTED, CONNECTING, DISCONNECTED                                                               | `timeout` 600,000 ms documented                                           | GM (H)        |
| OpenCode       | none documented                                                      | ordered allow, ask, deny rules                           | `/mcps`                                                                                           | startup 30 s, catalog 30 s, execution 12 h                                | OC (H)        |
| Goose          | a known-malware check                                                | Always Allow, Ask Before, Never Allow                    | on or off                                                                                         | the timeout is a field in the form                                        | GS (H)        |
| LM Studio      | a warning in the docs only                                           | a dialog with editable arguments; allow once or always   | not found                                                                                         | not found                                                                 | LMS (H)       |
| LibreChat      | the "I trust this application" box                                   | select tools per agent                                   | Connected, Needs Auth, Connecting, Disconnected, Error                                            | three timeouts documented in ms                                           | LC (H)        |
| Zed            | not found                                                            | `confirm`, `allow`, `deny`, with a documented precedence | a coloured dot with a tooltip                                                                     | not found                                                                 | ZED (H)       |
| Kilo Code      | none found                                                           | "Approve Always" writes an allow rule                    | `needs_auth`, `failed`                                                                            | 10 s local, 15 s remote, documented                                       | KILO (H)      |

## 2.2 Model and provider configuration

| Tool                   | Provider and key                                                  | Model list                                         | Custom endpoint                                                                         | Per-task models                                                    | Context and price shown                                          | Reasoning effort                                      | Sources    |
| ---------------------- | ----------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- | ---------- |
| Claude Code            | environment or sign-in; `settings.json`                           | built-in; a gateway's `/v1/models` on request      | `ANTHROPIC_BASE_URL`                                                                    | per subagent                                                       | prices in the picker; a warning that names the assumed window    | `/effort`, arrows in `/model`                         | CC-MOD (H) |
| VS Code                | "Manage Language Models", "Add Models", pick a provider           | queried from the endpoint when a URL is set        | "Custom Endpoint": name, key, API type; file fields for window and capabilities         | settings per feature                                               | context size and capabilities in the editor                      | a submenu in the picker, kept per session             | VSC-LM (H) |
| Cursor                 | Settings, Models, paste a key and Save                            | Cursor's own                                       | not on the docs pages read                                                              | none                                                               | prices on a docs page                                            | part of the model id (`gpt-5-high`)                   | CUR-M (H)  |
| Devin Desktop          | plan and team                                                     | the vendor's                                       | not found                                                                               | none                                                               | token prices in the picker                                       | a hovercard per model; the last variant is remembered | DEV-M (H)  |
| Zed                    | Settings, AI, LLM Providers; the key goes to the keychain         | Ollama models are discovered                       | "Add Provider": name, URL, model id, context window                                     | six settings (default, inline, commit message, summary and others) | not found                                                        | per model in settings                                 | ZED-M (H)  |
| JetBrains AI Assistant | "Providers & API keys", each with Test Connection                 | from the provider                                  | URL, key, a tool-calling box                                                            | "Models Assignment": core features, instant helpers                | a context window field, 64,000 for local when unset              | not found                                             | JB-M (H)   |
| Cline                  | a provider menu, then a key field, then a model menu              | per provider                                       | base URL, key, model id, then max output, window, image support, input and output price | Plan and Act                                                       | in the custom form                                               | a thinking switch; levels in the CLI                  | CLN-M (H)  |
| Roo Code               | named API configuration profiles; keys in secret storage          | per provider                                       | the same fields as Cline                                                                | a profile per mode; each mode remembers its model                  | in the custom form                                               | a menu when the model supports it                     | ROO-M (H)  |
| Continue (upstream)    | YAML `models`                                                     | none fetched                                       | `apiBase`                                                                               | `roles`                                                            | none                                                             | YAML                                                  | CON (H)    |
| OpenCode               | `/connect`, then `/models`                                        | the models.dev catalogue; local servers are probed | `providers.<id>` with a base URL and limits                                             | per agent                                                          | not found                                                        | a `#variant` suffix                                   | OC-M (H)   |
| Codex CLI              | `model_provider` in TOML                                          | a catalogue file                                   | `[model_providers.<id>]`                                                                | plan and review models                                             | windows in the docs                                              | in `/model`: Low to Extra High                        | CX-M (H)   |
| Gemini CLI             | sign-in or key                                                    | built-in                                           | not found                                                                               | not for subagents                                                  | not found                                                        | not found                                             | GM-M (H)   |
| Goose                  | "Configure providers", "Switch models"                            | per provider                                       | a form: type, name, URL, key, models, streaming; the file holds limit and token costs   | not found                                                          | in the custom provider file                                      | not found                                             | GS-M (H)   |
| LM Studio              | local                                                             | local files                                        | n/a                                                                                     | n/a                                                                | per-model defaults; a memory estimate as the window slider moves | presets                                               | LMS-M (H)  |
| Open WebUI             | Connections, Add Connection, a Verify button that calls `/models` | live, or an allowlist                              | any OpenAI-compatible URL                                                               | none                                                               | window and max output, or "Not provided"                         | a custom parameter                                    | OW-M (H)   |
| LibreChat              | YAML custom endpoints                                             | a list, or fetched                                 | `baseURL`, `apiKey`                                                                     | model specs with presets                                           | in the preset                                                    | in the preset                                         | LC-M (H)   |
| Aider                  | flags and files                                                   | a metadata file                                    | flags                                                                                   | weak and editor models                                             | in the metadata file                                             | in the settings file                                  | AID (H)    |

## 2.3 What the MCP specification says that a settings screen must respect

All from the specification, revision 2026-07-28 (H, fetched by a helper from `modelcontextprotocol.io`; the code already targets this revision, `MCPConnection.ts:472`).

- **Two standard transports: stdio and Streamable HTTP.** HTTP+SSE is deprecated. A client given one URL should try a POST first and fall back to the old transport only on a 400, 404 or 405 that is not a modern error. [SPEC-T]
- **Authorization is for HTTP servers.** A stdio server takes its credentials from the environment. [SPEC-A]
- **The client finds the authorization server from the 401.** Registration order: pre-registered client, then a client id metadata document, then dynamic registration (now deprecated), then asking the person. [SPEC-A]
- **So the screen needs:** a "Needs sign-in" state with a Sign in button, a "Signed in" state with Sign out, optional client id and secret fields, a callback port, and no sign-in controls for a local server (R, from the above).
- **A person should be able to deny any tool call.** Tool annotations such as `readOnlyHint` are untrusted unless the server is trusted. [SPEC-TOOLS]
- **Before a one-click setup of a local server**, the client must show the exact command, untruncated, say that it runs code, and let the person cancel. [SPEC-SEC]
- **The `mcpServers` JSON shape is a convention**, not part of the specification. It appears only as Claude Desktop's example. [SPEC-CFG]
- **There is an official registry**, in preview. It stores metadata (packages, remotes, and per-input `isRequired`, `isSecret`, `default`). It says host applications should use an aggregator, not the registry directly, and that consumers "should assume minimal-to-no moderation". It does not remove servers for having vulnerabilities. [REG] (V for the moderation page)

## 2.4 Patterns worth copying, and mistakes to avoid

Worth copying:

1. **Accept what other tools already wrote.** Paste, a dropped file, discovery of installed tools, a deeplink (VS Code discovery sources; JetBrains "Import from Claude"; Continue's dropped JSON; LM Studio and Cursor deeplinks; Claude Code `add-json`). Continuous already has the parser (`core/config/mcpWizard/parseMcpPaste.ts`).
2. **A scope the person can see and change in the list** (JetBrains "Level" column; Roo's two buttons; Claude Code `--scope`).
3. **Named states that say what to do next** (Claude Code's seven; Junie's seven, with "Approval required" when a command changed; Devin's "Needs authentication" with a button; LibreChat's five).
4. **Secrets kept out of the file by construction** (VS Code `inputs`; Zed keychain; `.mcpb` `sensitive`; Continue `${{ secrets.X }}`).
5. **Test before save, and say what was found** (JetBrains Test Connection on every provider; Junie CLI verifies the start; Open WebUI Verify; Claude Desktop's "Detected" label).
6. **Timeouts as a control with a stated value** (Roo: 60 s, 1 to 3,600; Codex: 10 s and 60 s; OpenCode: three separate timeouts).
7. **Say when a value is unset or unknown** (Open WebUI: "Default" or "N modified", and "Not provided"; Claude Code names the assumed window for an unknown model).
8. **A custom endpoint form that asks for window, max output and price** (Cline, Roo, Goose, Zed).
9. **Effort beside the model, remembered** (Devin hovercard; Codex `/model`; VS Code submenu).
10. **Settings that can be searched and linked to** (VS Code `@modified`, `@id:` and `vscode://settings/<id>`; Zed `zed://settings/...`).
11. **Approval separated from availability** (Zed profiles against tool permissions; Continue's Excluded hides a tool from the model; Codex `enabled_tools` against `approval_mode`).

Mistakes to avoid:

1. **Two formats or two paths for one thing** (VS Code has `servers` and `mcpServers`; Devin has old and new paths).
2. **A "form" that is a JSON box** (JetBrains AI Assistant), or a button that opens the file (Junie IDE, Roo, LM Studio, Cline for local servers).
3. **Precedence that is not written down** (Cursor, Devin, Junie, VS Code).
4. **Defaults only in environment variables** (Claude Code; the unset tool timeout is about 28 hours).
5. **A missing type that silently means the old transport** (Cline: no `type` means SSE).
6. **An unset secret that becomes an empty string** (OpenCode).
7. **Plain-text keys in the file or the export** (Cline, LM Studio; Roo's export).
8. **Save that does not test** (Open WebUI).
9. **An install where an agent follows a README** (Cline's marketplace), so two installs can differ.
10. **Effort as separate model ids** (Cursor), which multiplies the list.
11. **Project servers loaded without asking in unattended runs** (Claude Code `-p`).

## 2.5 Sources

All fetched 2026-11-21.

- CC-MCP: https://code.claude.com/docs/en/mcp. CC-MOD: https://code.claude.com/docs/en/model-config. Also https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/managed-mcp
- CD: https://modelcontextprotocol.io/docs/develop/connect-local-servers, https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop, https://claude.com/docs/connectors/custom/add-unlisted, https://github.com/anthropics/mcpb
- VSC-MCP: https://code.visualstudio.com/docs/agents/reference/mcp-configuration, https://code.visualstudio.com/docs/agent-customization/mcp-servers. VSC-RUN: https://code.visualstudio.com/docs/agents/run/manage-mcp-servers, https://code.visualstudio.com/docs/agents/run/approvals, https://code.visualstudio.com/docs/agents/run/tools. VSC-LM: https://code.visualstudio.com/docs/copilot/customization/language-models. Settings search: https://code.visualstudio.com/docs/configure/settings
- CUR: https://cursor.com/docs/context/mcp, https://cursor.com/docs/context/mcp/install-links. CUR-M: https://cursor.com/docs/settings/api-keys, https://cursor.com/docs/models
- DEV: https://docs.devin.ai/desktop/cascade/mcp, https://docs.devin.ai/windsurf/plugins/cascade/mcp. DEV-M: https://docs.devin.ai/desktop/chat/models, https://docs.devin.ai/desktop/changelog
- ZED: https://zed.dev/docs/ai/mcp, https://zed.dev/docs/ai/tool-permissions, https://zed.dev/docs/ai/agent-profiles. ZED-M: https://zed.dev/docs/ai/use-api-access, https://zed.dev/docs/ai/use-a-local-model, https://zed.dev/docs/ai/agent-settings
- JB: https://www.jetbrains.com/help/ai-assistant/mcp.html. JB-M: https://www.jetbrains.com/help/ai-assistant/use-custom-models.html. JUN: https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html, https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html
- CLN: https://docs.cline.bot/mcp/configuring-mcp-servers, https://docs.cline.bot/mcp/connecting-to-a-remote-server, https://docs.cline.bot/mcp/mcp-overview, https://github.com/cline/mcp-marketplace. CLN-M: https://docs.cline.bot/provider-config/openai-compatible, https://docs.cline.bot/features/plan-and-act
- ROO: https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo. ROO-M: https://roocodeinc.github.io/Roo-Code/features/api-configuration-profiles, https://roocodeinc.github.io/Roo-Code/providers/openai-compatible, https://roocodeinc.github.io/Roo-Code/features/settings-management
- CON: https://docs.continue.dev/customize/deep-dives/mcp, https://docs.continue.dev/reference, https://docs.continue.dev/ide-extensions/agent/how-to-customize
- OC: https://opencode.ai/docs/mcp-servers/, https://opencode.ai/docs/config/. OC-M: https://opencode.ai/docs/providers/, https://opencode.ai/docs/models/, https://opencode.ai/docs/agents/
- CX: https://learn.chatgpt.com/docs/extend/mcp?surface=cli, https://learn.chatgpt.com/docs/config-file/config-reference. CX-M: https://learn.chatgpt.com/docs/models, https://learn.chatgpt.com/docs/config-file/config-advanced
- GM: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md, https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md, https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/trusted-folders.md. GM-M: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model.md
- GS: https://goose-docs.ai/docs/getting-started/using-extensions, https://goose-docs.ai/docs/guides/config-files, https://goose-docs.ai/docs/guides/managing-tools/tool-permissions. GS-M: https://goose-docs.ai/docs/getting-started/providers
- LMS: https://lmstudio.ai/docs/app/mcp, https://lmstudio.ai/docs/app/mcp/deeplink, https://lmstudio.ai/blog/lmstudio-v0.3.17. LMS-M: https://lmstudio.ai/docs/app/advanced/per-model, https://lmstudio.ai/docs/app/presets
- OW: https://docs.openwebui.com/features/extensibility/mcp/. OW-M: https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/, https://docs.openwebui.com/features/workspace/models/
- LC: https://www.librechat.ai/docs/features/mcp, https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers. LC-M: https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/custom_endpoint, https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/model_specs
- KILO: https://kilo.ai/docs/automate/mcp/using-in-kilo-code. AID: https://aider.chat/docs/config/adv-model-settings.html
- SPEC-T: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports. SPEC-A: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization. SPEC-TOOLS: https://modelcontextprotocol.io/specification/2026-07-28/server/tools. SPEC-SEC: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices. SPEC-CFG: https://modelcontextprotocol.io/docs/develop/connect-local-servers
- REG: https://modelcontextprotocol.io/registry/about, https://modelcontextprotocol.io/registry/moderation-policy, https://modelcontextprotocol.io/registry/registry-aggregators, https://github.com/modelcontextprotocol/registry

# Part 3. The proposal

## 3.0 Two rules used on every screen

**Rule 1: basic or advanced.** A control is **basic** when one of these is true:

- a new person needs it in the first hour to get a reply or add a tool;
- it can spend money, run a program or send data off the machine, and the person has to decide it.

Everything else is **advanced**. Advanced controls are folded. The fold's header is not empty: it carries one line with the values in use, so a person can read the state without opening it.

**Rule 2: the value state.** Every field is visibly one of two things:

- **Set by you: X**, with a "Reset" that removes the key from the file.
- **Not set:** one sentence that says what happens then, with the value in use when one can be shown. For example "Not set: using 8,192 from the server".

More of rule 2:

- **Never the bare word "Default"**, and never an unexplained blank.
- **Not set writes nothing.** Opening and saving a form does not add keys. This already holds for models (`modelConfigForm.ts:219-222`) and must hold for MCP.
- **An inherited value names its source and links to it**: "Not set: 0.6 from the account `strata`", with "Go to account". The sources are the four model layers (account, catalog model, variant, config entry), the role, the mode, and user against workspace.
- **Wording by class.** Class a: "Not set: 20 s". Class b: "Not set: the provider decides", "Not set: none", "Not set: detected (Streamable HTTP)". Class c must become a or b before it ships.

```
Connect timeout
( ) Not set: 20 s
(o) Set by you: [ 45 ] s      Reset
```

In a narrow row the same state is one line: `Connect timeout   20 s  not set` or `Connect timeout   45 s  set by you  Reset`.

**What should become nullable, and what should stop.**

| Setting                                 | Today                                                                                | Proposed                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Max output tokens                       | a number is always sent, 4,096 when no cap is known (`providerModelLimits.ts:81-87`) | nullable for a local OpenAI-compatible server with no known cap: send none and say "Not set: the server decides". Elsewhere keep the computed cap and show it. Owner question Q6 |
| MCP tool call timeout                   | no key of its own; 60 s from a library, or whatever `connectionTimeout` is           | its own key, shown as "Not set: 60 s"                                                                                                                                            |
| Temperature and the other sampling keys | already unset means not sent                                                         | stay nullable; say "Not set: the provider decides"; remove the unused `DEFAULT_TEMPERATURE` so it is not wired in later                                                          |
| Reasoning budget                        | 2,048 is used when reasoning is on and no budget is set                              | stay nullable; show "Not set: 2,048", or the budget the chosen effort maps to                                                                                                    |
| Reasoning effort per mode               | "Default"                                                                            | stay nullable; "Not set: the model's own setting"                                                                                                                                |
| Prompt caching and its companions       | "Default"                                                                            | stay nullable; the sentence states the resolved behaviour for this provider ("Not set: on, 5 minute lifetime")                                                                   |
| MCP transport for a URL                 | unset means try both on every connect                                                | stop being nullable after the first successful test: write the transport that worked, so a later failure is not hidden by a fallback                                             |
| Where an MCP server is saved            | implied by which button was used                                                     | never implied: the dialog always shows the choice                                                                                                                                |
| Prompt per mode                         | "Default", resolved in code                                                          | show the resolved profile: "Not set: Full"                                                                                                                                       |
| Shadow review budget                    | blank with a placeholder of 0.25                                                     | "Not set: no limit below the $100.00 cap"; the placeholder goes                                                                                                                  |

## 3.1 Settings information architecture

### Proposed tabs

| #   | Tab         | Holds                                                                                              | Why                                                                                    |
| --- | ----------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Models      | models in use, connections, and (folded) per-mode models, other roles, accounts, model information | Nothing works without a model. One tab for one job                                     |
| 2   | MCP servers | the server list, Add, Import, each server's tools                                                  | The owner's first complaint. It is the second thing people set up                      |
| 3   | Tools       | built-in tools and their policies; the tool budget when TR6 lands                                  | What is left is short and matches the tab's name                                       |
| 4   | Permissions | views: Levels, Rules, Protections, Recent calls, Inbox                                             | Everything that decides "may the agent do this" in one place, once                     |
| 5   | Rules       | rules, rules by mode, prompts                                                                      | Unchanged                                                                              |
| 6   | Configs     | the list of configs                                                                                | Unchanged                                                                              |
| 7   | General     | chat, appearance, autocomplete, experimental, and (folded) the codebase index and docs             | Removes "Settings inside Settings". Indexing is marked deprecated in its own tab today |
| 8   | Help        | unchanged                                                                                          | Unchanged                                                                              |

Nine tabs become eight. With no `?tab=`, Settings opens on Models when no chat model works, otherwise on the tab last used.

### From, to

| Today                                                  | Goes to                                                        | Shown or folded                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Models: Chat, Autocomplete, Edit rows                  | Models, "In use"                                               | shown                                                                              |
| Models: the card that links to Providers               | removed                                                        | n/a                                                                                |
| Models: Which model does what                          | Models, "Models per mode"                                      | folded; header: "Plan: Claude Sonnet. Agent: Qwen. 3 not set"                      |
| Models: Assign models                                  | Models, "Roles"                                                | folded, together with Apply, Embed, Rerank, Reviewer                               |
| Models: Additional model roles                         | Models, "Roles"                                                | folded                                                                             |
| Models: Model information updates                      | Models, "Model information"                                    | folded; header: "Automatic, every 24 hours. Last pulled 2026-11-20"                |
| Providers: Connections                                 | Models, "Connections"                                          | shown                                                                              |
| Providers: Provider accounts                           | Models, "Accounts"                                             | folded; an account is shown on its connection row                                  |
| Rules: all                                             | Rules                                                          | unchanged                                                                          |
| Tools: Approval (preset and five levels)               | Permissions, view "Levels"                                     | shown; it is the first view                                                        |
| Tools: Skip the confirmation                           | Permissions, "Levels"                                          | shown, under the levels                                                            |
| Tools: Built-in rules                                  | Permissions, view "Protections"                                | folded; header: "11 of 11 on". The read-only copy on the Rules view becomes a link |
| Tools: Plans and questions                             | Permissions, "Levels", under the Plan edits and Questions rows | folded                                                                             |
| Tools: Decision timer                                  | Permissions, "Protections"                                     | folded; header: "Off"                                                              |
| Tools: Shadow review                                   | Permissions, "Protections"                                     | folded; header: "Off"                                                              |
| Tools: Commands and secrets                            | Permissions, "Protections"                                     | folded; header: "Commands run with secrets hidden (recommended). Not set"          |
| Tools: Built-in Tools                                  | Tools                                                          | shown, open                                                                        |
| Tools: MCP Servers                                     | MCP servers                                                    | shown                                                                              |
| Tools: Import from Cline                               | MCP servers, Add, "Import from another tool"                   | inside the dialog                                                                  |
| Permissions: How permissions work                      | Permissions, "Levels"                                          | shown once, as today                                                               |
| Permissions: Rules, Recent calls, Inbox, Try a call    | Permissions, the same views                                    | unchanged                                                                          |
| Permissions: Locks                                     | Permissions, "Protections"                                     | shown                                                                              |
| Configs                                                | Configs                                                        | unchanged                                                                          |
| Indexing: all three sections                           | General, "Codebase index and docs (deprecated)"                | folded; header: "Index on. 0 docs"                                                 |
| Settings: Chat, Appearance, Autocomplete, Experimental | General                                                        | as today; Experimental stays folded                                                |
| Help                                                   | Help                                                           | unchanged                                                                          |

**Where "Commands and secrets" belongs.** It decides which environment variables the agent's commands can read. That is a protection with a safe built-in value, the same kind of thing as "Ask before touching credentials". There are no terminal settings in the webview to put it with: the shell, WSL and container settings are VS Code settings (`extensions/vscode/package.json`, `continuous.terminal.*`). So it goes to Permissions, Protections, folded to one line. The fold's detail gains a link "Where commands run: open editor settings".

### Search and deep links

- **Deep links exist**: `/config?tab=<id>` (`index.tsx:55`). Keep every old id as an alias: `providers` opens Models at Connections, `indexing` and `settings` open General, `tools` opens Tools. Add `&section=<id>` to scroll to and open a fold, and `&item=<name>` for one model or server. The VS Code commands "Continuous: Open Providers" and "Manage Models and Providers" keep working through the aliases.
- **A search box above the tabs**, after the settings registry exists (ST11). It filters a flat list of setting names with their tab, and choosing one opens the tab, opens the fold and focuses the control. The evidence for it: VS Code's settings and model editors both have search with typed filters, and both VS Code and Zed give each setting an address (VSC-LM, ZED). No surveyed sidebar extension documents one, so it is last in the order, not first.
- **A settings registry in core** is what makes search, the value state and `continuous doctor config` (roadmap CO9) the same data: for each setting its id, label, file and key, class a, b or c, the built-in value or the function that says what unset does, the scope, and the tab. `MODEL_EDIT_FIELDS` is already this for models (`modelEditFields.ts:77-528`).

### Wireframes

Settings shell, 300 px. The tab strip is the existing icon row (`index.tsx:81-86`), reordered.

```
+------------------------------------+
| <  [M] [S] [T] [P] [R] [C] [G] [?] |
+------------------------------------+
| Models                         [+] |
|                                    |
| (the tab's content, one column)    |
+------------------------------------+
```

Settings shell, 800 px.

```
+---------------+--------------------------------------------------------------+
| < Back        |  [ Search settings...                                    ]   |
|---------------|                                                              |
| Models        |  Models                                           [+ Add]    |
| MCP servers   |                                                              |
| Tools         |  (the tab's content)                                         |
| Permissions   |                                                              |
| Rules         |                                                              |
|---------------|                                                              |
| Configs       |                                                              |
|               |                                                              |
| General       |                                                              |
| Help          |                                                              |
+---------------+--------------------------------------------------------------+
```

Permissions, 800 px, the Levels view with the Protections view's folds listed for reference.

```
Permissions
[ Levels ] [ Rules ] [ Protections ] [ Recent calls ] [ Inbox ]

Preset                                                        [ Careful v ]
Context use    Reading files and searching                    [ Permissive v ]
Tool use       Commands, MCP tools and the web                [ Cautious v ]
File edits     Changing files                                 [ Manual v ]
Plan edits     Loop only                                      [ Cautious v ]
Questions      Loop only                                      [ Cautious v ]
> Plans and questions       5 new to-dos; you decide 4 of 6 kinds
( ) Skip the confirmation when permissions change             off, not set

Protections view:
  Locks                     3 locked, always on
> Built-in rules            11 of 11 on
> Commands and secrets      Secrets hidden (recommended). Not set
> Decision timer            Off
> Shadow review             Off
```

At 300 px the five views become a menu (`[ Levels v ]`) and each row puts its control under its label, as the page does today.

Shown by default: the preset, the five levels, the folds' one-line headers. Folded: everything under a `>`.

## 3.2 Models and providers

### One flow: from nothing to a working chat model

The start screen asks what the person has, in their words. It replaces the two onboarding tabs "API Key" and "Local" and the provider menu as the first question.

300 px:

```
+------------------------------------+
| Add a model                    [x] |
|                                    |
| What do you have?                  |
|                                    |
| [ An API key                     ] |
|   Anthropic, OpenAI, OpenRouter... |
|                                    |
| [ A server on this computer      ] |
|   Found: Ollama  localhost:11434   |
|   Found: LM Studio localhost:1234  |
|                                    |
| [ A server on my network         ] |
|                                    |
| [ Nothing yet                    ] |
|   Two ways to start, both free     |
+------------------------------------+
```

800 px: the same four choices as two rows of two cards. Nothing else changes, so no second drawing.

Then, on one path for all four:

1. **Connection.** Provider (filled in for a found server), key, "Keep the key in". The test runs by itself when the key is pasted or the server is picked, and can be run again. Its line says what it found: "Connected. 14 models. Tools: yes."
2. **Models.** The checklist, with three columns the catalogue already has: context, price in and out per million tokens, tools. Unknown reads "not published", not a blank.
3. **Use for.** Chat, Edit, Apply ticked; Autocomplete unticked with a note when the model is not a completion model. This is where roles are chosen, once, in words.
4. **Review.** As today: what is written where, nothing before this step.

"Nothing yet" shows two choices: install Ollama and pull one model (the current Local tab's content), or get a key (links). It does not start a download by itself.

Shown by default: the four doors, key, the test line, the checklist, "Use for". Folded under "More" on the connection step: API base ("Not set: https://openrouter.ai/api/v1"), region and profile, the secret's name, proxy and certificates, request timeout ("Not set: 7,200 s"), connect timeout ("Not set: 10 s").

Reuse: `ProviderSetupFlow.tsx` (the three steps), `LocalServerPicker.tsx` and `core/llm/localServers.ts` (found servers), `ModelChecklist.tsx`, `ReviewStep.tsx`, `CataloguePrompt.tsx`, `OnboardingLocalTab.tsx` (the Ollama content), the existing Test connection. New: the start screen, the automatic test, the three columns, the "Use for" step.

### The Models tab

300 px:

```
+------------------------------------+
| Models                         [+] |
|                                    |
| In use                             |
| Chat          Claude Sonnet    [*] |
|   200,000 ctx  $3 / $15  effort:   |
|   not set                          |
| Autocomplete  not set   [ Set up ] |
|   No completions until you pick one|
| Edit          not set              |
|   Uses the Chat model              |
|                                    |
| Connections                        |
| o Anthropic   key in secure storage|
|   3 models            [ ... ]      |
| o Ollama      localhost:11434      |
|   2 models            [ ... ]      |
| [ + Add a model ]                  |
|                                    |
| > Models per mode   3 not set      |
| > Roles             4 more roles   |
| > Accounts          2, all yours   |
| > Model information Automatic, 24 h|
+------------------------------------+
```

800 px:

```
Models                                                             [+ Add a model]

In use
  Chat           [ Claude Sonnet            v ] [*]   200,000 ctx   $3 / $15   effort: not set
  Autocomplete   not set  [ Set up ]                  No completions until you pick one
  Edit           not set                              Uses the Chat model

Connections
  o  Anthropic    key CONTINUOUS_ANTHROPIC_API_KEY in secure storage   3 models   yours   [...]
  o  Ollama       http://localhost:11434, no key                      2 models   yours   [...]
  !  Bedrock      AWS SSO profile work: sign-in expired               1 model    yours   [ Fix ]

> Models per mode      Plan: Claude Sonnet. Agent: Qwen3.8 Flash#act. Loop, Re-plan, Subagent not set
> Roles                Apply, Embed, Rerank, Reviewer, Compaction
> Accounts             2 accounts in providers.yaml, both yours
> Model information    Automatic, every 24 hours. Last pulled 2026-11-20
```

- `[*]` is the gear that opens the model's details. `[...]` holds Manage models, Edit connection, Test, Remove (the actions of `ProvidersCard.tsx` today).
- "Edit: not set, uses the Chat model" is rule 2 applied to a role. Whether Edit really falls back to Chat was not checked in code; the line must say whatever the code does.
- Shown by default: In use, Connections. Folded: the four `>` rows.

Reuse: `ModelRoleRow.tsx`, `ProvidersCard.tsx`, `ProviderConnectionRow.tsx`, `ModeModelsTable.tsx`, `AssignModelsCard.tsx`, `ProviderInstancesCard.tsx`, `ModelInformationControl.tsx`, `PlaintextKeysNotice.tsx`. New: the one-line summaries on the folds, the context, price and effort on the In use rows.

### A model's details: every effective value with its source

The Configure dialog keeps its six tabs but gains a first tab, **Overview**, that is the answer to "what will this model actually do".

300 px:

```
+------------------------------------+
| Claude Sonnet                  [x] |
| [Overview] Connection  More v      |
|                                    |
| Context length                     |
|   200,000   published              |
| Max output                         |
|   32,000    from the provider      |
| Reasoning effort                   |
|   not set: the model's own setting |
| Reasoning budget                   |
|   not set: 2,048                   |
| Temperature                        |
|   0.6  from account strata  [Go]   |
| Prompt caching                     |
|   not set: on, 5 minute lifetime   |
| Price in / out per million         |
|   $3.00 / $15.00  price table      |
| Tools           yes   detected     |
| Images          yes   detected     |
| Roles                              |
|   chat, edit   set by you  [Reset] |
| Request timeout                    |
|   not set: 7,200 s                 |
|                                    |
| [ Test connection ]                |
| > Everything else (41 not set)     |
+------------------------------------+
```

800 px: the same rows as a four-column table.

```
Claude Sonnet     anthropic / claude-sonnet-4-6     account: anthropic-work          [ Test connection ]
[ Overview ] [ Connection ] [ Capabilities ] [ Generation ] [ Templates ] [ Context ] [ Advanced ]

Setting             Value in use            Source                         Action
Context length      200,000 tokens          published                      [ Set ]
Max output          32,000 tokens           from the provider              [ Set ]
Reasoning effort    the model's own         not set                        [ Set ]
Temperature         0.6                     account strata                 [ Go to account ]
Prompt caching      on, 5 minutes           not set                        [ Set ]
Price in / out      $3.00 / $15.00          price table                    [ Set ]
Tools               yes                     detected                       [ Set ]
Roles               chat, edit              set by you, config.yaml        [ Reset ]
Request timeout     7,200 s                 not set                        [ Set ]

> Everything else    41 settings, none set by you                          [ Show ]
```

- **Sources, one vocabulary.** "set by you" (with the file), "account NAME", "catalog model", "variant NAME", "from the server", "from the provider", "published", "price table", "detected", "assumed", "not set". Four of these exist for context length today (`ContextLengthControl.tsx:14-32`); the rest generalise it over the four layers of `docs/customize/model-catalog.mdx`.
- **Reset** removes the key from the layer where the person set it. **Go** opens that layer.
- **Reasoning effort and context length live here and nowhere else as a per-model value.** The chat toolbar's Thinking menu stays as the per-session choice and reads "Model setting (high)" where it reads "Default" today. The per-mode table keeps its effort row and reads "Not set: the model's setting".
- **Cost** is shown where a model is chosen (checklist), where it is in use (In use rows) and here. When no price is known the text is "no price known: cost is not estimated", never $0.
- **Local servers.** A found server shows its window as "from the server". When a server reports nothing: "32,768 assumed. Set the real size, or ask the server", with a button that runs the existing check.
- Shown by default: the rows above (what costs money, what limits a reply, what the model can do). Folded under "Everything else": sampling other than temperature, stop sequences, templates, system messages, compaction, cache details, proxy and certificates, headers.

Reuse: `ModelConfigDialog.tsx` and its panels, `ContextLengthControl.tsx`, `modelConfigForm.ts`, `MODEL_EDIT_FIELDS`, `PriceNote`. New: the Overview tab, a `resolvedValue(field, layers)` function in core that returns the value and its source for every field, and unset sentences for the 22 model rows marked "no" in section 1.5.

## 3.3 MCP servers

The dialog's steps, safety lines and option inventory are in `plans/research/mcp-server-wizard.md` sections 6 and 12. This section adds what the survey and Part 1 change, and what the owner asked for that the note does not have: the tab, the scope chip, moving between scopes, and the value state.

### The tab

300 px:

```
+------------------------------------+
| MCP servers                    [+] |
|                                    |
| o github              yours        |
|   5 tools, 1 waiting  [ Approve ]  |
|   [ Tools v ]              [ ... ] |
|                                    |
| ! postgres            this project |
|   Could not start: "uvx" was not   |
|   found. [ How to fix ]  [ Logs ]  |
|                                    |
| - linear              this project |
|   Waiting for you to trust this    |
|   folder's MCP files.  [ Review ]  |
|                                    |
| ? sentry              yours        |
|   Needs sign-in.      [ Sign in ]  |
|                                    |
| [ + Add a server ]                 |
+------------------------------------+
```

800 px:

```
MCP servers                                                    [ Import... ] [+ Add a server]

   Name       Where          State                                   Tools        Policy
o  github     yours          Active                                  5, 1 waiting  Mixed v   [...]
!  postgres   this project   Could not start: "uvx" was not found    none          n/a       [ How to fix ]
-  linear     this project   Waiting for you to trust this folder    none          n/a       [ Review ]
?  sentry     yours          Needs sign-in                           none          n/a       [ Sign in ]
x  memory     yours          Off                                     4             Ask First [...]

In Chat mode no MCP tools are offered. Plan offers the read-only ones.
```

`[...]` holds Edit, Duplicate, Move to this project (or Move to all my projects), Reload, Turn off, Sign out, Remove. A row opens to the tool list with Ask First, Automatic and Excluded per tool, as today.

Shown by default: name, where, state with one action, tool count. Folded: the tool list, prompts and resources, logs.

### States

Built on the six statuses in code (`ToolsSection.tsx:49-56`) plus the two holds that exist but are not shown as states.

| State                    | Looks like         | Message                                                           | Action           | Exists today                                                           |
| ------------------------ | ------------------ | ----------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| Active                   | green dot          | "Active"                                                          | none             | yes (`connected`)                                                      |
| Connecting               | amber dot, moving  | "Connecting", then "Downloading the package" for a slow first run | Cancel           | partly; the download text is MCPW27                                    |
| Needs sign-in            | `?`                | "Needs sign-in"                                                   | Sign in          | partly (an icon button, `ToolsSection.tsx:255-279`)                    |
| Signing in               | amber              | "Finish signing in in your browser"                               | Cancel           | yes (`authenticating`)                                                 |
| Tools waiting            | a count on the row | "1 tool waiting for approval"                                     | Approve          | yes, inside the server block                                           |
| Waiting for folder trust | `-`                | "Waiting for you to trust this folder's MCP files"                | Review           | held in core (`workspaceMcpPolicy.ts`), shown as an error line         |
| Changed since approved   | amber              | "The command changed since you approved it"                       | Review           | for tools ("changed"); for the command, proposed                       |
| Could not start          | `!`                | a plain sentence, see below                                       | How to fix, Logs | a raw error string, cut at 150 characters (`ToolsSection.tsx:469-486`) |
| Off                      | grey `x`           | "Off"                                                             | Turn on          | yes (`disabled`)                                                       |

Failure messages, plain language first, the raw text behind "Logs":

| Cause                                 | Message                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| The program is not installed          | Could not start: "uvx" was not found. Install uv, then Reload.                                                   |
| Nothing answered in time              | No answer after 20 s. The first run of an `npx` server can take longer. Try again, or raise the connect timeout. |
| The server exited                     | The server stopped right after it started. Its last lines are in Logs.                                           |
| 401 with sign-in information          | This server needs you to sign in.                                                                                |
| 401 without it                        | The server refused the key. Check the header or key in Edit.                                                     |
| A secret has no value on this machine | The secret GITHUB_TOKEN has no value here. Enter it.                                                             |
| The certificate is not trusted        | The server's certificate is not trusted. See "Certificates" in Edit.                                             |
| Port 3000 is in use during sign-in    | Sign-in needs port 3000 and another program is using it. Choose another port in Edit.                            |
| Both transports failed                | Could not connect over Streamable HTTP or the older SSE. Check the URL.                                          |

### The Add and Edit dialog

Basic, in order (the wizard note's Simple screen, with scope moved up and the value state added):

300 px:

```
+------------------------------------+
| Add an MCP server              [x] |
|                                    |
| Paste what the server's page says  |
| +--------------------------------+ |
| | npx -y @modelcontextprotocol/  | |
| | server-github                  | |
| +--------------------------------+ |
| or  [ Pick one ]  [ Import... ]    |
|                                    |
| Name    [ github               ]   |
| Runs    npx -y @modelcontext...    |
|         [ Show the whole command ] |
|   ! Not pinned to a version        |
| Token   [ ************         ]   |
|         kept in secure storage     |
|                                    |
| Use in  (o) All my projects        |
|         ( ) This project           |
|                                    |
| > Advanced   all 9 not set         |
|                                    |
| [ Run this command and test ]      |
| [ Save without testing ]           |
+------------------------------------+
```

800 px: the same fields in two columns (left: paste box and the "what will run" block; right: name, required values, scope), with the Advanced fold full width below. The test result replaces the right column.

```
Add an MCP server                                                                  [x]
+--------------------------------------------+  Name      [ github                ]
| Paste what the server's page says          |  Token     [ ************          ]
| npx -y @modelcontextprotocol/server-github |            kept in secure storage
+--------------------------------------------+
  or [ Pick one ]  [ Import from another tool ]  Use in    (o) All my projects
                                                           ( ) This project: shared with
  Runs   npx -y @modelcontextprotocol/server-github            people who open this folder
  ! Not pinned to a version. [ Pin to 2026.1.14 ]

> Advanced    Timeouts 20 s / 60 s. Working folder: this project. All 9 not set.

                                     [ Save without testing ]  [ Run this command and test ]
```

Advanced, each with its real built-in value from section 1.5:

| Field                      | Not set reads                                                             | Class | Notes                                                               |
| -------------------------- | ------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| Command and arguments      | (required for a local server)                                             | n/a   | editable list                                                       |
| Working folder             | Not set: this project's folder (your home folder in a remote workspace)   | b     | `MCPConnection.ts:756-793`                                          |
| Environment variables      | Not set: only PATH and a short list of system variables are passed        | a     | "Show the list"; add, remove, "store as secret"                     |
| Connect timeout            | Not set: 20 s                                                             | a     | `MCPConnection.ts:84`. The file key is in ms; the form uses seconds |
| Tool call timeout          | Not set: 60 s                                                             | a     | needs its own key; today it follows the connect timeout             |
| Connection type (URL only) | Not set: detected when tested (Streamable HTTP first, then the older SSE) | b     | written once the test succeeds                                      |
| Headers                    | Not set: none                                                             | b     | a header whose name looks like a credential is stored as a secret   |
| Use my own sign-in app     | Not set: the server registers this client itself                          | b     | client id; secret as a reference                                    |
| Sign-in callback           | Not set: http://localhost:3000                                            | a     | port and host, `mcpOauthLoopback.ts:4`, `:18`                       |
| Certificates               | Not set: your computer's certificate store is trusted (Windows and macOS) | a     | the same wording as for models                                      |
| Believe "read-only" claims | Not set: yes for your own servers, no for a project's                     | b     | user scope only, written to `permissions.yaml`                      |

Edit opens the same dialog filled from the entry (`manageMcpServers.ts:304`), with "Edit as YAML" for the one entry.

Differences from the wizard note worth checking in the build in flight:

- **Scope is asked in Basic, before the test**, because it decides whether the folder-trust step applies. The note has it as step 5 with the same two labels; keep the labels "All my projects" and "This project" everywhere, in the list too.
- **The value state on every Advanced field.** The note lists the fields; it does not say what an untouched field shows.
- **The tool call timeout** is not in the note's inventory as a separate setting. Part 1 found it is coupled.
- **Seconds in the form.** Roo and Codex use seconds; LibreChat, Kilo and this schema use milliseconds (ROO, CX, LC, KILO). A person should type 45, not 45000.

### Scope, and moving between scopes

- **All my projects** writes `mcpServers` in the person's own `config.yaml` (what `continuous mcp add --scope user` does). **This project** writes `.continuous/mcpServers/<name>.yaml` (`docs/customize/deep-dives/mcp.mdx:94-100`).
- **Move to this project.** Shows the file that will be written and says: "People who open this folder will be asked to trust it before it runs." Any literal secret is turned into a `${{ secrets.NAME }}` reference first; the move is refused if that fails. The entry is removed from the user config after the new file is written.
- **Move to all my projects.** Says: "It will start without the folder-trust question, and its read-only claims will be believed." This is a loosening (`mcpTrust.ts:8-15`), so it needs a confirmation and an audit line (roadmap CO6 covers the audit).
- **Tool approvals and policies do not move by themselves.** The approval record is per server id; after a move the tools are "waiting" again. Say so in the confirmation.
- **A name in both places.** The list shows both rows. The one that is not used reads "Not used: your own server with this name wins", with "Rename".

### Import paths, ranked by value

1. **Paste.** One box that takes a JSON block, a command line, a `claude mcp add` line, a URL or a deeplink. The parser exists and handles 14 shapes (`core/config/mcpWizard/types.ts:10-39`). This is the highest value: every server's README has one of these.
2. **Import from a tool on this computer.** Cline exists (`ImportClineMcp.tsx`). Add Claude Desktop, Claude Code, Cursor and VS Code as roadmap Track G lands. Evidence: JetBrains and VS Code both do this (JB, VSC-MCP).
3. **The pinned templates** (seven, `core/config/mcpWizard/templates.json`).
4. **A JSON file dropped in the folder**, which already works (`loadJsonMcpConfigs.ts`). The tab should list such files with "Convert to a server here".
5. **An install link** (MCPW15). Cursor, LM Studio, Goose and VS Code have one. It must open the review step and start nothing.
6. **Registry search** (MCPW14). Last; see below.

### Per-server and per-tool policy

- Keep the three words: Ask First, Automatic, Excluded. Keep the server-level menu that sets them all (shipped in #1028).
- **New tools stay hidden until approved**, and a changed description asks again. This is ahead of most of the survey; only Junie documents a comparable "Approval required" (JUN).
- **Say where a policy lives.** Today they are in the webview only (`uiSlice.ts:143-250`), so the CLI and a second editor window do not share them. Owner question Q8.
- **Tool cost.** Show the tool count and the estimated tokens per request on each row once TR6 and MCPW21 land. VS Code fails a request at 128 tools (VSC-RUN); a count before that is kinder.

### A registry or marketplace: recommended against, for now

- **For:** Cline, Cursor, Devin, VS Code, Junie's CLI and Claude Desktop all offer a browsable list (CLN, CUR, DEV, VSC-MCP, JUN, CD). It is what a new person expects.
- **Against, from the registry's own pages:** it is in preview; it says host applications should use an aggregator; it says to assume "minimal-to-no moderation"; it does not remove servers with vulnerabilities; it does not verify who controls a remote URL (REG).
- **Against, from the specification:** a one-click local install is code execution, and the client must show the full command and get consent (SPEC-SEC). A list makes it easy to click through that.
- **Against, from this repository:** the registry was at least 60,000 records and 55 MB when measured (roadmap MCPW14), and browsing it is a new outbound host.
- **Recommendation:** ship paste, import and the pinned templates. Keep MCPW14 as opt-in, asked once, searched locally, and never one click from list to running. Revisit when the registry leaves preview or a moderated sub-registry exists.

## 3.4 Configuration scope everywhere

One chip, one menu, one rule.

- **The chip.** Every row that comes from a file shows where it lives: `yours` (your own files, all projects) or `this project`. Hovering or focusing it gives the file path. Rows: models, connections, accounts, MCP servers, rules, prompts, configs, permission rules.
- **The menu.** "Move to this project..." or "Move to all my projects...", where the move makes sense (table below).
- **The rule on a name clash.** Yours wins, everywhere, and the row that lost says so. This matches `docs/customize/workspace-trust.mdx` and the MCP loader. It does not match `docs/customize/providers.mdx` and `providerInstances.ts:158`, which must be reconciled (owner question Q9).
- **Never written to a workspace file:** an API key, a token, an OAuth client secret, a header value that is a credential, or the value of any secret. Only `${{ secrets.NAME }}` references go there. Also never: trust records, approval levels and tool approvals. A workspace file can ask; only the person's own files can allow.

| Thing            | yours | this project | Move offered               | Notes                                                                                  |
| ---------------- | ----- | ------------ | -------------------------- | -------------------------------------------------------------------------------------- |
| MCP server       | yes   | yes          | both ways                  | section 3.3                                                                            |
| Model            | yes   | yes          | both ways                  | the key stays a reference; the account it names must exist                             |
| Provider account | yes   | yes          | to yours only              | an account in a project is held until trusted; do not make more                        |
| Rule, prompt     | yes   | yes          | both ways                  | plain text, the safest thing to share                                                  |
| Config           | yes   | yes          | already chosen at creation | `docs/customize/configs.mdx`                                                           |
| Approval levels  | yes   | no           | none                       | a project must not loosen them                                                         |
| Permission rule  | yes   | no           | none                       | a project may tighten through its own files only if the owner wants; not proposed here |
| Tool policy      | yes   | no           | none                       | Q8                                                                                     |
| UI settings      | yes   | no           | none                       | chat display, font                                                                     |

Wireframe of the chip and its menu, both widths:

```
o  github     [ yours v ]
              +----------------------------------+
              | In: ~/.continuous/config.yaml    |
              | Open the file                    |
              | Move to this project...          |
              +----------------------------------+
```

## 3.5 Migration and risk

### Slices

Each is one pull request and useful by itself. Sizes: S up to about 400 lines with tests, M up to about 1,200.

| Order | ID   | What                                                                                                                                                                                                   | Size |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 1     | ST0  | A scripted walk in `bench/screenshots` that counts steps and seconds for three journeys; record today's numbers                                                                                        | S    |
| 2     | ST1  | "MCP servers" tab: move the list out of Tools, add the tab second, alias the old link                                                                                                                  | S    |
| 3     | ST2  | Move Approval, Built-in rules, Plans and questions, Decision timer, Shadow review and Commands and secrets from Tools to Permissions views "Levels" and "Protections", each fold with a one-line state | S    |
| 4     | ST3  | Rename "Settings" to "General", fold Indexing into it, reorder the tabs, landing tab rule, link aliases, docs                                                                                          | S    |
| 5     | ST4  | The value-state component and rule 2 on the model dialog: no bare "Default", unset sentences for the 22 model rows marked "no"                                                                         | M    |
| 6     | ST5  | MCP defaults stated in the Add and Edit dialog; a separate tool call timeout key; write the tested transport                                                                                           | S    |
| 7     | ST6  | Merge Providers into Models: In use, Connections, four folds with summaries; `providers` alias                                                                                                         | M    |
| 8     | ST7  | "Add a model" start screen with found servers, automatic test, context and price columns, "Use for"                                                                                                    | M    |
| 9     | ST8  | Model Overview tab: every effective value with its source, Reset, Go                                                                                                                                   | M    |
| 10    | ST9  | Scope chip and "Move to..." for MCP servers                                                                                                                                                            | M    |
| 11    | ST10 | Settings registry in core, with a test that every drawn control has an entry; feeds CO9                                                                                                                | M    |
| 12    | ST11 | Search across Settings over the registry; `&section=` and `&item=` links                                                                                                                               | M    |
| 13    | ST12 | Scope chip for models, rules, prompts and accounts; one clash rule; the two docs pages agree                                                                                                           | M    |
| 14    | ST13 | Per-mode table and the Thinking menu say the resolved value; MCP states and failure sentences of section 3.3                                                                                           | S    |

ST0 to ST3 answer the scrolling complaint and need no new design. ST4 and ST5 answer "unknown defaults" where it hurts most. The dialog being built by the other engineer sits between ST1 and ST5 and is roadmap MCPW4, not a row here.

### What breaks

- **Docs that name the old places**: `docs/customize/model-setup.mdx` ("Settings > Providers", five times), `docs/customize/providers.mdx` ("Settings > Providers > Provider accounts"), `docs/customize/model-catalog.mdx` ("Settings > Models > Assign models"), `docs/customize/configs.mdx`, `docs/customize/deep-dives/mcp.mdx` (the Quick Start tells people to make a folder and a YAML file), `docs/ide-extensions/agent/permissions-page.mdx`, and the picture `docs/images/settings-configs.png`.
- **Text inside the product that names the old places**: "Change it in Settings > Tools or the toolbar" and "Pick one in the toolbar above the input or in Settings, Tools" (picture `settings-permissions`), and the model information text "in the Models settings" (picture `catalogue`).
- **Links**: `/config?tab=providers`, `tab=indexing`, `tab=settings`, and `CONFIG_ROUTES.PROVIDERS` (`ModelsSection.tsx:184`). All are kept as aliases in ST3 and ST6.
- **Screenshot views and baselines**: `settings-tools`, `settings-tools-mcp`, `settings-general`, `settings-indexing` and the axe and overflow baselines (`bench/screenshots/README.md`). Each slice updates its own views; the baselines must not grow.
- **Tests keyed to position**: `data-testid` values stay, so tests that find by id survive; tests that render `ToolsSection` and expect the MCP list will move with it.
- **Muscle memory.** People who learned "Tools, scroll down" will look there. ST1 leaves one line on Tools: "MCP servers moved to their own tab", for two releases.

### Risk

| Risk                                                      | What limits it                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Folding protections makes them easier to forget           | Each fold's header states the state; anything loosened shows in the header in the warning colour                               |
| An "unset" sentence that is wrong is worse than a blank   | The sentence comes from the same function the code uses to resolve the value (ST8, ST10), with a test per setting              |
| Moving a server to "yours" loosens it                     | Confirmation, an audit line, approvals reset                                                                                   |
| Not sending max tokens changes behaviour on local servers | Owner decision Q6; only for servers with no known cap; shown in Overview                                                       |
| Two engineers on the MCP surface                          | ST1 and ST5 are small and named; this note does not redefine MCPW4                                                             |
| JetBrains                                                 | The webview is shared; `ModeModelsTable` is hidden there today (`ModelsSection.tsx:192`). Each slice says what JetBrains shows |

### How to measure that it is easier

ST0 adds a walk to the screenshot harness that drives the real `<App/>` and writes, per journey: clicks, keys typed, the pixels scrolled, the number of times a file opens in the editor, and seconds with a fixed delay per action.

| Journey                                    | Today (counted from code, not run)                                | Target                                 |
| ------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------- |
| See the MCP server list from an open chat  | 2 clicks and about 2,600 px of scroll (800 px), 3,800 px (300 px) | 2 clicks, no scroll                    |
| Add a local MCP server from a README line  | at least 9 steps, 1 file opened, YAML written by hand             | 5 steps, no file, no YAML              |
| Move a server from the project to yours    | cut and paste between two files                                   | 2 clicks and a confirmation            |
| From no model to a first reply, with a key | not counted                                                       | count in ST0, then reduce by a third   |
| Find what max output a model will use      | not possible in the UI                                            | 2 clicks (gear, Overview)              |
| Controls that say only "Default"           | 9                                                                 | 0, checked by a test over the registry |
| Class c settings                           | 10                                                                | 0                                      |

### Owner questions

| #   | Question                                                                                               | Recommendation                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Q1  | Merge the Providers tab into Models?                                                                   | Yes. One job, and the Models tab already has a card that only links across                                    |
| Q2  | Do the approval preset and levels live on Permissions, not Tools?                                      | Yes. They stay in the chat toolbar too, which is where they are changed most                                  |
| Q3  | "Commands and secrets" to Permissions, Protections, folded?                                            | Yes. It is a protection with a safe built-in value. Link to the editor's terminal settings from it            |
| Q4  | Rename the "Settings" tab to "General" and fold Indexing into it?                                      | Yes. Indexing already says it is deprecated                                                                   |
| Q5  | A registry or marketplace in the Add dialog now?                                                       | No. Paste, import and pinned templates now. Registry search later, opt-in, asked once (MCPW14)                |
| Q6  | Stop sending max output tokens to a local server with no known cap?                                    | Yes, for local OpenAI-compatible servers only, shown as "Not set: the server decides". Keep the cap elsewhere |
| Q7  | A separate key for the MCP tool call timeout, and its value when not set?                              | Yes. `toolTimeout`, 60 s when not set, shown. The connect timeout stays 20 s                                  |
| Q8  | Move tool policies (Ask First, Automatic, Excluded) out of the webview into a file the CLI also reads? | Yes, into the person's own files, never a project file. It is a separate slice, after ST9                     |
| Q9  | On a name clash between yours and the project's, which wins for provider accounts and catalog models?  | Yours, as for MCP servers and as `workspace-trust.mdx` says. Fix `providers.mdx` and the code if they differ  |
| Q10 | Which tab opens first?                                                                                 | Models when no chat model works, otherwise the tab last used                                                  |
| Q11 | A search box across Settings?                                                                          | Yes, but after the registry (ST10). It is the last slice, not the first                                       |

## 3.6 Roadmap rows

Proposed new track: **Track ST: Settings layout, stated defaults and scope**. The prefix `ST` is not used in `plans/ROADMAP.md` at `1723e47ab` (used prefixes that start with S: S, SB, SES, SH). These rows are in this note only; the roadmap was not edited.

| ID   | Scope                                                                                                                                                                                                                                                                          | Size | Needs           | Acceptance                                                                                                                                                                       | State    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| ST0  | A scripted walk in `bench/screenshots` for three journeys (reach the MCP list, add a server, add a model): clicks, keys, pixels scrolled, files opened; today's numbers recorded in the note                                                                                   | S    | none            | The walk runs with no model and no network and writes one JSON line per journey; the three baseline numbers are committed                                                        | Proposed |
| ST1  | An "MCP servers" tab, second in the list: the server list, `+` and Import move out of Tools unchanged; `?tab=mcp`; one line on Tools for two releases saying where they went                                                                                                   | S    | none            | From an open chat the list is 2 clicks and 0 px of scroll at 300 and 800 px; `settings-tools-mcp` is replaced by a `settings-mcp` view; axe and overflow baselines do not grow   | Proposed |
| ST2  | Permissions gets views "Levels" (preset, five levels, Plans and questions folded) and "Protections" (Locks, Built-in rules, Commands and secrets, Decision timer, Shadow review, each folded with a one-line state); Tools keeps only Built-in Tools                           | S    | none            | No control is lost (a test lists every `data-testid` before and after); each fold header states its state; a loosened protection shows in the header                             | Proposed |
| ST3  | Tabs reordered to Models, MCP servers, Tools, Permissions, Rules, Configs, General, Help; "Settings" renamed "General"; Indexing folded into General; aliases for `providers`, `indexing`, `settings`; landing tab rule; docs and in-product text that name old places updated | S    | ST1, ST2        | Every old `?tab=` value opens the right place; a docs check finds no "Settings > Providers" or "Settings > Tools" left; with no chat model Settings opens on Models              | Proposed |
| ST4  | The value state: one component and one rule ("Set by you: X" with Reset, or "Not set: what happens and the value in use"); applied to the model Configure dialog; unset sentences for the 22 model settings that show none                                                     | M    | none            | No control in the model dialog renders the bare word "Default" or an empty placeholder (a test over `MODEL_EDIT_FIELDS`); saving an untouched form writes no key                 | Proposed |
| ST5  | MCP defaults stated in the Add and Edit dialog (connect timeout 20 s, tool call timeout 60 s, working folder, environment list, callback `localhost:3000`, certificates); a separate `toolTimeout` key; the tested transport is written to the entry                           | S    | MCPW4; owner Q7 | Every Advanced field shows its unset sentence; setting the connect timeout no longer changes the tool call timeout; a URL server saved after a test has an explicit `type`       | Proposed |
| ST6  | Models and Providers merged: "In use" rows with context, price and effort; "Connections"; folds for Models per mode, Roles, Accounts and Model information, each with a one-line summary                                                                                       | M    | ST3; owner Q1   | One tab; every action of `ProvidersCard` and `ProviderInstancesCard` is still reachable; the page is under 700 px tall with the folds closed at 800 px for a config of 5 models  | Proposed |
| ST7  | "Add a model" starts with "What do you have?": an API key, a server on this computer (found servers listed), a server on my network, nothing yet; the test runs by itself; the checklist shows context, price and tools; a "Use for" step                                      | M    | ST6             | In the ST0 walk, steps from no model to a saved chat model drop by a third; a found Ollama or LM Studio needs no typing; unknown price or window reads "not published"           | Proposed |
| ST8  | A model's Overview tab: every effective value with its source (set by you, account, catalog model, variant, from the server, published, detected, assumed, not set), Reset and Go; `resolvedValue` in core returns value and source for every field                            | M    | ST4             | For a model built from all four layers the Overview names the right layer for each set key (fixture test); max output, reasoning and caching show a value or a rule, never blank | Proposed |
| ST9  | Scope chip (`yours`, `this project`) on every MCP server row, with the file path; "Move to this project..." and "Move to all my projects..." with the confirmations of the note; a row that loses a name clash says so                                                         | M    | ST1, MCPW5      | A move leaves exactly one entry; no literal secret is ever written to a workspace file (canary test); moving to yours writes an audit line and resets tool approvals             | Proposed |
| ST10 | A settings registry in core: id, label, file and key, class (built-in value, unset by design), the built-in value or the function that says what unset does, scope, tab; the GUI rows, the docs reference and `continuous doctor config` read it                               | M    | ST4; CO9        | A test fails when a drawn control has no registry entry or an entry has neither a value nor an unset sentence; the count of settings with an unknown default is 0                | Proposed |
| ST11 | Search across Settings over the registry; choosing a result opens the tab, opens the fold and focuses the control; `&section=` and `&item=` in the link                                                                                                                        | M    | ST10            | Typing "timeout" lists the model and MCP timeouts with their tabs; the box is reachable by keyboard and announced through the existing announcer                                 | Proposed |
| ST12 | Scope chip and Move for models, rules, prompts and accounts; one rule on a name clash (yours wins) in code and in `providers.mdx`, `model-catalog.mdx` and `workspace-trust.mdx`                                                                                               | M    | ST9; owner Q9   | The three docs pages state the same rule; a fixture with the same account name in both places loads the person's own and marks the other "not used"                              | Proposed |
| ST13 | The per-mode table and the Thinking menu state the resolved value instead of "Default"; the MCP list shows the states and plain failure sentences of section 3.3, with the raw text behind Logs                                                                                | S    | ST4, ST1        | No "Default" option remains in `ModeModelsTable` or `ThinkingEffort`; each of the nine failure causes has a fixture and a sentence; no raw error is cut at 150 characters        | Proposed |

## What could not be verified

In this codebase:

- **Run-time precedence** when a provider account or catalog model has the same name in the user's files and the workspace. The docs disagree and only a code comment was read.
- **What unset means** for Region, API version, the no-proxy list, Reasoning, the three cache switches and the cache lifetime. The table says "not checked" or "depends on the provider"; each needs its adapter read before a sentence is written.
- **Whether Edit and Autocomplete fall back to the Chat model** when no model has the role.
- **The Providers tab and the Configure dialog on screen.** The harness has no view of either.
- **The Settings tab's height**, and every height at widths other than 300 and 800.
- **Whether any hub or `uses:` source still loads.**
- **The step counts for today's journeys.** They are counted from the code path, not walked. ST0 exists to replace them with measurements.
- **JetBrains.** Nothing was checked there.

About other tools:

- Rows marked H were not read by me. Four pages were spot-checked (VS Code MCP configuration, Devin MCP, Claude Code MCP, the registry moderation policy) and matched.
- **Devin Desktop and Windsurf.** `docs.windsurf.com` is reported to redirect to `docs.devin.ai` (H). The page I read describes Devin Desktop and treats Windsurf as a legacy format; it does not say the product was renamed.
- **Not found on the pages read:** Cursor's custom base URL, per-tool switches and file precedence; any Windsurf tool-count limit; VS Code's exact trust wording and where it stores a user's own keys; Zed's dialog field labels; where JetBrains AI Assistant stores MCP config; Cline's timeout value and per-tool boxes; Roo's settings search; whether any model picker other than those cited shows the context window.
- **Not surveyed:** Amp, Jan.
- **The MCP registry's state** beyond "preview" on its own pages, and its full schema.
- **Tool annotation defaults** in the specification came from a summary of the schema page.

## Leftovers

Scratch pictures are in a temp folder outside the repository. The harness started Edge and a build per run and each run exited. No server was left running by this work.
