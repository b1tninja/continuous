# Model information and prices from the providers

Status: research and design, 2026-11-13. The first slice is implemented (see "What the first slice does"). Builds on the OpenRouter model list (#690, #696) and the "Model information updates" setting of #829; the price display it describes is for the model configuration dialog of #826 and the cost displays that exist today.

## The question

Can Continuous get more accurate model information (context window, maximum output, prices, capabilities such as tools, images, reasoning and prompt caching, availability, deprecation) directly from the providers, especially Amazon Bedrock, Anthropic and OpenAI, the way it already does from OpenRouter's public list?

Short answer:

| Provider   | Window and output                           | Capabilities                           | Lifecycle                          | Prices                                                                                  | Needs                                           |
| ---------- | ------------------------------------------- | -------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Anthropic  | Yes, `GET /v1/models`                       | Yes, a full capability tree            | Yes (`lifecycle`, `retires_at`)    | **No** machine-readable source                                                          | The user's API key                              |
| OpenAI     | No                                          | No                                     | `shutdown_date` only               | **No** machine-readable source                                                          | The user's API key                              |
| Bedrock    | No (not in the control plane)               | Modalities, streaming, inference types | Yes (`ACTIVE`/`LEGACY` with dates) | **Yes**, the AWS Price List (public files, or the Query API with `pricing:GetProducts`) | IAM read actions; quotas need `servicequotas:*` |
| Gemini     | Yes (`inputTokenLimit`, `outputTokenLimit`) | `thinking`, generation methods         | No                                 | No                                                                                      | The user's API key                              |
| Ollama     | Yes (`/api/show` `model_info`)              | `capabilities`                         | n/a                                | n/a (local)                                                                             | Nothing                                         |
| OpenRouter | Yes                                         | Tools, modalities                      | No                                 | Yes (already used)                                                                      | Nothing                                         |

Prices are the weak point for the two first-party APIs: neither Anthropic nor OpenAI publishes a pricing endpoint, so their prices stay a hand-checked table with a visible "prices as of" date. Bedrock is the exception: its prices are machine-readable.

## A. What each provider offers

### Anthropic

- **Models API.** `GET /v1/models` and `GET /v1/models/{model_id}` ([list](https://platform.claude.com/docs/en/api/models/list)). Each model has `id`, `display_name`, `created_at`, `max_input_tokens` (the context window), `max_tokens` (the output cap), `line` (`opus`, `sonnet`, `haiku`, `fable`, `mythos`), `lifecycle` (`active`, `deprecated`, `retired`), `deprecated_at`, `retires_at`, and `capabilities`, a tree in which every leaf is `{supported: boolean}`: `batch`, `citations`, `code_execution`, `context_management` (per strategy), `effort` (`low` to `max`, `xhigh`), `image_input`, `pdf_input`, `server_tools` (`web_search`, `code_execution`), `structured_outputs`, and `thinking.types` (`adaptive`, `enabled`, `disabled`, `between_tools`). The list takes `lifecycle` as a filter (retired models only when asked) and pages with `after_id` / `has_more` / `last_id`, `limit` up to 1000. There is no `context_window` field and no price field. Prompt caching support is not in the tree.
- **Token counting.** `POST /v1/messages/count_tokens` ([docs](https://platform.claude.com/docs/en/build-with-claude/token-counting)): exact input tokens for a request before sending it. Useful for the budget's pre-call estimate; it is a call per estimate, so it is not a metadata source.
- **Prices.** Only the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing). No pricing API exists. Cache writes are 1.25x (5 minutes) and 2x (1 hour) the input price, reads 0.1x on most models and less on newer ones; regional endpoints carry a 10% premium for Claude 4.5 and later; batch is half price; fast mode on Claude Opus 5.5 is 2x. All of this is already in `ANTHROPIC_PRICING`.
- **Deprecations.** The [model deprecations page](https://platform.claude.com/docs/en/about-claude/model-deprecations) (at least 60 days' notice); the same facts are machine-readable through `lifecycle` and `retires_at` in the Models API. The page says Bedrock and Google-managed Vertex set their own schedules.
- **Rate limits.** Response headers `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`, `retry-after`, and the Priority Tier `anthropic-priority-*` headers ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)). Cache reads do not count toward input tokens per minute. A spend-cap 429 has `error.details.error_code: enforced_spend_limit_reached` and no `retry-after`.
- **Billed usage.** The response `usage` has `input_tokens` (after the last cache breakpoint), `cache_creation_input_tokens` with a `cache_creation` split by lifetime, `cache_read_input_tokens`, `output_tokens` (thinking included), and `service_tier`.

### OpenAI

- **Models API.** `GET /v1/models` returns `id`, `object`, `created`, `owned_by`, and now `shutdown_date` ([reference](https://developers.openai.com/api/reference/resources/models/methods/list)). No window, output limit, capabilities or prices. Capability facts (tools, images, reasoning, context) exist only on the per-model documentation pages.
- **Prices.** Only the [pricing page](https://developers.openai.com/api/docs/pricing). It lists Standard, Batch and Flex (about half of Standard), Fast (about 2x; the former Priority processing) and Ultrafast tiers, cached-input rates, cache write rates on the newest models, and short (up to 272K input tokens) and long context rates. No feed or API.
- **Billed usage.** Chat Completions `usage.prompt_tokens` includes the cached part (`prompt_tokens_details.cached_tokens`); `completion_tokens` includes `completion_tokens_details.reasoning_tokens`. The Responses API has the same under `input_tokens_details` / `output_tokens_details`, and the response names its `service_tier`.

### Amazon Bedrock

Control plane (`bedrock`), all read-only:

- `ListFoundationModels` / `GetFoundationModel` (`bedrock:ListFoundationModels`, `bedrock:GetFoundationModel`): `inputModalities`, `outputModalities`, `responseStreamingSupported`, `inferenceTypesSupported` (`ON_DEMAND`, `INFERENCE_PROFILE`, `PROVISIONED`), and `modelLifecycle` ([FoundationModelLifecycle](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_FoundationModelLifecycle.html)): `status` `ACTIVE` or `LEGACY`, and `startOfLifeTime`, `legacyTime`, `publicExtendedAccessTime` ("where users should expect higher pricing") and `endOfLifeTime`. No context window, output limit, tool support or caching support.
- `ListInferenceProfiles` (`bedrock:ListInferenceProfiles`): system cross-region profiles (`us.`, `eu.`, `apac.`, `global.`, ...) and application profiles, each with the model ARNs it routes to.
- `GetFoundationModelAvailability` (`bedrock:GetFoundationModelAvailability`, [reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html)): `agreementAvailability.status`, `authorizationStatus` (`AUTHORIZED`/`NOT_AUTHORIZED`), `entitlementAvailability` and `regionAvailability` (`AVAILABLE`/`NOT_AVAILABLE`). One call per model.
- `GetUseCaseForModelAccess`: whether Anthropic's use-case form is filed.

Quotas: [Service Quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html), service code `bedrock`, `ListServiceQuotas` / `GetServiceQuota` ([reference](https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_ListServiceQuotas.html)) with `servicequotas:ListServiceQuotas` / `servicequotas:GetServiceQuota`. Applied values per model and route (on-demand, cross-region, global; tokens and requests per minute), named in prose ("... tokens per minute for Anthropic Claude ..."), so matching a quota to a model ID is by name. `bedrock-runtime` and `bedrock-mantle` have separate quotas. AWS can apply quotas below the published defaults; the owner's account has 0 tokens per minute for the Claude 5.5 models in US regions.

Prices: the **AWS Price List**, two ways:

- Bulk files, **public, no credentials**: `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/<region>/index.json` ([how to fetch](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html)). Large, and they need parsing by `usagetype` (`USE1-Nova*-input-tokens`, `...-cache-read-input-token-count`, `...-flex`, `...-priority`, `-mantle-...`).
- Query API `pricing:GetProducts` ([reference](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_GetProducts.html)), served from `api.pricing.us-east-1` (and a few other regions), needs `pricing:GetProducts` (and `pricing:DescribeServices` to explore), filters on attributes.

Claude on Bedrock is priced on the [Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/); the existing table derives it from Anthropic's list with the 10% regional premium, measured against a week of invocation logs.

Service tiers ([docs](https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html)): Reserved, Priority (premium), Standard (`default`) and Flex (discount); the request field is `serviceTier.type` and the tier that served a Converse request comes back in the response (`serviceTier`, also on the stream's metadata event). On-demand quota is shared by priority, default and flex.

Billed usage ([TokenUsage](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_TokenUsage.html)): `inputTokens` (excludes cache reads and writes), `outputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens`, and `cacheDetails` (writes split by TTL, `5m` / `1h`).

Converse capability notes (tools, documents, prompt caching per model, reasoning) are only in the user guide's model tables ([supported models and features](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html), [prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)); there is no API for them, so `bedrockFamilyRules.ts` and the cache tables stay hand-maintained.

### Others, briefly

- **Gemini** `models.list` ([reference](https://aistudio.google.com/api-reference/models)): `inputTokenLimit`, `outputTokenLimit`, `supportedGenerationMethods`, `thinking`, default and maximum `temperature`, `topP`, `topK`. Already read by `fetchGeminiModels` (core/llm/fetchModels.ts:243). No prices.
- **Ollama** `POST /api/show` ([API docs](https://github.com/ollama/ollama/blob/main/docs/api.md#show-model-information)): `capabilities` (`completion`, `tools`, `vision`, `thinking`, ...) and `model_info.<arch>.context_length`. Already read (core/llm/llms/Ollama.ts:190); local, so it is not subject to the setting.
- **LiteLLM** [`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json): MIT licence (except the repository's `enterprise/` directory), thousands of entries with windows, output limits, per-token input, output and cache prices and capability flags, keyed by LiteLLM's own provider/model names. Updated by community pull requests; entries lag releases and are sometimes wrong. Trust: a fallback, never above a first-party source.
- **models.dev** (`https://models.dev/api.json`, [repository](https://github.com/sst/models.dev)): MIT, TOML per provider and model with limits, input/output/cache-read/cache-write/reasoning costs, modalities, reasoning and tool flags, knowledge cutoff and release dates. Community-maintained by pull request, used by opencode. Same trust level as LiteLLM; its schema is cleaner.

## B. What Continuous does today

- **Bundled data.** `packages/llm-info` (`LlmInfo`, packages/llm-info/src/types.ts:19): `contextLength`, `maxCompletionTokens`, `mediaTypes`, `lifecycle`, per provider file; found by `findLlmInfo` (packages/llm-info/src/index.ts:41). Retirement dates and sources are in `core/util/modelRetirements.generated.json`.
- **Resolution in core.** `BaseLLM` takes `contextLength` from config, else `llmInfo.contextLength` (core/llm/index.ts:302), and `maxTokens` from config, else `min(llmInfo.maxCompletionTokens, contextLength / 4)` (core/llm/index.ts:307). Images: `modelSupportsImages(provider, model, title, capabilities)` (core/llm/index.ts:143), where config `capabilities` win.
- **Model lists in setup.** `fetchModels` (core/llm/fetchModels.ts): Anthropic's `/v1/models` already gives window, output, `created_at` and `lifecycle` (`fetchAnthropicModels`, core/llm/fetchModels.ts:173); Gemini gives window and output; OpenAI gives ids only (`compatibleModelsBase`, which deliberately skips api.openai.com because it reports no windows); LM Studio, vLLM and Strata report windows through `listOpenAICompatibleModels`.
- **OpenRouter.** The public list is downloaded to `model-catalog/openrouter.json` (core/llm/modelCatalogStore.ts) with windows, tools and prices (core/llm/openRouterCatalog.ts); prices feed `priceFromCatalog` (core/llm/utils/catalogPricing.ts:123), the budget refuses a list older than 90 days (extensions/cli/src/budget/openRouterPrices.ts). #829 adds the "Model information updates" setting (`automatic` default, `manual`, `off`, refresh interval) and the background refresh (`modelCatalogRefresh.ts`).
- **Bedrock.** `listAvailableModels` (core/llm/llms/Bedrock.ts:505) calls `ListFoundationModels`, `ListInferenceProfiles`, `GetFoundationModelAvailability` (five at a time, ten-second deadline) and `GetUseCaseForModelAccess`, builds the catalog (`buildModelCatalog`, core/llm/llms/bedrockHelpers.ts:331) with LEGACY and access state, and caches it for an hour per account and region (core/llm/llms/bedrockCatalogCache.ts). Test connection (`bedrock/listModels`, core/core.ts:1630) bypasses the cache. Error hints are in `getBedrockErrorHint` (core/llm/llms/bedrockHelpers.ts:81). The openai-adapters Bedrock path (packages/openai-adapters/src/apis/Bedrock.ts) passes `serviceTier` through and has no catalog.
- **Test connection.** OpenAI-compatible endpoints: core/util/openaiCompatTest.ts (`openaiCompat/testConnection`, core/core.ts:943); Anthropic: core/util/anthropicSurfaceTest.ts; what was seen is recorded locally in core/util/measuredFacts.ts.
- **Prices.** One table set in core/llm/utils/calculateRequestCost.ts: `ANTHROPIC_PRICING` (line 127, with the Bedrock regional factor), `NOVA_PRICING` and `BEDROCK_PRICING` (lines 456 and 493, read from the AWS Price List on 2026-11-08), `OPENAI_PRICES` (line 588), and the OpenRouter list. `calculateRequestCost` (line 786) is used per request by the chat (core/llm/utils/sessionUsage.ts:55) and the CLI (extensions/cli/src/stream/streamChatResponse.helpers.ts:676); `costOf` (core/util/costOf.ts:108) prices aggregated usage for loops, the auto-permission shadow evaluation and the `--max-budget-usd` estimate; the run's spend is the session's per-request total (extensions/cli/src/budget/runLimits.ts:171).

### Is the cost arithmetic right?

Checked per provider against the billed usage fields above:

- Anthropic: `input_tokens` excludes the cache, so it is priced as uncached input, writes at 1.25x / 2x by the `cache_creation` split, reads at the read rate; thinking is inside `output_tokens` and priced as output. Correct.
- Bedrock: `inputTokens` excludes the cache; `cacheDetails` gives the 5-minute / 1-hour split (`bedrockUsageToUsage`, core/llm/llms/bedrockHelpers.ts:435). Nova writes are $0 surcharge per the Price List. Correct.
- OpenAI and OpenRouter: `prompt_tokens` includes the cache, so the cached part is taken out before the uncached rate is applied (`calculateOpenAICost`, `usageWithCacheTakenOut`); reasoning tokens stay in the completion at the output rate, or at OpenRouter's `internal_reasoning` rate when it is non-zero. Correct. Prompts over 272K on GPT-5.4/5.5 are left unpriced rather than priced at short-context rates.
- Not handled: **the service tier**. Bedrock lets a model be configured with `serviceTier: flex` or `priority`, and Anthropic reports `service_tier`, but every price was the standard tier's with nothing saying so on the request. Flex is overstated, priority understated. The first slice records the served tier and says so in the breakdown (below); pricing the tiers needs the Price List's flex and priority rows.

## C. Design

### What is authoritative, per provider

| Fact                   | Anthropic                            | OpenAI                           | Bedrock                                                        |
| ---------------------- | ------------------------------------ | -------------------------------- | -------------------------------------------------------------- |
| Window, output cap     | Models API                           | llm-info (curated)               | llm-info (curated); Anthropic's figures for Claude             |
| Images, PDFs           | Models API `capabilities`            | llm-info                         | `inputModalities`                                              |
| Thinking, effort       | Models API `capabilities`            | llm-info                         | llm-info, `bedrockFamilyRules.ts`                              |
| Tools, caching         | llm-info, cache tables               | llm-info                         | `bedrockFamilyRules.ts`, cache tables                          |
| Lifecycle              | Models API `lifecycle`, `retires_at` | Models API `shutdown_date`       | `modelLifecycle` with dates                                    |
| Access in this account | a 404 from `GET /v1/models/{id}`     | a 404 from `GET /v1/models/{id}` | `GetFoundationModelAvailability`, use-case form, quotas        |
| Prices                 | curated table, dated                 | curated table, dated             | AWS Price List; Claude from Anthropic's list x regional factor |

### Precedence

For every field: **user config > provider API > curated (llm-info, the price tables) > community catalogue**. A value from a lower source never replaces one from a higher source; a provider API value replaces a curated value only when the provider actually sent the field (an older API version or a gateway that strips fields leaves the curated value). Prices follow the same order: a price the person entered, then a list the provider publishes (OpenRouter's list; the AWS Price List), then the curated tables, then (if ever adopted) a community catalogue.

### Caching and the shared setting

One setting, the "Model information updates" of #829, and one store, `model-catalog/` in the global folder:

- `automatic`: provider metadata that comes with the user's own credentials is fetched only when the provider is configured and used: on Test connection, on opening the model picker's list for that provider, and in the background at most once per refresh interval for a provider that has a selected model. The Bedrock catalog cache (an hour, per account and region) and the OpenRouter copy keep their own TTLs; a provider metadata copy uses the setting's `refreshHours`.
- `manual`: only on an explicit action (Test connection, Refresh).
- `off`: no metadata requests beyond what the action itself is (a Test connection still lists models, because listing is the test); cached copies are not used, the bundled data applies.
- Ollama and other local servers: read when that provider is configured, not covered by the setting (#829 already does this).

Files: `model-catalog/<provider>-<account hash>-<region>.json`, schema-versioned, written through a temporary file like `writeOpenRouterCatalog`, size-capped, each with `source` and `fetchedAt`. The account hash is the one `bedrockCatalogCacheKey` already uses, so no key or account id is written.

### Privacy

- Calls go only to the provider the person configured, with that provider's credentials and the person's `requestOptions` (proxy, CA). Nothing is sent to a third party, and a community catalogue would be a plain GET with no credentials and a fixed User-Agent, under the same setting as OpenRouter's list (#829's `CATALOG_REQUEST_HEADERS`).
- Never at start-up for a provider that is not configured; never for every configured provider at once (only the selected and opened ones).
- The cached files hold public model facts and the account's access state (which models it can use), keyed by a hash; no prompts, keys, account ids or usage.

### Failure behaviour

Metadata is advisory. A failed, slow or refused lookup leaves the bundled data in place and never blocks a request or a Test connection result (the Bedrock access and use-case lookups already work this way, with a deadline). A refused lookup is reported once, as a note on the Test connection result, naming the missing permission.

### Bedrock IAM, and how to degrade

| Action                                                          | Gives                                                                            | Without it                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles` | The model list, modalities, lifecycle                                            | No list; type a model id (hint exists)                      |
| `bedrock:GetFoundationModelAvailability`                        | Access state per model                                                           | No access badge                                             |
| `bedrock:GetUseCaseForModelAccess`                              | Anthropic use-case form state                                                    | No form warning                                             |
| `servicequotas:ListServiceQuotas` (new)                         | Applied TPM/RPM per model and route, so a 0 quota shows before the first request | The error hint after the first refused request (this slice) |
| `pricing:GetProducts` (new, Query API only)                     | Prices for the account's region                                                  | Use the public bulk file (no IAM), or the dated table       |

The Service Quotas client is a new dependency (`@aws-sdk/client-service-quotas`); the Price List bulk file needs none.

### Where it shows

- **Model picker and provider setup**: lifecycle (deprecated, retires on, legacy since, extended access with higher prices from), image support, and access ("needs access", "quota is 0 in this region").
- **Cost display** (the usage indicator, the console's total, the CLI's `/cost`, the budget messages): the amount, then one line naming the **price source and date**: "Anthropic list prices, checked 2026-11-02", "OpenRouter model list, downloaded 2026-11-12", "AWS Price List, us-east-1, 2026-11-08", "Your price". When the provider served a non-standard tier, the breakdown says the figure is the standard tier's and which way the real charge differs.
- **Model configuration dialog** (#826, not edited here): its Context & cost tab reads `costOf`; with this slice `CostResult.priceSource` (`kind`, `label`, `url`, `asOf`) is there to show under the price, and a per-model price field (#826's decision D2) feeds `costOf`'s `userPrice`, which already reports `kind: "user"`.

## What the first slice does

No new requests: everything comes from answers Continuous already receives.

1. **Bedrock errors that name the real cause** (`getBedrockErrorHint`): "not available for this account" (what a model with an applied 0 tokens-per-minute quota answers, measured 2026-11-08) now points at Service Quotas instead of the console's model access page; "account is currently being verified" says to wait (first use of a region); a `ThrottlingException` says the quota is used up and that a first-request throttle can mean a quota near 0.
2. **Bedrock catalog facts**: each listed model carries `supportsImages` (from `inputModalities`) and its lifecycle dates (`legacyAt`, `extendedAccessAt`, `endOfLifeAt`).
3. **Anthropic Models API**: the setup list now reads `capabilities.image_input` (images) and `retires_at`, besides the window, output cap and `lifecycle` it already read. Effort levels are deliberately not turned into `reasoningEfforts`, because those become OpenAI-style `reasoning_effort` variants.
4. **Price source and date on every priced cost**: `CostBreakdown.priceSource` and `CostResult.priceSource` (`user`, `provider`, `curated`, `community`, with label, URL and date).
5. **Served tier**: Bedrock's `serviceTier` (stream metadata and Converse response) and Anthropic's `usage.service_tier` are kept in `Usage.response.serviceTier`; a non-standard tier adds a "Prices: standard tier; the provider served this request at the flex tier, ..." line and sets `CostBreakdown.servedTier`.

## What the second slice does

Owner decisions 1, 2, 4 and 5 below were approved; this slice implements them for Bedrock.

1. **Service Quotas** (`core/llm/llms/bedrockQuotas.ts`, `Bedrock.checkQuotas`): `ListServiceQuotas` for service code `bedrock`, every page, five seconds at most, with the Bedrock client's credentials, region, profile, proxy and CA. The per-minute on-demand, cross-region and global quotas are matched to model IDs by name (`bedrockModelNames.ts`: vendor words dropped, a trailing `V2` is the version, the rest must be the ID's words exactly). A 0 tokens- or requests-per-minute quota on the route the model's requests take gives "<model> has a 0 tokens-per-minute quota in <region> for this account; request an increase in Service Quotas" with the console link, on Test connection (for the selected model) and once per model and region when a Bedrock model is selected. AccessDenied is one quiet line ("Quota check skipped: this profile lacks servicequotas:ListServiceQuotas") remembered per profile and region for a day or until the access key changes; throttling (15 minutes), timeouts and network errors (an hour) and a region without Service Quotas (a day) are remembered too; a Bedrock API key skips the check. Cached in `model-catalog/bedrock-quotas-<hash>.json`.
2. **AWS Price List** (`core/llm/bedrockPriceList.ts`, `core/llm/utils/bedrockPriceListPricing.ts`): the public `AmazonBedrock` bulk file for the selected model's region, read as a stream (a member-at-a-time JSON scanner; only per-token rows are kept), size and time limited, cached atomically in `model-catalog/bedrock-prices-<region>.json` with `fetchedAt`. `calculateRequestCost` uses it ahead of `NOVA_PRICING`, `BEDROCK_PRICING` and the Anthropic list, as `{kind: "provider", label: "AWS Price List", asOf}`, with global cross-region, flex and priority rows where the list has them and the curated tables as the fallback.
3. **Under the setting** (`core/llm/bedrockMetadata.ts`): only the provider of the selected model, never every configured one. `automatic`: on selection, on Test connection and in the background (the #829 refresher, at most once per `refreshHours`); `manual`: Test connection only; `off`: no request, and nothing kept is used.
4. **Served tier** (decision 5): a tier the Price List prices (flex, priority) is priced at its rows; any other non-standard tier keeps the standard price and the note.

The Price List usage types and Service Quotas names were read from AWS documentation and the 2026-11-08 Price List reading, not captured for this slice (no AWS calls were made while building it); the test fixtures are shaped like the real answers. Check the matching against a live `ListServiceQuotas` page and a live offer file before relying on it for a dollar budget.

## Next slices

1. Show the price source and date in the usage indicator, the console total and the CLI `/cost` (GUI and CLI only read the new field).
2. ~~Bedrock flex and priority prices from the Price List's `-flex` / `-priority` usage types, so a served tier is priced instead of noted.~~ Done in the second slice.
3. Anthropic: `GET /v1/models/{id}` on Test connection to validate the configured id (404 means "no such model for this key") and fill images, thinking types and effort levels into the model's capabilities; cache it under the setting.
4. OpenAI: read `shutdown_date` from the list in setup and validate the configured id on Test connection.
5. ~~Bedrock quotas through Service Quotas, behind the new IAM permission.~~ Done in the second slice.
6. A community catalogue (models.dev first) only as the last fallback, behind the setting, and only after the owner decides.

## Owner decisions

1. **Extra IAM for Bedrock**: add `servicequotas:ListServiceQuotas` (and the `@aws-sdk/client-service-quotas` dependency) to show a 0 quota before the first request? Recommended: yes, optional, degrade to the error hint.
2. **Bedrock prices source**: the public Price List bulk file (no IAM, a large download per region) or `pricing:GetProducts` (small, needs IAM)? Recommended: the bulk file for the account's region, under the setting, cached for days.
3. **Community catalogues**: adopt models.dev or LiteLLM as a last-resort source for windows and prices of models the curated tables do not know? Both are MIT; neither is authoritative. Recommended: models.dev, fallback only, labelled "community" with its date, never for `--max-budget-usd` without `--budget-allow-unpriced`.
4. **Provider metadata under `automatic`**: allow a background refresh of the selected provider's metadata (with the user's credentials) at the refresh interval, or only on explicit actions? Recommended: background only for the provider of the selected model.
5. **Served-tier pricing**: until tier prices are in the tables, keep the standard price with the note (current), or report the cost as unknown for priority and fast (which also disables the dollar cap)? Recommended: keep the note.
