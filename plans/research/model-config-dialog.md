# Model configuration dialog

Status: design plus a first slice (the "Configure..." dialog with Connection, Capabilities, Generation and Context & cost). Written 2026-11-13 against `main` 62277ea78. Owner request: "add more advanced model configuration dialogs, especially now that we support the prompt styles and tool call dialects". Principle: a good UI to view, change and check the model settings that already exist; new semantics come later and are listed as owner decisions.

## 1. What exists today (read from the code)

### 1.1 The model entry (`packages/config-yaml/src/schemas/models.ts`)

| Field                                                                                                                                                                                             | Where                                                            | Notes                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `model`, `provider`, `apiBase`, `apiKey`, `connection`, `contextLength`, `maxStopWords`, `roles`, `capabilities`, `toolDialect`, `env`, `useLegacyCompletionsEndpoint`, `useResponsesApi` | `baseModelFields` at :281                                        | `provider` is optional when `connection` names a provider account (`connectedModelSchema` :338)                                                                                                                                                                                                                              |
| `roles`                                                                                                                                                                                           | `modelRolesSchema` :30                                           | chat, autocomplete, embed, rerank, edit, apply, summarize, subagent, reviewer. Default `[chat, edit, apply, summarize]` (docs/reference.mdx :76)                                                                                                                                                                             |
| `capabilities`                                                                                                                                                                                    | `modelCapabilitySchema` :45                                      | `tool_use`, `image_input`, `next_edit`, any string. A list present means exactly those: `core/config/yaml/models.ts` :111-115 sets `tools: capabilities.includes("tool_use")`, so a list without `tool_use` turns tools off                                                                                                  |
| `defaultCompletionOptions`                                                                                                                                                                        | `completionOptionsSchema` :55                                    | contextLength, maxTokens, temperature, topP, topK, minP, presencePenalty, frequencyPenalty, stop, n, reasoning, reasoningBudgetTokens, promptCaching, omitSampling, stream, keepAlive                                                                                                                                        |
| `cacheBehavior`                                                                                                                                                                                   | :90                                                              | cacheSystemMessage, cacheConversation, ttl (`auto`, `5m`, `1h`)                                                                                                                                                                                                                                                              |
| `requestOptions`                                                                                                                                                                                  | :12                                                              | timeout (seconds, default 7200: `packages/fetch/src/getAgentOptions.ts` :12), connectTimeout (default 10), verifySsl, useSystemCa, caBundlePath (string or list), proxy, headers, extraBodyProperties, noProxy, clientCertificate                                                                                            |
| `embedOptions`                                                                                                                                                                                    | :100                                                             | maxChunkSize, maxBatchSize, embeddingPrefixes                                                                                                                                                                                                                                                                                |
| `chatOptions`                                                                                                                                                                                     | :133                                                             | baseSystemMessage, baseAgentSystemMessage, basePlanSystemMessage, toolOverrides (:138)                                                                                                                                                                                                                                       |
| `contextManagement`                                                                                                                                                                               | :150                                                             | autoCompactRatio, autoCompactTokens, subagent budget, requestBodyHints                                                                                                                                                                                                                                                       |
| `promptTemplates`                                                                                                                                                                                 | :218 (chat names from `templateSchema` :174)                     | apply, chat, edit, autocomplete                                                                                                                                                                                                                                                                                              |
| `autocompleteOptions`                                                                                                                                                                             | :195                                                             | 18 options                                                                                                                                                                                                                                                                                                                   |
| `routes`                                                                                                                                                                                          | `catalogRouteSchema` :232                                        | further accounts serving the same model                                                                                                                                                                                                                                                                                      |
| `toolDialect`                                                                                                                                                                                     | `TOOL_DIALECT_VALUES` :248                                       | auto, native, off and 23 markup dialects                                                                                                                                                                                                                                                                                     |
| Reasoning effort                                                                                                                                                                                  | `packages/config-yaml/src/schemas/index.ts` :103, :137           | Not on the model: `modeModels.<mode>.reasoningEffort` (off, low, medium, high)                                                                                                                                                                                                                                               |
| Provider-specific (`env.*`)                                                                                                                                                                       | `core/config/yaml/models.ts` :12-33                              | apiType, apiVersion, deployment, deploymentId (Azure); region, profile, accessKeyId, secretAccessKey, sessionToken, crossRegionInference, serviceTier, latency, guardrail\*, modelArn, mantlePathPrefix (Bedrock); projectId (Vertex); aiGatewaySlug, accountId (Cloudflare); maxTokensParam; `useLegacyCompletionsEndpoint` |
| Provider accounts                                                                                                                                                                                 | `providerInstanceSchema` :350, catalog `catalogModelSchema` :392 | `~/.continuous/providers.yaml` and `models.yaml` (docs/customize/model-catalog.mdx)                                                                                                                                                                                                                                          |

