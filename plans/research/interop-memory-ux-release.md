# Research: agent interop, memory, UX and release engineering

Last updated: 2026-11-11. Status: research, docs only (draft, extended in later commits). Nothing here was run against a model, a GPU or the repository settings; every `gh api` call was a read. All web pages were fetched on 2026-11-11 and are cited by URL; protocol claims about IETF documents are not made here (none were needed: the MCP and ACP pages cite RFC 9207 and RFC 7591 only by name, and those names are quoted from the MCP changelog, not restated).

Scope: ROADMAP Tracks O (parallel agents and agent interop), V (memory and session history), UX (chat, settings and permissions surfaces) and CI (merge safety, supply chain and release hygiene). Built state was read from `plans/ROADMAP.md`, `docs/ci-merge-gate.md`, `.github/workflows/*`, `extensions/cli/src/acp/*`, `plans/agent-interop-acp.md` and `plans/memory-and-history.md` on origin/main at 0d4fe36f3.

## 0. Summary

1. The interop picture moved since `agent-interop-acp.md` (2026-11-10). MCP revision 2026-07-28 is a real, published revision (it was "unverified" there) and it is stateless: no `initialize` handshake, no `Mcp-Session-Id`, tasks moved to an extension, sampling, roots and logging deprecated, DCR deprecated in favour of Client ID Metadata Documents. Our MCP client must handle both the old handshake and the new `server/discover` plus per-request `_meta`.
2. ACP has stabilised `session/list`, session resume, session config options and elicitation, and published a v2 Draft on 2026-07-20 that asks agents to keep v1 and not ship v2 by default. Our `continuous acp` advertises `loadSession: false` and `mcpCapabilities {http:false, sse:false}`; the cheap, high-value step is `session/list` plus resume, which needs per-session history in the CLI (Track V V4).
3. AGENTS.md is now read natively by Claude Code (v2.1.277 and later, only when no CLAUDE.md exists above the working directory by default), Codex, Cursor and about two dozen others. We already read it; the gap is nested-file precedence and a byte cap (Codex 32 KiB).
4. Agent Skills is a small, stable format (`SKILL.md`, `name`, `description`, optional `license`, `compatibility`, `metadata`, experimental `allowed-tools`). A validator against that spec is a one-day item.
5. Memory: the field splits into human-written rules (CLAUDE.md, AGENTS.md, Cursor rules), agent-written notes (Claude auto memory, Cline memory bank, Codex memories) and service memory (Mem0, Letta). Codex memories are off by default and redact secrets on write; Claude auto memory is on by default and machine-local. A minimal design for us is opt-in, scrub on write, plain markdown, per-repo, with `/memory` show, edit and delete.
6. The repository already uses npm-style OIDC for the Marketplace (`vsce publish --oidc`), which is ahead of most. Gaps: `main` is not protected (`gh api .../branches/main` reports `protected: false`, no rulesets), most actions are pinned by tag not SHA, no build provenance attestation, no SBOM, Open VSX still uses a token.
7. VSIX signing by the publisher is not available in `vsce` as far as any source found shows; the Marketplace signs on its side. Do not plan for `vsce publish --sign`.

## 1. What is built (verified from the tree)

