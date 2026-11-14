<!--
DRAFT release notes for the release after 2.12.1. Not published, no version chosen.
Lines tagged `<!-- pending: #NNN -->` come from PRs that were still open when this was written;

delete those lines if the PR does not land. Fold the result into `<tag>.md` at release time.
(#627 and #640 each also add `.github/release-notes/UNRELEASED.md`; this file is separate so it cannot conflict with them.)
-->

## What's new since 2.12.1

### Security and privacy

**Continuous no longer contacts Continue-operated servers.** Earlier builds, 2.12.0 and 2.12.1 included, said they collect no telemetry, and that was not fully accurate. <!-- pending: #627 -->

- The built-in `search_web` tool and the `@web` provider used to post the query, with the version, OS, a machine id and a key embedded in the code, to a Google Cloud Run proxy run by the upstream project. That proxy is no longer contacted and the key is deleted (it stays in git history; treat it as public). <!-- pending: #627 -->
- The docs crawler's remote path is removed: crawling is always local, from the site you named. `useLocalCrawling` is still accepted in config and ignored. <!-- pending: #627 -->
- CLI OpenTelemetry metrics are opt-in: they need `CONTINUOUS_OTEL=1` and an `OTEL_*` exporter or endpoint, and the service name is `continuous-cli`. `CONTINUE_METRICS_ENABLED` and `CONTINUE_CLI_ENABLE_TELEMETRY` are no longer read. <!-- pending: #627 -->
- A test (`core/egress/egressAllowlist.vitest.ts`) fails when a new hostname appears in source without an entry and a reason in `core/egress/egress-allowlist.json`. <!-- pending: #627 -->
- `api.continue.dev` remains in code for the CLI's hub paths and the generated SDK client; see the PR for why. <!-- pending: #627 -->

**Commit attribution is opt-in.** The CLI used to tell the model to add `Generated with [Continue]` and `Co-Authored-By: Continue <noreply@continue.dev>` to your commits. Nothing is added now unless your own `settings.json` sets `attribution.commit` and/or `attribution.pullRequest` to `true` (project settings are ignored). When on, the default line is `Co-Authored-By: Continuous <noreply@continuous.invalid>`; `attribution.text` overrides it. `CONTINUE_CLI_DISABLE_COMMIT_SIGNATURE` is gone. NOTICE, LICENSE and third-party notices now ship. (#626)

**`PRIVACY.md`** describes what is stored locally, what is sent to your model providers, what is not sent, and how to delete it (`continuous clean`). The README links to it. <!-- pending: #640 -->

**`continuous serve` is locked down.** A token is required on every request, loopback included; a Host that does not match is refused with 403 (was 421); Origin is refused unless listed with `--allow-origin`; 1 MB body limit, rate limits, and masking of `/state` and `/diff`. See Behaviour changes. <!-- pending: #631 -->

**MCP OAuth hardening.** The issuer is recorded and a callback with a mismatching `iss` is rejected (RFC 9207), as is a missing `iss` when the server says it supports it. The provider sends its own `state`, which the callback must echo; the redirect URI no longer carries `?state=`. The callback listener binds to loopback only. Static clients are supported with `oauth.clientId` / `oauth.clientSecret` (write the secret as `${{ secrets.NAME }}`). <!-- pending: #634 -->

**`fetch_url_content` and `@url` hardening.** Response size and time caps, a content-type allowlist, http(s) only, `user:pass@` URLs refused, a secret scan of model-chosen URLs, removal of hidden text (HTML comments, zero-width and bidi characters, control characters) from fetched pages, and `requestOptions.headers` / `extraBodyProperties` sent only to the origin of a configured model `apiBase`. <!-- pending: #636 -->

**Previously unproxied callers now use the shared fetch.** Docs crawlers, favicon and model-list fetches, CLI MCP SSE/streamable-http transports, CLI storage sync, HTTP hooks and the Bedrock credential chain (SSO, STS, web identity) now honour `HTTPS_PROXY`, the OS certificate store and `requestOptions`. Crawls and favicons refuse a redirect to a non-public address one hop at a time. `VERBOSE_FETCH` no longer prints proxy credentials. <!-- pending: #638 -->

**Hooks.** Hook input is passed through the secret masker for project-origin command hooks and every http hook; `additionalContext` is capped at 10,000 characters per event; `managedHooksOnly: true` in your own settings stops project hook files being read at all. <!-- pending: #633 -->

**Permissions (already on main).** Confused-deputy rule for the host file tools: writes outside the workspace, through symlinks or junctions, to device names, alternate data streams or UNC paths now ask, and reading `~/.continue` or `~/.continuous` is protected (#586, #588). Secret values in environment assignments are masked wherever a command is shown for approval (#591), and `trustedDomains` in your own config.yaml now reaches the engine, so `ask-unknown-host` actually fires (#594). The audit gains an index, a Settings list and inbox, and a shadow reviewer with a spend ledger (#584, #585, #599, #608, #609, #610).

### Behaviour changes that may surprise you

- **Web search is off unless `CONTINUOUS_WEB_SEARCH_URL` is set.** With it unset, `search_web` is not in the tool list and `@web` reports itself unavailable. Set it to a SearXNG-compatible JSON endpoint (`GET <url>?q=..&format=json`, reply `{results:[{title,url,content}]}`); optional `CONTINUOUS_WEB_SEARCH_KEY` is sent as a bearer token to that endpoint only. See `docs/customize/web-search.mdx`. <!-- pending: #627 -->
- **`continuous serve` needs a token and checks Host.** If you give none, a 256-bit token is generated, saved owner-only as `serve-<port>.token` in the global folder and printed once. It is read only from the `Authorization: Bearer` header; `?token=` gets 401. Explicit tokens must be 16+ characters. `--no-auth` is loopback only and cannot be combined with a token. Host mismatch is 403. Scripts that called serve without a token must send the header or start with `--no-auth`. <!-- pending: #631 -->
- **Hooks accept `onFailure` as a synonym of `onError`** (`continue` or `block`, alongside `allow` or `block`). The default is unchanged: a failed or timed-out hook blocks (Claude Code's documented default is to continue). If both are set the stricter wins; an unknown value blocks. Changing `onFailure` re-asks for trust. <!-- pending: #633 -->
- **`HTTPS_PROXY` serves https URLs and `HTTP_PROXY` http URLs; https no longer falls back to `HTTP_PROXY`.** One warning is logged if only `HTTP_PROXY` is set. Lower case wins over upper case. Anyone who relied on the fallback must set `HTTPS_PROXY`. <!-- pending: #638 -->
- **Claude 4.7 and later (also Fable and Mythos) are sent no `temperature`, `top_p` or `top_k`**, on the Anthropic API, the openai-adapters path and both Bedrock paths. `defaultCompletionOptions.omitSampling` overrides the default. Other models are unchanged. <!-- pending: #637 -->
- **Fetch limits.** `fetch_url_content` stops at 2 MiB (counted after decompression) and a 20 s deadline, and says when it truncated. Limits are `toolPermissions.auto.environment.fetchMaxBytes` / `fetchTimeoutSeconds` in your own config.yaml only. Images, PDFs and other binary content types are refused before the body is read. <!-- pending: #636 -->
- **Unresolved internal names ask.** A host name that resolves to nothing locally and does not end in a delegated TLD is treated as non-public: the fetch asks, and a redirect to one from a public host is refused. A real-TLD name that does not resolve is left alone. A URL with credentials or a long mixed-case encoded value also asks. <!-- pending: #636 -->
- **Plan mode.** The CLI no longer offers `Bash` in Plan mode unless your own `permissions.yaml` sets `plan.allowTerminal: true`. In both the IDE and the CLI, MCP tools (and non-MCP custom http tools) are offered in Plan only if your `permissions.yaml` lists them (`plan.mcpTools`) or trusts the server (`mcpServers: {name: trusted}`) and the tool says read-only; a server's own `readOnlyHint` opens nothing, and a server that came with the open folder never counts. A hidden MCP tool called in CLI Plan is answered "Tool X not found". <!-- pending: #646 -->
- **Role by tool table.** Each role (chat, agent, background, planner, reviewer, orchestrator) has a fixed set of tool classes; a call outside it is refused at execution with an error naming the role, and unknown tools are usable by agent and background only. <!-- pending: #646 -->
- **Run limits.** `cn -p` and `cn serve` accept `--max-budget-usd`, `--max-turns`, `--max-duration` (minutes) and `--budget-allow-unpriced`; exit codes 20, 21 and 22. A dollar budget on a model with no price is refused at startup unless `--budget-allow-unpriced`. Interactive chat refuses the flags. <!-- pending: #635 -->
- **Docs crawler:** `useLocalCrawling: false` no longer does anything. <!-- pending: #627 -->
- **CLI metrics** are off unless `CONTINUOUS_OTEL=1` is set (see Security and privacy). <!-- pending: #627 -->
- **MCP OAuth defaults.** The redirect host stays `localhost` (`redirectHost: 127.0.0.1` is available); with `clientId` set, dynamic registration is skipped; DCR sends `application_type: native`; a callback with an unknown `state` gets 400 without cancelling the waiting sign-in. <!-- pending: #634 -->
- **Permissions already on main.** More calls ask: writes outside the workspace and reads of `~/.continue` / `~/.continuous` (#586), the ask-only gaps in large-change, history, infrastructure and dependency rules (#603).
- **Whitespace-only `old_string` is not rejected.** It is still the existing empty-search case and inserts `new_string` at the start of the file; #641 left this alone because existing tests pin it. <!-- pending: #641 -->

### Features

- **MCP revision 2026-07-28.** HTTP servers are probed with `server/discover`; a server that offers the revision is spoken to statelessly, anything else uses the classic handshake. `input_required` is retried (8 rounds at most), and `tools/list`, `resources/list`, `resources/templates/list` and `prompts/list` are paginated (20 pages, 2000 items; a notice shows at the cap). stdio stays classic. <!-- pending: #642 -->
- **`continuous plan list [--json]` and `continuous plan build <name|path>`** for plan files in `.continuous/plans/`; a step's `check:` command runs under the Bash permission decision when the model marks it completed; an in-progress plan is offered at interactive start. <!-- pending: #643 -->
- **Retirement warnings for Anthropic models.** A dismissible chip beside the model picker, one line at `continuous` start-up at most once a day (`continuous dismiss-notice <model>`), and Test connection for Anthropic (`continuous test-connection --provider anthropic`) reads `lifecycle`, `deprecated_at` and `retires_at` from `GET /v1/models`. <!-- pending: #637 -->
- **Cache-miss explanations** name reasoning or thinking changes, tool choice, added or removed images, and changed tool descriptions or schemas. The Ollama warm window follows `completionOptions.keepAlive` (default 30 min); GPT-5.6+ rows gain 30m and 12h cache write rates. <!-- pending: #630 -->
- **Hook lifecycle events** now fire: `SessionStart`, `SessionEnd`, `Stop`, `Notification`, `PermissionRequest` (a deny answers for you; an allow is not honoured) and `PreCompact`. <!-- pending: #633 -->
- **Reviewer:** raise-only rules turn a reviewer `allow` into `ask` for `sudo`-style commands, paths outside the workspace and shell startup files, `truncate`/`shred`/`dd of=`, and lockfile edits that add `http://` URLs. An opt-in v3 prompt is selected with `toolPermissions.auto.reviewerPrompt: v3` in your own config.yaml (default off). <!-- pending: #645 -->
- **Tainted-session rule**, off by default: `toolPermissions.auto.environment.taintedSessionRule: ask` makes sink calls ask at every level once untrusted content entered the session. <!-- pending: #647 -->
- **Accessibility:** polite and assertive live regions (including "Approval needed" announcements), reduced-motion and forced-colours support, named icon buttons; an axe-core gate in the screenshot harness. <!-- pending: #639 -->
- **Test connection** records probes locally, offers "Turn on recovery", and hints at the API base (#607). A one-line first-run notice in the chat and a once-only CLI banner (#600). Permission rule editor with native confirmation for a loosening (#593).
- **Bedrock:** opt-in prefix repair of broken streamed tool input (#602). **Tool dialects:** Python `True`/`False` for boolean parameters, think blocks in the leak nudge, a Gemma guard (#632, pending); leak nudge covers every dialect (#601).
- **Lab (developer tool):** effective n, `--temperature inherit`, per-pass seeds (#644, pending); whitespace-fidelity probe and server identity in captures (#641, pending).

### Fixes

- Edits where the model's `old_string` lost its first-line indentation no longer over-indent later lines of `new_string`. This is an upstream vLLM Qwen3 parser bug that strips whitespace from string arguments (vllm-project/vllm#48753). <!-- pending: #641 -->
- `trustedDomains` from your own config.yaml was always dropped, so `ask-unknown-host` never fired. (#594)
- PowerShell `${env:FOO} = 'x'` no longer asks at every level; `GIT_*` variables are complete (#604).
- Node-only core modules no longer leak into the webview bundle (#651).
- Dialect fixes listed under Features. <!-- pending: #632 -->

### Docs

- Docs consistency pass for changes since 2.12.1 new pages for web search, run limits, plan files, hooks trust and `cn serve`. <!-- pending: #619 #627 #635 #643 #633 #631 -->
- CI merge-gate branch-protection recipe and failure modes. <!-- pending: #652 -->
- CI cache policy in `docs/ci-caching.md` (no user-visible change). <!-- pending: #650 -->
- Research reports and roadmap consolidation (#612 to #618, #620, #621, #624, #628, #629): internal planning documents, no user-visible change.
- Brand: the static logo gets a thin glowing border instead of the cyan dot. <!-- pending: #606 (draft) -->

### Upgrade notes

- Run `continuous serve` scripts with `Authorization: Bearer <token>` (see the token file in the global folder) or `--no-auth` on loopback. <!-- pending: #631 -->
- If you used `@web` or `search_web`, set `CONTINUOUS_WEB_SEARCH_URL` to your own SearXNG-compatible endpoint. <!-- pending: #627 -->
- Behind a proxy that you configured through `HTTP_PROXY` only, set `HTTPS_PROXY` as well. <!-- pending: #638 -->
- If a tool relied on `CONTINUE_METRICS_ENABLED` or `CONTINUE_CLI_ENABLE_TELEMETRY`, set `CONTINUOUS_OTEL=1`. <!-- pending: #627 -->
- If you want commits to carry an attribution line, set `attribution.commit: true` in your own `settings.json`. (#626)
- If you want `Bash` in CLI Plan mode, set `plan.allowTerminal: true` in your own `permissions.yaml`. <!-- pending: #646 -->
- Claude 4.7+ users who need to override the sampling default use `defaultCompletionOptions.omitSampling` (check the accepted values in the PR before release). <!-- pending: #637 -->
- Privacy statement for the release: 2.12.0 and 2.12.1 were wrong about web search and some docs crawls going through an upstream proxy with a machine id, and about the `Co-Authored-By: Continue` trailer; this release removes both. <!-- pending: #627 #640 -->
