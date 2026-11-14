# Open decisions: a memo for the owner

Status: research, 2026-11-11, from the "Later" and "Open decisions" sections of `plans/ROADMAP.md` at `0d4fe36f3`. Only rows marked "yes" under "Needs an owner" are covered, and only those that no other research area owns (reviewer and permissions rows belong to the security areas, the cache rows to the cache areas). Each entry gives a recommendation and what it costs. These are recommendations from reading, not measurements.

## 1. Decisions that the privacy audit changes

### Fate of `core/continueServer/` (roadmap: "delete with L7")

The directory holds `stubs/headers.ts`, which is what puts the machine id, OS, version and an upstream key on requests to the upstream proxy (privacy audit F1, F2). **Recommend: delete the headers stub now, not with L7.** L7 is a feature; the stub is a defect. Cost: the `@web` provider, the `search_web` tool and the remote docs crawler lose their only backend. That is the intent. If a web search is wanted later, make it a configured MCP server or a provider key the user supplies (Brave, Tavily, SearXNG), listed in the allowlist.

### `search_web` as a built-in tool

Options: (a) remove it; (b) keep it, off by default, and send nothing until a search provider is configured; (c) keep as is. **Recommend (b).** A tool every model sees but that needs a key the user chose costs one tool-list entry, which matters for caching (Track Z), so also hide it from the list while unconfigured. (c) is not defensible.

### Distribution channel for the `.vsix`

Today: GitHub Releases, Visual Studio Marketplace (trusted publishing), Open VSX (if the token exists). The row says "open", but the workflows already publish to all three. **Recommend: record the decision as made** (GitHub Releases is the reference, Marketplace and Open VSX are mirrors), and add what is missing: the privacy file, the NOTICE inside the package, an SBOM and a provenance attestation (rows PV4, PV6). Trade-off: each extra channel is another place a bad release lives; yanking a Marketplace version is slower than editing a GitHub release. Keep Open VSX only if the owner has signed the Eclipse agreement.

## 2. Release and CI

### Branch protection on `main` (CI1) and merge-gate required (CI16)

Two rows describe one action. **Recommend: apply it once**, with `merge-gate` as the sole required check, and keep the rollback command in `docs/ci-merge-gate.md`. Trade-off: until it is on, auto-merge cannot be trusted and an admin push can skip the gate; once on, a flaky aggregate job blocks everything, which the rollback command answers. The row's own condition (the gate has gone green on a real PR) can be checked now.

### MCP launch pin and YOLO (S5, X1b)

The row asks to confirm that a changed MCP launch re-asks at every level except YOLO. **Recommend: confirm the exception, but make YOLO announce and audit the re-pin** (already built per the row). The alternative (ask even at YOLO) makes YOLO unusable for anyone who edits an MCP server config while working; the cost of the exception is that a repository change to a server's command runs without a prompt for someone who chose YOLO. Since a repository's text must not become the user's policy (decided 2026-11-10), consider asking at YOLO only when the change came from a workspace file, not the user's own config.

### First-approval notice for an MCP server (S5-P2), YOLO announcement (B21)