| Area                   | State on main                                                                                                                                                                       | Evidence                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| ACP server             | First slice: `initialize`, `session/new`, `session/prompt`, `session/cancel`, updates, `session/request_permission` failing closed. No `session/load`, no `fs/*`, no `terminal/*`   | `extensions/cli/src/acp/agent.ts` (`loadSession: false`, `mcpCapabilities: { http: false, sse: false }`), ROADMAP O10 |
| Agent registry and map | Slice 1 built (#530); identity in the audit envelope (O12) and Inbox (O18) not started                                                                                              | ROADMAP O11, O12, O18                                                                                                 |
| Memory and history     | Plan only (V0, V1, V4 not started); masking of old tool results built behind a flag (VA1 #453, VA2 #467)                                                                            | ROADMAP Track V                                                                                                       |
| Merge gate             | `merge-gate` workflow built, protection NOT applied; `merge_group` trigger present but the PR workflows have none                                                                   | `docs/ci-merge-gate.md`, `gh api` (read)                                                                              |
| Post-merge check       | Built, reports an issue when `main` is red                                                                                                                                          | `post-merge-check.yml`                                                                                                |
| Supply chain           | Pins script, screenshots lockfile, advisory `supply-chain.yml` with dependency review                                                                                               | ROADMAP CI4                                                                                                           |
| Release                | `Publish Extension` uses `vsce@4.1.0 publish --oidc`, per-platform VSIX, environment `marketplace`; Open VSX with token and `ovsx@1.3.0`; pre-release workflow with `--pre-release` | `.github/workflows/main.yaml`, `preview.yaml`                                                                         |
| UX                     | UX1, UX2, UX3 built; UX13 (axe on new screenshot states) not started                                                                                                                | ROADMAP Track UX                                                                                                      |

Repository settings read with `gh api repos/b1tninja/continuous` on 2026-11-11: public, owner type User, `allow_auto_merge: true`, `delete_branch_on_merge: false`, secret scanning and push protection enabled, Dependabot security updates enabled, default workflow token permission `read`, `sha_pinning_required: false`, rulesets list empty, branch `main` not protected.

## 2. Interop protocols (a)

### 2.1 MCP, revision 2026-07-28

Source: https://modelcontextprotocol.io/specification/2026-07-28/changelog (fetched 2026-11-11). This verifies the claims `agent-interop-acp.md` marked unverified.

| Change                                                                                                                                                                                                      | What it means for us                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Stateless protocol: no `initialize`/`initialized`, each request carries `io.modelcontextprotocol/protocolVersion` and client capabilities in `_meta`; `server/discover` is mandatory for servers (SEP-2575) | Client must try `server/discover` and fall back to the handshake for older servers; keep both paths |
| Streamable HTTP: no `Mcp-Session-Id`, no SSE resumability or `Last-Event-ID`; a broken stream loses the in-flight request and the client re-issues it                                                       | Retry logic on tool calls over HTTP must re-issue, not resume                                       |
| `subscriptions/listen` replaces the GET endpoint and `resources/subscribe`                                                                                                                                  | Only matters if we consume list-changed notifications                                               |
| Tasks moved to extension `io.modelcontextprotocol/tasks`: polling with `tasks/get`, `tasks/update`, no `tasks/list`                                                                                         | The "session as an MCP task" idea (interop step 7) can now be read from an official extension text  |
| Multi Round-Trip Requests: `InputRequiredResult` with `inputRequests`, client retries with `inputResponses`; replaces server-initiated `elicitation/create`, `roots/list`, `sampling/createMessage`         | Elicitation support means handling `resultType: "input_required"` and retrying, not a server push   |
| Roots, Sampling, Logging deprecated (SEP-2577); HTTP+SSE transport deprecated; minimum 12-month deprecation window                                                                                          | Do not build sampling or roots; log to stderr                                                       |
| DCR (RFC 7591) deprecated in favour of Client ID Metadata Documents; `iss` validation (RFC 9207) MUST; credentials keyed by issuer                                                                          | OAuth for streamable-http (fork plan) should implement CIMD first and `iss` check                   |
| `ttlMs` and `cacheScope` on list results; deterministic `tools/list` order SHOULD                                                                                                                           | Direct cache win: stable tool order is what Track C wants                                           |
| `structuredContent` may be any JSON; `outputSchema` any 2020-12 keywords                                                                                                                                    | Use for tool results that feed other tools                                                          |
| OpenTelemetry trace context in `_meta` (`traceparent`)                                                                                                                                                      | Pass through for audit correlation                                                                  |

### 2.2 ACP

Sources: https://agentclientprotocol.com/llms.txt, /announcements/acp-v2-draft.md, /get-started/clients.md, /get-started/introduction (all fetched 2026-11-11).

- Stabilised in v1 (announcement titles): Session List, Session Resume, Session Config Options, Elicitation. Session Delete is a v1 page. Remote (HTTP or WebSocket) is "a work in progress".
- v2 Draft published 2026-07-20: updates can arrive outside a turn; messages, tool calls and terminal output are patched by stable ids; diffs become structured file changes (add, delete, modify, move, copy) with optional `git_patch`; permission requests get `title`, `description`, `subject` and are not tied to a tool call. Guidance to agents: keep v1, gate v2 behind negotiation, do not ship v2 by default.
- Clients listed (editors): JetBrains, Zed, Emacs (agent-shell), Neovim (four plugins), Sublime Text, Qt Creator, Pulsar, Visual Studio Code (five extensions), Visual Studio (via a vendor assistant), Unity, Obsidian, and several new editors. This confirms the editor list the earlier plan took from secondary sources.
- RFDs worth tracking: session fork, subagent sessions, session usage (context size and cost), session compaction, MCP-over-ACP, Streamable HTTP and WebSocket transport.

What a client expects from an agent (from our plan plus the v1 pages): newline-delimited JSON-RPC on stdout only; `session/update` with tool calls that carry `kind`, `status`, `locations` and `diff` content; permission options with the four kinds; `session/cancel` answered with `stopReason: cancelled`; and now `session/list` and resume so the editor's history panel works.

### 2.3 A2A

Source: https://a2a-protocol.org/latest/ (fetched 2026-11-11): v1.0 specification, six official SDKs, Linux Foundation governance, joined the Agentic AI Foundation (blog dated 2026-08-27). Decision unchanged: do not build. Reuse the task state vocabulary only.

### 2.4 Rules files: AGENTS.md, CLAUDE.md, Cursor, Codex

| Tool                 | What it reads                                                                                                                                     | Precedence and limits                                                                                                                                                             | Source                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| AGENTS.md convention | `AGENTS.md`, nested per directory                                                                                                                 | Nearest file wins; explicit user chat prompt overrides all; no required fields                                                                                                    | https://agents.md                                            |
| Claude Code          | `CLAUDE.md` (project, user, org, `.claude/CLAUDE.md`, `.claude/rules/` with `paths:`), reads `AGENTS.md` natively from v2.1.277                   | Default `claude-md-or-agents-md`: AGENTS.md only when no CLAUDE.md or CLAUDE.local.md at or above the working directory; option to load both; `@path` imports; `claudeMdExcludes` | https://code.claude.com/docs/en/memory                       |
| Codex                | `~/.codex/AGENTS.override.md` or `AGENTS.md`; per directory from repo root down: override, then AGENTS.md, then fallback names                    | One file per directory, joined root to leaf, later overrides earlier; stops at `project_doc_max_bytes` (32 KiB default)                                                           | https://learn.chatgpt.com/docs/agent-configuration/agents-md |
| Cursor               | `.cursor/rules/*.mdc` (frontmatter `description`, `globs`, `alwaysApply`; plain `.md` ignored), User Rules, Team Rules, AGENTS.md root and nested | More specific wins; four apply modes                                                                                                                                              | https://cursor.com/docs/context/rules                        |

### 2.5 Agent Skills

Source: https://agentskills.io/specification (fetched 2026-11-11). Directory with `SKILL.md`; frontmatter `name` (1 to 64, lowercase, digits, hyphens, no leading, trailing or double hyphen, equals the directory name), `description` (1 to 1024), optional `license`, `compatibility` (max 500), `metadata` (string map), experimental `allowed-tools` (space-separated). Optional `scripts/`, `references/`, `assets/`. Progressive disclosure: about 100 tokens of metadata at start, body under 5000 tokens when activated, files on demand; keep `SKILL.md` under 500 lines; validate with `skills-ref validate`.

Compatibility matrix (what to support next, from the spec; per-tool claims other than Claude Code are not verified here):

| Feature                                   | Spec         | Us today                                 | Next                                                           |
| ----------------------------------------- | ------------ | ---------------------------------------- | -------------------------------------------------------------- |
| Discovery of `SKILL.md` directories       | yes          | to be checked in the experiment E1 below | read `.agents/skills` and `.claude/skills`, user and project   |
| Metadata-only preload, load on activation | yes          | n/a until E1                             | cap at the spec's token figures                                |
| `allowed-tools`                           | experimental | do not honour as a grant                 | map to our policy engine as a hint only; never bypass approval |
| `compatibility` field                     | optional     | ignore                                   | show in the list                                               |
| Validator                                 | `skills-ref` | none                                     | run in CI on bundled skills                                    |

## 3. Memory and session history (b)

### 3.1 The field

| System                  | Writes                                    | Stores                                                                                                                   | Retrieval                                                                           | Default                 | Privacy notes                                                                                      | Source                                                            |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Claude Code CLAUDE.md   | person                                    | markdown files, several scopes                                                                                           | loaded whole at start, imports, path-scoped rules                                   | on                      | files may be committed                                                                             | https://code.claude.com/docs/en/memory                            |
| Claude Code auto memory | model                                     | `~/.claude/projects/<project>/memory/`, project from the git repo so worktrees share it; `autoMemoryDirectory` overrides | first 200 lines or 25 KB loaded each session; `/memory` toggle, `autoMemoryEnabled` | on                      | machine-local                                                                                      | same                                                              |
| Codex memories          | model, in background after a chat is idle | generated files under `~/.codex/memories/`                                                                               | summarised context from eligible prior chats                                        | off; `memories = true`  | secrets redacted from generated fields, review before sharing; `/memories` per chat; delete action | https://learn.chatgpt.com/docs/customization/memories?surface=app |
| Cline memory bank       | model, on instruction                     | six markdown files in `memory-bank/` (brief, product, active context, patterns, tech, progress)                          | instructions say read all at task start                                             | opt-in by pasting rules | stale files mislead; maintenance is manual                                                         | https://docs.cline.bot/features/memory-bank                       |
| Cursor                  | rules only on the page fetched            | `.cursor/rules`                                                                                                          | by rule type                                                                        | n/a                     | the page does not mention memories, status unverified                                              | https://cursor.com/docs/context/rules                             |
| Mem0                    | service extracts facts from messages      | managed store, scopes user, agent, app, run                                                                              | relevant memories at query time                                                     | n/a                     | retention, export and delete not stated on the overview page                                       | https://docs.mem0.ai/overview                                     |
| Letta                   | agent edits blocks                        | V1: memory blocks (`human`, `persona`); Agent SDK: git-tracked MemFS                                                     | blocks in context                                                                   | n/a                     | V1 SDK being deprecated; archival and recall pages not read                                        | https://docs.letta.com/concepts/memgpt                            |

Not verified: Cursor's memory feature, Mem0 retention and export, Letta archival memory. Session retention in Claude Code (`cleanupPeriodDays`) did not appear on the settings page fetched; do not state a default.

### 3.2 Minimal design for us (proposal)

1. Two stores, both plain markdown, per repository: `rules` (human-written, AGENTS.md and the existing instruction files) and `notes` (model-written, `.continue/memory/` outside git by default).
2. Opt-in, off by default (matches Codex, differs from Claude): fits the local-first and secret-sensitive posture and the existing scrub-on-write rule.
3. Scrub on write: run the existing secret scrubber over every note before it touches disk, and over the quoted tool output if a note includes any; refuse to write if the scrubber changed more than N lines (suspect paste of a credential file).
4. Load budget: first 200 lines or 25 KB, like Claude, so the cost is bounded and the cache prefix is stable; the notes file is a cache segment (Track C).
5. Surface: `/memory` shows, edits, deletes, disables for this repo and this chat; export and import are a zip of the markdown (no format to invent).
6. Cross-session search: over the Track V V4 append-only log with an offset index (V8), not a vector store; full text first.
7. Retention: default none for notes (kept until deleted); session logs follow `history` settings; a visible "delete everything for this repo" action.
8. Resume and ACP: the same per-session log gives `session/list` and `session/load`.

## 4. UX and accessibility (c)

Sources: https://code.visualstudio.com/api/extension-guides/webview (fetched 2026-11-11): webviews get `vscode-light`, `vscode-dark`, `vscode-high-contrast` body classes, `--vscode-*` colour variables, `vscode-using-screen-reader` and `vscode-reduce-motion` classes; the guide says to always test in high-contrast mode.

Checklist (status T is superseded by the verified findings in section 4.1 below the table; WCAG 2.2 criteria from https://www.w3.org/TR/WCAG22/, fetched 2026-11-11: new in 2.2 are 2.4.11 Focus Not Obscured (Minimum, AA), 2.5.7 Dragging Movements (AA), 2.5.8 Target Size (Minimum, AA), 3.2.6 Consistent Help (A), 3.3.7 Redundant Entry (A), 3.3.8 Accessible Authentication (Minimum, AA)):

| #   | Item                                                                                                                                          | Status                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Honour `vscode-reduce-motion` and `vscode-using-screen-reader` classes                                                                        | T                          |
| 2   | Approval dialog: names the tool, shows exact command or diff, default focus on the safe choice, Esc denies, all actions reachable by keyboard | T                          |
| 3   | Diff review: per-hunk accept and reject, keyboard stepping, a text alternative to colour                                                      | T                          |
| 4   | Contrast 4.5:1 text, 3:1 non-text, in light, dark and high contrast                                                                           | UX3 built; high contrast T |
| 5   | Targets at least 24 px (WCAG 2.2 target size minimum)                                                                                         | UX4 planned                |
| 6   | Named controls, roving tabindex toolbars                                                                                                      | UX2 built, UX4 planned     |
| 7   | Loading, empty and error states with retry                                                                                                    | UX8, UX13 planned          |
| 8   | Live region for streaming and approval requests                                                                                               | T                          |

### 4.1 Gaps verified from the code (grep on origin/main 0d4fe36f3, `gui/src`)

| Finding                                                                                                                                                                                                                                              | Evidence                                                           | Maps to              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------- |
| No handling of the VS Code body classes `vscode-reduce-motion`, `vscode-using-screen-reader` or `vscode-high-contrast`; only the OS media query `prefers-reduced-motion` is used (`index.css:117`, `GradientBorder.tsx:66`). No `forced-colors` rule | grep for the three class names and `forced-colors` returns nothing | new row UX-TBD2      |
| The chat stream has no live region: `aria-live` appears only in the Permissions states (`PermissionsStates.tsx`, `PermissionsSection.tsx`, `RuleChangeForm.tsx`, `RuleTester.tsx`); `StepContainer.tsx` and `ThinkingIndicator.tsx` have none        | grep `aria-live`                                                   | new row UX-TBD3      |
| The tool-approval toolbar (`PendingToolCallToolbar.tsx`) has no `role`, no `aria-label` and no live announcement when an approval appears; its only `aria-` use is `aria-hidden` on icons                                                            | grep of the file                                                   | UX-TBD3; extends UX6 |
| Errors do use `role="alert"` in 9 places (loop controls, inbox, question panel, provider setup, Bedrock tester, policy controls)                                                                                                                     | grep `role="alert"`                                                | good; keep           |
| Permissions editor handles Escape and returns focus to "Add a rule" (`RuleChangeForm.tsx:140`, test in `PermissionsEditor.test.tsx:250`); Permissions loading uses `role="status"` with `aria-busy`                                                  | read                                                               | good                 |
| Permissions files carry few `aria-label`s (`PermissionsSection` 8, `EditableRules` 5, `RuleTester` 1, `Locks` 1) and `badges.tsx` none: chips that carry state by colour need a text name                                                            | `grep -c aria-label`                                               | UX3 follow-up        |
| Whether an approval can be answered by keyboard alone, and focus order inside the approval toolbar, was not determined from reading; needs the axe and keyboard test below                                                                           | not verified                                                       | E5                   |

### 4.2 axe-core on the screenshot harness

The harness (`bench/screenshots/src/shoot.mjs`) already drives Chromium through `playwright-core@1.64.0` (`bench/screenshots/package.json`), opens each state and waits for `window.__shotReady`. `@axe-core/playwright` (https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/README.md, fetched 2026-11-11) takes a Playwright `page`, so the integration is one call after `__shotReady` and before `page.screenshot`: `new AxeBuilder({ page }).withTags(["wcag2a","wcag2aa"]).analyze()`, write `violations` per state into `manifest.json`, fail on a baseline diff rather than on zero (so the first run records today's debt). Details to settle in the experiment: the package declares `playwright` as its peer and the harness vendors `playwright-core` (check compatibility); the README examples show `wcag2a` and `wcag2aa` only, so check that a `wcag22aa` tag exists in the pinned axe-core before relying on 2.2 rules; the target-size rule and colour contrast on the three themes in `harness/themes.ts` need a run per theme. Pin the versions exactly, as `supply-chain.md` requires for `playwright-core`.

## 5. Release engineering (d)

### 5.1 Publishing

- Marketplace: https://code.visualstudio.com/api/working-with-extensions/publishing-extension (fetched 2026-11-11). Global Azure DevOps PATs are retired on 2026-12-01 per that page; recommended is Trusted Publishing from GitHub Actions with `vsce publish --oidc` (credential lives 15 minutes, each OIDC token exchanged once) or Entra with `--azure-credential`. We already do this (`main.yaml`, `preview.yaml`). `--pre-release` takes `major.minor.patch` only and needs a different version from the release; `--target` publishes platform-specific VSIX (we build a matrix). Verified publisher needs a DNS TXT record, a publisher at least 6 months old and a domain at least 6 months old.
- Open VSX: https://github.com/eclipse/openvsx/wiki/Publishing-Extensions (fetched 2026-11-11): Eclipse account, Publisher Agreement, token, `ovsx create-namespace`, scanning for secrets and look-alike names. No trusted publishing mentioned; the workflow comment says the same. Pre-release and targets not covered on that page.
- VSIX signing: a search on 2026-11-11 found no `vsce --sign`; the Marketplace signs extensions it hosts and VS Code verifies at install. A 2025 Microsoft post lists publisher signing for third parties as a goal. Treat publisher-side signing as unavailable; verify later.
- npm provenance: https://docs.npmjs.com/trusted-publishers (fetched 2026-11-11): npm 11.5.1 or later, Node 22.14 or later, GitHub-hosted runners only, `id-token: write`; provenance automatic for public packages from public repos. Relevant if we publish `packages/*` or the CLI to npm.
- Build provenance for the VSIX and CLI bundle: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations (fetched 2026-11-11): `actions/attest@v4` with `subject-path`, permissions `id-token: write`, `contents: read`, `attestations: write`, verify with `gh attestation verify <file> -R b1tninja/continuous`; `sbom-path` attaches an SBOM. Free-plan availability for public repos not stated on that page; test in E3.

### 5.2 Merge safety on a personal-account repo

| Mechanism             | Facts (source)                                                                                                                                                                                                                                                                                                                              | Available here                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Branch protection     | Required checks pass when "successful", "skipped" or "neutral"; strict mode needs up-to-date branch; admins bypass unless "Do not allow bypassing" is on; bypass lists only for org repos (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | yes, to verify by applying (owner action)                         |
| Skipped-job semantics | A workflow skipped by path filter leaves its checks Pending and blocks; a job skipped by a conditional reports Success (https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)                                          | this is why `merge-gate` has no path filter: correct              |
| Rulesets              | Docs page says Team and Enterprise plans; layers with branch protection, most restrictive wins; no evaluate mode mentioned (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)                                                                                    | `GET /rulesets` returned an empty list (200), creation not tested |
| Merge queue           | Needs `merge_group` trigger in workflows that produce required checks; enabled in protection ("Require merge queue"); page does not state who may use it (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)                                | `docs/ci-merge-gate.md` records org-only; unverified here         |
| Auto-merge            | repository flag `allow_auto_merge` is true                                                                                                                                                                                                                                                                                                  | yes; waits for required checks, so useless until one is required  |

### 5.3 Review of current workflows

| Finding                                                                                                                                                                       | Evidence                           | Severity                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `main` unprotected, so `merge-gate` gates nothing                                                                                                                             | `branches/main` `protected: false` | high, owner decision (CI16)                                         |
| Most third-party actions pinned by tag (`actions/checkout@v7`, `setup-node@v7`, `upload-artifact@v7`, `download-artifact@v8`), a few by SHA                                   | workflow grep                      | medium; `sha_pinning_required: false`                               |
| `npx --yes @vscode/vsce@4.1.0` and `ovsx@1.3.0` install their dependency trees unlocked at publish time inside a job with `id-token: write`                                   | `main.yaml`, `preview.yaml`        | medium: pin through a lockfile or a checked-in devDependency        |
| No attestation, no SBOM                                                                                                                                                       | grep found none                    | medium                                                              |
| Open VSX uses a long-lived token (secret on the `marketplace` environment, approval gate)                                                                                     | `main.yaml`                        | low, no alternative exists                                          |
| Dependabot weekly across 16 npm directories plus github-actions, cargo, gradle, docker and pip ecosystems; no `cooldown` setting, so a release is proposed the day it appears | `dependabot.yml`                   | low to medium; a cooldown delays fresh (possibly hijacked) releases |

## 6. Recommended setup (documented, NOT run)

Branch protection (owner action, from `docs/ci-merge-gate.md` section 4), after `merge-gate` has reported once:

```sh
gh api -X PUT repos/b1tninja/continuous/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["merge-gate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
gh api -X PATCH repos/b1tninja/continuous -F delete_branch_on_merge=true
gh pr merge <n> --auto --squash --repo b1tninja/continuous
```

Keep `enforce_admins: false` while the runner queue is slow so the owner can break glass. Add `merge_group` to `pr-checks.yaml` and `cli-pr-checks.yml` only if the repository moves to an organisation.

## 7. Ranked recommendations

| Rank | Recommendation                                                                                                                  | Effort | Risk                              | Owner decision |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------- | -------------- |
| 1    | Apply branch protection with `merge-gate` (CI16)                                                                                | S      | stuck check blocks merges         | yes            |
| 2    | Pin actions by SHA and publish tools through a lockfile; Dependabot `cooldown` (the github-actions ecosystem is already listed) | S      | low                               | no             |
| 3    | Attest VSIX and CLI bundle with `actions/attest`, verify in release checklist (CI5)                                             | M      | free-plan availability unverified | no             |
| 4    | MCP client: `server/discover` fallback, `input_required` retry, CIMD and `iss` check                                            | M      | spec just landed                  | no             |
| 5    | ACP: `session/list` and resume on per-session history (needs V4)                                                                | M      | depends on V4                     | no             |
| 6    | Opt-in memory notes with scrub on write and `/memory`                                                                           | M      | privacy                           | yes            |
| 7    | axe-core in the screenshot harness (UX13)                                                                                       | S      | low                               | no             |
| 8    | Skill validator in CI, `.agents/skills` discovery                                                                               | S      | low                               | no             |

## 8. Proposed ROADMAP rows (ids TBD)

| ID      | Scope                                                                                                                                                                                           | Size | State    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| CI-TBD1 | Pin third-party actions by SHA, add a Dependabot `cooldown` (the github-actions ecosystem is already listed; Dependabot then keeps SHA pins current), install `vsce` and `ovsx` from a lockfile | S    | Proposed |
| CI-TBD2 | `actions/attest` for the VSIX files and the CLI bundle, an SBOM, `gh attestation verify` step in the release checklist                                                                          | M    | Proposed |
| O-TBD1  | MCP 2026-07-28 client: `server/discover`, per-request `_meta`, `input_required` retry, tasks extension read                                                                                     | M    | Proposed |
| O-TBD2  | ACP `session/list` and resume; advertise `loadSession` once V4 lands                                                                                                                            | M    | Proposed |
| V-TBD1  | Opt-in repository notes: scrub on write, 200 line and 25 KB load budget, `/memory`, export as zip                                                                                               | M    | Proposed |
| UX-TBD2 | Honour `vscode-reduce-motion`, `vscode-using-screen-reader`, `vscode-high-contrast` and `forced-colors` in the GUI                                                                              | S    | Proposed |
| UX-TBD3 | A polite live region for streamed replies and an announced, named tool-approval toolbar (role, label, focus on appearance)                                                                      | M    | Proposed |
| UX-TBD1 | axe-core over the screenshot states (extends UX13)                                                                                                                                              | S    | Proposed |

## 9. Experiments for later (none run)

| ID  | Question                                                                                                                             | Cost               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| E1  | Which skills directories do we read today, and does a spec-valid skill load?                                                         | desk, no spend     |
| E2  | Does a real Zed or JetBrains accept our ACP baseline (step 2 of the interop plan)?                                                   | desk, local editor |
| E3  | Does `actions/attest` work on this public user-owned repository, and does `gh attestation verify` pass on a VSIX?                    | one Actions run    |
| E4  | Does a ruleset with a required check and no bypass list create on a user-owned repo (dry run on a scratch repository, not this one)? | free, scratch repo |
| E5  | axe-core through Playwright on the screenshot harness: violations per state                                                          | free, local        |

## 10. Not verified

- Cursor memories, Mem0 retention and export, Letta archival memory, Claude Code session retention default.
- Merge queue availability for user-owned repositories (earlier note says org-only; the GitHub page fetched does not say).
- Whether publisher-side VSIX signing exists in any `vsce` release.
- Per-tool Agent Skills support outside Claude Code.
- The `cooldown` option and Dependabot SHA-pin updating were stated from the file read and general knowledge of Dependabot, not from a fetched page; confirm at https://docs.github.com/en/code-security/dependabot before relying on them. The `wcag22aa` axe tag is unchecked.