**Prompt styles.** There is no `promptStyle` setting. `PromptStyle` (`core/util/toolDialectPresets.ts` :78) is preset data per model family ("Data only: nothing reads this field to change what is sent"), with one row per family in `core/util/toolDialectPresetTable.ts` :22. What a model is actually sent is decided by `capabilities` plus the global `experimental.onlyUseSystemMessageTools` (`gui/src/redux/util/buildChatRequest.ts` :129-135, `core/llm/toolSupport.ts` :549): native tool definitions, or the code-block framework in the system message (`core/tools/systemMessageTools/buildToolsSystemMessage.ts`). So today's "prompt style" choice is native vs system message, per model through `capabilities`.

**Prices.** There is no price field. Budgets (`extensions/cli/src/budget/runBudget.ts` :66, :80) price through `costOf` (`core/util/costOf.ts` :91) and `calculateRequestCost` (`core/llm/utils/calculateRequestCost.ts` :703): built-in tables for Anthropic, Bedrock, Vertex Claude and OpenAI, and the downloaded OpenRouter list (`core/llm/utils/catalogPricing.ts`, `continuous models refresh`). `costOf` already accepts a `UserPrice` (:33) but only the shadow reviewer and loop cost pass one.

### 1.2 The UI today

| Piece                         | Where                                                                                                                                                                                             | What it does                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Gear on each picker row       | `gui/src/components/modelSelection/ModelSelect.tsx` :95-99 (before this change)                                                                                                                   | Navigated to the Models settings page                                                                                            |
| Gear on each role row         | `gui/src/pages/config/components/ModelRoleRow.tsx` :73-83, `useEditModel` in `components/mainInput/Lump/useEditBlock.ts`                                                                          | Opened config.yaml (or the block file)                                                                                           |
| Provider setup flow           | `gui/src/components/ProviderSetup/ProviderSetupFlow.tsx` :142                                                                                                                                     | Provider, key storage, model checklist, review; writes through `config/saveProviderModels` (`core/config/providerSetup.ts` :402) |
| Providers / accounts cards    | `gui/src/pages/config/components/ProvidersCard.tsx`, `ProviderInstancesCard.tsx`                                                                                                                  | Connections and providers.yaml accounts                                                                                          |
| Mode models table             | `gui/src/pages/config/components/ModeModelsTable.tsx`                                                                                                                                             | Models and reasoning effort per mode                                                                                             |
| Test connection               | `gui/src/forms/OpenAICompatConnectionTester.tsx`, `BedrockConnectionTester.tsx`; core `core/util/openaiCompatTest.ts` :233; CLI `continuous test-connection` (`extensions/cli/src/index.ts` :551) | Lists models, sends one probe with a made-up tool, offers "Turn on recovery" (`config/setToolDialect`)                           |
| Tool dialect one-click        | `core/config/yaml/saveToolDialect.ts`, leak notice `gui/src/components/mainInput/ToolDialectNotice.tsx`                                                                                           | Sets `toolDialect` on one model                                                                                                  |
| Global "system message tools" | `gui/src/pages/config/sections/UserSettingsSection.tsx` :64                                                                                                                                       | One switch for all models                                                                                                        |
| Writer                        | `core/util/paths.ts` `editConfigFile` :593, `editConfigYaml` :490; `core/util/yamlEdit.ts` `editYamlText`                                                                                         | `parseDocument` edit: comments, key order, unknown keys and CRLF kept; one `.bak` for files in `~/.continuous`                   |
| Secrets                       | `config/setSecret` (`core/protocol/core.ts`), `core/config/secretStorage.ts`, `core/util/unresolvedSecrets.ts`                                                                                    | Secure storage or `~/.continuous/.env`; config.yaml holds `${{ secrets.NAME }}`                                                  |

Everything in 1.1 except the fields the provider flow writes (provider, model, apiBase, key, roles for new models) and `toolDialect` (one-click) was editable only by hand.

## 2. The dialog

### 2.1 Entry points

- The gear on each model in the chat model picker, and the gear on each role row of Models settings, now open **Configure <model>**. Both had an accessible name only in the picker; the role row gear now has `aria-label="Configure <model>"`.
- The dialog has **Open file** in its header, so the old behaviour is one click away.

