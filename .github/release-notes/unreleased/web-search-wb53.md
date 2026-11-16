## New

- Web search reads `web.search` in your own `config.yaml`: `provider: searxng` (your SearXNG server, also chosen by a `url` with no provider) or `provider: custom` (your own endpoint, `GET` in the SearXNG shape or `POST` with a `{"q": "..."}` body, the shape of Claude Desktop's custom search server). `maxResults` and `safeSearch` are in force. Search stays off until you pick a provider, and `@web` says why when it is not available.
- A workspace, assistant or hub config may only tighten search: `provider: off`, lower limits or a stricter `safeSearch`. A provider, URL or key it names is ignored with a notice.
- Search requests send `User-Agent: Continuous-User/<major>.<minor>`, with no info URL, or your `web.userAgent` preset.

## Behaviour changes

- `CONTINUOUS_WEB_SEARCH_URL` and `CONTINUOUS_WEB_SEARCH_KEY` still work, now with a deprecation notice: use `web.search.url` and `web.search.apiKey`. They are not used when `web.search` names a provider or a URL.
- A key typed into `web.search.apiKey` (rather than `${{ secrets.NAME }}`) is used with a warning in the config errors and in `continuous doctor config`. A later minor release refuses it.
