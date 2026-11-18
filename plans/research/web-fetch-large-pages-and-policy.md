# Web fetch: large pages, agent feedback and a Web policy area (2026-11-15)

Status: research and design only, written against `main` at `c03ece909` (merge of #898). No code was changed, nothing was built or measured. Vendor pages were read live on 2026-11-15; each is cited by URL and marked P (primary: vendor documentation, specification, source code) or S (secondary). Protocol claims were checked with the `primarysource` RFC tools and are cited by paragraph. Where a statement about our code is inferred rather than read, it says so.

This note extends `plans/research/web-fetch-deep-dive.md` (#898), which proposed rows WB17 to WB36 and is the baseline. Agents are building WB18 (robots parser), WB22 to WB24 (fetch guard, `@url` parity, fetch record and provenance) and WB27 (the `web:` config section, with `web.enabled` and a placeholder `web.policy`). The rows proposed here start at WB37.

The owner's ask, 2026-11-15:

> I think we should offer both: an isolated sandboxed (no cookie persistence) basic web fetch that has advanced features around detecting pages that are too long to fit in the response. Research what the best practice is and how other providers or gateways handle fetching web content. There are always issues to avoid as soon as we involve persistence or caching, but it's wasteful to request the same pages again just because the response wouldn't fit. Agents often stupidly retry fetching content that is too big when it returns an error, thinking it's a temporary page load error or network issue, so we should strive to provide better feedback to the agent about the conditions and what options it has — maybe, if the user has enabled MCP Playwright capabilities, as an alternative, or perhaps a 'would you like to enable Playwright'. But I think there is reason not to enable it by default, and to have a control to disable web fetch entirely. Think about how we can fit this into our familiar policy control knobs and levels.

Also decided by the owner: the default User-Agent is `Continuous-User/<ver>`, with presets (Continuous, a generic agent, common browsers from one checked-in data file, and custom).

## 1. Summary

Today a long page is cut at 20,000 characters (`core/tools/implementations/fetchUrlContent.ts:8`). The model is then told to "consider fetching specific sections or using a more targeted approach" (`fetchUrlContent.ts:37`), but no tool can do that. The only thing it can try is the same fetch again, which returns the same first 20,000 characters. Every failure reaches the model as a bare thrown message (`HTTP 404 Not Found`, `Too many redirects fetching …`, a deadline error). None of them says whether a retry could help. Both behaviours produce the loop the owner describes.

The field has converged on three answers to "the page does not fit":

- a **budget plus an offset** to read on (MCP `fetch`, Claude Code `WebFetch`);
- **query-filtered extraction** (Tavily `query` and `chunks_per_source`, Exa `highlights`, OpenAI `find_in_page`, Anthropic's code-based dynamic filtering);
- **summarising against a prompt** (Claude Code `WebFetch`, Exa `summary`).

Gateways also return **typed per-URL statuses** inside a successful response (Anthropic error codes, Gemini `urlRetrievalStatus`, Exa `statuses[]`, Tavily `failed_results`), and the model acts on these.

The decisions that shape the build:

1. **A page that does not fit is not an error.** The result holds:
   - the first window, measured in the active model's tokens;
   - an outline of headings with line numbers and sizes;
   - the total size;
   - a content id (`web-3`).

   The page goes into a per-session store, so reading more never fetches it again (section 4).

2. **A new tool, `read_web_content`, modelled on `read_command_output` (#887).** It reads a stored page by `section`, `page`, `offset` or `grep` (matching lines with their numbers). `fetch_url_content` gains `grep` and `refresh` (section 9).
3. **The store is a history buffer, not a cache.** It lives in memory only and is scoped to one session, with a size cap. It is deleted with the session and never shared across sessions. It is keyed by final URL and content hash, and it re-applies the host rules on every read. `Cache-Control: no-store`, a non-public host and a credentialed response keep a page only for the current turn. RFC 9111 §6 says a history mechanism is outside caching rules and may honour `no-store`; we choose to honour it (section 5).
4. **Every outcome is typed and says whether a retry can help.** There are 26 outcome codes, each with exact wording in the house refusal style. "Do not retry unchanged" appears wherever it is true (section 6).
5. **A per-session repeat guard.** The second identical fetch is answered from the record without contacting the site. The third is refused and counts toward the existing refusal cap (3 in a row ends the turn, `core/util/turnEnd.ts:35`).
6. **JavaScript pages are detected, not rendered.** When a Playwright MCP server is configured and its tools are offered, the result names the exact tool to call. When none is configured, the result says so and the IDE shows a one-time card, "Enable a browser for JavaScript pages?". The card leads to the MCP add flow with the Playwright template pinned and `--isolated`. It is never on by default (section 7).
7. **Isolation:**
   - Each fetch has its own in-memory cookie jar. A cookie is returned only to the exact host that set it, only within that one fetch's redirect chain, and is gone when the fetch ends.
   - No `Authorization` header is sent, and no person's cookies are ever used.
   - The only exception is a per-host header the person writes in their own config. It marks the page as credentialed (section 3).
8. **A Web policy area, the sixth.** Its levels are:
   - **Off**: no web tools are offered.
   - **Manual**: ask every fetch.
   - **Cautious**: ask for new domains.
   - **Listed**: allowed domains only, with no asks.
   - **Automatic**: a reviewer decides new domains.
   - **Permissive**: runs within the rules.
   - **IDGAF**.

   When it is not set, it follows Tool use, so no saved setting changes meaning. Each preset sets it. A workspace can only tighten it, through `web.enabled: false` or deny rules. Headless runs refuse what would ask. The Browser panel's Allow and Block buttons write the same rules and session grants (section 8).

9. **IDGAF on Web never asks, but hard safety still binds**, because it lives inside the fetch, not in the permission layer:
   - scheme and userinfo refusals;
   - the WB6 credential-in-URL refusal;
   - public-to-private redirect refusal;
   - cloud metadata addresses;
   - byte cap and deadline;
   - cookie isolation.

   IDGAF reaches past what is an ask today: a private start URL, a robots disallow, a confusable host, an unseen redirect host. Each of these is recorded. The person's own `floor:` rules and `web.robots: respect` still bind (section 8.6).

10. **Defaults:**
    - Web follows Tool use, so the Careful preset gives Cautious.
    - The window is 5% of the model's context window, between 1,500 and 6,000 tokens.
    - The store is capped at 16 MiB per session and 64 MiB per process.
    - The browser card is offered once per session, and never again after "Don't ask again".

The build plan (section 11) has 16 rows, WB37 to WB52, in five parallel groups. Three rows (WB38, WB43, WB52's harness) can start now. Most of the rest wait for WB24 and WB27, which are in flight.

## 2. Findings: how others handle content too big for a response

### 2.1 Comparison

| Tool or gateway                       | Size limit and what happens past it                                                                                                                                                                                                          | How to read more                                                                                                                                                                   | Narrowing                                                                                                                                                                                                                 | Cache                                                                                                                         | Failure feedback                                                                                                                                                                                                                                                                                                        | Source                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API `web_fetch` server tool | `max_content_tokens`: "If the fetched content exceeds this limit, the tool truncates it"; approximate, text only (no default stated; examples use 100000). A PDF that would push the request over the PDF limits returns `content_too_large` | none in the tool; the model fetches again or filters                                                                                                                               | **dynamic filtering** (`web_fetch_20260209` and later): "Claude can write and run code to filter fetched content before it reaches the context window", on the code execution tool, Claude 4.6 or later, not ZDR-eligible | "caches results … might not always reflect the latest version"; `use_cache: false` from `web_fetch_20260309`                  | HTTP 200 with `web_fetch_tool_result_error` and a code: `invalid_tool_input`, `url_too_long` (250 characters), `url_not_allowed`, `url_not_in_prior_context`, `url_not_accessible`, `too_many_requests`, `unsupported_content_type`, `content_too_large`, `max_uses_exceeded`, `unavailable`; Claude continues the turn | P https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool                                                                                                                                                                                                              |
| OpenAI Responses `web_search`         | `search_context_size` low/medium/high, default medium, "does not set an exact token count"; "The web search context window is limited to 128k"; `return_token_budget` `default`/`unlimited` for GPT-5+ reasoning models                      | the `web_search_call` actions `open_page` and `find_in_page` (reasoning models)                                                                                                    | `find_in_page`; `filters.allowed_domains` / `blocked_domains` (100 each)                                                                                                                                                  | `external_web_access: false` is cache-only                                                                                    | `sources` lists every URL consulted                                                                                                                                                                                                                                                                                     | P https://developers.openai.com/api/docs/guides/tools-web-search                                                                                                                                                                                                                            |
| Gemini `url_context`                  | "up to 20 URLs per request"; "The maximum size for content retrieved from a single URL is 34MB"; content counts as input tokens; nothing said about truncation                                                                               | none                                                                                                                                                                               | none                                                                                                                                                                                                                      | "attempts to fetch the content from an internal index cache", then "automatically falls back to do a live fetch"              | `urlContextMetadata.urlMetadata[].urlRetrievalStatus`: `SUCCESS`, `ERROR`, `PAYWALL`, `UNSAFE`, `UNSPECIFIED`                                                                                                                                                                                                           | P https://aistudio.google.com/docs/url-context, P https://aistudio.google.com/api-reference/generate-content                                                                                                                                                                                |
| Claude Code `WebFetch`                | "reads up to 100,000 characters of a page's content per call. On Claude Code v2.1.290 or later, the result for a longer page tells Claude how much went unread"                                                                              | `offset` parameter                                                                                                                                                                 | a **separate model call runs the prompt against the content**, and Claude receives that result, "lossy by design"                                                                                                         | 15 minutes (`CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`)                                                                              | cross-host redirect returned, not followed; 5-minute deadline; `CLAUDE_CODE_DISABLE_WEB_FETCH=1` turns the tool off                                                                                                                                                                                                     | P https://code.claude.com/docs/en/tools-reference                                                                                                                                                                                                                                           |
| Codex CLI                             | no local fetch; `web_search` is `disabled`/`cached`/`indexed`/`live`, default `cached` ("an OpenAI-maintained index without external web access"), `live` under full-access sandboxes                                                        | n/a                                                                                                                                                                                | `tools.web_search` domain filters                                                                                                                                                                                         | the index is the cache                                                                                                        | n/a                                                                                                                                                                                                                                                                                                                     | P https://learn.chatgpt.com/docs/config-file/config-reference                                                                                                                                                                                                                               |
| Reference MCP `fetch` server          | `max_length` default 5000 characters (`le=999999`)                                                                                                                                                                                           | `start_index`; appends "Content truncated. Call the fetch tool with a start_index of {next_start} to get more content."; past the end, `<error>No more content available.</error>` | `raw` for the HTML                                                                                                                                                                                                        | none                                                                                                                          | robots refusal for model-initiated fetches, private IPs refused unless `--allow-private-ips`                                                                                                                                                                                                                            | P https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/fetch/src/mcp_server_fetch/server.py                                                                                                                                                                              |
| Cline / Roo `browser_action`          | no limit documented; a screenshot after each action, 900x600 viewport; "While the browser is active, only `browser_action` tool can be used."                                                                                                | `scroll_down` / `scroll_up` one page height                                                                                                                                        | none                                                                                                                                                                                                                      | none                                                                                                                          | console logs                                                                                                                                                                                                                                                                                                            | S https://github.com/Kilo-Org/kilocode-legacy/blob/main/docs/legacy-ides/automate/tools/browser-action.md (the shared lineage). Cline's current docs list only `fetch_web_content` with no parameters (P https://docs.cline.bot/tools-reference/all-cline-tools); Roo's page did not render |
| Jina Reader                           | `X-Token-Budget`: "If a request exceeds the budget, the request fails" (no truncation)                                                                                                                                                       | `X-Page` for a PDF page                                                                                                                                                            | `X-Target-Selector`, `X-Remove-Selector`, `X-Wait-For-Selector`                                                                                                                                                           | 5 minutes; `X-No-Cache`, `X-Cache-Tolerance`; "Requests with cookies are not cached"                                          | HTTP status                                                                                                                                                                                                                                                                                                             | P https://jina.ai/reader/                                                                                                                                                                                                                                                                   |
| Firecrawl `/scrape`                   | none on text; PDF `maxPages`                                                                                                                                                                                                                 | none                                                                                                                                                                               | `onlyMainContent` (default true), `includeTags`/`excludeTags`, `formats` incl. `summary`, `json`                                                                                                                          | `maxAge` default 172800000 ms (2 days), `storeInCache` default true                                                           | HTTP status                                                                                                                                                                                                                                                                                                             | P https://docs.firecrawl.dev/api-reference/endpoint/scrape                                                                                                                                                                                                                                  |
| Exa `/contents`                       | `text.maxCharacters` (default 5,000,000)                                                                                                                                                                                                     | `subpages`                                                                                                                                                                         | `highlights` with `query` and `maxCharacters`; `summary` with `query`/`schema`; `includeSections`                                                                                                                         | `maxAgeHours` (omitted: cache, live if missing; `0`: fresh; `-1`: cache only); a failed live fetch may return the cached copy | `statuses[]` with `status`, `source` cached/crawled, `error.tag`, `httpStatusCode`                                                                                                                                                                                                                                      | P https://docs.exa.ai/reference/get-contents                                                                                                                                                                                                                                                |
| Tavily `/extract`                     | none stated                                                                                                                                                                                                                                  | none                                                                                                                                                                               | `query` reranks chunks, `chunks_per_source` 1-5 (default 3)                                                                                                                                                               | none stated                                                                                                                   | `failed_results[]`; "Check both arrays even when the response is HTTP 200"                                                                                                                                                                                                                                              | P https://docs.tavily.com/documentation/api-reference/endpoint/extract                                                                                                                                                                                                                      |
| Cloudflare Markdown for Agents        | converts HTML up to 6 MiB decompressed                                                                                                                                                                                                       | n/a                                                                                                                                                                                | the origin serves `text/markdown` on `Accept: text/markdown`; `Vary` includes `Accept`                                                                                                                                    | ETag and Last-Modified are removed, so conditional requests are not honoured                                                  | `x-markdown-tokens` "indicates the estimated number of tokens" (blog only); `Content-Signal`                                                                                                                                                                                                                            | P https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/, P https://blog.cloudflare.com/markdown-for-agents/                                                                                                                                                         |
| Perplexity Agent API                  | `web_search` `max_tokens` and `max_tokens_per_page` budgets (defaults not stated); `fetch_url` content "may be truncated for longer pages"                                                                                                   | none                                                                                                                                                                               | snippets                                                                                                                                                                                                                  | n/a                                                                                                                           | n/a                                                                                                                                                                                                                                                                                                                     | P https://docs.perplexity.ai/docs/agent-api/tools.md, P https://docs.perplexity.ai/docs/agent-api/tools/fetch-url-content.md. `search_context_size` could not be confirmed on a Perplexity page                                                                                             |
| `llms.txt`                            | a Markdown index at `/llms.txt` (H1 required, H2 link lists, an "Optional" H2 an agent may skip); `page.md` or `page.html.md` variants                                                                                                       | links                                                                                                                                                                              | n/a                                                                                                                                                                                                                       | n/a                                                                                                                           | n/a                                                                                                                                                                                                                                                                                                                     | P https://llmstxt.org/ (`llms-full.txt` is a convention, not in the spec)                                                                                                                                                                                                                   |
| Playwright MCP                        | none on snapshots; `browser_snapshot` and `browser_find` take `filename` to save to a file instead                                                                                                                                           | `browser_find`, scrolling                                                                                                                                                          | `--snapshot-mode full\|none`                                                                                                                                                                                              | the persistent profile is the default; `--isolated` keeps it "in memory, do not save it to disk"                              | console and network tools                                                                                                                                                                                                                                                                                               | P https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md                                                                                                                                                                                                                 |

### 2.2 What the field teaches

- **Budgets are in tokens where it matters.** Anthropic, Perplexity and Jina count in tokens. MCP `fetch`, Claude Code and Exa count in characters, which misjudges code-heavy and non-Latin pages. Cloudflare's `x-markdown-tokens` exists because publishers know agents budget in tokens.
- **An offset alone is not enough.**
  - MCP `fetch` and Claude Code give the model a way to read on, but only in order, so a model that wants section 9 of 12 reads 1 to 8 first.
  - The gateways that score best on retrieval tasks let the model narrow by query: Tavily `query`, Exa `highlights.query`, OpenAI `find_in_page`, and Anthropic's code filter.
  - An outline turns the offset into something the model can aim. No tool we read returns one.
- **Summarising is lossy and costs a model call.** Claude Code says "lossy by design". It also moves the page's own text, injected instructions included, into a second model whose output loses the spotlight markers. WB12, the optional summariser, stays deferred (section 4.6).
- **Failure must be data, not an exception.** Every gateway that the model calls directly returns a typed status inside a successful response and lets the model carry on: Anthropic's `web_fetch_tool_result_error`, Gemini's `urlRetrievalStatus`, Exa's `statuses[]`, Tavily's `failed_results`. Our fetch throws, so the model sees a stack-like message with no advice.
- **Caching:**
  - Gateways cache for a long time and offer a bypass: Firecrawl 2 days, Exa index-first, Jina 5 minutes, Claude Code 15 minutes, Anthropic automatic with `use_cache: false`.
  - Jina refuses to cache a request with cookies. That is the same line we draw for credentialed pages.
- **Isolation is the default only where it was designed in.** Playwright MCP persists a profile with logins unless `--isolated` is passed. Jina and Firecrawl send cookies only when the caller supplies them. Anthropic refuses credential-bearing URLs and URLs not already in the conversation.

### 2.3 What HTTP says about the cases we handle

- **`Retry-After`** tells "how long the user agent ought to wait before making a follow-up request", as an HTTP-date or a number of seconds ([RFC 9110§10.2.3¶1-2](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)). With 503 it gives how long the service is expected to be unavailable (¶1). A 503 "will likely be alleviated after some delay" ([RFC 9110§15.6.4¶1](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.4)).
- **429** "MAY include a Retry-After header", and "Responses with the 429 status code MUST NOT be stored by a cache" ([RFC 6585§4¶2, ¶7](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)).
- **401** means the request "lacks valid authentication credentials". The server "MUST send a WWW-Authenticate header field" ([RFC 9110§15.5.2¶1](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.2)).
- **403**: the client "SHOULD NOT automatically repeat the request with the same credentials". "a request might be forbidden for reasons unrelated to the credentials" ([RFC 9110§15.5.4¶2](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4)), which is where agent blocks live.
- **404** "does not indicate whether this lack of representation is temporary or permanent" ([RFC 9110§15.5.5¶1](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.5)). **410** is "likely to be permanent" ([RFC 9110§15.5.11¶1](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.11)). Both are heuristically cacheable.
- **`no-store`**: a cache "MUST NOT store any part of either the immediate request or the response and MUST NOT use the response to satisfy any other request". "MUST NOT store" means not in non-volatile storage, with "a best-effort attempt to remove the information from volatile storage as promptly as possible after forwarding it" ([RFC 9111§5.2.2.5¶1-2](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5)).
- **`no-cache`**: the response "MUST NOT be used to satisfy any other request without forwarding it for validation" ([RFC 9111§5.2.2.4¶3](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.4)).
- **`private`**: a private cache "MAY store the response" ([RFC 9111§5.2.2.7¶3](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.7)).
- **History is not a cache.** "Web browsers often have history mechanisms such as 'Back' buttons that can be used to redisplay a representation retrieved earlier in a session". The caching requirements "do not necessarily apply" to them, and a history mechanism "might honor cache directives (e.g., Cache-Control: no-store)" ([RFC 9111§6¶1-4](https://www.rfc-editor.org/rfc/rfc9111.html#section-6)). This is the frame for the content store: reading more of a page already fetched in this session is history. A new `fetch_url_content` of the same URL is a new request, and the WB25 cache rules govern it.
- **Freshness**, when the page sets it, comes from `max-age`, then `Expires` minus `Date` ([RFC 9111§4.2.1¶2](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2.1)).
- **`Vary`** names the request fields that selected the representation ([RFC 9110§12.5.5¶1](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.5)). Since we send `Accept: text/markdown` (UA-9), the store keys on the Accept variant as well as the URL.
- **`text/markdown`** is registered by [RFC 7763§2](https://www.rfc-editor.org/rfc/rfc7763.html#section-2) (Informational), with `charset` required.
- **Cookies**: "A user agent MAY ignore a received cookie in its entirety" ([RFC 6265§5.3¶3](https://www.rfc-editor.org/rfc/rfc6265.html#section-5.3), Proposed Standard, current), which permits the per-fetch, host-only jar in section 3.

## 3. The basic fetch: isolation

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IS-1 | **A fresh cookie jar per fetch, in memory, host-only, discarded at the end of the fetch.** A `Set-Cookie` received on hop _n_ is sent back only on a later hop of the same fetch to the exact host that set it (no `Domain` widening, `Secure` honoured, `Path` honoured). The jar is never shared between fetches, never written anywhere, never shown to the model, and not recorded beyond a count in the fetch record. This amends #898 section 7.5 ("never sent"): consent and redirect walls that set a cookie and redirect back to themselves then work, and nothing outlives the fetch. RFC 6265§5.3¶3 allows ignoring any cookie, so cross-host cookies are dropped. |
| IS-2 | **No credentials:** no `Authorization`, no `Proxy-Authorization` to the target, no person's cookies, no browser profile, no global `requestOptions.headers` (already true for the tool, #636; WB23 closes `@url`).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| IS-3 | **The one exception** is a per-host header the person writes in their own config (`web.hosts[<pattern>].headers`, #898 section 7.6). A page fetched with one is marked `credentialed`. A credentialed page is kept only for the current turn (ST-5) and labelled `headers: per-host (personal)` in the provenance line.                                                                                                                                                                                                                                                                                                                                                       |
| IS-4 | **No `Referer`, no `From`, no `Accept-Language`** (UA-8, UA-9, unchanged). `Accept: text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.8, */*;q=0.1` (UA-9, unchanged). A `text/markdown` answer skips conversion, and `x-markdown-tokens` is recorded as the site's estimate beside ours.                                                                                                                                                                                                                                                                                                                                                                |
| IS-5 | **Connection isolation:** a fresh agent per fetch (no keep-alive pool shared with model-provider traffic), so a connection opened for a model provider never carries a fetch. This is inferred to be the case for `modelToolFetch` today; WB39's tests assert it.                                                                                                                                                                                                                                                                                                                                                                                                             |
| IS-6 | A test fetches from a local server that sets a cookie on a 302 to itself, then a 302 to a second host. The cookie returns on the first hop, does not reach the second host, and is absent from the next fetch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 4. Pages that do not fit

### 4.1 Measuring

- **Unit.** Size is measured in tokens of the model that will read the result, with the product's own counter (`countTokens` in `core/llm/countTokens.ts`). It is an estimate for models whose tokenizer we do not ship, and the result prints it with `~`.
- **Lines.** The converted text (Markdown for HTML, pretty-printed JSON, plain text) is split into lines. A line longer than 2,000 characters (minified text) is broken into virtual lines at that length, so `offset` and `grep` line numbers stay meaningful. Line numbers are fixed when the page is stored.
- **Window.** The first window is `web.limits.windowTokens` if set. Otherwise it is 5% of the active model's context window, clamped to 1,500 to 6,000 tokens:

  | Context window | Window size  |
  | -------------- | ------------ |
  | 200k and 128k  | 6,000 tokens |
  | 32k            | 1,600 tokens |
  | 8k             | 1,500 tokens |

  Today's 20,000-character cut is about 5,000 tokens, so the large-model default barely moves.

- **Pages.** The page is divided into consecutive windows of the window size, cut at line boundaries, and the page count is fixed when it is stored.
- **Slack.** A page up to 1.25 times the window is returned whole, so that a page just over the limit is not split for a few lines.
- **Byte ceiling.** The 2 MiB cap after decompression (WB5) still bounds what is stored. A page cut there says so (`cut at 2 MiB`), and the stored copy holds what was read.

### 4.2 The outline

- Built from Markdown headings (`#` to `####`) after conversion. Readability keeps article headings, and the visible-text fallback has none (inferred from `URLContextProvider.ts:178-205`).
- Each entry: `§<n> <heading text> (line <l>, ~<tokens>)`. Heading text is sanitised like the title, cut to 80 characters, and inside the spotlight markers.
- At most 60 entries and about 600 tokens. Deeper levels are dropped first, and a dropped level is reported (`#### headings not shown`).
- **No headings** (plain text, JSON, the visible-text fallback): the outline is replaced by the page list. For JSON, the top-level keys and their line numbers are listed instead when there are 60 or fewer.

### 4.3 What the first result contains

The provenance line (#898 section 7.8, built by WB24), then the size statement, the outline, the reading instructions, then the first window. The exact text is in section 6.2. The outline and instructions cost about 300 to 700 tokens. That is the price of never re-fetching, and it is paid only when the page does not fit.

### 4.4 Reading on

`read_web_content` (section 9.2) reads from the store by one of:

- **`section`**: an outline number or heading text, matched case-insensitively, exact first, then prefix. It returns from that heading to the next heading of the same or a higher level. A section larger than the window returns its first window and says where it continues.
- **`page`**: 1-based.
- **`offset`**: a line number, with optional `lines`. Without `lines`, as many lines as fit in the window.
- **`grep`**: a case-insensitive regular expression. It returns matching lines as `<line> [§<section>]: <text>`, at most 200 matches and one window of text. A pattern that is not a valid expression is matched as literal text and the result says so. That is friendlier than `read_command_output`, which refuses it; the model's intent is clear.

With no selector it returns page 2, the natural "more". Each read ends with the next step (`Next: page 3, or offset 431.`) and costs no network.

### 4.5 Fetching the same URL again

`fetch_url_content` first looks in the session's store for the final URL (or a start URL that redirected there in this session) with the same Accept variant:

- **Fresh entry**: returned from the store with `cache: session` in the provenance line and the sentence `This is this session's copy from <hh:mm> UTC (<n> minutes old); it was not fetched again. Pass refresh: true if the page has changed since.` A `grep` argument applies to the stored copy.
- **Entry past its freshness**: revalidated with `If-None-Match` / `If-Modified-Since` (WB25). A 304 keeps the id, and a 200 with a new hash makes a new id.
- **`refresh: true`**: fetches again and counts toward the repeat guard.
- **Freshness** is the page's own `max-age` or `Expires` (RFC 9111§4.2.1), capped at `web.cache.minutes` (default 15). With no explicit freshness it is 15 minutes. `no-cache` always revalidates.

### 4.6 What is not done

- **No summariser by default.** WB12's `extract` on a small role model stays deferred until WB52 measures whether outline plus `grep` leaves a gap. It is lossy, costs a call, and its output carries the page's injected text without the spotlight markers.
- **No code-execution filtering** like Anthropic's dynamic filtering. It needs a sandbox that is not the default (W8).
- **No automatic fetch of `llms.txt` or `.md` variants.** The model is told they may exist (section 7), because each would be a request the model did not choose.

## 5. The store, and the persistence pitfalls

### 5.1 Shape

- `core/util/web/contentStore.ts`, alongside `commandOutputStore.ts` and modelled on it: short ids, a record per entry, lookup by id, and the newest entry as the default.
- One difference from the command store: **no file on disk**. Command output is the person's own process; a web page may be an intranet page the person reached through an ask.
- Entries are keyed by `(sessionId, finalUrl, acceptVariant)`, with the SHA-256 of the converted text stored on the entry. Ids are per session (`web-1`, `web-2`, …). The same URL with the same hash keeps its id; a changed hash gets a new id, and the old one stays readable until it is evicted.
- `ToolExtras` gains `sessionId`. It has none today (`core/index.d.ts:2165-2195`), and the command store is per window. The CLI passes its session id the same way.

### 5.2 Decisions on each pitfall

| #    | Pitfall                                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST-1 | **Stale content**                        | Every result from the store says how old it is. Reuse by a new fetch follows freshness (4.5), with revalidation and `refresh: true`. Reading more of a stored page (history, RFC 9111§6) never checks freshness: the model asked for more of what it already has.                                                                                                                                                                                                             |
| ST-2 | **Private pages**                        | Memory only, never on disk, never in session history. WB24 keeps metadata only, so a reopened session shows that a page was read but not its text. A page from a **non-public address** is kept only for the current turn: it was reached through an ask, and the approval covered that call.                                                                                                                                                                                 |
| ST-3 | **Cross-session leaks**                  | One map per session id. A read names an id within its own session only, and an id from another session is "not found". Subagents have their own store; a parent cannot read a child's ids, since the child reports in text. A test asserts that two sessions fetching the same URL get separate entries.                                                                                                                                                                      |
| ST-4 | **Poisoning**                            | Only the fetch pipeline writes to the store, from a response it received for that final URL. The model cannot write, rename or alias an entry. Each read **re-applies the host rules** (WB21) and the Web level, so a domain the person blocks mid-session can no longer be read from the store (outcome `blocked`). Every window, from fetch or read, is spotlighted. The secret mask (#898 section 7.7) runs once at store time, so no read returns an unmasked credential. |
| ST-5 | **`no-store`, credentialed, non-public** | Kept for the current turn and readable by `read_web_content` until the turn ends, then removed. Never used to answer a later `fetch_url_content`, even in the same turn (RFC 9111§5.2.2.5¶1: "MUST NOT use the response to satisfy any other request"). The first result says `This page asks not to be stored; it can be read with read_web_content until this turn ends.`                                                                                                   |
| ST-6 | **Disk use**                             | None: no web content goes to disk.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ST-7 | **Memory**                               | 16 MiB of converted text per session and 64 MiB per process, evicted least recently read. An evicted id returns outcome `expired`, and fetching it again does not count as a repeat. Store size shows in the Browser panel and `/web`.                                                                                                                                                                                                                                        |
| ST-8 | **Lifetime**                             | An entry is deleted when its session is deleted, cleared or closed, or when the process exits. It is never copied into a fork of the session. A forked session starts empty, because forking copies the transcript, and the transcript holds the windows already read.                                                                                                                                                                                                        |
| ST-9 | **429 and errors**                       | Error outcomes are kept as records for the repeat guard (6.4), never as content. Bodies of 429 responses are never stored (RFC 6585§4¶7).                                                                                                                                                                                                                                                                                                                                     |

## 6. Feedback to the agent

### 6.1 Rules for every outcome

- The result is a normal tool result, never a thrown exception. The context item's `status` carries the outcome code, as `read_command_output` already does with `Running` and `Finished`, so the GUI can render a badge and tests can match the code without parsing text.
- Wording follows the house refusal style:
  - **First sentence:** what happened, naming the host and the status.
  - **Second sentence:** whether repeating the call can help.
  - **Third sentence:** what to do instead.
- Where repeating cannot help, the text says "Do not retry it unchanged" or uses the existing `CARRY_ON` sentence (`core/tools/toolListHold.ts:141`).
- No response body is quoted, except a `<noscript>` line or a `WWW-Authenticate` scheme and realm, each cut to 120 characters and inside the spotlight markers.
- The provenance line (WB24) comes first whenever a request was made, so the model sees status, type, size and the rule that decided.

### 6.2 Outcomes and exact texts

`<host>`, `<url>`, `<n>` and similar are filled in. Codes are kebab-case.

| Code                 | When                                                                                         | Retry can help?      | Exact text after the provenance line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                 | fits in the window (with the 25% slack)                                                      | n/a                  | (the page)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `partial`            | larger than the window                                                                       | n/a: not an error    | `This page is ~<total> tokens; this shows the first ~<shown> (lines 1-<l> of <L>, page 1 of <P>). It is saved for this session as <id>, so reading more does not fetch it again.`<br>`Outline (line, ~tokens):`<br>`<outline lines>`<br>`To read more, call read_web_content with id "<id>" and one of: section (a number or heading from the outline), page (2 to <P>), offset (a line number), or grep (a pattern; returns matching lines with their numbers). This is not an error: do not fetch this URL again.` |
| `from-session`       | a fresh stored copy answered the fetch                                                       | n/a                  | `This is this session's copy from <hh:mm> UTC (<n> minutes old); it was not fetched again. Pass refresh: true if the page has changed since.`                                                                                                                                                                                                                                                                                                                                                                        |
| `robots`             | robots disallow, the person declined or nobody can be asked (RB-4)                           | no                   | `Not fetched: robots.txt on <host> asks automated agents not to read <path>. Retrying will not change this. If the page is needed, ask the person; a URL they write in a message is fetched without this check.`                                                                                                                                                                                                                                                                                                     |
| `blocked`            | a deny rule, the Web level (Listed, or a reviewer's no), a ceiling or a session block        | no                   | `Refused: <reason, e.g. "a rule blocks <host> (deny host:*.<domain>, your permissions.yaml)">. It was not fetched. Do not retry this call or reach the same result another way. Do what else the request needs, then say what you could not do and why.`                                                                                                                                                                                                                                                             |
| `declined`           | the person answered No to the ask                                                            | no                   | `Not fetched: the person declined reading <host>. Do not retry it; carry on without it, or ask them why if you need it.`                                                                                                                                                                                                                                                                                                                                                                                             |
| `refused-unattended` | an ask in a headless run (CO2)                                                               | no                   | the CO2 text, unchanged: `<reason> Running headless, so it was refused: nobody can be asked in -p or serve. To allow it, run with --auto, --policy <preset\|area=level\|file> ..., or --allow <tool>.` with `--policy web=<level>` named.                                                                                                                                                                                                                                                                            |
| `not-text`           | binary content type or sniffed binary                                                        | no                   | `Not read: <host> returned <media type>, not text. Only HTML, plain text, Markdown, JSON and XML are read, and fetching it again returns the same file. If the person needs it, ask them to open or download it.` (PDF, until WB35: `PDF text extraction is not available in this version.`)                                                                                                                                                                                                                         |
| `needs-js`           | heuristics in 7.1                                                                            | no                   | section 7.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `needs-cookies`      | the redirect limit was reached while hops set cookies the jar could not satisfy (cross-host) | no                   | `Not read: <host> keeps redirecting (<n> hops) while setting cookies, which is a sign-in or consent wall. This fetch keeps no cookies between sites, so retrying loops the same way. Ask the person for the content, or use a browser tool if one is configured.`                                                                                                                                                                                                                                                    |
| `auth-required`      | 401                                                                                          | no                   | `Not read: <host> answered 401 Unauthorized; it wants a sign-in (<scheme> realm="<realm>"). This fetch never sends cookies or credentials, so retrying gets the same answer. Ask the person for the content, or whether a per-host header in their own config should cover this site.`                                                                                                                                                                                                                               |
| `forbidden`          | 403                                                                                          | no                   | `Not read: <host> answered 403 Forbidden. The site refuses this request: a sign-in wall or a block on automated agents. Do not retry it unchanged. Look for the same content elsewhere (an official docs repository, an API, an llms.txt or .md version), or ask the person.`                                                                                                                                                                                                                                        |
| `rate-limited`       | 429, or 503 with `Retry-After` beyond the 10 s wait (#898 7.4)                               | yes, after the delay | `Not fetched yet: <host> answered <429 Too Many Requests\|503 Service Unavailable> and asks to wait <n> seconds (Retry-After). It can be fetched again after <hh:mm:ss> UTC; a call before then is answered from this result without contacting the site. Do other work meanwhile.`                                                                                                                                                                                                                                  |
| `host-limit`         | our per-host limit (10 a minute, #898 7.4)                                                   | yes, after the delay | `Not fetched: this session has made <n> requests to <host> in the last minute, the limit. Try again in <s> seconds, or use what you already have (<ids>).`                                                                                                                                                                                                                                                                                                                                                           |
| `timeout`            | the deadline passed                                                                          | once                 | `Not fetched: <host> did not finish answering within <s> seconds. One retry may help if the site was slow; if it times out again, the page is too slow for this tool, so do not retry a third time.`                                                                                                                                                                                                                                                                                                                 |
| `dns`                | NXDOMAIN or no address                                                                       | no                   | `Not fetched: the name <host> does not resolve (no such domain). Retrying will not help. Check the spelling; the URL may be wrong or invented.`                                                                                                                                                                                                                                                                                                                                                                      |
| `dns-temporary`      | `EAI_AGAIN`, SERVFAIL                                                                        | once                 | `Not fetched: the DNS lookup for <host> failed temporarily. One retry may help; if it fails again, tell the person their network or resolver may be down.`                                                                                                                                                                                                                                                                                                                                                           |
| `tls`                | certificate or handshake failure                                                             | no                   | `Not fetched: the TLS certificate of <host> could not be verified (<reason, e.g. self-signed certificate>). No connection was made, and retrying will not change this. Do not suggest turning verification off. Tell the person; for an internal site with its own CA, they can add the CA in their own config (requestOptions.caBundlePath).`                                                                                                                                                                       |
| `connection`         | refused, reset, unreachable                                                                  | once                 | `Not fetched: the connection to <host> was <refused\|reset\|unreachable>. One retry may help if the site was restarting; if it fails again, do not retry, and tell the person.`                                                                                                                                                                                                                                                                                                                                      |
| `not-found`          | 404                                                                                          | no                   | `Not found: <host> answered 404 for <path>. The page is not at this address (or the site hides it). Retrying will not help. Check the URL; for documentation, start from the site's index or search it.`                                                                                                                                                                                                                                                                                                             |
| `gone`               | 410                                                                                          | no                   | `Gone: <host> answered 410 for <path>: it was removed on purpose. Do not retry it; look for its replacement.`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `server-error`       | 500, 502, 504, other 5xx without `Retry-After`                                               | once, later          | `Not read: <host> answered <status> <reason>. The site failed; an immediate retry rarely helps. Try once more after other work, and not again after that.`                                                                                                                                                                                                                                                                                                                                                           |
| `client-error`       | any other 4xx                                                                                | no                   | `Not read: <host> answered <status> <reason>. Retrying the same request will not change this.`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `repeat`             | the repeat guard (6.4)                                                                       | no                   | `Not fetched again: this is the <ordinal> identical fetch of <url> in this session, and the earlier ones returned <code>. Repeating it will not change the result. <If an id exists: Read it with read_web_content (id "<id>").> Otherwise fetch a different URL, or tell the person what you could not read.`                                                                                                                                                                                                       |
| `expired`            | a read names an evicted id                                                                   | yes: fetch again     | `<id> is no longer in this session's store (it was removed to save memory). Fetch the URL again; that does not count as a repeat.`                                                                                                                                                                                                                                                                                                                                                                                   |
| `not-found-id`       | a read names an unknown id                                                                   | no                   | `No page with id <id> in this session. Known: <ids>.` (the `read_command_output` form)                                                                                                                                                                                                                                                                                                                                                                                                                               |

The existing hard refusals keep their wording (`fetchUrlSafety.ts`: scheme, userinfo, credential in the URL; `guardedFetch.ts`: redirect to a non-public address). Each gains the second sentence, `Do not retry it unchanged.`, and the `status` code `refused`.

### 6.3 Asks

When the Web level asks (section 8), the card says:

> The agent wants to read `<url>` (`<host>`; new in this session; the URL came from `<a search result | an earlier page | the agent>`).

The buttons are:

- **Allow once**
- **Allow `<host>` for this session**
- **Always allow `<host>`**, with a toggle for `*.<registrable domain>`, which is not offered for WB11 user-content hosts
- **No**

The CLI prompt offers the same four as `1/2/3/n`.

### 6.4 The repeat guard

- **Key:** per session, the normalised final URL (or the start URL when no request completed) plus `grep` and `refresh`.
- **Second identical call:**
  - after an outcome whose retry column says "no": answered from the recorded outcome without contacting the site, with `(answered from this session's record; the site was not contacted)` appended;
  - after a "once" outcome: one real retry is allowed.
- **Third identical call within the session:** outcome `repeat`. It counts as a refusal for the existing refusal cap (`REFUSAL_CAP`, 3 consecutive or 20 per turn, `core/util/turnEnd.ts:35`), so a loop of refetches ends the turn as "needs you" with the URL listed.
- **"After the delay" outcomes:** calls before the stated time are answered from the record and do not count. The first call after it is a real fetch.
- **`refresh: true`:** counts like a normal call, so a model cannot dodge the guard by setting it every time.
- **Person-directed fetches** (`@url`, the Browser panel) are not counted.
- **Reset:** the guard resets for a URL when the person writes it in a new message, since that is a new request from them.

## 7. JavaScript pages and the browser option

### 7.1 Detection

After conversion, a page is `needs-js` when its visible text is under 200 characters and at least one of the following holds:

- a `<noscript>` element has text;
- the body's only substantial element is an empty application root: `#root`, `#app`, `#__next`, `#__nuxt`, `#svelte`, `[ng-app]`, `[data-reactroot]`;
- there are three or more `<script>` elements and the visible text is under 2% of the HTML bytes.

A JSON or plain-text response is never `needs-js`. The detector is pure and tested against a fixture corpus of real shells (create-react-app, Next.js client-only, Angular, Docusaurus with JS off, Swagger UI) and of short real pages that must not trip it.

### 7.2 What the model is told

The text has a common head, then one of three tails.

Head:

```
Fetched, but <host> serves a page that needs JavaScript: the HTML is an application shell with <n> characters of text<; <noscript>: "<first 120 characters>">. This tool does not run JavaScript, so fetching it again returns the same shell.
```

Tail A, a browser tool is offered in this session (detected in 7.3):

```
A browser tool is available: call <server>_browser_navigate with this URL, then <server>_browser_snapshot to read the page. It runs outside this fetch's rules and records, and each call asks as your Web level says.
```

Tail B, a browser server is configured but its tools are not offered (turned off, Plan mode, or not approved by TR4):

```
A browser server (<server>) is configured but its tools are not available in this session. Ask the person to turn them on if this page is needed.
```

Tail C, none is configured:

```
No browser tool is configured. Look for another source: the project's docs repository, an API, an llms.txt or a .md version of the page. Or tell the person this page needs a browser; they have been offered one.
```

The exact tool names come from the registered tool list (`getToolNameFromMCPServer`, `core/tools/mcpToolName.ts:32-56`, so a server named `playwright` gives `playwright_browser_navigate`), never a hard-coded string.

### 7.3 Which servers count as a browser

- An MCP server whose tool list contains both `browser_navigate` and `browser_snapshot` (the Playwright MCP names, P README).
- Or one whose config entry says `category: web`.

The wizard writes `category: web` for its fetch and Playwright templates (`plans/decisions-2026-11-15.md:103`). The person can set it on any server.

### 7.4 The IDE card

The card is shown once per session, at the first `needs-js` outcome with tail C. It is never shown in headless runs, when Web is Off, or after "Don't ask again", which is stored in the IDE's global state, not in `permissions.yaml`.

> **Enable a browser for JavaScript pages?**
> The agent fetched `<host>`, which needs JavaScript. The built-in fetch does not run page code. You can add Playwright MCP, which runs a browser with a fresh in-memory profile (`--isolated`) each session and never your own sign-ins. A browser runs the page's code and reaches every host the page loads; our web rules and fetch log do not cover it, and its origin lists are not a security boundary.
> [Set up Playwright…] [Not now] [Don't ask again]

"Set up Playwright…" opens the MCP add wizard (#798) at the Playwright template with these settings:

- the version pinned at Add (after TR4);
- `--isolated`;
- `category: web`;
- every tool asking under the Web level, never trusted as read-only.

The CLI prints one line instead: `This page needs JavaScript. To add a browser: continuous mcp add playwright (runs with --isolated).`

### 7.5 Why not on by default

Each reason comes from the owner's words and the record:

- A browser is new egress and a large surface (`decisions-2026-11-15.md:116`, never-do list).
- Its traffic is outside our host rules, robots handling and fetch log (#898 section 7.10).
- Playwright's default profile persists logins (P README).

WB34, the in-house browser, stays kept for the owner.

## 8. The Web policy area

### 8.1 Why an area

`plans/policy-areas.md` put web under Tool use, and `plans/research/custom-policy.md` section 4 said "no new areas". The owner now asks for the web to have its own knob, levels and an Off. A sub-setting of Tool use would need its own levels anyway and would hide them inside another control. So Web becomes the sixth area, with the same question for each level ("who decides a call that your rules leave open?") and two web-only levels:

- **Off**: nothing to decide.
- **Listed**: nobody decides; unlisted means refused.

The per-area level set is already allowed: "A level that does not exist for an area, or an unknown name, falls back to that area's default and reports it" (`policy-areas.md`, Settings).

**What is in the Web area:**

- `fetch_url_content` / CLI `Fetch`;
- `read_web_content`;
- `search_web`;
- provider-native search (WB10);
- tools of MCP servers that count as a browser or have `category: web` (7.3).

**What is not:** `@url`, the Browser panel's address bar and docs indexing are person-directed and governed by `web.enabled` (8.4). A terminal `curl` stays in Tool use; host rules apply to it as today.

### 8.2 The levels

Ordered from top to bottom by how few decisions reach you, as the other dropdowns are. Off is set apart by a divider.

| Level          | Stored                | Fetch to a host an allow rule covers | Fetch to any other host                                                                | Robots disallow, private start, confusable host, reputation hit | Redirect to an unseen host | Dropdown line                                                                   |
| -------------- | --------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| **Off**        | `off`                 | tool not offered                     | tool not offered                                                                       | n/a                                                             | n/a                        | "No web tools: the agent cannot fetch or search."                               |
| **Manual**     | `manual`              | asks                                 | asks                                                                                   | asks                                                            | asks                       | "Asks before every fetch and search."                                           |
| **Cautious**   | `cautious`            | runs                                 | asks, unless the host was allowed for this session or the exact URL is in your message | asks                                                            | asks                       | "Asks before a new domain; runs domains you allowed."                           |
| **Listed**     | `listed`              | runs                                 | **refused**, no ask                                                                    | refused                                                         | refused                    | "Only domains you allowed. Never asks; everything else is refused."             |
| **Automatic**  | `automatic`           | runs                                 | a reviewer model decides; unsure asks                                                  | asks you (the reviewer never decides these)                     | the reviewer decides       | "As Cautious, and a reviewer model decides new domains."                        |
| **Permissive** | `permissive`          | runs                                 | runs unless a deny or ask rule stops it                                                | asks                                                            | followed and labelled      | "Fetches anything no rule stops."                                               |
| **IDGAF**      | `idgaf`, session only | runs                                 | runs                                                                                   | runs and is recorded                                            | followed and labelled      | "Fetches anything. Every rule is ignored; built-in fetch safety still applies." |

Notes on the table:

- **Allowed for this session** is set by the ask card's second button or the Browser panel's Allow Once (8.5). It lives in memory and ends with the session.
- **The exact URL in your message** is WB6's user-origin flag. A URL the person wrote is theirs, as in Anthropic's prior-context rule.
- **Search** (`search_web`) uses the same columns with the backend host as the host: once the backend is configured, it counts as allowed. WB3's query gate (refuse a secret, ask on a path or code) applies at every level below IDGAF.
- **`read_web_content`** never asks. It reads only what this session fetched. It is withheld when Web is Off, and it re-checks deny rules and the level on every read (ST-4).
- **Redirects:**
  - At Manual and Cautious a hop to an unseen host is treated as a new domain. This settles WB16's open ask by level: at these levels it asks in the IDE and is refused unattended.
  - At Permissive and IDGAF the hop is followed and the page is labelled with the final URL.
  - At Listed the hop is refused, and the model gets `blocked` with the hop named.
- **Automatic:**
  - The reviewer is a new job beside the tool-call job (`policy-areas.md`, "The reviewer model"). It sees the URL, where the URL came from (person, search result, earlier page, model), the host, and the person's messages. It never sees the page.
  - Unsure, a parse failure or a timeout asks.
  - Without a reviewer, Automatic behaves as Cautious (`withoutReviewer`, `policy.ts:269-275`).

### 8.3 Decision order for a web call

This is the policy-areas order with the web steps named:

1. Org ceiling caps the level. `ceiling.web: off` is allowed.
2. Web is Off, or `web.enabled: false` from any config: the tool is not offered. A call that still arrives (a warm cache, C88) gets the withheld-tool refusal.
3. A hook says deny or ask: it tightens.
4. **Fetch-internal hard safety:** scheme, userinfo, credential-shaped value in the URL (WB6), cloud metadata address, and, at every hop, public-to-private redirect, byte cap, deadline and cookie isolation. These run inside the fetch at every level, IDGAF included, because they are how the tool works, not approvals (8.6).
5. `floor:` deny rules (`host:`/`net:` forms included) and `web.robots: respect`. These bind at IDGAF too, because the person wrote them as hard lines.
6. Level is IDGAF: run and record.
7. Deny rule (`host:`, `net:`, `fetchUrl(...)`) or a session block: `blocked`.
8. Protections: private start, confusable or mixed-script host, robots disallow (model-origin URLs), reputation hit. Ask, or refuse at Listed and unattended.
9. Ask rule: ask (refused at Listed and unattended).
10. Manual: ask.
11. Host covered by an allow rule, `trustedDomains` (DC-5), a session grant, or the exact URL in a user message: run.
12. Level decides: Cautious asks, Listed refuses, Automatic goes to the reviewer, Permissive runs.

### 8.4 Settings, `web.enabled`, and what WB27 already builds

- `levels.web` lives in `permissions.yaml`, beside the other five levels (`settingsFile.ts`). It follows the same rules:
  - per user;
  - never read from a repository;
  - IDGAF never saved;
  - an unknown value falls back to the area's default and is reported.
- **Unset follows Tool use.** When `levels.web` is absent, Web takes Tool use's level (manual, cautious, automatic, permissive, idgaf map one to one). So no saved setting changes meaning, and `presetOf` (`policy.ts:144-148`) treats an absent `web` as matching. When the person picks a Web level, it is written and stops following.
- **`web.enabled: false`** (config.yaml, WB27) is the product-wide off switch: no agent web tools, no `@url`, no Browser panel fetch, no docs crawl, no favicon lookup. It may come from the personal file or a workspace file, since turning off only tightens, or from an organisation config.
  - When any of these says false, the Web control shows **Off (config.yaml: web.enabled)**, locked, with the file named.
  - `levels.web: off` turns off only the agent's web tools, so the person can still `@url` a page.
- **WB27's placeholder `web.policy`:**
  - If it ships before WB45 with a level value, it is read as `levels.web` with a deprecation notice from `continuous doctor config`.
  - If it has not shipped, WB27 drops the key before release. Levels have one home, `permissions.yaml`.
- **Workspace tightening.** A repository cannot set `levels.web`, as for every level. It can:
  - set `web.enabled: false`;
  - add deny and ask `host:` rules (DC-4);
  - set `web.requireHttps: true`;
  - lower limits.

  It cannot add web allow rules without the trust dialog (`policy-areas.md`, "Repository files cannot add allow rules").

- **CLI:**
  - `--web <level>`;
  - `--policy web=listed`, alongside the other `area=level` pairs;
  - `/policy web=<level>`;
  - `--policy` files take `levels.web`.

  The headless start-up line (CO2) names the Web level.

- **Headless (CO2).** Every ask is refused with the CO2 text. A headless run at Cautious therefore behaves as Listed, and the start-up line says so: `Web: Cautious (unattended: only allowed domains)`.

### 8.5 Presets, Custom and the Browser panel

| Preset       | Context    | Tools      | Edits      | Plan       | Questions  | **Web**        |
| ------------ | ---------- | ---------- | ---------- | ---------- | ---------- | -------------- |
| Careful      | Permissive | Cautious   | Manual     | Cautious   | Cautious   | **Cautious**   |
| Accept edits | Permissive | Cautious   | Permissive | Cautious   | Cautious   | **Cautious**   |
| Hands off    | Permissive | Permissive | Permissive | Permissive | Permissive | **Permissive** |
| Reviewer     | Automatic  | Automatic  | Automatic  | Automatic  | Automatic  | **Automatic**  |
| IDGAF        | IDGAF      | IDGAF      | IDGAF      | IDGAF      | IDGAF      | **IDGAF**      |

The Reviewer row follows `policy.ts:116-126`, where Context is Automatic. `policy-areas.md` shows Permissive there; the code is what ships.

No preset sets Off or Listed. Both are choices the person makes, and either makes the chip read Custom.

- **Custom editor** (`custom-policy.md` section 3.2), step 2: a Web select with the seven levels and their lines. "Follows Tool use" is shown as the value when `levels.web` is unset.
- **Custom editor**, step 3: the host rules (`host:`/`net:`) as their own group, "Web domains", in the same Never / Ask / Always lists.
- **Toolbar.** No sixth icon. The five-icon toolbar is already 152 px of a 300 px row (`policy-areas.md`, Interface). The Tool use icon's dropdown gains a last row, "Web: `<level>`", that opens the Web levels. In the one-picker shape, Web is the sixth row of the popover.
  - When Web is Off or IDGAF, a small globe mark on the Tool use icon shows it: struck through for Off, red for IDGAF.
  - The control turns red when any area, Web included, is at IDGAF.
- **Browser panel** (WB31). Its buttons map onto the same state:

  | Button                    | Effect                                                                             |
  | ------------------------- | ---------------------------------------------------------------------------------- |
  | **Allow, Once**           | adds the host to the session grants                                                |
  | **Allow, Always**         | writes `allow: host:<h>` (or `host:*.<domain>`) to the personal `permissions.yaml` |
  | **Block, Once**           | adds a session block                                                               |
  | **Block, Always**         | writes `deny: host:<h>`                                                            |
  | **Ask about this domain** | writes `ask: host:<h>`                                                             |
  - The panel header shows the Web level, with a link to change it.
  - At Listed, "Allow, Always" is how the list grows, and the panel says so on a `blocked` row.

- **Settings > Web** (WB28) gains a **Policy** section. It holds the level select, the session grants and blocks with Remove buttons, the browser-card state ("Don't ask again" can be undone here), and the store size.

### 8.6 What IDGAF may and may not skip on Web

This follows the record: IDGAF means no rule, built-in or reviewer is consulted (`policy-areas.md`, IDGAF; `evaluate.ts:219-261`). The fetch-internal checks are not approvals: they live in the tool (`fetchUrlSafety.ts`, `guardedFetch.ts`, `boundedBody.ts`), so `idgafRunsEverything` never sees them.

| Check                                                                                                     | At IDGAF                                    | Why                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| http/https only; no userinfo                                                                              | refused                                     | in the tool; RFC 9110§4.2.4¶4 treats userinfo as an error (#898 5.2)                                                                                                                                                                           |
| Credential-shaped value in the URL, start and every `Location` (WB6, WB22)                                | refused                                     | decided 2026-11-15 "Refuse it"; in the tool                                                                                                                                                                                                    |
| Public-to-private redirect                                                                                | refused                                     | in the tool (`guardedFetch.ts:75-79`)                                                                                                                                                                                                          |
| Cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`) as start or hop | **refused** (new, WB45)                     | no person reads documentation from the metadata service, and it is the one SSRF target that hands out credentials. It joins the in-tool checks rather than the private-start ask                                                               |
| Byte cap, deadline, redirect limit, cookie isolation, no credentials                                      | apply                                       | how the tool works                                                                                                                                                                                                                             |
| Private or loopback start URL                                                                             | runs, recorded                              | today's behaviour (`evaluate.ts:511-522`): a person's local server is a real target                                                                                                                                                            |
| Robots disallow                                                                                           | runs, recorded `robots: disallowed (IDGAF)` | an ask today, so IDGAF reaches past it                                                                                                                                                                                                         |
| `web.robots: respect`                                                                                     | refused                                     | the person's explicit hard line, read from the personal file only (RB-8), like `floor:`                                                                                                                                                        |
| `host:`/`net:` deny rules                                                                                 | ignored, counted in the dropdown line       | IDGAF ignores deny rules by decision                                                                                                                                                                                                           |
| `floor:` deny rules                                                                                       | refused                                     | bind at IDGAF by design                                                                                                                                                                                                                        |
| Confusable host, reputation hit, unseen redirect host                                                     | runs, recorded                              | asks today                                                                                                                                                                                                                                     |
| Repeat guard (6.4)                                                                                        | applies                                     | it does not ask or deny on policy grounds; it returns the recorded outcome. It ends a loop the person would not want at any level. Its third-call refusal counts toward the refusal cap, which IDGAF does not lift for any area (`turnEnd.ts`) |
| Org ceiling                                                                                               | caps                                        | as for every area                                                                                                                                                                                                                              |

The dropdown's IDGAF line names the exceptions in one sentence: "Fetches anything. Every rule is ignored; built-in fetch safety (no credentials, no cloud metadata, no redirect into your network) still applies."

### 8.7 Defaults

| Setting           | Default                                                                                                                                                                                              | Why                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `levels.web`      | unset (follows Tool use, so Cautious under Careful)                                                                                                                                                  | no saved setting changes meaning                                                                                       |
| Cautious vs today | today the fetch tool asks every call under Tools Cautious (`allowedWithPermission`). Cautious on Web also runs (a) a host the person allowed for this session and (b) the exact URL the person wrote | the loosening the owner asked for (fewer prompts for the same docs site), limited to the person's own grants and words |
| `web.enabled`     | true                                                                                                                                                                                                 | off is a choice                                                                                                        |
| Window            | 5% of the context window, 1,500 to 6,000 tokens                                                                                                                                                      | 4.1                                                                                                                    |
| Store             | 16 MiB per session, 64 MiB per process, memory only                                                                                                                                                  | 5.2                                                                                                                    |
| Browser card      | once per session, until "Don't ask again"                                                                                                                                                            | 7.4                                                                                                                    |
| Playwright        | never enabled by the product                                                                                                                                                                         | owner                                                                                                                  |

## 9. Tool schema changes

### 9.1 `fetch_url_content`

```ts
function: {
  name: "fetch_url_content",
  description:
    "Read a web page (http or https) as Markdown, or text and JSON as text. A page too long for one result returns its start, an outline and an id: read the rest with read_web_content instead of fetching again. A failure says whether retrying can help. Not for files, downloads or URLs with credentials.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", description: "The URL to read" },
      grep: {
        type: "string",
        description:
          "Optional. A regular expression (case-insensitive): return only the matching lines, with line numbers and the section each is in, instead of the page's start. The whole page is still saved for read_web_content.",
      },
      refresh: {
        type: "boolean",
        description:
          "Fetch again even if this session already has a copy. Only when the page has changed since; repeated identical fetches are refused.",
      },
    },
  },
}
```

- `readonly` stays `true`. The area is Web (`areaOfTool` gains a `web` branch, replacing `WEB_RULE_NAMES` → `tools`, `policy.ts:342, 388`).
- `defaultToolPolicy` stays `allowedWithPermission`. The Web level decides as section 8 says.
- CLI `Fetch` gains the same two parameters (`extensions/cli/src/tools/fetch.ts`).
- The `max_length` / `start_index` design in WB9 is superseded. There is no `max_tokens` parameter, because the window follows the model. A model that wants less uses `grep`.

### 9.2 `read_web_content` (new)

```ts
export const readWebContentTool: Tool = {
  type: "function",
  displayTitle: "Read Web Content",
  wouldLikeTo: "read more of a fetched page",
  isCurrently: "reading a fetched page",
  hasAlready: "read a fetched page",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: "read_web_content",
    description:
      "Read more of a page fetch_url_content saved in this session, without fetching it again: a section from its outline, a page, the lines from an offset, or the lines matching a pattern with their numbers. Use it when a fetch result says the page was longer than one result.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The page's id from its fetch_url_content result (web-3). Leave it out for the most recent page.",
        },
        section: {
          type: "string",
          description:
            "A section from the outline: its number (4) or its heading text.",
        },
        page: { type: "number", description: "A page number, from 1." },
        offset: {
          type: "number",
          description: "A line number to start from.",
        },
        lines: {
          type: "number",
          description:
            "With offset: how many lines (default: as many as fit). With grep: at most this many matches (default 200).",
        },
        grep: {
          type: "string",
          description:
            "A regular expression (case-insensitive): return only matching lines, with their line numbers and sections.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  toolCallIcon: "GlobeAltIcon",
};
```

- If more than one selector is given, the first in the order `section`, `page`, `offset`, `grep` wins. The result says which was used.
- Not in `BuiltInToolNames`, like `read_command_output` (`commandOutput.ts:5-15`). It is offered only when `fetch_url_content` is.
- CLI name: `ReadWebContent`.

Result header, then the spotlighted text, then the next step:

```
web-3 · https://docs.example.com/guide · fetched 10:04 UTC (4 minutes ago) · lines 213-430 of 1,530 · page 2 of 7 · ~6,000 tokens
<spotlighted window>
Next: page 3, or offset 431.
```

For `grep`:

```
web-3 · https://docs.example.com/guide · 14 lines match "rate.?limit" (of 1,530)
212 [§4 Rate limits]: Requests are limited to 600 a minute per key.
…
Read a match in context with offset (e.g. offset 205).
```

## 10. User-Agent presets

The owner's decision: the default is `Continuous-User/<major.minor>`, with presets. This extends UA-1 and UA-6 of #898.

| `web.userAgent`        | Sent                                                                          | Robots token used for the check                                    |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `continuous` (default) | `Continuous-User/<major.minor>`, plus ` (+<info URL>)` once UA-10 is answered | `Continuous-User`                                                  |
| `generic`              | `Mozilla/5.0 (compatible; Agent-User/1.0)`                                    | `Agent-User`, so in practice the `*` group                         |
| `browser:<id>`         | the string for `<id>` from the data file                                      | `Continuous-User`: we check robots as who we are, whatever we send |
| any other string       | that string; `""` sends none (UA-6)                                           | `Continuous-User`                                                  |

- **Data file:** `core/util/web/userAgentPresets.json`. Each entry has an id, a label, the string, and the date it was updated. The first ids are `chrome-windows`, `edge-windows`, `firefox-windows`, `safari-macos` and `chrome-android`.
  - A script, `scripts/update-user-agents.mjs`, rewrites the file from a pinned source at release time, which is a person-run step.
  - A test fails when an entry is more than 180 days old, so a stale browser string, itself a fingerprint, cannot ship unnoticed.
- **Personal config only** for `generic`, `browser:*` and custom strings (UA-7), and per host through `web.hosts[...].userAgent`. A workspace file can never choose one.
- The provenance line shows the preset id (`ua: browser:chrome-windows`), and Settings > Web > Identity shows the exact string beside the dropdown.
- **No client hints.** `Sec-CH-UA` and its relatives are never sent, even with a browser preset, so the request does not pretend to be more of a browser than its string.

## 11. Build plan

Sizes follow the ROADMAP: XS under half a day, S under 2 days, M three to five days, L more. "Group" is the parallel group: rows in a group do not depend on each other, and a group starts when the rows it needs have merged. WB18, WB22, WB23, WB24 and WB27 are in flight; rows that need them wait for their merge.

### 11.1 New rows

| Row  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                | Size | Needs                                                                   | Group                      | Files                                                                                                                                                                                                                    | Tests                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WB37 | Session web content store (section 5): per-session map, ids, final URL + Accept variant + SHA-256, memory only, 16/64 MiB LRU, turn-scoped entries for `no-store`/credentialed/non-public, cleared with the session, never forked; `ToolExtras.sessionId` (IDE and CLI)                                                                                                                                                              | M    | WB24                                                                    | 2                          | `core/util/web/contentStore.ts` (new), `core/index.d.ts`, `core/tools/callTool.ts`, session delete/clear paths in `core/core.ts`, CLI session service                                                                    | two sessions isolated; `no-store` entry gone after the turn and never reused by a fetch; eviction order; non-public entry turn-scoped; nothing written to disk (fs spy)                                                                                                                  |
| WB38 | Windows and outline (section 4.1, 4.2): token counting for the active model, line splitting with virtual lines, window size from context length, 25% slack, pages, outline from headings, JSON key outline, `grep` with sections                                                                                                                                                                                                     | S    | none                                                                    | 1                          | `core/util/web/window.ts`, `core/util/web/outline.ts` (new, pure)                                                                                                                                                        | page boundaries stable; outline caps and dropped-level note; 2,000-char virtual lines; grep literal fallback; token counts within 10% of the provider tokenizer on a fixture set                                                                                                         |
| WB39 | `fetch_url_content` large-page result (4.3 to 4.5): first window + outline + id, `grep` and `refresh` parameters, answering from the store, revalidation hook for WB25, spotlight every window, replace the 20,000-character cut and its truncation text; IS-1 per-fetch host-only cookie jar; IS-5 fresh agent per fetch                                                                                                            | M    | WB37, WB38, WB41, WB27 (`web.limits.windowTokens`, `web.cache.minutes`) | 3                          | `core/tools/definitions/fetchUrlContent.ts`, `core/tools/implementations/fetchUrlContent.ts`, `core/context/providers/URLContextProvider.ts`, `core/util/guardedFetch.ts` (jar), CLI `extensions/cli/src/tools/fetch.ts` | a 40k-token fixture returns window + outline + id; second fetch answered from the store; `refresh` refetches; cookie test (IS-6); exact `partial` text                                                                                                                                   |
| WB40 | `read_web_content` (IDE) and `ReadWebContent` (CLI): `section`, `page`, `offset`, `lines`, `grep`; re-check host rules and the level on read; `expired` and `not-found-id`                                                                                                                                                                                                                                                           | M    | WB39                                                                    | 4                          | `core/tools/definitions/webContent.ts` (new), `core/tools/implementations/webContentTools.ts` (new), `core/tools/index.ts`, `core/tools/roleTools.ts`, `extensions/cli/src/tools/readWebContent.ts` (new)                | each selector; section by number and heading; a domain blocked after the fetch is refused on read; IDE and CLI give identical text for a corpus                                                                                                                                          |
| WB41 | Typed outcomes (section 6.2): classify DNS (`ENOTFOUND` vs `EAI_AGAIN`), TLS, connect, timeout, status classes, `WWW-Authenticate` scheme and realm, `Retry-After` (both forms, RFC 9110§10.2.3), content type, robots, rule; return them as results with `status` codes instead of throwing; add "Do not retry it unchanged" to the existing hard refusals                                                                          | M    | WB24, WB22 (guard errors), WB18 (robots text only)                      | 2                          | `core/util/web/outcomes.ts` (new), `core/context/providers/URLContextProvider.ts`, `core/util/guardedFetch.ts`, `core/util/fetchUrlSafety.ts`, CLI `fetch.ts`                                                            | one fixture per code against a local server and a DNS stub; exact texts snapshotted; `@url` still shows a person-readable error                                                                                                                                                          |
| WB42 | Repeat guard (6.4): per-session key, answered-from-record, third identical call `repeat` counted in `REFUSAL_CAP`, "after the delay" windows, reset on a new person message                                                                                                                                                                                                                                                          | S    | WB37, WB41                                                              | 3                          | `core/util/web/repeatGuard.ts` (new), `core/util/turnEnd.ts`, `fetchUrlContent.ts`, CLI `fetch.ts`                                                                                                                       | 404 three times: one request on the wire, third result `repeat`, turn ends at the cap; 429 with `Retry-After: 2` answered from the record before, fetched after                                                                                                                          |
| WB43 | JS-page detector and browser-tool finder (7.1 to 7.3): pure detector with fixture corpus; finder over the registered tool list for `browser_navigate` + `browser_snapshot` or `category: web`                                                                                                                                                                                                                                        | S    | none                                                                    | 1                          | `core/util/web/needsJs.ts`, `core/util/web/browserTools.ts` (new, pure)                                                                                                                                                  | shells detected, short real pages not; finder returns the registered names for a server named `playwright` and for a renamed one                                                                                                                                                         |
| WB44 | `needs-js` result tails and the IDE card (7.2, 7.4); Playwright template with `--isolated` and `category: web` in the MCP wizard; CLI one-line hint                                                                                                                                                                                                                                                                                  | S    | WB43, WB41, MCPW1-5 (#798)                                              | 4                          | `fetchUrlContent.ts`, `gui/src/components/web/EnableBrowserCard.tsx` (new), `core/protocol/*`, MCP wizard templates, `extensions/cli/src/tools/fetch.ts`                                                                 | card shown once per session, never headless, never after "Don't ask again"; template writes `--isolated` and a pinned version; tail A names the registered tool                                                                                                                          |
| WB45 | Web policy area in core (section 8): `web` in `PolicyArea`, the levels `off` and `listed` valid for Web only, unset follows Tool use, presets and `presetOf`, `normalizePolicy`, ceiling, session grants and blocks, the decision order (8.3), cloud-metadata refusal in the tool, `web.robots: respect` as a floor, `web.enabled` interplay and the `web.policy` alias, Off withholding the web tools and `category: web` MCP tools | L    | WB27, WB21 (host rules; until it merges, `trustedDomains` stands in)    | 2                          | `core/tools/permissions/{policy,evaluate,settingsFile,approval}.ts`, `core/tools/permissions/webGrants.ts` (new), `core/tools/index.ts`, `core/util/fetchUrlSafety.ts`, `extensions/cli/src/permissions/policyLevels.ts` | every level × {allowed host, new host, granted host, URL in message, robots, private, redirect to unseen host} in IDE and CLI; absent `web` follows Tools; presets match; IDGAF table 8.6 row by row; workspace cannot set `levels.web`; `web.enabled: false` from a workspace locks Off |
| WB46 | GUI for the Web area: the Tool use dropdown row or picker row, the globe mark, Settings > Web > Policy, the Custom editor's Web select and "Web domains" group, the four-button ask card (6.3)                                                                                                                                                                                                                                       | M    | WB45                                                                    | 3                          | `gui/src/components/PolicyControls/*`, `gui/src/pages/config/sections/WebSection.tsx` (WB28) or `ToolsSection.tsx`, `gui/src/pages/config/sections/permissions/*`, the approval card                                     | GUI tests: follows Tool use until set; Off locked by `web.enabled`; card's session button adds a grant; Always writes `host:` with the subdomain toggle hidden for WB11 hosts                                                                                                            |
| WB47 | Browser panel buttons on the Web area (8.5): Allow/Block Once to session grants, Always to `permissions.yaml`, Ask about this domain, level in the header                                                                                                                                                                                                                                                                            | S    | WB31, WB45                                                              | 4                          | `gui/src/pages/web/*`, `core/protocol/*`                                                                                                                                                                                 | Once is gone after the session; Always rule appears in the file and in the Custom editor                                                                                                                                                                                                 |
| WB48 | CLI for the Web area: `--web`, `--policy web=`, `/policy web=`, the headless start-up line, the four-way prompt, `/web allow\|block` writing grants                                                                                                                                                                                                                                                                                  | S    | WB45, CO2 (#896)                                                        | 3                          | `extensions/cli/src/permissions/*`, `extensions/cli/src/slashCommands.ts`, headless policy                                                                                                                               | headless Cautious refuses a new host with the CO2 text naming `--policy web=`; `/web allow` grant lasts the session                                                                                                                                                                      |
| WB49 | User-Agent presets (section 10): data file, `web.userAgent` values, staleness test, update script, Settings Identity dropdown, provenance id, no client hints                                                                                                                                                                                                                                                                        | S    | WB17, WB27                                                              | 3                          | `core/util/web/userAgentPresets.json` (new), `scripts/update-user-agents.mjs` (new), `packages/fetch/src/webHeaders.ts` (WB17), `WebSection.tsx`                                                                         | workspace cannot set a preset; robots token stays `Continuous-User` under `browser:*`; no `Sec-CH-UA`; stale entry fails the test                                                                                                                                                        |
| WB50 | Reviewer job for Web at Automatic (8.2): prompt, inputs (URL, origin, host, messages; never the page), unsure asks, the built-in check gains 20 web items                                                                                                                                                                                                                                                                            | S    | WB45                                                                    | 3                          | `core/tools/permissions/auto/*`, reviewer prompts                                                                                                                                                                        | the check's web slice runs; a page body never appears in the reviewer request                                                                                                                                                                                                            |
| WB51 | Docs: `docs/customize/web.mdx` gains large pages and `read_web_content`, the outcome list, the Web level, the browser route and its limits; `PRIVACY.md` line for the store (memory only, session only)                                                                                                                                                                                                                              | XS   | WB39, WB41, WB45                                                        | 5                          | `docs/customize/web.mdx`, `PRIVACY.md`                                                                                                                                                                                   | docs lint                                                                                                                                                                                                                                                                                |
| WB52 | Measurement: a bench scenario set (a 60k-token docs page, a 404, a 403, a JS shell, a 429) run across the local and hosted models in the harness, counting refetches, tokens and task success before and after WB39 to WB42; decides WB12                                                                                                                                                                                            | S    | harness now; the after-run needs WB39, WB41, WB42                       | 1 (harness), 5 (after-run) | `bench/scenarios/web-*` (new)                                                                                                                                                                                            | the before-run lands with group 1; the after-run report goes in `plans/research/`                                                                                                                                                                                                        |

### 11.2 Parallel groups

| Group | Rows                                      | Starts when                                                                                                                   |
| ----- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1     | WB38, WB43, WB52 (harness and before-run) | now                                                                                                                           |
| 2     | WB37, WB41, WB45                          | WB24 (WB37, WB41), WB27 (WB45), WB22 and WB18 (WB41). WB45 can start on WB27 alone with `trustedDomains` standing in for WB21 |
| 3     | WB39, WB42, WB46, WB48, WB49, WB50        | WB37 + WB38 + WB41 (WB39); WB37 + WB41 (WB42); WB45 (WB46, WB48, WB50); WB17 (WB49)                                           |
| 4     | WB40, WB44, WB47                          | WB39 (WB40); WB43 + WB41 + #798 (WB44); WB31 + WB45 (WB47)                                                                    |
| 5     | WB51, WB52 after-run                      | WB39, WB41, WB42, WB45                                                                                                        |

**File overlap to plan around:**

- WB39, WB41 and WB42 all touch `fetchUrlContent.ts` and the CLI `fetch.ts`. WB41 merges first; WB39 and WB42 then rebase, or one agent takes WB39 and WB42 together.
- WB45 and WB46 share nothing but the protocol types.
- WB46 and WB49 both touch `WebSection.tsx` if WB28 has built it. Give them to one agent, or merge WB46 first.

### 11.3 Amendments to existing rows (proposed, not applied)

| Row                                      | Amendment                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WB9                                      | Paging (`start_index`, `max_length`) is superseded by WB39 and WB40 (window, outline, `read_web_content`). The link list stays.                                                                                 |
| WB12                                     | Stays deferred; WB52 decides it.                                                                                                                                                                                |
| WB16                                     | The open ask is settled by level (8.2): asks at Manual and Cautious, refused at Listed and unattended, followed and labelled at Permissive and IDGAF.                                                           |
| WB25                                     | Body storage moves into WB37. WB25 keeps freshness, revalidation, the per-host rate limit and `Retry-After`, and now produces the `rate-limited` and `host-limit` outcomes.                                     |
| WB27                                     | `web.policy`, the placeholder, is dropped before release, or read as `levels.web` with a deprecation notice if it has shipped. Adds `web.limits.windowTokens` and `web.cache.minutes` (if not already present). |
| #898 RB-4                                | The model text becomes the `robots` outcome in 6.2.                                                                                                                                                             |
| #898 7.5                                 | "Never sent" becomes IS-1's per-fetch host-only jar; the test changes accordingly (IS-6).                                                                                                                       |
| #898 7.2                                 | "this page needs JavaScript; open it in the Browser panel or a browser MCP server" becomes section 7.2's three tails.                                                                                           |
| `policy-areas.md`, `custom-policy.md` §4 | "Web under Tool use" and "no new areas" are superseded for the web by the owner's 2026-11-15 ask; Web is the sixth area.                                                                                        |

## 12. Kept for the owner

1. **UA-10** (unchanged from #898): the info URL in the `Continuous-User` comment. The default token is decided, and WB49 ships without the comment until this is answered.
2. **WB34** (unchanged from #898): an in-house JS-capable browser.
3. **Nothing else.** Everything in sections 3 to 10 is decided above. No row needs spend, and nothing proposed is irreversible: the store is memory only, and every level and preset is a setting.

## 13. Sources

RFCs, read through the `primarysource` RFC tools (status checked 2026-11-15):

- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html), HTTP Semantics, Internet Standard, current; 6 verified errata elsewhere, none on the sections cited (§10.2.3, §12.5.5, §15.5.2, §15.5.4, §15.5.5, §15.5.11, §15.6.4).
- [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html), HTTP Caching, Internet Standard, current; no verified errata (§4.2.1, §5.2.2.4, §5.2.2.5, §5.2.2.7, §6).
- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html), Additional HTTP Status Codes, Proposed Standard, current (§4).
- [RFC 6265](https://www.rfc-editor.org/rfc/rfc6265.html), HTTP State Management Mechanism, Proposed Standard, current (§5.3).
- [RFC 7763](https://www.rfc-editor.org/rfc/rfc7763.html), The text/markdown Media Type, Informational, current (§2).

Vendor and project pages (P unless marked), read 2026-11-15:

- Anthropic web fetch tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool; web search tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- OpenAI web search: https://developers.openai.com/api/docs/guides/tools-web-search
- Gemini URL context: https://aistudio.google.com/docs/url-context, https://aistudio.google.com/api-reference/generate-content
- Claude Code tools reference: https://code.claude.com/docs/en/tools-reference
- Codex config reference: https://learn.chatgpt.com/docs/config-file/config-reference
- MCP fetch server: https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/fetch/src/mcp_server_fetch/server.py and its README
- Cline tools: https://docs.cline.bot/tools-reference/all-cline-tools; browser action lineage (S): https://github.com/Kilo-Org/kilocode-legacy/blob/main/docs/legacy-ides/automate/tools/browser-action.md
- Jina Reader: https://jina.ai/reader/
- Firecrawl scrape: https://docs.firecrawl.dev/api-reference/endpoint/scrape
- Exa contents: https://docs.exa.ai/reference/get-contents
- Tavily extract: https://docs.tavily.com/documentation/api-reference/endpoint/extract
- Cloudflare Markdown for Agents: https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/, https://blog.cloudflare.com/markdown-for-agents/
- Perplexity: https://docs.perplexity.ai/docs/agent-api/tools.md, https://docs.perplexity.ai/docs/agent-api/tools/fetch-url-content.md, https://docs.perplexity.ai/guides/bots
- llms.txt: https://llmstxt.org/
- Playwright MCP: https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md

Not confirmed on a primary page, and so not relied on: Roo Code's browser tool page (did not render), Perplexity `search_context_size`, and ChatGPT agent browsing.
