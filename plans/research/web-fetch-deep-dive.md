# Web fetch and URL handling: deep dive, decisions and build plan (2026-11-15)

Status: research and design only, written against `main` at `7c4c6851c` (merge of #895). No code was changed, nothing was built or measured, and no third-party site was fetched beyond documentation pages (read 2026-11-15 unless another date is given). Every "today" statement comes from reading the code on that commit; where a claim needs a test to settle it, the text says "inferred". Protocol claims were checked with the `primarysource` RFC tools and are cited by paragraph. Other sources are cited by URL and marked P (primary: vendor documentation, specification, source code) or S (secondary: press, blog, mirror).

This note extends and does not repeat `plans/research/web-search-and-fetch.md` (2026-11-11, before #636, #638 and #735) and `plans/research/area-injection-tool-exposure-web.md` (2026-11-12). Track WB in `plans/ROADMAP.md` (lines 1858-1879) and section 4 of `plans/decisions-2026-11-15.md` (lines 107-119) are the baseline: the rows proposed here start at WB17, and amendments to existing rows are listed in section 10.2. The ROADMAP itself is not edited.

The owner's ask: a deep dive into fetching web content and URL handling, the tools that do it, and the configuration of how we fetch: User-Agent, `robots.txt`, domain restrictions, a reputation list (DNSBL) as a roadmap item, and a Browser window.

## 1. Summary

The fork's fetch is already better guarded than most agents' fetch. It resolves the host once and pins the address, refuses public-to-private redirects, caps bytes after decompression, enforces a total deadline, scans the model's URL for secrets, scopes the global request headers to model origins, and can spotlight the result. What it lacks is everything that faces the **site** rather than the **user**. It never says who it is: the User-Agent on the wire is `node-fetch` on every path except the docs crawler, which pretends to be Chrome 88. It never reads `robots.txt`. The person cannot name domains it may or may not reach, because the existing `host:`/`net:` rules apply only to terminal commands. And nothing shows the person, after the fact, what was fetched and what the model was sent.

The ten decisions that shape the build:

1. **One honest User-Agent, no fingerprint.** `Continuous-User/<major.minor> (+<info URL>)` for fetches made for a person, and `Continuous-Crawler/<major.minor> (+<info URL>)` for the docs crawler. No OS, no IDE, no machine id, no patch version. The person can override it in their own config, per host if they want. The info URL and the product tokens are public identity, so they are **kept for the owner** (section 3.4).
2. **`robots.txt` binds the crawler, informs the agent, and never stands between a person and a page they named.** The docs crawler follows RFC 9309 to the letter. The model's fetch tool checks `robots.txt` under `Continuous-User`; a disallow becomes an ask, not a silent refusal, and is refused in headless runs. A URL the person typed, pasted or opened in the Browser panel skips the check (section 4.5).
3. **Domain rules reach the web.** `host:` and `net:` rules in `permissions.yaml` apply to every web path (fetch tool, `@url`, crawler, favicon, search backend, Browser panel). They are matched on the normalised A-label, re-checked at **every redirect hop** inside `guardedFetch`, and decided in core, never by the model (section 5).
4. **No reputation list ships on.** An opt-in provider layer (section 6) accepts a local feed, Safe Browsing v5 hash-prefix lookups with the person's own key, or an organisation's own RHSBL zone. A hit asks. Nothing is queried, downloaded or bundled by default.
5. **Every fetch leaves a record.** Final URL, hops, status, type, bytes, SHA-256, time, cache state, robots verdict, rule applied and User-Agent go into a per-session fetch log, a masked audit line, and a compact provenance line inside the spotlight markers (section 7.8).
6. **No cookies, no forwarded credentials, ever, from the agent's fetch.** Per-host headers are allowed only from the person's own config, only to that exact host, and are stripped on a cross-host redirect (section 7.6).
7. **Cache politely.** A 15-minute session cache with ETag revalidation (RFC 9111), honouring `no-store`. A per-host rate limit, and `Retry-After` honoured for 429 and 503 (section 7.4).
8. **A `web:` section in config.yaml** replaces the scattered `toolPermissions.auto.environment.fetch*` keys and the `CONTINUOUS_*` environment variables. Keys that loosen safety are read from the personal file only; a workspace file can only tighten (section 8).
9. **A Browser panel, built as a GUI route so VS Code and JetBrains get it together.** It shows what was fetched and what the model saw, lets the person allow or block a domain once or always (writing the same `permissions.yaml` rules), re-fetch, and open the page in a real browser. The person can paste a URL there and hand the page to the chat. It never uses the person's cookies. The CLI gets `/web` (section 9).
10. **JavaScript rendering stays out of the built-in fetch.** On 2026-11-15 the owner decided "No JavaScript rendering, no cloud reader proxy as a default, no bundled headless browser" (`plans/decisions-2026-11-15.md:116`). A JS-capable browser driven through the user's installed Chrome or Edge is designed here (section 9.4) but **kept for the owner**, because it reverses that decision. The supported route today is an MCP browser server the person adds.

The build plan (section 10) has 20 new rows in five parallel groups. Seven of them have no dependency and can start at once.

## 2. Current state: every path that touches the web

Paths are relative to the repository root. "Model URL" means a URL chosen by the model; "person URL" means one the person typed.

### 2.1 Inventory

| Path                           | Who chooses the URL                                                            | Client and transport                                                                                                                                       | What it sends                                                                                                                                                                                                     | Limits                                                                                                                                                                                                                                                           | Guards                                                                                                                                                                                                                                                                                                 | Gaps                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch_url_content` tool (IDE) | model                                                                          | `modelToolFetch` (`core/util/modelToolFetch.ts:16-28`, chosen at `core/core.ts:2676-2680`), then `fetchWithGuardedRedirects` (`core/util/guardedFetch.ts`) | node-fetch defaults: `User-Agent: node-fetch`, `Accept: */*`, `Accept-Encoding: gzip, deflate, br`; global `requestOptions.headers` only to a model `apiBase` origin (`packages/fetch/src/scopeHeaders.ts:30-52`) | 2 MiB after decompression, 20 s total (`core/util/boundedBody.ts:9-10`), ceilings 64 MiB and 300 s (`core/util/userFetchLimits.ts:25-26`); 5 redirects (`guardedFetch.ts:5`); 20,000 characters to the model (`core/tools/implementations/fetchUrlContent.ts:8`) | http/https only, no userinfo, outbound secret scan on the URL (`core/util/fetchUrlSafety.ts:17-62`); private target asks and cannot be loosened (`core/tools/permissions/evaluate.ts:515-522`); DNS pinned 10 min (`core/util/networkAddress.ts:139`); spotlight optional (`fetchUrlContent.ts:47-55`) | no UA, no robots, no host rules, redirect hops not re-checked against `trustedDomains`, status not returned on success, spotlight off by default                                                                                                                                         |
| CLI `Fetch` tool               | model                                                                          | `guardedToolFetch()` → `modelToolFetch` (`extensions/cli/src/tools/fetch.ts:33-46`)                                                                        | as above                                                                                                                                                                                                          | as above, then cut again at `CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH` (default 20,000, `fetch.ts:17-24`)                                                                                                                                                            | as above, but `Fetch` is `allow` in normal and plan modes (`extensions/cli/src/permissions/defaultPolicies.ts:27`, `:63`)                                                                                                                                                                              | the "long encoded value" ask is dropped at default levels (`permissionChecker.ts:295-300`, `coreRules.ts:501-503`); `preprocessArgs`' `nonPublic` result is discarded (`fetch.ts:69-70`); no `config` is passed, so `spotlightUntrusted` is never read (`fetch.ts:90-93`) (all inferred) |
| `@url` provider                | person                                                                         | `extras.fetch` = `fetchwithRequestOptions(url, init, config.requestOptions)` (`core/context/providers/URLContextProvider.ts:42-49`)                        | node-fetch defaults **plus every global `requestOptions.headers`** value                                                                                                                                          | byte cap, deadline, content types as above; no character cut                                                                                                                                                                                                     | scheme and userinfo checks; cross-domain redirect strips auth and cookie headers (`packages/fetch/src/node-fetch-patch.js:260-284`)                                                                                                                                                                    | redirects unguarded (node-fetch `follow`, default 20): a public URL can redirect to `169.254.169.254`; global headers (often a gateway token) go to any site the person names                                                                                                            |
| `search_web` tool and `@web`   | model (tool) or the whole chat message (`@web`, `WebContextProvider.ts:29-33`) | `GET <CONTINUOUS_WEB_SEARCH_URL>?q=…&format=json` (`core/context/providers/webSearchBackend.ts:56-66`)                                                     | `Accept: application/json`, optional `Authorization: Bearer <CONTINUOUS_WEB_SEARCH_KEY>`, plus global headers                                                                                                     | top 5 results, 8,000 characters each (`core/tools/implementations/searchWeb.ts:5-10`); no byte cap, no deadline beyond the 2-hour agent timeout                                                                                                                  | absent unless the endpoint is configured (`core/tools/index.ts:39`)                                                                                                                                                                                                                                    | `allowedWithoutPermission` (`core/tools/definitions/searchWeb.ts:28`); no query scan (WB3); results not sanitised or spotlighted; raw response body in the error (`webSearchBackend.ts:67-69`)                                                                                           |
| `@google` (deprecated)         | person                                                                         | POST `https://google.serper.dev/search` (`GoogleContextProvider.ts:31`)                                                                                    | `X-API-KEY`                                                                                                                                                                                                       | body read whole with `response.text()`                                                                                                                                                                                                                           | none                                                                                                                                                                                                                                                                                                   | unbounded body, raw body in the error (line 72)                                                                                                                                                                                                                                          |
| `@http` provider               | config                                                                         | POST to a configured URL (`HttpContextProvider.ts:53-66`)                                                                                                  | query, full input, options; workspace path only to a local host (line 23)                                                                                                                                         | none                                                                                                                                                                                                                                                             | config-defined                                                                                                                                                                                                                                                                                         | out of scope (a configured integration, not a fetch)                                                                                                                                                                                                                                     |
| Docs crawler, Cheerio          | config (`docs:` entry)                                                         | `fetchWithGuardedRedirects(…, networkFetchWith(requestOptions), { stayOnStartHost: true })` (`core/indexing/docs/crawlers/CheerioCrawler.ts:102-106`)      | node-fetch defaults; headers stripped (`core/util/networkFetch.ts:12`)                                                                                                                                            | `maxDepth` 4, 1,000 pages (`DocsCrawler.ts:24-25`); **batches of 50 concurrent requests with no delay** (`CheerioCrawler.ts:50`); `response.text()` with no cap or deadline (line 125)                                                                           | same-host links only (line 141)                                                                                                                                                                                                                                                                        | `robots.txt` appears only in an ignore list (line 14) and is never read; no rate limit; no body cap                                                                                                                                                                                      |
| Docs crawler, Chromium         | config                                                                         | puppeteer with `--proxy-server`, `--ignore-certificate-errors` when `verifySsl: false` (`chromiumNetworkArgs.ts:24-30`)                                    | **`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.150 Safari/537.36`** (`ChromiumCrawler.ts:74`)                                                               | `page.goto(url, { timeout: 0, waitUntil: "networkidle2" })` (line 104): no navigation timeout                                                                                                                                                                    | non-public start refused (line 51), page host checked (line 139)                                                                                                                                                                                                                                       | subresources, in-page redirects and rebinding inside Chromium are not guarded; masquerades as a browser                                                                                                                                                                                  |
| Docs crawler, GitHub           | config                                                                         | Octokit over `networkFetchWith(requestOptions)` (`GitHubCrawler.ts:23`)                                                                                    | Octokit's UA, optional token                                                                                                                                                                                      | recursive tree, every `.md`/`.mdx`, no count or size limit                                                                                                                                                                                                       | GitHub API only                                                                                                                                                                                                                                                                                        | unbounded                                                                                                                                                                                                                                                                                |
| Chromium download              | fixed                                                                          | global `fetch` (`chromiumDownload.ts:186`) from `storage.googleapis.com/chromium-browser-snapshots` (line 200)                                             | Node's undici defaults                                                                                                                                                                                            | SHA-256 pinned (lines 25-58)                                                                                                                                                                                                                                     | only after the install prompt                                                                                                                                                                                                                                                                          | bypasses the shared client, so proxy and CA settings do not apply                                                                                                                                                                                                                        |
| Favicon lookup                 | derived from `@url` or a docs site                                             | `findFaviconPath`, `getFaviconBase64` (`core/util/fetchFavicon.ts:15-19`, `:58`)                                                                           | node-fetch defaults                                                                                                                                                                                               | `response.text()` / `arrayBuffer()`: no cap, no deadline                                                                                                                                                                                                         | `stayOnStartHost`; `refuseNonPublicStart` for a foreign icon host                                                                                                                                                                                                                                      | no image MIME check; the server's type goes into a data URI (line 73)                                                                                                                                                                                                                    |
| GUI images                     | context items, providers, model markdown                                       | webview `fetch(src)` (`gui/src/components/SafeImg.tsx:28`); model images are click-to-load (`SecureImageComponent.tsx`, `imageSourceRisk.ts:21-52`)        | the webview's own UA                                                                                                                                                                                              | CSP `img-src … https: http: data: blob:`, `connect-src https: http:` (`extensions/vscode/src/util/webviewCsp.ts:22-35`)                                                                                                                                          | click-to-load for model images                                                                                                                                                                                                                                                                         | MCP `faviconUrl` rendered straight into `<img>` (`ToolCallDisplay.tsx:51`)                                                                                                                                                                                                               |
| Opening links                  | person (click) or core                                                         | `vscode.env.openExternal` (`extensions/vscode/src/extension/VsCodeMessenger.ts:427-435`)                                                                   | the system browser's own                                                                                                                                                                                          | n/a                                                                                                                                                                                                                                                              | webview links limited to http, https, mailto (`webviewMessageGuard.ts:24-39`)                                                                                                                                                                                                                          | `openUrl` from core is unchecked (`VsCodeMessenger.ts:433-435`)                                                                                                                                                                                                                          |
| Model catalog, model providers | fixed or configured                                                            | various                                                                                                                                                    | `user-agent: continuous` (`core/llm/modelCatalogStore.ts:101`); `Continuous/${CONTINUE_VERSION}` (`core/llm/llms/ClawRouter.ts:47`); `Continuous/IDE` (`packages/openai-adapters/src/apis/ClawRouter.ts:36`)      | n/a                                                                                                                                                                                                                                                              | n/a                                                                                                                                                                                                                                                                                                    | out of scope for web fetch, but see section 3.3                                                                                                                                                                                                                                          |

No bundled MCP fetch or browser server exists. The decisions file plans a `fetch` MCP template among eight wizard templates (`plans/decisions-2026-11-15.md:103`). JetBrains' `ContinueBrowser.kt` (`extensions/intellij/src/main/kotlin/.../browser/ContinueBrowser.kt`) is the JCEF host for the chat GUI, not a web browser. The VS Code extension opens no webview other than the chat (`extensions/vscode/src/commands.ts:802`) and never calls VS Code's Simple Browser.

### 2.2 What can be configured today

| Setting                                                                                                                                                                                                                           | Where                                                                                                        | Read from                                                                          | Effect                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `requestOptions.{timeout, connectTimeout, verifySsl, useSystemCa, caBundlePath, proxy, noProxy, headers, extraBodyProperties, clientCertificate}`                                                                                 | `packages/config-yaml/src/schemas/models.ts:12-28`, top level and per model                                  | any config                                                                         | transport for all paths; `headers` scoped away from model-chosen hosts (#636) but not from `@url` or search |
| `toolPermissions.auto.environment.trustedDomains`                                                                                                                                                                                 | `packages/config-yaml/src/schemas/index.ts:229-251`                                                          | personal config only (`core/tools/permissions/userTrustedDomains.ts`)              | arms `ask-unknown-host` (start host only); not an allow until B56 (#625, draft)                             |
| `toolPermissions.auto.environment.fetchMaxBytes`, `fetchTimeoutSeconds`                                                                                                                                                           | same                                                                                                         | personal config only                                                               | byte cap and deadline for the tool and `@url`                                                               |
| `toolPermissions.auto.environment.taintedSessionRule: off \| ask`                                                                                                                                                                 | same                                                                                                         | personal config only                                                               | network and state-changing calls ask after a web fetch                                                      |
| `permissions.yaml` `fetchUrl(<glob>)` / CLI `Fetch(<glob>)`                                                                                                                                                                       | `core/tools/permissions/names.ts:59, 123-124`; `extensions/cli/src/permissions/permissionsYamlLoader.ts:134` | permissions files                                                                  | a glob over the **whole URL string**, not the parsed host                                                   |
| `permissions.yaml` `host:` / `net:` rules                                                                                                                                                                                         | `core/tools/permissions/rules.ts:166-219`                                                                    | permissions files                                                                  | **terminal commands only** (`matchTerminalCommand`, lines 249-268)                                          |
| `experimental.spotlightUntrusted`                                                                                                                                                                                                 | `core/index.d.ts:2815`                                                                                       | JSON config only: the YAML schema has no `experimental` block (inferred from grep) | spotlight on fetch results                                                                                  |
| `experimental.useChromiumForDocsCrawling`                                                                                                                                                                                         | `core/index.d.ts:2839`                                                                                       | JSON config                                                                        | Chromium crawler                                                                                            |
| `docs[].maxDepth`                                                                                                                                                                                                                 | `packages/config-types/src/index.ts:225` only                                                                | not in the YAML docs schema (`schemas/index.ts:30-37`)                             | crawl depth                                                                                                 |
| `CONTINUOUS_WEB_SEARCH_URL`, `CONTINUOUS_WEB_SEARCH_KEY`, `CONTINUOUS_SPOTLIGHT_UNTRUSTED`, `CONTINUE_USE_WEB_FETCH`, `VERBOSE_FETCH`, `CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH`, `HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` | environment                                                                                                  | environment                                                                        | search endpoint, spotlight, transport, logging                                                              |

There is no way to set a User-Agent, a `robots.txt` policy, a host allow or deny list for the web, a rate limit, a cache or a reputation check.

### 2.3 Documentation drift found on the way

- `PRIVACY.md:66` says "`@url`, the `fetch_url` tool and docs indexing fetch the sites you point them at". The tool is `fetch_url_content` in core and `Fetch` in the CLI. The sentence is also silent on the User-Agent that every such fetch sends.
- ROADMAP WB13 ("reads `spotlightUntrusted`", Built #735) is not true of the code: the CLI passes no `config` to the implementation, so only the environment variable works.
- ROADMAP WB16 is "Built (#735)", and the decision at `plans/decisions-2026-11-15.md:118` says "Ask when the target host has not been seen". `guardedFetch.ts` refuses only public-to-private hops; there is no ask on an unseen host. The final-URL label is built; the ask is not.
- `extensions/cli/src/config.ts:19-37` defines `getUserAgent()` (`Continuous-CLI/<version>`) and `_mergeUserAgentIntoRequestOptions`, which would also add `x-continue-unique-id: <machine id>`. Nothing calls it. It is dead code, but it would leak a machine id to every model provider if someone revived it, so WB17 deletes it.

## 3. User-Agent

### 3.1 What HTTP says

- A user agent "SHOULD send a User-Agent header field in each request unless specifically configured not to do so" ([RFC 9110§10.1.5¶1](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.1.5-1)). The grammar is `product *( RWS ( product / comment ) )` with `product = token ["/" product-version]` (¶2, ¶4).
- "A sender MUST NOT generate advertising or other nonessential information within the product identifier", and SHOULD NOT put anything but a version in `product-version` ([RFC 9110§10.1.5¶5](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.1.5-5)).
- "A user agent SHOULD NOT generate a User-Agent header field containing needlessly fine-grained detail … Overly long and detailed User-Agent field values increase request latency and the risk of a user being identified against their wishes ('fingerprinting')" ([RFC 9110§10.1.5¶8](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.1.5-8)).
- Implementations "are encouraged not to use the product tokens of other implementations in order to declare compatibility with them"; a masquerading agent gets responses tailored to what it pretends to be ([RFC 9110§10.1.5¶9](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.1.5-9)).
- `From`: "A user agent SHOULD NOT send a From header field without explicit configuration by the user", while "A robotic user agent SHOULD send a valid From header field" ([RFC 9110§10.1.2¶5-6](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.1.2-5)).
- `Referer`: when the URI came from keyboard input or similar, the user agent "MUST either exclude the Referer header field or send it with a value of 'about:blank'" ([RFC 9110§10.1.3¶7](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.1.3-7)).
- For `robots.txt` purposes, a crawler's product token "MUST contain only uppercase and lowercase letters ('a-z' and 'A-Z'), underscores ('_'), and hyphens ('-')", and "SHOULD be a substring in the User-Agent header" ([RFC 9309§2.2.1¶1](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.2.1-1)).

### 3.2 What other agents send

| Agent                  | User-Agent                                                                                                                               | Notes                                                                                                                                                                            | Source                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code `WebFetch` | begins with `Claude-User`; observed as `Claude-User (claude-code/<version>; +https://support.anthropic.com/)`; `Accept` prefers Markdown | 100,000 characters, 15 min cache, cross-host redirects returned rather than followed, hostname sent to `api.anthropic.com` for a safety blocklist unless `skipWebFetchPreflight` | P https://code.claude.com/docs/en/tools-reference, P https://code.claude.com/docs/en/data-usage#webfetch-domain-safety-check; S (exact string) https://braindetox.kr/en/posts/claude_code_web_fetch_request_headers_check.html |
| Gemini CLI `web_fetch` | `Mozilla/5.0 (compatible; Google-Gemini-CLI/1.0; +https://github.com/google-gemini/gemini-cli)`                                          | blocks localhost, `.local`, `.internal`, private IPs; 10 s; 10 requests per host per minute; 250,000 characters; no robots                                                       | P https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/web-fetch.ts                                                                                                                         |
| Aider `/web`           | `Aider/<version> +<website>` (Playwright appends it to the browser's UA)                                                                 | Playwright 5 s `networkidle`; httpx with no timeout; no robots                                                                                                                   | P https://raw.githubusercontent.com/Aider-AI/aider/main/aider/scrape.py                                                                                                                                                        |
| Cline                  | plain Chrome 128 string via puppeteer                                                                                                    | 10 s `goto`; no robots, no private-IP check                                                                                                                                      | P `apps/vscode/src/services/browser/UrlContentFetcher.ts` in cline/cline                                                                                                                                                       |
| Codex CLI              | none local: `web_search` is a hosted Responses-API tool (`cached` or `live`)                                                             | fetching happens on OpenAI's servers                                                                                                                                             | P https://learn.chatgpt.com/docs/config-file/config-reference, `codex-rs/core/src/tools/hosted_spec.rs`                                                                                                                        |
| OpenHands              | the `browser_use` library's Chromium; no custom UA found                                                                                 | full browser                                                                                                                                                                     | P OpenHands/software-agent-sdk `openhands-tools/openhands/tools/browser_use/impl.py`                                                                                                                                           |
| OpenAI ChatGPT-User    | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot`                              | user-directed                                                                                                                                                                    | P https://developers.openai.com/api/docs/bots                                                                                                                                                                                  |
| Perplexity-User        | `Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)`                                                  | user-directed                                                                                                                                                                    | P https://docs.perplexity.ai/guides/bots                                                                                                                                                                                       |
| This fork, today       | `node-fetch` (tool, `@url`, Cheerio, favicon), Chrome 88 (Chromium crawler)                                                              | node-fetch 3.3.2 sets `User-Agent: node-fetch` when none is given                                                                                                                | P https://raw.githubusercontent.com/node-fetch/node-fetch/v3.3.2/src/request.js; `ChromiumCrawler.ts:74`                                                                                                                       |

The pattern among those that identify themselves is the same: a product token naming the operator and the purpose, a version, and a `+URL` comment pointing at a page that explains the agent. Two vendors split the token by purpose (OpenAI: GPTBot, OAI-SearchBot, ChatGPT-User; Anthropic: ClaudeBot, Claude-SearchBot, Claude-User), so that a site can treat a person's request differently from a crawl.

### 3.3 Privacy trade-off

The UA is sent to every site the model or person names, so anything in it is disclosed to arbitrary third parties. `node-fetch` discloses nothing, but it is the string every scraper sends, so it is the most likely to be blocked, and it gives the site no way to treat a person's request differently from a crawl. A browser-like string is no better: it hides the agent from the site, which is exactly what RFC 9110§10.1.5¶9 and the Perplexity episode (Cloudflare, 2025-08-04, https://blog.cloudflare.com/perplexity-is-using-stealth-undeclared-crawlers-to-evade-website-no-crawl-directives/, P for Cloudflare's claim) argue against.

A product token with a `major.minor` version identifies the software and almost nothing about the person. Each release shares one string with every other user of that release. The OS, the IDE (VS Code or JetBrains), the patch version and any id would each split that crowd further, and none of them is "necessary to identify the product" (RFC 9110§10.1.5¶5).

### 3.4 Decisions

| #     | Question                               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UA-1  | Default for fetches made for a person  | `Continuous-User/<major>.<minor> (+<info URL>)` for the fetch tool, `@url`, the Browser panel and the favicon lookup. One string for IDE and CLI.                                                                                                                                                                                                                                                                                                                                                             |
| UA-2  | Default for the docs crawler           | `Continuous-Crawler/<major>.<minor> (+<info URL>)`, Cheerio and Chromium alike. The Chrome 88 string goes.                                                                                                                                                                                                                                                                                                                                                                                                    |
| UA-3  | Search backend                         | `Continuous-User/<major>.<minor>` with no URL comment (the backend is the person's own choice and needs no explanation page).                                                                                                                                                                                                                                                                                                                                                                                 |
| UA-4  | What is never in it                    | OS, IDE, Node version, patch version, machine id, session id. A test asserts this for every path.                                                                                                                                                                                                                                                                                                                                                                                                             |
| UA-5  | Robots product tokens                  | `Continuous-User` and `Continuous-Crawler`. Both satisfy RFC 9309§2.2.1¶1 (letters and hyphen only) and appear as substrings of the UA.                                                                                                                                                                                                                                                                                                                                                                       |
| UA-6  | Person override                        | `web.userAgent` (string) in the personal config only. An empty string sends no UA (RFC 9110 allows that "if specifically configured"). Logged in the fetch record so the panel can show it.                                                                                                                                                                                                                                                                                                                   |
| UA-7  | Per-domain override                    | `web.hosts[<pattern>].userAgent`, personal config only. Allowed, because some internal sites gate on UA, and the person's choice to masquerade is theirs to make. Never allowed from a workspace file, since a repository must not be able to make the agent pretend to be a browser.                                                                                                                                                                                                                         |
| UA-8  | `From` header                          | Never sent by the fetch tool or `@url` (RFC 9110§10.1.2¶5). For the crawler, sent only if the person sets `web.crawler.contact` (RFC 9110§10.1.2¶6 asks robots to send one, but the contact is the person's to give).                                                                                                                                                                                                                                                                                         |
| UA-9  | `Referer`, `Accept`, `Accept-Language` | No `Referer`, ever. `Accept: text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.8, */*;q=0.1` (sites that serve Markdown to agents can, and our converter is skipped). No `Accept-Language` by default (it is a fingerprint and a locale disclosure); `web.acceptLanguage` sets one.                                                                                                                                                                                                      |
| UA-10 | The info URL and the token names       | **Kept for the owner.** They are the fork's public identity on every site it touches. Proposal: a page in this repository's docs (`docs/web-agent.md`) that says what the agent is, that it acts for a person, how it treats `robots.txt`, and how to reach the maintainer. The token names above are a proposal too.                                                                                                                                                                                         |
| UA-11 | Web Bot Auth (signed requests)         | Not now. The IETF `webbotauth` working group has one document, `draft-ietf-webbotauth-httpsig-protocol-01` (2026-10-29), built on RFC 9421 HTTP Message Signatures (Proposed Standard). A per-install key would itself identify the person across sites, and a shared key cannot be kept secret in open source. Revisit when the draft defines an anonymous mode (`draft-rescorla-anonymous-webbotauth-01` exists as an individual draft). Source: https://datatracker.ietf.org/wg/webbotauth/documents/ (P). |

## 4. `robots.txt`

### 4.1 What RFC 9309 requires

RFC 9309 (Proposed Standard, 2022-09) is current, with no verified errata.

- **Scope.** "Crawlers are automated clients. Search engines, for instance, have crawlers to recursively traverse links for indexing" ([RFC 9309§1¶2](https://www.rfc-editor.org/rfc/rfc9309.html#section-1-2)). "These rules are not a form of access authorization" (§1¶4).
- **Groups.** Crawlers "MUST use case-insensitive matching to find the group that matches the product token"; multiple matching groups are combined. With no matching group, they "MUST obey the group with a user-agent line with the '*' value, if present" ([RFC 9309§2.2.1¶4-6](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.2.1-4)).
- **Matching.** "The most specific match found MUST be used. The most specific match is the match that has the most octets." An equivalent `allow` beats a `disallow` (SHOULD). No match means allowed. "The /robots.txt URI is implicitly allowed" ([RFC 9309§2.2.2¶2](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.2.2-2)). Percent-encoding is normalised before comparison (¶3-4). `*` and `$` are the special characters (§2.2.3).
- **Location.** `/robots.txt`, lowercase, at the top level, UTF-8, `text/plain` (§2.3¶1).
- **Redirects.** Crawlers "SHOULD follow at least five consecutive redirects, even across authorities", and the rules apply "in the context of the initial authority" (§2.3.1.2¶1-2). Beyond five they MAY treat the file as unavailable.
- **4xx.** "Unavailable": the crawler "MAY access any resources on the server" ([RFC 9309§2.3.1.3¶2](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.3.1.3-2)).
- **5xx or network error.** "Unreachable": the crawler "MUST assume complete disallow" ([RFC 9309§2.3.1.4¶1](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.3.1.4-1)). After "a reasonably long period of time (for example, 30 days)" it MAY treat the file as unavailable or keep a cached copy (¶2).
- **Caching.** Crawlers MAY cache it and MAY use RFC 9111 cache control, but "SHOULD NOT use the cached version for more than 24 hours, unless the robots.txt file is unreachable" ([RFC 9309§2.4¶1](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.4-1)).
- **Size.** A parsing limit SHOULD be imposed, and "MUST be at least 500 kibibytes" ([RFC 9309§2.5¶1](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.5-1)).
- **Security.** Treat the file as untrusted content (§3¶3).

### 4.2 Does it apply to a person's fetch?

The RFC's subject is crawlers, defined by automation and recursive traversal. A person asking an agent to read one page is not that, and the vendors split along exactly this line:

- **Google**: user-triggered fetchers (Google-Agent and others) "generally ignore robots.txt rules" because "the fetch was requested by a user" (P https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers). Google-Extended is a robots token only, controlling Gemini training and grounding (P https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers).
- **OpenAI**: for ChatGPT-User "robots.txt rules may not apply" (P https://developers.openai.com/api/docs/bots). Trade press reports this replaced a compliance statement on 2025-12-09 (S https://ppc.land/openai-revises-chatgpt-crawler-documentation-with-significant-policy-changes/).
- **Perplexity**: Perplexity-User "generally ignores robots.txt rules" (P https://docs.perplexity.ai/guides/bots). Cloudflare's 2025-08-04 report is about undeclared crawlers evading the rules, not about the declared user agent.
- **Anthropic**: ClaudeBot, Claude-User and Claude-SearchBot all "respect 'do not crawl' signals by honoring industry standard directives in robots.txt" (P https://support.claude.com/en/articles/8896518). Anthropic's API `web_fetch` server tool refuses `robots.txt` disallows, and refuses URLs not already in the conversation (P https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool, read 2026-11-11 in the earlier note).
- **MCP Fetch server** (reference implementation): obeys `robots.txt` for model-initiated fetches but not for user-initiated ones (P https://github.com/modelcontextprotocol/servers/tree/main/src/fetch).

The useful line is the MCP server's, and it maps onto a distinction the fork already plans to track: whether the **URL came from the person** (WB6's per-session seen-URL set; `plans/research/area-injection-tool-exposure-web.md` §6.2). An agent loop that searches, picks a result and fetches it is closer to automation than to a person reading a page, even if a person started the loop.

### 4.3 AI-preference signals beyond `robots.txt`

- **IETF AIPREF.** `draft-ietf-aipref-vocab-08` (2026-09-13) defines labels `train-ai`, `ai-use` (input to generative AI the user did not provide) and `search`. `draft-ietf-aipref-attach-05` (2026-08-18) attaches them through a `Content-Usage` HTTP header and a `Content-Usage` rule in `robots.txt`, updating RFC 9309. Both are working-group drafts in state "I-D Exists", and the vocabulary author notes §3-4 lack consensus (P https://datatracker.ietf.org/wg/aipref/documents/). Neither is in the RFC library yet.
- **llms.txt** (Jeremy Howard, 2024-09-03): a Markdown file at a site root or subpath with an H1, an optional summary and link lists, plus `.md` page variants (P https://llmstxt.org/). It is an offer of agent-friendly content, not a restriction.
- **ai.txt**: Spawning's training opt-out (spec page not found) and an individual draft `draft-car-ai-txt-wellknown-00` (P https://datatracker.ietf.org/doc/draft-car-ai-txt-wellknown/).

An agent reading a page for a person is not training, and `ai-use` in the AIPREF draft is defined around content the user did not provide. Until the drafts settle, the right move is to record the signal and show it, not to act on it.

### 4.4 Decisions

| #     | Question                                             | Decision                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RB-1  | Docs crawler (Cheerio, Chromium)                     | **Respect**, as RFC 9309 says, under token `Continuous-Crawler`: 4xx allows, 5xx and network errors disallow, 24-hour cache, follow up to five redirects for the file, rules applied to the initial authority, 512 KiB parse limit, `Crawl-delay` honoured as a floor on the per-host delay (a widely used non-standard record; RFC 9309§2.2.4¶1 allows other records).             |
| RB-2  | Crawler override                                     | `docs[].robots: ignore` on a single docs entry, personal config only, shown in the docs status and the fetch log. Use case: the person's own site, or a site that disallows everything by mistake.                                                                                                                                                                                  |
| RB-3  | GitHub crawler                                       | Not subject: it uses the GitHub API, which has its own terms and rate limits, not `robots.txt`.                                                                                                                                                                                                                                                                                     |
| RB-4  | Model's fetch tool, URL not seen from the person     | **Check** under `Continuous-User`. A disallow is an **ask**: the card says "`robots.txt` on `<host>` asks agents not to read `<path>`. Fetch anyway?" with Once / Always for this host / No. Headless and other unattended runs **refuse**. The model is told: `Not fetched: <host>'s robots.txt disallows this path for automated agents. Ask the person if they want it fetched.` |
| RB-5  | Model's fetch tool, URL the person wrote             | **Skip.** A URL that appeared in a user message (WB6's seen-URL set, user-origin flag), `@url`, the Browser panel's address bar and a pasted link are person-directed fetches.                                                                                                                                                                                                      |
| RB-6  | `robots.txt` unreachable (5xx, timeout) for the tool | Proceed, and say so in the provenance line (`robots: unreachable`). The MUST in §2.3.1.4 binds crawlers; the tool is not one, and blocking a person's request because a site's error page is down would be the wrong way round.                                                                                                                                                     |
| RB-7  | Cost                                                 | One extra request per new authority per 24 hours, with a 3-second budget inside the fetch deadline. The cache is shared by tool and crawler but the verdict is per token.                                                                                                                                                                                                           |
| RB-8  | Global mode                                          | `web.robots: respect \| ask \| ignore`, default `ask` (RB-4/RB-5). `respect` turns RB-4's ask into a refusal; `ignore` skips the tool check (personal config only). The crawler always uses RB-1 unless RB-2.                                                                                                                                                                       |
| RB-9  | AIPREF `Content-Usage`, llms.txt, ai.txt             | Record and show `Content-Usage` (header or robots rule) in the fetch record and the Browser panel; no behaviour change until an RFC exists. The crawler may use `llms.txt` as a seed list when the person opts in per docs entry (`docs[].useLlmsTxt: true`). ai.txt is ignored.                                                                                                    |
| RB-10 | Where the check runs                                 | In core, inside the fetch pipeline after the host rule and before the request, never as model instructions.                                                                                                                                                                                                                                                                         |

## 5. Domain controls

### 5.1 Today

There are three overlapping mechanisms and none is a domain rule for the web:

- `trustedDomains` (personal config) arms `ask-unknown-host` (`core/tools/permissions/askProtections.ts:140-163`). It uses label-suffix matching (`h === d || h.endsWith("." + d)`, lines 107-113), which avoids the prefix-match shape of CVE-2026-24052. It checks only the start URL's host.
- `fetchUrl(<glob>)` rules match the whole URL string as a glob, so `fetchUrl(https://example.com/*)` does not match `https://EXAMPLE.com/` or `https://example.com.evil.net/` correctly, and nothing normalises IDNs.
- `host:` and `net:` destination rules (`core/tools/permissions/rules.ts:186`, grammar `/^(?:(\S+)\s+)?(host|net):(\S+)$/i`) with net sets `metadata`, `local` and `private` (`destinations.ts`) exist and are tested, but apply only to `runTerminalCommand`.

B56 (trusted-host allow, #625 draft) and WB11 (its deny list of user-content hosts, decided 2026-11-15) will add an allow side. This section makes the rules one system.

### 5.2 Normalisation and matching

- **Parse with WHATWG URL**, then lowercase, strip one trailing dot, and convert to the A-label form (IDNA; RFC 5891 is the lookup protocol, Proposed Standard, current). Match rules on the A-label. Show both forms in every ask and in the panel.
- **Confusables.** "There are no comprehensive technical solutions to the problems of confusable characters", and implementations are advised to "provide visual indications where a domain name contains multiple scripts" ([RFC 5890§4.4](https://www.rfc-editor.org/rfc/rfc5890.html#section-4.4)). Decision: a host with a mixed-script label, or whose Unicode skeleton (UTS #39) equals that of a host in an allow rule or `trustedDomains` without being that host, always asks and cannot be settled by an allow rule.
- **Wildcards.** `host:example.com` matches only `example.com`. `host:*.example.com` matches any subdomain and not the apex. Matching is on whole labels (no `startsWith`, no substring). A bare `*` is allowed only in a deny rule.
- **Ports.** A rule without a port matches any port; `host:example.com:8443` narrows to one.
- **IP literals.** Matched by `net:` CIDR rules (`net:10.0.0.0/8`, `net:private`); an IP literal never matches a `host:` name rule. IPv4-mapped and NAT64 forms are judged by the embedded IPv4 address, as `isNonPublicAddress` already does.
- **Schemes.** Only `http` and `https` are fetched (already enforced). `file:`, `data:`, `ftp:`, `ws:`, `javascript:` and everything else are refused before any rule runs. Plain `http` is allowed and labelled `unencrypted` in the provenance line; `web.requireHttps: true` refuses it. No automatic upgrade, because an upgrade changes the URL the person approved.
- **Userinfo.** Refused, as today ([RFC 9110§4.2.4¶4](https://www.rfc-editor.org/rfc/rfc9110.html#section-4.2.4-4): a recipient "SHOULD parse for userinfo and treat its presence as an error").

### 5.3 Where and when the check runs

- In core, in one function used by every web path (`checkWebDestination(url, purpose, session)`), never in the prompt.
- **At every hop.** `fetchWithGuardedRedirects` already re-classifies each hop for private addresses; it gains the host rule, the reputation check and the robots check per hop. A hop to a host that would ask is either asked (interactive) or returned to the model as text ("redirected to `<url>`, not followed: host not allowed"), matching Claude Code's behaviour for cross-host redirects. This also closes the unbuilt half of WB16.
- **Order:** scheme and userinfo → secret scan → `host:`/`net:` deny → private-address protection (cannot be loosened, as today) → reputation (if on) → `host:` allow / `trustedDomains` / ask-unknown-host → robots → request.
- **Precedence.** Deny beats allow at every layer. A workspace `permissions.yaml` can add deny rules and asks; only the personal file (and a managed file, if one is deployed) can add web allow rules. This matches how `trustedDomains` and the fetch limits are read today.

### 5.4 SSRF and rebinding

The fork's protection is sound where it applies: resolve once, pin the address for the connection, re-classify every hop, refuse public-to-private hops, and ask for a private start that only IDGAF can override.

Remaining work:

- **Add the RFC 6890 special-purpose blocks the classifier misses:** `192.0.0.0/24`, `198.18.0.0/15`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `100::/64`, `2001::/23` (excluding the globally reachable entries) and `2001:db8::/32`. RFC 6890 is BCP 153, updated by RFC 8190, which renamed the registry column to "Globally Reachable" ([RFC 8190§2.1](https://www.rfc-editor.org/rfc/rfc8190.html#section-2.1)). Generate the table from the IANA registry CSV at build time, with a test that pins it.
- **`.localhost` names.** These are refused already through `NON_PUBLIC_NAME` (`networkAddress.ts:113`), consistent with [RFC 6761 §6.3](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3).
- **Behind a proxy**, the pin is dropped and the proxy resolves the name (`packages/fetch/src/fetch.ts:118-123`). Decision: also resolve locally, ask if the local answer is non-public or the name is an unresolvable no-TLD name, and state the residual in the docs: the proxy may resolve differently, and only the proxy's own egress policy closes that.
- **Headless browser paths** (Chromium crawler, section 9.4) need the check at the browser's request-interception layer, not only for the page URL.

### 5.5 Audit

Every web request (not only tool calls) writes one line to the existing audit directory: time, purpose (`tool`, `@url`, `crawler`, `favicon`, `search`, `panel`), session, URL with the query masked, hops, decision, rule that decided, robots verdict, reputation verdict, status, bytes and SHA-256. The fetch log (section 7.8) links to the line.

### 5.6 Decisions

| #    | Decision                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DC-1 | `host:`/`net:` rules apply to every web path, through one core function, at every hop.                                                                                                              |
| DC-2 | Matching on the normalised A-label, whole labels, `*.` for subdomains only, optional port, IP literals only through `net:`.                                                                         |
| DC-3 | Mixed-script or confusable hosts always ask.                                                                                                                                                        |
| DC-4 | Workspace files can deny and ask; web allows come from the personal file or a managed file only.                                                                                                    |
| DC-5 | `trustedDomains` stays, as sugar for `allow: host:<d>` and `host:*.<d>`, read from the personal file, and subject to the WB11 deny list of user-content hosts.                                      |
| DC-6 | The existing `fetchUrl(<glob>)` form keeps working, but the Permissions page writes `host:` rules, and `continuous permissions` warns when a `fetchUrl` glob could be bypassed by case or a suffix. |
| DC-7 | RFC 6890 ranges from the IANA registry; local resolution behind a proxy.                                                                                                                            |

## 6. Reputation lists (DNSBL, RHSBL, "RDNSBL")

### 6.1 Mechanics

DNS-based lists are documented in RFC 5782 (Informational, IRTF, current). An IP list reverses the octets and appends the list's zone, so 192.0.2.99 on `bad.example.com` becomes `99.2.0.192.bad.example.com`. A listed entry has an A record conventionally `127.0.0.2` and optionally a TXT record giving the reason ([RFC 5782§2.1](https://www.rfc-editor.org/rfc/rfc5782.html#section-2.1)). Combined lists encode sublists as bit masks or multiple A records, all of them SHOULD be inside `127.0.0.0/8` (§2.3). Domain lists, "sometimes called RHSBLs", prepend the domain to the zone: `invalid.edu.doms.example.net` ([RFC 5782§3¶1](https://www.rfc-editor.org/rfc/rfc5782.html#section-3)). "There is no agreed convention for wildcards" (§3¶4). Heavy users "usually arrange for a private mirror" (§6¶1), and clients "MUST respect the TTL values" (§6¶5). Checking the domains of URLs found in messages is a documented use (§6¶8). What the owner called "RDNSBL" is this domain form.

The privacy cost is structural: a lookup sends the domain, in clear, to the resolver and to the list's name servers.

### 6.2 The lists

| List                    | Query                                                                                            | Privacy                                          | Terms for an open-source tool given to end users                                                                                                                   | Offline                      | Source (P)                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------- |
| Spamhaus DBL            | DNS: `<host>.dbl.spamhaus.org`, codes `127.0.1.2`-`.6`, `.102`-`.106`                            | domain to Spamhaus and the resolver              | "free of charge for low-volume, non-commercial users"; **queries through public resolvers return the error `127.255.255.254`**; a free DQS key exists              | paid                         | https://www.spamhaus.org/blocklists/domain-blocklist/         |
| SURBL                   | DNS                                                                                              | domain to SURBL                                  | Free Query Service under 1,000 users; "does not include embedding our data … into products or services for which a fee is charged"; products need an SDS agreement | paid rsync                   | https://www.surbl.org/usage-policy                            |
| Google Safe Browsing v5 | `hashes.search` sends a 4-byte hash prefix; `urls.search` sends the URL; hash lists downloadable | prefix mode leaks little; URL mode leaks the URL | "for non-commercial use only"; Web Risk for commercial; needs a Google API key                                                                                     | yes (hash lists, local mode) | https://developers.google.com/safe-browsing/reference         |
| URLhaus (abuse.ch)      | HTTP API or dumps (CSV, JSON, hostfile, RPZ), regenerated every 5 minutes                        | none for dumps                                   | needs an `Auth-Key` per user; fair use; terms §7.3 bar derivative works and AI training without consent                                                            | yes                          | https://urlhaus.abuse.ch/api/, https://abuse.ch/terms-of-use/ |
| PhishTank               | JSON dump `online-valid.json`                                                                    | none                                             | "New user registration temporarily disabled"; "a few downloads per day"; Cisco EULA                                                                                | yes                          | https://www.phishtank.com/developer_info.php                  |
| OpenPhish community     | plain-text feed on GitHub, updated every 12 hours                                                | none                                             | commercial use "Limited" (terms not read)                                                                                                                          | yes                          | https://openphish.com/phishing_feeds.html                     |

No list can be switched on for everyone. The DNS lists fail behind public resolvers and leak every domain, and their free terms exclude products. The good lists need a per-user key, and the fork cannot ship a shared one. Safe Browsing is non-commercial only. And most fetches in a coding agent go to documentation sites, where the hit rate of phishing and malware lists is low. The value is real but narrow: a model steered by injected text to a known-malicious host.

### 6.3 Decisions

| #    | Decision                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RP-1 | A `ReputationProvider` interface (`check(host, url) → {listed, list, reason}`), off by default, with nothing bundled and nothing downloaded until the person configures a provider.                                                                                                                                                                               |
| RP-2 | First providers: **local feed** (a file or a URL the person names, hostfile or plain list, refreshed on the person's schedule through the shared fetch; works with OpenPhish community, URLhaus with the person's own key, PhishTank dumps, or an organisation's own list), and **Safe Browsing v5 hash-prefix** with the person's own key (never `urls.search`). |
| RP-3 | A **custom RHSBL zone** provider for an organisation that runs its own mirror or holds a DQS key. The docs say plainly that each lookup sends the domain to that zone's servers.                                                                                                                                                                                  |
| RP-4 | A hit **asks** by default, showing the list and its reason; `web.reputation.onHit: refuse` makes it a refusal. A provider error never blocks (fail open, recorded), because a list outage must not stop documentation reads.                                                                                                                                      |
| RP-5 | Checked at every hop, cached by TTL (RFC 5782§6¶5) or for the feed's refresh period.                                                                                                                                                                                                                                                                              |
| RP-6 | The person accepts each provider's terms. The docs link each provider's terms and say which are non-commercial only. Shipping a default provider would need a licence and possibly spend, so it is **not proposed**.                                                                                                                                              |

## 7. Fetch behaviour

### 7.1 Redirects

Keep the limit of 5 hops. RFC 9110 sets no number: a client "SHOULD detect and intervene in cyclical redirections", and the note says an earlier version recommended five, which some clients still enforce ([RFC 9110§15.4¶7-8](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4-7)).

On each hop:

- Run the section 5.3 checks.
- Drop `Authorization`, `Cookie` and any per-host header on a host change. RFC 9110 says to consider removing headers "added by the calling context" where there are security implications, naming Authorization and Cookie ([RFC 9110§15.4¶6](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4-6)).
- Detect loops by URL set.

`@url` moves onto the guarded path (it uses node-fetch's `follow`, default 20 today). The `CONTINUE_USE_WEB_FETCH` path, with its limit of 10, gets the same guard or goes.

### 7.2 Limits and content

- **Keep** the 2 MiB post-decompression cap, the 20 s total deadline, the content-type allowlist and the sniffing.
  - The cap after decompression already defuses decompression bombs.
  - Keep the 10 s connect timeout.
- **Apply the same caps to the paths that have none:** the crawler, favicon, the search response, `@google` and the GitHub crawler (count and size).
- **Favicons** must be `image/*` (excluding `image/svg+xml`, which can carry script in some renderers). They are capped at 256 KiB with a 5 s deadline.
- **Charset:** keep the current decode by the header charset, then fall back to the `<meta charset>`, then UTF-8.
- **HTML to Markdown:** keep Readability, then node-html-markdown, with the visible-text fallback. It matches or beats what peers use:

  | Agent      | Converter               |
  | ---------- | ----------------------- |
  | Gemini CLI | html-to-text            |
  | Cline      | turndown                |
  | Aider      | pandoc                  |
  | OpenHands  | browser-use's extractor |

  If the server answers `text/markdown` (UA-9 asks for it), skip conversion. Add a link list at the end (WB9).

- **PDFs** are refused today as binary. Decision: a later row (WB35) adds text extraction with `pdfjs-dist` (Apache-2.0), capped by pages and bytes. Not before the panel, because PDFs are where people most want to see what the model got.
- **JS-rendered pages:** not in the built-in fetch (decided 2026-11-15). When the extracted text is under a threshold and the page has a `<noscript>` or an app root, the result says "this page needs JavaScript; open it in the Browser panel or a browser MCP server" instead of returning an empty shell.

### 7.3 Caching

- A 15-minute in-memory session cache keyed by final URL and `Accept`.
- Do not store responses with `Cache-Control: no-store`.
- After expiry, revalidate with `If-None-Match` / `If-Modified-Since`, as RFC 9111 describes for a cache that holds validators ([RFC 9111§4.3.1](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.3.1)). A 304 refreshes the entry without a body.
- Never cache 429 responses ([RFC 6585§4¶7](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)).
- Proxy-specific headers are never stored ([RFC 9111§3.1¶2](https://www.rfc-editor.org/rfc/rfc9111.html#section-3.1)).
- The Browser panel's re-fetch bypasses the cache.
- No disk cache: page bodies must not outlive the session on disk, since they may contain what the person read on an intranet.

### 7.4 Rate limiting and retries

- **Tool and `@url`:** 10 requests per host per minute (the figure Gemini CLI uses), counted per session. Over the limit, the model is told to wait or ask.
- **Crawler:**
  - Concurrency 2 per host instead of batches of 50.
  - At least 1 s between requests to a host, or `Crawl-delay` if larger.
- **429 and 503 with `Retry-After`** ([RFC 9110§10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3), [RFC 6585§4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)):
  - The crawler waits up to 60 s.
  - The tool waits up to 10 s once, then returns the status and the delay.
- **Retries:** one retry for a GET on a connect error or a 503 within the deadline, and none otherwise.

### 7.5 Cookies

Never sent and never stored by the agent's fetch, the crawler or the panel's fetch. node-fetch keeps no cookie jar. A test asserts that no `Cookie` header leaves even when a server sets one and redirects back.

### 7.6 Headers and credentials

- **Global `requestOptions.headers`** never reach a host that a model or a person chose.
  - That is already true for the tool (#636).
  - `@url` and the search backend still leak them; WB23 and WB3 close that.
- **Per-host headers:** `web.hosts[<pattern>].headers` sends a header (say, an intranet token) only to hosts matching the pattern.
  - Personal config only.
  - Stripped on a cross-host redirect.
  - The value is never shown to the model.
  - It is masked in the panel and the audit.
- **Credentials in URLs:** WB6 (decided: refuse) stands.
  - The scan also runs on every redirect `Location`, which is not scanned today.

### 7.7 Prompt injection and secrets in bodies

- **Spotlighting.** WB7 is decided: spotlight is on for fetch and search results. The default flip also needs:
  - a YAML-reachable setting (`web.spotlight`, since `experimental` is not in the YAML schema);
  - the CLI to pass `config` to the implementation;
  - `@url`, `@docs` and search results to be covered.
- **Secrets in fetched bodies.** Run the inbound secret profile over fetched bodies and mask any credential-shaped strings before the model sees them. A page that embeds a live-looking key is either a leak (don't propagate it) or bait.
- **Taint.** A fetch is already a `web-fetch` taint source. The provenance line (7.8) gives the model and the reviewer the facts they need without trusting the page.

### 7.8 Provenance

Each fetch returns, inside the spotlight markers and ahead of the content, one line (about 40 tokens):

```
[fetched https://final.example/path · 200 text/html · 48 KiB · 2026-11-15T10:04:12Z · sha256:3f2a…9c · robots: allowed · rule: host:*.example (personal) · cache: miss · via 1 redirect]
```

The full record goes to the session fetch log. It holds:

- the start URL and every hop;
- the response headers, with `Set-Cookie` dropped;
- the User-Agent sent;
- `Content-Usage`, if present;
- the model-visible text, or its hash plus a pointer into the session's in-memory store.

The Browser panel and `/web` show this record (section 9). Success statuses other than 200 (203, 206) are shown; today a non-2xx throws and a 2xx is silent.

### 7.9 Search (WB1, WB3, WB10)

Already decided:

- WB1: configured or hidden.
- WB3: refuse a query that contains a secret; ask when it contains a workspace path or code.
- WB10: provider-native search is opt-in per model.

This note adds:

- The search backend gets the same byte cap, deadline, UA (UA-3), sanitising and spotlight as a fetch.
- The search backend does not get the global headers.
- Its error messages carry the status and no body.
- Result URLs enter the seen-URL set as **model-origin**, not person-origin, so fetching a result checks robots (RB-4).

### 7.10 CLI and IDE parity, MCP

The CLI `Fetch` must reach the same verdicts as the IDE tool. Today two asks are lost at default levels (section 2.1) and spotlight is unreachable; WB26 fixes both and adds a parity test that runs the same URL corpus through both checkers.

An MCP fetch or browser server's calls are tool calls the permission engine sees by name, but its network traffic is outside our fetch pipeline, so host rules, robots and the fetch log do not apply to it. The Browser panel lists MCP browser calls with the label "outside the fork's fetch rules". The `fetch` MCP template (`decisions-2026-11-15.md:103`) should pin the reference server, whose own robots handling matches RB-4/RB-5.

## 8. Configuration surface

### 8.1 Proposed `web:` section

```yaml
# ~/.continue/config.yaml (personal). Keys marked [P] are read from the personal file only;
# a workspace config.yaml may set only the keys marked [T] (tighten-only).
web:
  userAgent: default # [P] "default" | "" (send none) | any string
  acceptLanguage: "" # [P] none by default
  requireHttps: false # [T] true refuses plain http
  robots: ask # [P] for loosening to "ignore"; [T] for "respect"   ask | respect | ignore
  spotlight: true # [P] to turn off; replaces experimental.spotlightUntrusted
  limits:
    maxBytes: 2097152 # [T] lower only from a workspace; ceiling 64 MiB
    timeoutSeconds: 20 # [T] lower only; ceiling 300
    maxRedirects: 5 # [T] lower only; ceiling 10
    perHostPerMinute: 10 # [T]
    modelChars: 20000 # characters returned to the model per call
  cache:
    minutes: 15 # 0 disables
  hosts: # [P] per-host overrides; patterns use the host: rule syntax
    "*.intranet.example":
      headers: { Authorization: "${{ secrets.INTRANET_TOKEN }}" }
      userAgent: "Mozilla/5.0 (compatible; Continuous-User/2.15)"
  reputation: # [P] off unless a provider is listed
    onHit: ask # ask | refuse  ([T] may set refuse)
    providers:
      - type: feed
        url: https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt
        refreshHours: 12
      - type: safeBrowsing
        apiKey: ${{ secrets.SAFE_BROWSING_KEY }}
      - type: rhsbl
        zone: dbl.example-mirror.internal
  crawler:
    contact: "" # [P] sent as From: only when set
    concurrencyPerHost: 2
    minDelayMs: 1000
  search: # WB1's provider block lives here
    provider: searxng
    url: http://127.0.0.1:8888
docs:
  - name: My site
    startUrl: https://docs.example.com
    robots: respect # [P] for "ignore"
    useLlmsTxt: false
    maxDepth: 4 # added to the YAML schema
```

Domain allow and deny rules do not live under `web:`; they stay in `permissions.yaml` as `host:`/`net:` rules, so there is one place for permissions:

```yaml
# ~/.continue/permissions.yaml
allow:
  - host:*.python.org
  - host:docs.rs
deny:
  - host:*.pastebin.com
  - net:private # already a built-in protection for the web; explicit here for terminal parity
ask:
  - host:*.github.io
```

### 8.2 Migration

- `toolPermissions.auto.environment.fetchMaxBytes` and `fetchTimeoutSeconds` are read as aliases for `web.limits.*` for two releases. A deprecation line goes in `continuous doctor config`.
- `experimental.spotlightUntrusted` and `CONTINUOUS_SPOTLIGHT_UNTRUSTED` map to `web.spotlight`.
- `CONTINUOUS_WEB_SEARCH_URL` and `CONTINUOUS_WEB_SEARCH_KEY` map to `web.search`. WB1 owns that change.
- `CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH` maps to `web.limits.modelChars`.
- `trustedDomains` stays (DC-5).

### 8.3 Settings and Permissions pages

**A Web page in Settings**, beside Providers (`gui/src/pages/config/configTabs.tsx`), has five sections:

1. **Identity**
   - Shows the exact User-Agent that will be sent, per purpose.
   - A text box for the override.
   - A line on the privacy trade-off.
2. **robots.txt**
   - A three-way control for `respect`, `ask` and `ignore`, each with a one-line explanation.
3. **Limits and cache**
4. **Reputation**
   - Off by default.
   - Adding a provider shows its terms link and what each lookup discloses.
5. **Search**
   - WB1's provider block and WB4's test button.

Every control writes to the personal config.yaml. A workspace override that tightens a value is shown as such and is locked.

**The Permissions page** lists `host:`/`net:` rules in the same table as the other rules:

- Each rule shows its source: personal, workspace or managed.
- "Test a URL" runs `checkWebDestination` and shows each step's verdict: scheme, secret, deny, private, reputation, allow, robots.
- B62 (pass `trustedDomains` on the GUI test path) folds into this.

## 9. The Browser panel

The owner's addition: "this may fit well into a 'browser' window feature".

### 9.1 What exists elsewhere

- **VS Code** (P https://code.visualstudio.com/docs/agents/run/browser-tools, read 2026-11-15)
  - An integrated browser has succeeded the Simple Browser (opt-in via `simpleBrowser.useIntegratedBrowser`).
  - Built-in agent tools: `openBrowserPage`, `navigatePage`, `readPage`, `screenshotPage`, `clickElement`, `typeInPage`, `runPlaywrightCode` and others, under `workbench.browser.enableChatTools`.
  - Pages the agent opens use "A private, in-memory session that doesn't share cookies or storage with your other browser tabs".
  - Tabs the person shares carry their cookies and sign-in, after a confirmation. In untrusted workspaces storage is always ephemeral.
  - Network filtering is configured by administrators. The page names no setting; trade press names `chat.agent.networkFilter`, `chat.agent.allowedNetworkDomains` and `chat.agent.deniedNetworkDomains` (S, Visual Studio Magazine, 2026).
  - These tools are Copilot's and not exposed to other extensions as an API, as far as the docs say.
- **Cursor** (P https://cursor.com/docs/agent/tools/browser): a browser pane inside the editor, driven by the agent through MCP tools, with origins added one at a time.
- **Cline** (P https://docs.cline.bot/tools-reference/browser-automation.md): `browser_action` drives puppeteer at 900x600 and returns a screenshot after each action. A remote mode attaches to the person's Chrome on port 9222, with that profile's cookies.
- **Playwright MCP** (P https://playwright.dev/mcp/configuration/options)
  - `--isolated` keeps an in-memory profile.
  - `--allowed-origins` and `--blocked-origins` are documented as "not a security boundary" and do not cover redirects.
  - `--user-data-dir` persists a profile.
- **Claude Code**
  - `WebFetch` has no viewer.
  - A Chrome extension integration drives the person's real Chrome, with its sign-ins. Not read in primary docs for this note.
- **OpenHands**: a `browser_use`-based Chromium tool.

The field splits cleanly in two:

- **A viewer of what the agent fetched.** Nobody does this well; Claude Code and Gemini CLI show only the tool call.
- **A browser the agent drives.** VS Code, Cursor, Cline, Playwright MCP and OpenHands do this, with cookies either isolated or deliberately shared.

The first is cheap, fits the fork's audit-first stance, and is missing everywhere. The second is large and is the subject of a standing owner decision.

### 9.2 Design: the panel

The panel is a route in the shared GUI (`gui/src/pages/web/`), not a VS Code `WebviewPanel`, so JetBrains (JCEF) gets it unchanged. It opens from:

- a link on every fetch tool call in the chat;
- the `Continuous: Show Web Activity` command;
- the Settings Web page.

**Left: the session's fetch log**, newest first. Each row shows:

- purpose icon (tool, `@url`, search, crawler, panel, MCP-browser);
- host, status, size and time;
- a badge for asked, refused, robots or reputation.

**Right: the selected fetch**, in three tabs:

1. **What the model saw.** The exact text sent, including the spotlight markers and the provenance line, rendered as Markdown. This answers "see what the model was actually sent".
2. **Page.** The converted page rendered as Markdown with links shown as text, and the response headers (with `Set-Cookie` removed and per-host headers masked).
   - The remote HTML is **not** rendered in our webview. The webview's CSP allows `frame-src` only for its own source, data, blob and about (`webviewCsp.ts`). Loosening that would let any fetched page run script next to the chat, which holds the session and the permission controls.
3. **Decisions.** One line per step:
   - final URL and every hop;
   - User-Agent sent;
   - robots verdict and the matching rule line;
   - reputation verdict;
   - the permission rule that decided, and its file;
   - SHA-256 and fetched-at;
   - a link to the audit line.

**Actions:**

- **Allow domain**: Once (session) or Always. Always writes `host:<host>` to the personal `permissions.yaml` through the existing permissions editor (`extensions/cli/src/commands/permissionsEdit.ts` logic, shared through core).
- **Block domain**: Once or Always, writing a deny the same way.
  - For both Allow and Block, a choice between the exact host and `*.<registrable domain>`, using the Public Suffix List the fork already ships in `core/util/publicTlds.ts` (extend it to the full list if needed).
  - User-content hosts on the WB11 list offer the exact host only.
- **Re-fetch**: bypasses the cache and records a new entry.
- **Open in browser**: `vscode.env.openExternal` through the existing http/https/mailto guard (`webviewMessageGuard.ts:24-39`). JetBrains uses `BrowserUtil.browse`.
- **Open in VS Code's browser**: the built-in `simpleBrowser.show` command (confirm the command id against the VS Code version at build time).
- **Copy URL**, and **Copy as context**, which adds the stored text as a context item without fetching again.

**Retention:**

- The log lives in memory for the session.
- Metadata is persisted with the session history, so a reopened session shows what was fetched. Bodies are not persisted (7.3).
- The audit line is the durable record.

### 9.3 Design: person-directed browsing

The panel has an address bar.

**Pasting or typing a URL:**

- Runs the same pipeline with purpose `panel` and origin `person`, so robots is skipped (RB-5). Host rules, private-address protection and reputation still apply.
- Shows the result in the three tabs.
- **Add to chat** attaches it as a context item, exactly as `@url` would, with provenance.
- Following a link in the rendered Markdown fetches it the same way. Each click is a person-directed fetch.

**Cookies and sign-ins:** never, by default and with no setting to turn them on in this row.

- The panel's fetch runs in core, not in a browser, and has no cookie jar.
- The webview cannot read VS Code's Simple Browser or integrated browser: those are VS Code-owned webviews isolated from extensions.
- A page that needs a sign-in either works through a per-host header (7.6), or the person opens it in their browser and pastes the text.
- Using the person's own signed-in browser profile would hand the model, and any injected text it reads, the person's sessions on every site. That is the shared-tab mode VS Code gates behind a per-tab confirmation, and it belongs with 9.4 if anywhere.

**How this differs from the agent's fetch tool:**

| Aspect     | Agent's fetch tool                      | Panel fetch                                       |
| ---------- | --------------------------------------- | ------------------------------------------------- |
| Initiator  | model                                   | person                                            |
| robots     | checked                                 | skipped                                           |
| Permission | goes through the tool permission engine | no ask, because the person's click is the consent |
| Rate limit | counted                                 | counted                                           |
| Log        | recorded                                | recorded                                          |

Host deny rules, private-address protection and reputation apply to both.

### 9.4 Design: a JS-capable browser (kept for the owner)

The 2026-11-15 decision excludes JS rendering and a bundled headless browser. The docs crawler's on-demand Chromium download (`chromiumDownload.ts`) already sits at the edge of that decision. If the owner reopens it, this is the design:

**Options:**

| Option                                                      | Size and egress                                                                                                                       | Licence                                       | Fit                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| None (today), plus an MCP browser server the person adds    | none from us                                                                                                                          | n/a                                           | Works now. Our rules do not reach the server's network traffic.                   |
| The person's installed Chrome or Edge via `playwright-core` | `playwright-core` is about 14 MB and already pinned in `bench/screenshots` (`bench/screenshots/package.json:13`); no browser download | Apache-2.0 (`docs/third-party-notices.md:22`) | Best: no new egress, no download; Chrome or Edge is present on most machines.     |
| Playwright's Chromium download                              | about 100+ MB from Playwright's CDN, a new egress host                                                                                | Apache-2.0 / BSD                              | Adds egress; needs PV12 consent.                                                  |
| VS Code's integrated browser                                | none                                                                                                                                  | n/a                                           | Not available to extensions as an API; JetBrains and CLI have nothing equivalent. |

**Security, if built:**

- A fresh, in-memory profile for every session (`launchPersistentContext` never; `newContext` with no storage state).
- **Every request**, not just navigations, goes through `route()` interception, which calls `checkWebDestination`. Subresources, XHR, WebSocket and service workers are all covered, and service workers are blocked outright.
  - This is the only way the host rules and the private-address protection hold inside a browser.
  - It does not fully stop DNS rebinding, because Chromium resolves names itself. The browser must therefore run behind the fork's egress proxy (`core/util/egressProxy.ts`, built but unwired: `plans/jail-network.md:3`), which resolves and pins names.
- Downloads are refused (`acceptDownloads: false`).
- Permissions (camera, geolocation, notifications) are denied.
- Popups are closed.
- Navigation has a 15 s timeout and a 20-navigation cap per task.
- Same UA policy as UA-1, with `Continuous-User` appended to the browser's own token rather than replacing it (Aider's approach), so the site still sees an agent.
- **Screenshots** are shown to the person in the panel. They go to the model only for a vision model and only when the person enables it, because images carry injected text the spotlight cannot mark.
- JavaScript runs in the browser's own sandbox, so the panel never renders the live page in our webview; it shows screenshots and the extracted text.

**Recommendation to the owner:** keep the decision for the built-in fetch. If a JS route is wanted, build it as an opt-in tool on the person's installed browser behind the egress proxy (WB34), after the panel exists to show what it did. Until then, document Playwright MCP with `--isolated` as the supported route, and say plainly that its origin lists are not a boundary.

### 9.5 History and audit

Covered by the fetch log (9.2) and the audit line (5.5). The session history keeps the metadata, so "what did the agent read yesterday" is answerable from the panel for any saved session.

### 9.6 CLI and JetBrains parity

- **JetBrains** gets the panel unchanged because it is a GUI route. Open in browser uses `BrowserUtil`, and there is no Simple Browser equivalent, so that action is hidden.
- **CLI** gets a `/web` slash command (`extensions/cli/src/slashCommands.ts`):
  - `/web` lists the session's fetches (index, purpose, status, host, size, verdict badges).
  - `/web show <n>` prints the decisions block and the model-visible text through the pager.
  - `/web raw <n>` prints the converted page.
  - `/web allow <host> [--always]` and `/web block <host> [--always]` write the same rules.
  - `/web refetch <n>`.
  - `/web open <n>` opens the system browser, if one is available.
  - `continuous web log --session <id>` reads the same data from saved sessions, for headless and CI runs.

## 10. Build plan

### 10.1 New rows (Track WB)

Sizes follow the ROADMAP: XS under half a day, S under 2 days, M three to five days, L more. "Group" is the parallel group: rows in the same group do not depend on each other and can run at the same time; a group starts when the rows it depends on have merged.

| Row  | Scope                                                                                                                                                                                                                                                                                                                                           | Size | Needs                                  | Group | Files touched                                                                                                                                                                                                                                                                                                             | Tests                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WB17 | One User-Agent policy (UA-1 to UA-9): `webHeaders(purpose)` in `packages/fetch`; applied to the fetch tool, `@url`, crawlers (Cheerio and Chromium `--user-agent`), favicon, search backend; delete the dead CLI `getUserAgent`/`_mergeUserAgentIntoRequestOptions` and its `x-continue-unique-id`; `web.userAgent` and per-host override       | S    | WB27, owner (UA-10)                    | 2     | `packages/fetch/src/webHeaders.ts` (new), `core/util/modelToolFetch.ts`, `core/util/networkFetch.ts`, `core/context/providers/URLContextProvider.ts`, `webSearchBackend.ts`, `core/indexing/docs/crawlers/{CheerioCrawler,ChromiumCrawler}.ts`, `core/util/fetchFavicon.ts`, `extensions/cli/src/config.ts`, `PRIVACY.md` | per-path header capture against a local server: UA present, no OS/IDE/patch/id, no `From`, no `Referer`, no `Accept-Language`; override and empty-string cases; egress allowlist test unchanged |
| WB18 | `robots.txt` parser and matcher (RFC 9309): groups, case-insensitive token, longest match, allow-on-tie, `*`/`$`, percent-encoding rules, 512 KiB limit, `Crawl-delay` and `Content-Usage` read; a per-authority cache (24 h, 4xx allow, 5xx/unreachable disallow-for-crawler, 5-redirect fetch)                                                | M    | none                                   | 1     | `core/util/robots/{parse,match,cache}.ts` (new)                                                                                                                                                                                                                                                                           | RFC examples and Google's open-source robots test corpus as fixtures (licence check: Apache-2.0); fuzz the parser; cache expiry and status-class cases                                          |
| WB19 | Crawler politeness: robots (RB-1, RB-2) for Cheerio and Chromium, concurrency 2 per host, 1 s floor or `Crawl-delay`, `Retry-After`, body cap and deadline on Cheerio, Chromium navigation timeout, GitHub crawler file count and size caps, `docs[].maxDepth` and `docs[].robots` in the YAML schema, `From` when `web.crawler.contact` is set | M    | WB17, WB18                             | 3     | `core/indexing/docs/crawlers/*.ts`, `core/indexing/docs/DocsService.ts`, `packages/config-yaml/src/schemas/index.ts`                                                                                                                                                                                                      | crawl a local fixture site with a disallow, a 503 robots, a `Crawl-delay`; assert request timing and count; a 1 GB page stops at the cap                                                        |
| WB20 | Robots for the model's fetch tool (RB-4 to RB-8): check under `Continuous-User` when the URL is model-origin; disallow asks (refuse headless), unreachable proceeds and is labelled; person-origin skips                                                                                                                                        | S    | WB17, WB18, WB6                        | 3     | `core/tools/definitions/fetchUrlContent.ts`, `core/tools/permissions/{askProtections,protected}.ts`, `core/context/providers/URLContextProvider.ts`, CLI `fetch.ts`                                                                                                                                                       | disallowed path asks in IDE and CLI and refuses headless; user-message URL skips; refusal text to the model is exact                                                                            |
| WB21 | Web destination rules (DC-1 to DC-6): `checkWebDestination` in core; `host:`/`net:` for every web path, A-label normalisation, label-boundary wildcards, ports, mixed-script and confusable ask, checked at every redirect hop (closes WB16's unbuilt ask), workspace tighten-only, `fetchUrl` glob warning                                     | M    | WB27                                   | 2     | `core/util/webDestination.ts` (new), `core/util/hostName.ts` (new), `core/util/guardedFetch.ts`, `core/tools/permissions/{rules,destinations,askProtections,evaluate}.ts`, `extensions/cli/src/permissions/*`                                                                                                             | corpus of hosts: case, trailing dot, IDN, mixed-script, `evil-example.com` vs `*.example.com`, IP literals and mapped forms, redirect to a denied host; parity IDE/CLI                          |
| WB22 | RFC 6890 special-purpose ranges generated from the IANA registry; local resolution check behind a proxy (DC-7); scan every redirect `Location` for secrets                                                                                                                                                                                      | S    | none                                   | 1     | `core/util/networkAddress.ts`, `core/util/specialPurpose.generated.ts` (new), `core/util/guardedFetch.ts`, `packages/fetch/src/fetch.ts`                                                                                                                                                                                  | every registry block classified; proxy case asks for a private local answer; redirect to `?token=sk-…` refused                                                                                  |
| WB23 | `@url`, favicon and search parity: `@url` on `fetchWithGuardedRedirects` with scoped headers; favicon `image/*` only (no SVG), 256 KiB, 5 s; search response byte cap, deadline, no global headers, no body in errors; `@google` capped                                                                                                         | S    | none                                   | 1     | `core/context/providers/{URLContextProvider,webSearchBackend,GoogleContextProvider}.ts`, `core/util/fetchFavicon.ts`                                                                                                                                                                                                      | `@url` to a redirect to 169.254.169.254 refused; gateway header not sent to a named site; SVG favicon refused                                                                                   |
| WB24 | Fetch record and provenance (7.8): one record per request, the provenance line inside the spotlight markers, non-200 success statuses shown, the session fetch log in core with a messenger API, metadata saved with session history, the audit line (5.5)                                                                                      | M    | none                                   | 1     | `core/util/fetchRecord.ts` (new), `core/tools/implementations/fetchUrlContent.ts`, `core/context/providers/URLContextProvider.ts`, `core/protocol/*` (log API), session history writer, audit writer                                                                                                                      | record fields for a 3-hop fetch; provenance line token count under 60; log survives a session reload without bodies; audit line masks the query                                                 |
| WB25 | Session cache with ETag/Last-Modified revalidation, `no-store` honoured, 429 never cached; per-host rate limit (tool 10/min); `Retry-After` handling and one retry (7.3, 7.4). Takes over WB9's cache item                                                                                                                                      | M    | WB24                                   | 2     | `core/util/fetchCache.ts` (new), `core/util/hostRateLimit.ts` (new), `core/context/providers/URLContextProvider.ts`                                                                                                                                                                                                       | 304 path returns cached text with `cache: revalidated`; `no-store` refetches; 11th request in a minute is refused with a wait; 503 + `Retry-After: 2` retried once                              |
| WB26 | CLI parity fixes: keep `preprocessArgs`' `nonPublic`, keep the "long encoded value" ask at default levels, pass `config` so spotlight is read; an IDE/CLI parity test over a URL corpus                                                                                                                                                         | S    | none                                   | 1     | `extensions/cli/src/tools/fetch.ts`, `extensions/cli/src/permissions/{permissionChecker,coreRules}.ts`                                                                                                                                                                                                                    | `http://wiki/` asks in CLI; a 64-char high-entropy query asks; spotlight markers present with `web.spotlight: true`; parity corpus identical verdicts                                           |
| WB27 | The `web:` config section (8.1) in `packages/config-yaml`, personal-only and tighten-only reading, aliases for the old keys and environment variables, `continuous doctor config` deprecation lines; `web.spotlight` made YAML-reachable and on by default (WB7 flip)                                                                           | M    | none                                   | 1     | `packages/config-yaml/src/schemas/web.ts` (new), `schemas/index.ts`, `core/config/yaml/loadYaml.ts`, `core/util/userFetchLimits.ts`, `core/tools/permissions/spotlight.ts`, `extensions/cli/src/commands/doctorConfig.ts`                                                                                                 | schema round-trip; a workspace file cannot raise a limit or set `robots: ignore`; aliases read; spotlight default on                                                                            |
| WB28 | Settings Web page and Permissions page host rules with "Test a URL" (8.3); folds in B62                                                                                                                                                                                                                                                         | M    | WB27, WB21                             | 3     | `gui/src/pages/config/sections/WebSection.tsx` (new), `configTabs.tsx`, `gui/src/pages/config/sections/permissions/*`, `core/protocol/*`                                                                                                                                                                                  | GUI tests: UA preview matches WB17 output; locked workspace override; Test a URL shows every step                                                                                               |
| WB29 | Reputation providers (RP-1 to RP-6): feed, Safe Browsing v5 hash-prefix, custom RHSBL zone; ask on hit, fail open, per-hop, TTL cache                                                                                                                                                                                                           | M    | WB21, WB27                             | 4     | `core/util/reputation/*.ts` (new), `core/util/webDestination.ts`, docs page                                                                                                                                                                                                                                               | fixture feed hit asks; provider timeout does not block; RHSBL against a local DNS stub honours TTL; no lookup happens with no provider configured (egress test)                                 |
| WB30 | AIPREF and llms.txt (RB-9): show `Content-Usage` in the record; `docs[].useLlmsTxt` seeds the crawl                                                                                                                                                                                                                                             | S    | WB24, WB19                             | 4     | `core/util/fetchRecord.ts`, `core/indexing/docs/crawlers/DocsCrawler.ts`                                                                                                                                                                                                                                                  | header and robots-rule forms parsed; llms.txt links crawled first and same-host only                                                                                                            |
| WB31 | Browser panel (9.2): GUI route, fetch log list, three tabs, allow/block once/always writing `permissions.yaml`, re-fetch, open externally, open in VS Code's browser, copy as context; JetBrains via the same route                                                                                                                             | M    | WB24, WB21                             | 3     | `gui/src/pages/web/*` (new), `core/protocol/*`, `extensions/vscode/src/extension/VsCodeMessenger.ts`, `extensions/intellij/.../IdeProtocolClient.kt`, shared permissions editor in core                                                                                                                                   | GUI tests on a recorded log; Always-allow writes the expected rule to a temp `permissions.yaml`; webview CSP unchanged (assert `frame-src`)                                                     |
| WB32 | Person-directed browsing (9.3): address bar, link following, Add to chat, no cookies                                                                                                                                                                                                                                                            | S    | WB31                                   | 4     | `gui/src/pages/web/*`, `core/context/providers/URLContextProvider.ts`                                                                                                                                                                                                                                                     | a pasted URL skips robots and records origin `person`; Add to chat produces the same item as `@url`; no `Cookie` header across a set-cookie redirect                                            |
| WB33 | CLI `/web` and `continuous web log` (9.6)                                                                                                                                                                                                                                                                                                       | S    | WB24, WB21                             | 3     | `extensions/cli/src/slashCommands.ts`, `extensions/cli/src/commands/web.ts` (new)                                                                                                                                                                                                                                         | snapshot of `/web` and `/web show`; `allow --always` writes the rule                                                                                                                            |
| WB34 | JS-capable browser on the person's installed Chrome or Edge via `playwright-core`, in-memory profile, `route()` interception through `checkWebDestination`, behind the egress proxy, no downloads, screenshots to the person (9.4)                                                                                                              | L    | owner, WB21, WB31, W6 wiring           | 5     | `core/browser/*` (new), `core/util/egressProxy.ts` wiring, `gui/src/pages/web/*`                                                                                                                                                                                                                                          | subresource to a private address blocked; rebinding fixture blocked behind the proxy; download refused; navigation cap                                                                          |
| WB35 | PDF text extraction (`pdfjs-dist`, page and byte caps), shown in the panel                                                                                                                                                                                                                                                                      | M    | WB24                                   | 4     | `core/util/fetchedPdf.ts` (new), `core/util/fetchedText.ts`, `third-party-notices.md`                                                                                                                                                                                                                                     | a 500-page PDF stops at the cap; an encrypted PDF returns a clear refusal                                                                                                                       |
| WB36 | Docs: `docs/customize/web.mdx` (UA, robots modes, host rules, limits, reputation terms, Browser panel); `docs/web-agent.md` (the info page UA-10 links to); fix `PRIVACY.md:66`; correct ROADMAP WB13 and WB16 state                                                                                                                            | XS   | none (UA-10 for the info page wording) | 1     | `docs/customize/web.mdx`, `docs/web-agent.md`, `PRIVACY.md`                                                                                                                                                                                                                                                               | docs lint                                                                                                                                                                                       |

Parallel groups at a glance:

| Group | Rows                                     | Starts when                                                                    |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| 1     | WB18, WB22, WB23, WB24, WB26, WB27, WB36 | now (no dependencies)                                                          |
| 2     | WB17, WB21, WB25                         | WB27 (WB17 also the owner's UA-10 answer; WB25 needs WB24)                     |
| 3     | WB19, WB20, WB28, WB31, WB33             | WB17 + WB18 (WB19, WB20, which also needs WB6); WB21 + WB24 (WB28, WB31, WB33) |
| 4     | WB29, WB30, WB32, WB35                   | WB21/WB27 (WB29); WB19 + WB24 (WB30); WB31 (WB32); WB24 (WB35)                 |
| 5     | WB34                                     | owner decision, WB31, and the egress proxy wired (W6)                          |

Group 1 rows touch disjoint files except WB23 and WB24, which both touch `URLContextProvider.ts`. Merge WB23 first, or give one agent both.

### 10.2 Amendments to existing rows (proposed, not applied)

| Row      | Amendment                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| WB7      | The default flip is delivered by WB27 (`web.spotlight`, YAML-reachable); coverage of `@url`, `@docs` and search stays in WB7.               |
| WB8      | Remaining items move: robots to WB18/WB19, RFC 6890 ranges to WB22. WB8 becomes "Built".                                                    |
| WB9      | The cache item moves to WB25; paging and the link list stay.                                                                                |
| WB13     | State corrected to "Built in part (#735): spotlight setting not read", with the fix in WB26.                                                |
| WB16     | State corrected to "Built in part (#735): final URL label; the ask on an unseen host is not built", with the fix in WB21.                   |
| WB3      | Adds: the search backend gets the UA (WB17), byte cap and no global headers (WB23).                                                         |
| B56/WB11 | Unchanged, but implemented on top of `checkWebDestination` (WB21) so the trusted-host allow uses the same normalisation and per-hop checks. |
| PV12     | The Chromium download moves onto the shared fetch with proxy and CA (small change, can ride with WB19).                                     |

## 11. Kept for the owner

1. **UA-10: the public identity.** The product tokens (`Continuous-User`, `Continuous-Crawler`) and the info URL that every fetched site will see and log. Proposal: those tokens, and `docs/web-agent.md` in this repository as the page. WB17 can merge with a placeholder URL only if the owner prefers that; otherwise it waits.
2. **WB34: a JS-capable browser.** It reverses "No JavaScript rendering … no bundled headless browser" (`plans/decisions-2026-11-15.md:116`). The design here uses the person's installed browser and no download, but it is still a new capability with a large attack surface, and it should not start without the owner reopening that decision.
3. **Nothing else.** Each other question in sections 3 to 9 is decided above. RP-6 (no default reputation provider) avoids the only spend-shaped question.

## 12. Sources

RFCs, cited via the `primarysource` RFC tools (status checked 2026-11-15):

- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html), HTTP Semantics, Internet Standard, current (§4.2.4, §10.1.2, §10.1.3, §10.1.5, §10.2.3, §15.4; verified erratum 7109 on §15.4.9 concerns 308 method preservation and does not affect this note).
- [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html), HTTP Caching, Internet Standard, current (§3.1, §4.3.1).
- [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html), Robots Exclusion Protocol, Proposed Standard, current, no verified errata (§1, §2.2.1, §2.2.2, §2.3, §2.4, §2.5, §3).
- [RFC 5782](https://www.rfc-editor.org/rfc/rfc5782.html), DNS Blacklists and Whitelists, Informational (IRTF), current (§2.1, §2.3, §3, §6).
- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html), Additional HTTP Status Codes, Proposed Standard (§4, 429).
- [RFC 6890](https://www.rfc-editor.org/rfc/rfc6890.html) (BCP 153), Special-Purpose IP Address Registries, updated by [RFC 8190](https://www.rfc-editor.org/rfc/rfc8190.html) (§2.1).
- [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761.html), Special-Use Domain Names (§6.3).
- [RFC 5890](https://www.rfc-editor.org/rfc/rfc5890.html) (§4.4) and [RFC 5891](https://www.rfc-editor.org/rfc/rfc5891.html), IDNA, Proposed Standard, current.
- [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html), HTTP Message Signatures, Proposed Standard, current.

IETF drafts (datatracker, read 2026-11-15): `draft-ietf-aipref-vocab-08`, `draft-ietf-aipref-attach-05` (https://datatracker.ietf.org/wg/aipref/documents/); `draft-ietf-webbotauth-httpsig-protocol-01`, `draft-rescorla-anonymous-webbotauth-01` (https://datatracker.ietf.org/wg/webbotauth/documents/); `draft-car-ai-txt-wellknown-00`.

Vendor and project pages are cited inline by URL in sections 3.2, 4.2, 4.3, 6.2 and 9.1.
