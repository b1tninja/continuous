## New

- Web is a policy area of its own, with seven levels: Off, Manual, Cautious, Listed (only domains you allowed, never asks), Automatic, Permissive and IDGAF. Set it with `levels.web` in `permissions.yaml`, or in `cn` with `--policy web=<level>` (for example `--policy tools=permissive,web=listed`). Until you set it, Web follows Tool use, so nothing you saved changes meaning. The presets set it too: Careful and Accept edits give Cautious, Hands off Permissive, Reviewer Automatic, IDGAF IDGAF; Off and Listed make the preset read Custom.
- At Cautious, a fetch to a host you allowed for this session, or to the exact URL you wrote in your message, runs without asking.
- `levels.web: off` refuses the agent's web tools (fetch and search; `cn` stops offering them) and leaves `@url` working. `web.enabled: false` in any config.yaml, a project's included, turns off every web fetch: the agent's tools, `@url` and the docs crawler. Only your own config.yaml can turn it back on.
- The headless start-up line of `cn -p` and `cn serve` names the Web level and what an ask becomes there, for example `Web Cautious (unattended: only allowed domains)`.

## Behaviour changes

- A fetch to a cloud metadata service (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, `metadata.google.internal`, `metadata.goog`, in any spelling, or a name that resolves to one) is now refused at every level, IDGAF included, as the start URL and at every redirect. It used to ask, like other private addresses. A URL with a user name or password in it is now refused by the permission layer too, as the fetch already did.
- At IDGAF, your own `floor:` rules now bind on web fetches, alongside the fetch's built-in safety checks.
