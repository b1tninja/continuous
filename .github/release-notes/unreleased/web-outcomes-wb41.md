## Behaviour changes

- A web fetch that does not return a page (`fetch_url_content` in the editor, `Fetch` in `cn`) now comes back as a normal tool result that says what happened and whether retrying can help, instead of a bare error such as `HTTP 404 Not Found`. Each result has a typed code: `not-found`, `gone`, `forbidden`, `auth-required`, `rate-limited` (with the wait from `Retry-After`), `server-error`, `client-error`, `timeout`, `dns`, `dns-temporary`, `tls`, `connection`, `not-text`, `needs-js` (an application shell that needs JavaScript), `needs-cookies` (a redirect loop that sets cookies, such as a sign-in or consent wall) and `refused`. In the editor the code is the result's `status`. Response bodies are never quoted.
- The existing refusals (a non-http URL, a user name or password in the URL, a credential-shaped value, a redirect to a non-public address) keep their wording and now end with "Do not retry it unchanged."
- `@url` shows the first sentence of the same outcome when a page cannot be read, for example `Not found: docs.example.com answered 404 for /v2/guide.`

## Fixes

- `cn`'s `Fetch` no longer leaves console errors silenced after a failed fetch.
