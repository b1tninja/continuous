## New

- Web is a policy area of its own, with seven levels: Off, Manual, Cautious, Listed (only domains you allowed, never asks), Automatic, Permissive and IDGAF. Set it with `levels.web` in `permissions.yaml`, or in `cn` with `--policy web=<level>` (for example `--policy tools=permissive,web=listed`). Until you set it, Web follows Tool use, so the levels you saved keep their meaning. The presets set it too: Careful and Accept edits give Cautious, Hands off Permissive, Reviewer Automatic, IDGAF IDGAF; Off and Listed make the preset read Custom.
- At Cautious, a fetch runs without asking when you allowed its host: a `host:` rule in the `allow:` list of your `permissions.yaml` (`host:docs.example.com`, or `host:*.example.com` for the subdomains, matched on whole labels), a domain in your `trustedDomains`, an allow rule, the host allowed for this session, or the exact URL you wrote in your message. There is no built-in list of allowed hosts.
- `cn` asks about a fetch with **Allow `<host>` for this session**, **Always allow `<host>`** (adds `host:<host>` to your `permissions.yaml`) and **No**.
- `levels.web: off` refuses the agent's web tools (fetch and search; `cn` stops offering them) and leaves `@url` working. `web.enabled: false` in any config.yaml, a project's included, turns off every web fetch: the agent's tools, `@url` and the docs crawler. Only your own config.yaml can turn it back on.
- The headless start-up line of `cn -p` and `cn serve` names the Web level and what happens to a fetch there, for example `Web Cautious (unattended: public hosts still run in this release; from 2.38 only allowed domains)`.

## Behaviour changes

- In interactive `cn`, `Fetch` now follows the Web level: at Cautious (the default) a fetch to a host you have not allowed asks, where it used to run. `--allow Fetch` or `--policy web=permissive` keeps every host running. "Always allow" on a fetch now writes `host:<host>` instead of `Fetch`, so it never allows every URL.
- Headless `cn -p` and `cn serve` keep running fetches to public hosts in this release, and print one line on standard error at the first such fetch: from 2.38 a headless fetch follows your Web level, so at Cautious only hosts you allowed run.
- A fetch to a domain in `trustedDomains` now runs without asking at Cautious and Automatic, where it used to ask. While the list is set, every other host still asks.
- A fetch to a cloud metadata service (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, `metadata.google.internal`, `metadata.goog`, in any spelling, or a name that resolves to one) is now refused at every level, IDGAF included, as the start URL and at every redirect. It used to ask, like other private addresses. A URL with a user name or password in it is now refused by the permission layer too, as the fetch already did.
- At IDGAF, your own `floor:` rules now bind on web fetches, alongside the fetch's built-in safety checks.