### 2.2 Layout (sidebar width; tabs wrap)

```
+------------------------------------------------------------+
| Configure Qwen Coder                                    [x] |
| User config: ~/.continuous/config.yaml   Open file          |
| [Connection] Capabilities  Generation  Context & cost       |
|------------------------------------------------------------|
| Provider        [vllm                                   ]   |
| Model id        [qwen3-coder                            ]   |
| API base        [http://gpu-box:8000/v1                 ]   |
| API key         Stored as the secret QWEN_KEY.              |
|                 (o) Keep  ( ) Use a secret  ( ) Remove      |
| Request timeout [            Default: 7200             ]   |
| Connect timeout [            Default: 10               ]   |
| Proxy           [  Default: HTTPS_PROXY / HTTP_PROXY   ]   |
| Verify TLS      [Default (on)              v]               |
| Headers         X-Team [tools        ] Remove               |
|                 Authorization [hidden (kept)  ] Remove      |
|                 [Add header]                                |
| Test connection [Test connection]  (unsaved values)        |
|------------------------------------------------------------|
|                                  [Cancel] [Review changes]  |
+------------------------------------------------------------+
```

Capabilities:

```
| Roles      [x] Default (chat, edit, apply, summarize)       |
| How tools are sent (prompt style)                           |
|   (o) Auto-detect (native)  ( ) Native  ( ) System message  |
|   Known family Qwen3-Coder: asks for native tool calls ...  |
|   Sent as an API tool definition (read_file shown):         |
|   { "tools": [ { "type": "function", ... } ] }              |
| Image input  (o) Auto-detect ( ) Yes ( ) No                 |
| Tool calls written as text  [Qwen XML (qwen-xml)      v]    |
|   Qwen3-Coder's markup. A reply in this form runs read_file:|
|   <tool_call><function=read_file><parameter=filepath>...    |
```

Context & cost:

```
| Context length  [ 131072 ]                                  |
| Prompt caching  [Default v]   Cache lifetime [Default v]    |
| Price (used by budgets)                                     |
|   $3.00 in / $15.00 out per million tokens, built-in table. |
|   or: No price is known for vllm/qwen3-coder, so a dollar   |
|   budget (--max-budget-usd) refuses to run on it ...        |
```

Review:

```
| Review the change to config.yaml                            |
|   The key is stored as QWEN_NEW in secure storage, not in   |
|   config.yaml.                                              |
|     - name: Qwen Coder                                      |
| -     apiKey: ${{ secrets.QWEN_KEY }}                        |
| +     apiKey: ${{ secrets.QWEN_NEW }}                        |
|       defaultCompletionOptions:                             |
| -       temperature: 0.2 # tuned                             |
| +       temperature: 0.7 # tuned                             |
|   Comments and every setting not shown here are kept.       |
|                                          [Back] [Save]      |
```

Added in the second slice (section 7): **Templates & system message** (`promptTemplates`, `chatOptions.base*SystemMessage`, `toolOverrides`) and **Advanced (YAML)** (the entry as text, parsed, turned into the same patch and written through the same writer). Still planned: **Autocomplete** and **Embeddings** (shown only when the role applies).

### 2.3 Behaviour

