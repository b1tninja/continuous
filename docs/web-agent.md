# Continuous-User and Continuous-Crawler

This page is for site operators who found `Continuous-User` or `Continuous-Crawler` in their logs.

[Continuous](https://github.com/b1tninja/continuous) is an open-source coding assistant (a VS Code and JetBrains extension and a terminal agent) that runs on the user's own machine. It is a community fork of Continue. Requests come from the user's machine, not from a service of ours: there is no central crawler and no shared address range.

## The two tokens

| User-Agent                                          | What sends it                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Continuous-User/<major>.<minor> (+<this page>)`    | A fetch made for one person: they named the URL, or their assistant read one page while working on their request |
| `Continuous-Crawler/<major>.<minor> (+<this page>)` | The docs indexer, which crawls a documentation site the person added to their configuration                      |

The string carries the product and its release, and nothing about the person: no operating system, no editor, no machine or session id. A person can change it in their own configuration, so not every request from the software carries these tokens.

A request to the person's own search endpoint carries `Continuous-User/<major>.<minor>` without the link to this page. The docs indexer's GitHub mode uses the GitHub API and sends that client's own string.

Releases 2.26 and earlier send `node-fetch` instead (and the docs indexer's browser mode a Chrome string).

## robots.txt

Both tokens are valid `robots.txt` product tokens (RFC 9309), so a group can name either one. The check is made under these tokens even when the person has chosen another User-Agent string: the agent checks `robots.txt` as who it is, not as what it sends. For example:

```
User-agent: Continuous-Crawler
Disallow: /

User-agent: Continuous-User
Disallow: /private/
```

The planned behaviour, being built now:

- `Continuous-Crawler` follows RFC 9309: the most specific rule wins, a 4xx for `robots.txt` allows, a 5xx or a network error disallows, the file is cached for at most 24 hours, and `Crawl-delay` is honoured. It sends at most two requests at a time to a host, at least one second apart.
- `Continuous-User` checks `robots.txt` when the assistant picked the URL itself. A disallow is shown to the person, who decides whether to fetch the page; unattended runs refuse. A URL the person typed or pasted is a person reading a page and is not checked, as for other user-directed agents.

`robots.txt` is not access control. To keep the agent out, refuse the request.

## Other behaviour

- No cookies are sent or stored and no `Referer` is sent. `From` and `Accept-Language` are sent only if the person configured them.
- Each fetch reads one page, with a size cap (2 MiB by default) and a time limit (20 seconds). A limit of 10 requests per host per minute from one person's session is planned.
- Requests are not signed. Web Bot Auth is not implemented, because a per-install key would identify the person across sites.

## Contact

Open an issue at <https://github.com/b1tninja/continuous/issues>.
