# Privacy

> **Unofficial, community-maintained fork.** Continuous is not affiliated with, endorsed by, or supported by Continue Dev, Inc. This page describes this fork only.

Continuous runs on your machine. It has no account, no server of ours and no analytics. This page says what it keeps, what it sends and how to check.

Some statements below describe the product **after** the egress fix ([#627](https://github.com/b1tninja/continuous/pull/627)). Builds 2.12.0 and 2.12.1 do not match them: see [Older builds](#older-builds).

## Stored on your machine

Everything lives under the global folder, `~/.continuous` (copied from `~/.continue` on first start; the old folder is left alone). Set `CONTINUOUS_GLOBAL_DIR` to move it.

- **Settings, models and rules**: `config.yaml`, `permissions.yaml` (your tool permission rules).
- **Chat sessions and history**: `sessions/`, plus `dev_data/` event files and `logs/`. Sessions keep the conversation, not the full prompt of each request (which repeated the conversation and the system message every time). Dev data keeps the sizes, token counts and a hash of each prompt, not its text. Full prompts are kept only if you turn on the debug prompt log (`continuous.debugPromptLog`, or `--debug-prompt-log` in the terminal): `logs/prompts/`, masked, 50 MB at most, deleted after 14 days.
- **The audit trail** of tool decisions: `audit/`, with `audit-index.json` and, in shadow mode, `shadow-spend.jsonl`. On by default, masked and capped (30 days, 20 MB a file). Turn it off with `audit.enabled: false` in `config.yaml` or `CONTINUE_AUDIT=off`.
- **Checkpoints** of agent file edits, and plan files in your own project.

New session and log files are written owner-only, and secrets the scanner recognises are masked before they reach disk. This is a safety net, not a guarantee: do not paste secrets into prompts.

**Retention.** Nothing deletes by itself. `continuous clean` lists, and with `--yes` deletes, sessions older than 30 days, logs older than 14 days and `dev_data` older than 90 days; `--older-than 7d` sets one age for all. It does not securely erase: SSDs, snapshots and backups can keep copies. **Continuous: Clean up old sessions** (`continuous sessions clean`) removes the full prompts earlier releases stored in sessions and dev data; it asks first and keeps the originals in `cleanup-backups/` until you delete them. The audit trail has its own retention setting (30 days by default, `audit.retentionDays`).

## Sent to the model providers you choose

Your messages, the files and tool output the agent reads, and the conversation so far go to the endpoint you configured for each model, under that provider's own terms. Only hosts you configured are used. Local providers (Ollama, LM Studio) stay on your machine.

## Not sent

- **No telemetry.** No usage data, crash reports or machine id go to us or to anyone. There is no analytics SDK in the code.
- The terminal agent has an OpenTelemetry metrics exporter. It is **off** unless you set `CONTINUOUS_OTEL=1` and an `OTEL_*` exporter or endpoint yourself; then it sends counters (such as tokens and cost) and host details to the destination you named.
- The update check is a stub; it contacts nothing.
- Terminal commands the agent runs start with a scrubbed environment (secret-looking variables removed).

## Contacts a third party by default: OpenRouter's model list

**This changed after 2.16.1.** Builds 2.16.0 and 2.16.1 contacted `openrouter.ai` only when you chose Pull now or Refresh. Now, by default, Continuous keeps OpenRouter's public model list current on its own, whether or not you use OpenRouter.

- **What is sent**: one `GET https://openrouter.ai/api/v1/models`. No account, API key, prompt, file, body or machine id. The only headers are `accept: application/json` and `user-agent: continuous` (no version or platform). The `headers` from your `requestOptions` are not sent to this host; its proxy and certificate settings are used. OpenRouter sees your IP address (or your proxy's) and the time of the request, as any web server would.
- **When**: with model information updates on **Automatic** (the default), when the copy on this computer is missing or older than 24 hours (`modelCatalogRefreshHours`): about 15 to 60 seconds after the IDE starts, 1 to 3 seconds after the terminal agent starts, and again each time the interval passes while it keeps running. Each open IDE window and terminal session checks the file's date first, so a list another window just downloaded is not fetched again. When the host cannot be reached it tries again after 5 minutes, then 10, 20 and so on, up to every 6 hours. Nothing waits for it. **Refresh now** in the model, settings and usage screens, Pull now in provider setup and `continuous models refresh` also send it, at once.
- **What is kept**: the list (names, ids, context sizes, tool support, per-token prices) and its date, in `model-catalog/openrouter.json` in the global folder. Nothing else is written to that file. It is used for model lists, context sizes and cost estimates, including `--max-budget-usd`.
- **How to turn it off**: set **Model information updates** to **Off** (`continuous.modelInformationUpdates` in VS Code, the Models settings page, `modelCatalog: off` in `~/.continuous/config.yaml`, or `CONTINUOUS_MODEL_INFO_UPDATES=off`). Then `openrouter.ai` is never contacted and the bundled model data is used. **Only when I ask** (`modelCatalog: manual`) restores the 2.16.0 behaviour; `modelCatalog: never`, saved by "Don't ask again" in those builds, is kept and means the same without the question.

## Contacts a third party when a model has no price: the community catalogue

Continuous prices a request from, in order: a price you entered, a list the provider publishes (OpenRouter's, or the AWS Price List for Bedrock), the price tables in the code. When none of them has a price for a model you have selected, it can fall back to [models.dev](https://models.dev), a community-maintained catalogue (MIT).

- **What is sent**: one `GET https://models.dev/api.json`. No account, API key, prompt, file, body, model name or machine id: the whole catalogue is downloaded, so models.dev does not learn which model you use. The only headers are `accept: application/json` and `user-agent: continuous`, the same as for OpenRouter's list. The `headers` from your `requestOptions` are not sent to this host; its proxy and certificate settings are used. models.dev sees your IP address (or your proxy's) and the time of the request.
- **When**: only while a selected model (the IDE's chat or reviewer model, the terminal agent's model) has no price from the sources above, and never when model information updates are **Off**. With **Automatic** (the default): when the copy on this computer is missing or older than the refresh interval (24 hours), checked about 15 to 60 seconds after the IDE starts and 1 to 3 seconds after the terminal agent starts, then again at least every 6 hours (every hour while every selected model is priced, which makes no request). Failures are retried after 5 minutes, then 10, 20 and so on, up to every 6 hours. With **Only when I ask** (`modelCatalog: manual`): only when you choose **Refresh now** in the IDE (when a selected model is unpriced). Nothing waits for it.
- **What is kept**: the prices of the providers Continuous maps (per-million-token input, output, cache and reasoning rates, with context-size tiers) and the download date, in `model-catalog/models-dev.json` in the global folder, at most 4 MB. Nothing else is written to that file.
- **How it is used**: only for a model that has no other price. A figure priced from it is labelled "community catalogue (models.dev), <date> — estimate". `--max-budget-usd` is not held on it unless you pass `--budget-allow-unpriced`, and the Auto reviewer's shadow budget is never held on it.
- **How to turn it off**: set **Model information updates** to **Off**, as for OpenRouter's list. The copy is then not used either.

## Contacted when a Bedrock model is configured: AWS Price List and Service Quotas

These are requests to AWS beyond the Bedrock requests themselves. Neither happens unless a Bedrock model is configured, and only for the region of the selected Bedrock model.

- **AWS Price List** (Bedrock prices for cost estimates): one `GET https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/<region>/index.json`, a public file. No AWS credentials, account id, prompt or body; the only headers are `accept: application/json` and `user-agent: continuous`, and the `headers` from your `requestOptions` are not sent (its proxy and certificate settings are used). AWS sees your IP address and the region you use. Kept: the per-token prices and their date, in `model-catalog/bedrock-prices-<region>.json`.
- **Service Quotas** (the optional quota check): `ListServiceQuotas` for service code `bedrock` at `servicequotas.<region>.amazonaws.com`, signed with the same AWS credentials as your Bedrock requests (a Bedrock API key is never used for it). It reads your account's applied quotas and changes nothing. Kept: the per-minute inference quota names and values, or the fact that the permission is missing, in `model-catalog/bedrock-quotas-<hash>.json`, keyed by a hash of the profile or key id and the region (no key, secret or account id).
- **When**: with model information updates on **Automatic** (the default), when you select a Bedrock model, on Bedrock Test connection, and in the background at most once per `modelCatalogRefreshHours` for the selected model; on **Only when I ask**, on Bedrock Test connection only; on **Off**, never, and copies kept from before are not used.

## Contacts a third party only if you set it up

- **Web search**: the `search_web` tool and `@web` exist only if you set `CONTINUOUS_WEB_SEARCH_URL` to a search endpoint you run or choose (optional `CONTINUOUS_WEB_SEARCH_KEY`, sent to that endpoint only). See [web search](docs/customize/web-search.mdx).
- **Ollama's model library**: Ollama's provider setup contacts `ollama.com` (the public model library page) with a plain GET, no key, no account and no prompt, only after you choose Download or Refresh there. It is never fetched at start-up or on a timer, and the Model information updates setting does not change that.
- **MCP servers** you add, and their sign-in pages.
- **Pages you name**: `@url`, the `fetch_url` tool and docs indexing fetch the sites you point them at, directly from your machine.
- **Docs on GitHub**: a docs entry on github.com uses the GitHub API.
- **Chromium**: one download, only if you accept the install prompt.

The embeddings model is bundled; nothing is downloaded from Hugging Face at run time.

## Check it yourself

- `core/egress/egressAllowlist.vitest.ts` fails when source code names a host that is not in `core/egress/egress-allowlist.json` with a reason, and denies `*.run.app` and `*.continuedev.com`. It is a static check of the source, not a capture of live traffic.
- `continuous doctor network`, if present in your build, reports the outbound paths. It depends on [#638](https://github.com/b1tninja/continuous/pull/638).
- The code is open. A firewall or proxy log is the final word.

The code names no Continue-operated host. The generated hub/API SDK client (`packages/continue-sdk`) and every consumer of it in the terminal agent were removed, and `core/egress/egress-allowlist.json` has no entry for `api.continue.dev`, so the egress test fails if one is added back. A `--config` value that is a hub assistant slug (`owner/slug`) is rejected with "hub assistants are not supported; pass a config.yaml path". This is a reading of the source, not a capture of traffic. Nothing in the default local path makes a connection to a Continue-operated host, including a first run with no `config.yaml`.

## Where secrets are kept

API keys are not kept in the repository. In VS Code they are stored encrypted in the extension's storage, with the key in VS Code's secret storage. In `config.yaml` you can refer to a key by name (`${{ secrets.NAME }}`) or an environment variable instead of writing it down. Do not commit `config.yaml` with keys in it; `continuous secrets scan` checks files and history.

## Older builds

Builds 2.12.0 and 2.12.1 sent web search queries and, for sites with `useLocalCrawling: false`, docs URLs to a proxy run by the upstream Continue project, with the extension version, operating system, a machine id and a key embedded in the code. They also told the model to add a `Co-Authored-By: Continue` trailer to commits. Upgrade to a release that includes the egress fix and the attribution fix ([#626](https://github.com/b1tninja/continuous/pull/626)).

Builds 2.14.0 and earlier looked up model lists on `openrouter.ai` and `ollama.com` (public GET requests, no key) as soon as the provider setup screen opened. In 2.16.0 and 2.16.1 that happened only when you chose Download, Pull now or Refresh. After 2.16.1 the OpenRouter list is refreshed automatically by default (see [above](#contacts-a-third-party-by-default-openrouters-model-list)); `ollama.com` is still contacted only when you ask in Ollama's setup.

## Reporting a privacy or security problem

This fork's GitHub Issues are turned off. Report security-sensitive problems privately through GitHub private vulnerability reporting: <https://github.com/b1tninja/continuous/security/advisories/new>. General privacy questions use the same channel until a project mailbox exists. Please do not post vulnerability details or secrets in a public pull request.

Changes to this page are made by pull request; the history is in git.