- **Prefilled from the entry as written**, not from the loaded model, so a value inherited from a provider account or default is not mistaken for one the user set. A model whose `connection:` names an account says so: a value set here wins for this model only.
- **Defaults are placeholders**, never written. Only fields whose input changed become patch operations; clearing a field removes the key, and a map left empty is removed.
- **Validation** per field while typing (`aria-invalid`, message linked with `aria-describedby`), again on Review in the webview, and authoritatively in core: the same rules (`core/config/modelEdit/modelEditFields.ts`) plus the zod schema of the whole entry. A tab with an error is marked and Review jumps to it.
- **Review shows the YAML diff** core computed for the exact text it will write, with two lines of context and credentials masked. Save sends the preview's SHA-256; core refuses with "changed since the preview" if the file moved, and the dialog asks for a new review.
- **Round trip**: the writer is `editYamlText`, so comments, key order, anchors, CRLF and unknown keys survive. Core only accepts patches to the listed paths, request headers and `capabilities`; anything else is refused with a message.
- **Secrets**: the dialog never receives a plain credential (plain values under credential-like keys are replaced with `••••••`; secret references are returned as names). A key is written to config.yaml only as `${{ secrets.NAME }}`; a typed value goes to `config/setSecret` (secure storage or `.env`) before the config is saved, and if storing fails nothing is saved. Credential headers (`Authorization`, `*api-key*`, `*token*`, `*secret*`, `Cookie`, ...) accept only a reference; an existing plain one stays as written unless replaced.
- **Scope**: the file is the one every GUI save writes (`getEditableConfigYamlPath`, the selected config). The header says "User config" (inside `~/.continuous`) or "Workspace config" and shows the path. A model from a block file, a catalog `from:`, a `uses:` entry, a hub assistant or a non-local profile is shown read-only with the reason and Open file.
- **Test connection** reuses the existing testers with the unsaved values: OpenAI-compatible and Anthropic through `OpenAICompatConnectionTester` (key: the one being typed, else the loaded model's key, never shown), Bedrock through `BedrockConnectionTester` (region, profile).
- **Accessibility**: `role="dialog"`, `aria-modal`, labelled by its heading; WAI-ARIA tabs with roving `tabindex` and Left/Right/Home/End; every input has a label; radio groups are named; previews and the diff are focusable regions; the diff marks lines as "added:"/"removed:" for screen readers rather than by colour alone; Escape closes (app dialog).
- **JetBrains**: the three new messages are in `MessageTypes.kt`, so the same webview dialog works there. JetBrains has no secure storage (`plans/model-config-ux.md` 9), so "Use a secret" falls back to `.env` there.

### 2.4 CLI parity

There is no `continuous models edit` today; `continuous models` is the OpenRouter list (`extensions/cli/src/commands/models.ts` :190). The core functions are surface-free (`editModelBlockText`, `previewModelEditText`), so a CLI can reuse them. Proposed (owner decision D5): `continuous model show <name>` (masked entry) and `continuous model set <name> <path>=<value> ... [--dry-run]` printing the same diff. Until then, the same change by hand is the YAML in the Review step.

## 3. Owner decisions

| #   | Question                                                                                                                                | Recommendation                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Make the prompt style a per-model setting (`toolPrompt: native \| system-message \| <family form>`) instead of riding on `capabilities` | Not yet. The family forms are data only and unmeasured (ROADMAP Q17, Q24, TR10). The dialog shows the preset's recommendation and the real choice (native or system message). Revisit when Q17 measures a prompted path |
| D2  | A price field on the model (`pricing: { input, output, cacheRead, cacheWrite }` per MTok)                                               | Approved (by the owner's delegate, 2026-11-13) and done in the second slice: section 7                                                                                                                                  |
| D3  | Edit the provider account (providers.yaml) from this dialog, or only the model                                                          | Only the model; link to the account card. One file per save keeps the review honest                                                                                                                                     |
| D4  | Edit models defined in block files and catalogs (`from:`)                                                                               | Later: the writer works per file, so it is the same code pointed at `sourceFile`; the review must then name that file                                                                                                   |
| D5  | CLI command name and shape (2.4)                                                                                                        | `continuous model show/set`, not under `models` (that is the OpenRouter list)                                                                                                                                           |
| D6  | Allow a plaintext key from the dialog at all                                                                                            | No. The provider flow still offers "inline"; the dialog does not                                                                                                                                                        |
| D7  | Reasoning effort per model (today only per mode)                                                                                        | Keep per mode; the dialog links to the mode table                                                                                                                                                                       |

## 4. First slice (this PR)

Core:

- `core/config/modelEdit/modelEditFields.ts`: field registry, masking, validation, patch application (webview-safe).
- `core/config/modelEdit/modelBlockEdit.ts`: read, preview (diff, hash) and save for the editable config.
- Messages `config/getModelBlock`, `config/previewModelEdit`, `config/saveModelEdit` (protocol, pass-through, JetBrains list, handlers; save reloads the config).

GUI (`gui/src/components/ModelConfig/`): `ModelConfigDialog.tsx`, `modelConfigForm.ts`, `toolPreview.ts`, `useModelConfigDialog.tsx`; the two gears now open it.

Covered fields: provider, model, apiBase, apiKey (secret reference), env.region / profile / projectId / deployment / apiVersion / apiType (shown per provider), requestOptions.timeout / connectTimeout / proxy / noProxy / verifySsl / useSystemCa / caBundlePath / headers, roles, capabilities (tool_use, image_input; other names kept), toolDialect, defaultCompletionOptions.temperature / topP / topK / presencePenalty / frequencyPenalty / maxTokens / stop / reasoning / reasoningBudgetTokens / promptCaching, contextLength, cacheBehavior.cacheSystemMessage / cacheConversation / ttl.

Not covered yet (still kept untouched on save, and editable by hand): `name` (rename), `connection`, `routes`, `maxStopWords`, `useLegacyCompletionsEndpoint`, `useResponsesApi`, defaultCompletionOptions.contextLength / minP / n / stream / keepAlive / omitSampling, requestOptions.extraBodyProperties / clientCertificate, env credentials (accessKeyId, secretAccessKey, sessionToken: shown nowhere yet, never sent) and the other env keys (deploymentId, crossRegionInference, serviceTier, latency, guardrailIdentifier, guardrailVersion, modelArn, mantlePathPrefix, maxTokensParam, aiGatewaySlug, accountId), `chatOptions` (system messages, toolOverrides), `promptTemplates`, `embedOptions`, `autocompleteOptions`, `contextManagement`, catalog `variants`, raw YAML.

## 5. Follow-ups, in order

1. Done (section 7). Advanced (YAML) tab: the entry as text, validated with the schema, written through the same preview and save.
2. Done (section 7). Templates & system message tab (`chatOptions`, `promptTemplates`, tool overrides), with the default system message shown as the placeholder.
3. Autocomplete and Embeddings tabs, shown when the role applies.
4. Done (section 7). Price field (D2), then show it and its source in the Context & cost tab.
5. Done (section 7), except as noted there for `deploymentId`. The remaining env keys (Bedrock service tier, latency, guardrails, cross-region inference; Azure deploymentId) and env credentials as secret references.
6. Edit models in block files and catalog entries (D4).
7. CLI `continuous model show/set` (D5).
8. Rename (`name`), updating `modeModels` and selected-model references in the same save.
9. Keep the Test connection result per model in the dialog (the probe status from `openaiCompat/probeStatus`).

## 6. Not verified

- Run in a real VS Code or JetBrains window: only unit and component tests ran (no screenshot harness run).
- The app dialog container (`gui/src/components/dialogs/index.tsx`) does not trap focus. Since the second slice this dialog traps it itself (`useFocusTrap`); other dialogs in the app still do not.
- `useSystemCa` default text is from docs/reference.mdx :138, not from code.

## 7. Second slice

Written 2026-11-13, stacked on the first slice (#826).

### 7.1 Advanced (YAML) tab

- Core returns `entryYaml` with the entry (`core/config/modelEdit/entryYaml.ts`): the entry's own lines from the file, de-indented, comments and key order kept, every plain credential replaced by the mask on the parsed document (not by line, so a block scalar is masked too). If that text does not parse back to the masked entry (an alias to an anchor outside the entry, say), the masked entry is shown as plain YAML instead.
- What is typed is parsed in the webview (`parseEntryYaml`, the error names its line) and compared with the masked entry (`opsFromEntryEdit` in `modelEditFields.ts`). A difference at a managed path becomes an operation on that path; a difference anywhere else (`name`, `routes`, an unknown key) is listed and refused before any preview, and core refuses such a path anyway. A masked value left alone is equal, so it is never written; a plain credential typed over the mask fails the same secret-reference check as the other tabs.
- The operations go through `config/previewModelEdit` and `config/saveModelEdit` unchanged: same field rules, same schema check of the whole entry, same diff, same hash check. The file keeps its own comments; a comment typed in the tab is not written (the tab says so).
- The form's changes and the YAML's are merged (`mergeOps`). The same change in both is kept once; different changes to one setting, or to a map and a key inside it, are refused with the setting's name, so neither silently wins.
- An error core reports is shown in the tab where the change was typed: the YAML tab when only the YAML changed anything, or when the YAML changed that setting.

### 7.2 Templates & system message tab

- `chatOptions.baseSystemMessage`, `baseAgentSystemMessage`, `basePlanSystemMessage`: multi-line fields (written as typed, trailing whitespace dropped, empty removes the key). The built-in text (`core/llm/defaultSystemMessages.ts`) is the placeholder, and a preview shows what is sent first for the chosen mode.
- `promptTemplates.chat`: the names the schema accepts (`CHAT_TEMPLATE_VALUES`, now exported from config-yaml), previewed with `autodetectTemplateFunction` on a two-message conversation; for a provider that sends chat messages the preview says the server applies the model's own template.
- `promptTemplates.edit`, `apply`, `autocomplete`: Handlebars, rendered with sample values for exactly the variables core fills in (edit: `userInput`, `prefix`, `codeToEdit`, `suffix`, `language`, from `core/edit/streamDiffLines.ts`; apply: `original_code`, `new_code`; autocomplete: `prefix`, `suffix`, `filename`, `reponame`, `language`, from `core/autocomplete/templating`). A template that does not compile, or reads a variable that is never filled in, is flagged.
- `chatOptions.toolOverrides.<tool>`: one operation per tool, validated with `toolOverrideSchema`. The editor sets the description and `disabled`; other override keys written in the file (`displayTitle`, `systemMessageDescription`, ...) are kept. The preview runs `applyToolOverrides` on the loaded tool.

### 7.3 Price field (D2)

- Schema: `pricing: { input, output, cacheRead?, cacheWrite?, currency? }` on every model shape (`modelPricingSchema` in `packages/config-yaml/src/schemas/models.ts`): non-negative numbers, US dollars per million tokens, `currency` only `USD`.
- `core/util/modelPrice.ts`: `userPriceOf(model)` turns it into the `UserPrice` `costOf` already takes (checked again: a negative or non-numeric rate makes no price, never a made-up one), and `USER_PRICE_SOURCE` = "your config", the label #836 uses for `kind: "user"`.
- Budgets: `startRunLimits` (cn -p and cn serve) passes the model's price to `RunBudget` (refusal check, estimate before each request, price note) and to `costSince` for the run's spend, keyed `provider/model` as the session's usage is. `costOf`, `calculateRequestCost` and the price-source code of #836 are not changed.
- Dialog: Context & cost has the four fields and the price note says "from your config" when they are set.

Coordination with #836 (draft, price source and date on cost displays): this branch does not touch its price-source files (`priceSourceText.ts`, `costOf.ts`, `calculateRequestCost.ts`, the community catalogue). It does change three files #836 also changes, in small additive hunks: `extensions/cli/src/budget/runBudget.ts` and `runLimits.ts` (an optional `userPrice`), `extensions/cli/src/commands/chat.ts` (one line passing `pricing`), and `.github/release-notes/UNRELEASED.md`. Once both are in, #836's `PriceSource` for a run priced this way is `kind: "user"`; nothing here creates a second label.

Not wired yet: the chat's own cost display and session totals in the IDE and the CLI (`calculateRequestCost` in `sessionUsage.ts` and `streamChatResponse.helpers.ts`), and the Auto reviewer's shadow budget (`ShadowDeps.userPrices` exists but no caller fills it). Each is a one-line `userPriceOf` at its call site once #836 has landed in those files.

### 7.4 Provider settings

- Bedrock (`env`): `crossRegionInference` (auto and the inference profile prefixes; a test keeps the list equal to `INFERENCE_PROFILE_PREFIXES`), `serviceTier` (default, priority, flex, reserved), `latency` (standard, optimized), `guardrailIdentifier`, `guardrailVersion` (default DRAFT), as docs/customize/model-providers/top-level/bedrock.mdx lists them.
- AWS credentials (`env.accessKeyId`, `secretAccessKey`, `sessionToken`, for bedrock, bedrock-mantle and sagemaker): secret references only, with the same Keep / Use a secret / Remove editor as the API key; a typed value is stored with `config/setSecret` before the save, and every credential to store is stored first, so a failure saves nothing.
- `deploymentId`: the code reads it only in the watsonx provider (`core/llm/llms/WatsonX.ts`); Azure reads `env.deployment` (already in the first slice) and `env.apiVersion`. So `deploymentId` is shown for watsonx, with its `projectId` and `apiVersion`, not for Azure.

### 7.5 Focus trap

`gui/src/components/ModelConfig/useFocusTrap.ts`: Tab from the last control goes to the first and Shift+Tab from the first to the last, focus that lands outside the dialog is brought back, and on close focus returns to the element that opened it. The dialog now renders one root element for the loading, read-only and editing states so the trap holds across them.

### 7.6 Still not covered

`name` (rename), `connection`, `routes`, `maxStopWords`, `useLegacyCompletionsEndpoint`, `useResponsesApi`, the rest of `defaultCompletionOptions` and `requestOptions` listed in section 4, the other env keys (`modelArn`, `mantlePathPrefix`, `maxTokensParam`, `aiGatewaySlug`, `accountId`), `embedOptions`, `autocompleteOptions`, `contextManagement`, catalog `variants`. They are kept on save, editable by hand, and refused in the Advanced tab with Open file as the way to change them.