Both are "proposed". **Recommend: accept both.** They are wording and logging changes, cheap, and each makes a silent state visible. The audit trail already exists (#481).

## 3. Network and local-server exposure

### A loopback `cn serve` without a token (S1-L1)

Any local process, including another user's on a shared machine and any browser page that can reach loopback, can drive an unauthenticated server that runs tools. **Recommend: a token by default**, printed once and stored in the config folder with user-only permissions, with `--no-token` as an explicit loud opt-out. Trade-off: a script or editor integration written for the old behaviour breaks once; documented in the release notes.

### Default of `readPolicy` in the sandbox compiler (S9-X3)

Open by default means a confined command can read home secrets. **Recommend: deny reads of the policy folders, `~/.ssh`, `~/.aws`, `~/.config/gh` and the OS credential stores by default**, with an allow list the user edits. Trade-off: some tools need `~/.gitconfig` and `~/.npmrc`; list those as read-allowed and say so. This matches the Confined definition in the vocabulary table ("our escape probes passed for the named properties").

### Whether project `prompts/` stay writable by the agent (S3-F4)

**Recommend: lock it like the rest of `.continue`.** A prompt file is text the product later feeds to a model as the user's own, so writable by the agent means an injected session writes the next session's instructions. Cost: the agent can no longer create a prompt file for you; it can propose one and you save it.

## 4. Model and research spending

### Haiku 5.5 as the Plan mode default

Evidence: matched Opus 5.5 on every plan criterion at one thirtieth of the cost, on three-file seeds. Blockers: the test account cannot run it and the bench has no Anthropic adapter. **Recommend: not yet, as the row says,** but unblock the measurement through the direct Anthropic API (a key already exists per the owner's notes) rather than waiting on AWS quota. Ship the default only with a measured n of at least 5 on the harder seeds.

### Bedrock quotas (Claude 5.x at zero)

**Recommend: stop pursuing AWS Support in parallel with the direct API.** Two requests were auto-closed; the error text points to AWS Sales. Use the direct API or EU regions for tests, and keep Bedrock tests to the families the account can run. A support case costs time, not money, so file one more only if a Bedrock-specific path (Mantle) needs it.

### Hosted-model spend for TR12 and the `--repeat 3` run (B53)

Both are small (the B53 figure is about USD 0.48). **Recommend: approve B53 now** (it closes a variance question at trivial cost) and **hold TR12** until the free lab results are in, as the row says.

## 5. Parsers and command analysis

### POSIX parser (D1) and PowerShell parser (D2)

D1: tree-sitter-bash with our own gate. D2: our own strict subset at run time, PowerShell's parser as a CI oracle. **Recommend: accept both.** Trade-offs: tree-sitter-bash ships a WASM or native binary in the bundle (size, and one more third-party licence to put in the notices file, row PV4); a strict PowerShell subset refuses valid scripts, which is the safe failure for a permissions check. Do not call `powershell.exe` at run time to parse: it starts a process per check and is the thing being guarded.

## 6. Prompt and cache behaviour

### Read rules and `AGENTS.md` once per session (C55)

**Recommend: read once per session, rebuild on `/reload`,** as the planning default says. Cost: an agent that edits its own instructions file sees the change only after `/reload`; the audit trail should record that the file changed so the person knows. Gain: a stable cached prefix. Measure on one real session before it becomes the shipped default, as the row says.

### Mode text placement (TR10), tagged rules format (TR10), orchestrator and background as uses (TR13)

These change prompt bytes once for every user, so batch them: **decide all three in one release** so the cache goes cold once. Recommend: leave mode text where it is until K18 slice 2; adopt one tagged format for rules (CLI and IDE) in that same release; make orchestrator and background modes of `agent` and `loop` first and promote to uses only if a measurement asks for separate models.

### Plan mode and MCP (TR2), MCP in unattended runs (TR1, TR3), new tools from a changed server (TR4), reviewer excerpt (TR8)

These are the security areas' to answer; where the row already says "recommended", **accept the recommendations as written** (read-only trusted MCP tools in Plan, none unattended unless listed, new tools hidden until approved). Reviewer excerpt: defer until the reviewer eval asks for it, since the first real run failed the floor gate and the reviewer is experimental.

## 7. Items in "Later" worth an owner glance

None needs a decision. Three have a cost worth knowing: the per-use reasoning-effort split depends on mid-task fixtures (I10) not existing yet; the LLM grader for plan-ask criteria needs hosted-model spend (see section 4); and the Strata server settings (`--conversation-cache-min-tokens`, 8 slots) are requests to another project, not our work. Everything else is research queue.

## 8. Proposed ROADMAP rows (ids TBD)

| Id      | Row                                                                                                                                | State |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----- |
| OD1 TBD | Delete `core/continueServer/stubs/headers.ts` now and make `search_web` configured-or-hidden; do not wait for L7 (privacy row PV1) | open  |
| OD2 TBD | Record the distribution channel decision: GitHub Releases primary, Marketplace and Open VSX mirrors; close the "open" row          | open  |
| OD3 TBD | Token by default on loopback `cn serve` with `--no-token` as the opt-out (S1-L1, X11)                                              | open  |
| OD4 TBD | Sandbox `readPolicy` denies policy folders and credential stores by default, with a small read-allow list (S9-X3)                  | open  |
| OD5 TBD | Lock project `prompts/` against agent writes (S3-F4)                                                                               | open  |
| OD6 TBD | Batch TR10 and TR13 prompt-byte changes into one release so the cache goes cold once                                               | open  |
| OD7 TBD | Approve the B53 `--repeat 3` spend; measure Haiku 5.5 through the direct Anthropic API instead of waiting for Bedrock quota        | open  |
