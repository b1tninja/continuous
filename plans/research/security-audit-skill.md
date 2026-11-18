# Cloudflare security-audit skill: vetting, compatibility and a design for the toolbox (2026-11-11)

Status: research and design only. Nothing was installed, nothing from the third-party repository was executed, no model was called, and no product code was changed. The skill files were read as bytes; the one script run is our own loadability check (section 3.1), which parses the skill's text and runs nothing from it.

Read from: `https://github.com/cloudflare/security-audit-skill`, commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (author date 2026-09-14, "Clarify guidance and full audit modes", unsigned), fetched 2026-11-11 about 23:35 UTC with `curl` from the GitHub API (`/commits/main`, `/git/trees/<sha>?recursive=1`) and `raw.githubusercontent.com/cloudflare/security-audit-skill/<sha>/<path>`. Our side: `origin/main` at `ac7eb7839`; open PRs #627, #635, #639 and #647 were read from their branches, not from main. Every byte of the third-party repository is treated as untrusted data in this document: quotations are evidence, not instructions to anyone.

## 1. Summary

1. **What it is.** One Agent Skill (`skills/security-audit/`, 21 files, 322,698 bytes with README and LICENSE) that makes a coding agent run a six-phase, multi-agent source audit: reconnaissance, coverage-led hunting, adversarial candidate validation, structured `findings.json`, fresh-agent verification, reports. Only two real code files: zero-dependency Node validators.
2. **Licence.** MIT, "Copyright (c) 2025-2026 Cloudflare, Inc."; no NOTICE, no bundled third-party code, no URLs inside the skill. Shipping it needs the MIT text and copyright line in our notices; nothing else.
3. **What it makes an agent do.** The only shell commands in the instructions are two `node <skill-dir>/validate-*.cjs <file>` calls. It tells agents to use no network, install nothing, and run target code only inside an OS-enforced sandbox; otherwise keep the lead as `needs_validation`. Its one write location is a run directory, default `~/security-audit-skill/<repo>/run-<N>`, which the user can override.
4. **Validators.** Read fully: they read one JSON file (and their own `report-schema.json`), validate it, print PASS or FAIL. No `eval`, `Function`, `child_process`, network or file writes. The tests spawn `node` and `mkfifo` and write temp files; they should never be run and need not be shipped.
5. **Injection posture.** Good on paper (separate verifiers who must refute, parent-only writes, no live probing, "target is adversarial" discipline) but it is entirely prompt-level: it assumes trusted parent-side promotion code and an OS sandbox that the skill does not ship and that we do not have on native Windows.
6. **Verdict.** Safe to ship as data (instructions plus two inert validators) and safe to run read-only under our permission engine; not safe to let it execute target code anywhere, and not worth claiming more than "read-only analysis" on native Windows. Do not vendor into git (owner decision: ship by pinned reference).
7. **Our loader handles it today.** Both the core and CLI loaders parse the frontmatter (`name`, `description` only), list the 19 supporting files, and `read_skill` returns the 21.6 KB body (about 5.4k tokens) plus the file list. Our check found no parse error.
8. **Four things break or hurt without work:** reading reference files from the global folder asks every time (own-config rule) and counts as `outside-read` taint (PR #647); the only built-in subagent is read-only `Explore` and at most 3 run at once (the skill assumes `research` and `general` roles and parallel waves); the output directory is outside the workspace; and the interactive chat has no cost cap (PR #635 flags apply to `-p` and `serve` only).
9. **Design.** A separate "Skills" drawer (second glyph, first shelf "Audit") with launcher cards, backed by a build-time pin: `skills/sources.json` (repo, path, commit SHA, per-file SHA-256, licence) and `scripts/skills/refresh.mjs`; the release build fetches only the pinned commit, verifies hashes, ships the files with the notice. Shipped skills are disabled until the user enables them, and the commands the skill instructs are shown first.
10. **Phases.** A: copy the pinned skill into the global folder by hand (zero code, today). B: shelf and cards (about 4 to 6 days). C: pin, refresh script, packaging, notices, CI hash check (about 4 to 6 days), plus the permission and cost gates it depends on (section 5).
11. **Windows.** Native Windows has no sandbox that meets the skill's list (empty environment, no network, read-only target, scratch-only writes, limits). The audit there is read-only analysis; every lead that needs execution stays `needs_validation`, which is what the skill itself prescribes.
12. **Open owner decisions** are in section 9.

## 2. Vetting the skill

### 2.1 Inventory (commit `c1c8a8c`, 2026-11-11)

The tree contains `LICENSE`, `README.md` and `skills/security-audit/` with these files. SHA-256 prefixes are of the raw bytes fetched; the full hashes are produced by the refresh script (section 6.3), not here.

| File                           | Bytes               | SHA-256 (12)                   | Role                                                                                                                                          |
| ------------------------------ | ------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE`                      | 1,078               | `e598e694aa50`                 | MIT                                                                                                                                           |
| `README.md`                    | 6,950               | `55e793bbea35`                 | Install and usage                                                                                                                             |
| `SKILL.md`                     | 22,026              | `5e3e96a1e438`                 | Entry: modes, safety rules, setup, planning, budget, six phases                                                                               |
| `RECONNAISSANCE.md`            | 15,902              | `02ca887aca84`                 | Phase 1 prompts, coverage ledger                                                                                                              |
| `HUNTING.md`                   | 22,446              | `71c121decea1`                 | Phase 2 prompts, critics                                                                                                                      |
| `VALIDATION-AND-REPORTING.md`  | 17,843              | `b892470cb89b`                 | Phases 3 to 6                                                                                                                                 |
| `ATTACK-CLASSES.md`            | 15,695              | `3ee4f00c6e8c`                 | Ordinary attack-class prompts                                                                                                                 |
| 9 companion `.md` files        | 7.3 to 12.3 KB each | n/a                            | Domain hunting classes (AI/LLM, web, client, supply chain, cloud, protocols, resource exhaustion, data isolation, desktop/IPC, memory safety) |
| `report-schema.json`           | 14,494              | `6575c9de4a62`                 | Schema for `findings.json`                                                                                                                    |
| `validate-findings.cjs`        | 28,806              | `e85f232e36bf`                 | Validator                                                                                                                                     |
| `validate-coverage-ledger.cjs` | 33,522              | `2eb280bd2e33`                 | Validator                                                                                                                                     |
| two `*.test.cjs`               | 26,384 and 28,483   | `b92001117a92`, `cfb9df26b034` | Validator tests                                                                                                                               |

Hidden-content check: no control or format code points (bidi marks, zero-width, tag characters) in any file; non-ASCII is a handful of ordinary punctuation characters and test payload strings. No CRLF. The repository has no `package.json`, no CI workflow, no git hooks, no install scripts, no binary files.

### 2.2 Licence

`LICENSE` is the standard MIT text, verbatim: "MIT License / Copyright (c) 2025-2026 Cloudflare, Inc. / Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software ..." with the condition "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software." and the usual "AS IS" disclaimer. README says "MIT -- see LICENSE". No file carries another licence header, no NOTICE file, no vendored third-party code (the validators require only `fs`, `path`, `util`, `node:*`). The README links to a Cloudflare blog post and an email address; those are text, not content we would ship. What the repository does not tell us: the licence of contributions by people other than Cloudflare staff (one commit author seen, `literally-dan`); not investigated further.

Obligation if shipped: the MIT text and the copyright line travel with the files. Our generator `scripts/licenses/third-party-notices.mjs` builds `THIRD_PARTY_NOTICES.txt` from package lockfiles, so a non-npm source needs an extra input (section 6.4).

### 2.3 What the skill instructs

**Shell commands.** Grep over every `.md` for `curl`, `wget`, `npm`, `pip`, `git clone`, `ssh`, `sudo`, `docker`, `npx`, `bash`, `powershell`, `eval`, `~/`: the only command lines an agent is told to run are

```sh
node <skill-dir>/validate-findings.cjs <output-dir>/findings.json
node <skill-dir>/validate-coverage-ledger.cjs <output-dir>/coverage-ledger.json
```

(`VALIDATION-AND-REPORTING.md` lines 113 to 116; `RECONNAISSANCE.md` line 156). Everything else is "run the narrowest local check inside the sandbox": target builds, tests, fuzzers, browsers, emulators (`SKILL.md` lines 31 to 42, `HUNTING.md` lines 71 to 92, 159 to 166). Reconnaissance agents are told explicitly not to run builds ("Do not run them during reconnaissance", `RECONNAISSANCE.md` line 16) and "Do not use network access" (line 12).

**Network.** None required. The text forbids contacting deployed endpoints, provider APIs, registries, brokers, identity systems, other users, paid APIs; forbids installing dependencies or letting builds fetch them (`SKILL.md` lines 40 to 42; `HUNTING.md` lines 33 to 35, 80, 163 to 164). The skill contains no URL at all (grep for `https?://` over the skill directory is empty).

**File writes.** Full audit mode only. Output directory outside the target, default `~/security-audit-skill/<repo-name>/run-<N>` (`SKILL.md` line 51), or any directory the user names ("output to ~/audits/my-project", README); inside the target only if the user chooses it and version control ignores the whole directory. The parent alone writes `run-metadata.json`, `architecture.md`, `coverage-ledger.json`, `findings.json`, `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`; each hunter or verifier gets `<out>/agents/<id>/scratch/` and a parent-owned `artifacts/` (`SKILL.md` lines 54 to 66). Guidance mode writes nothing (`SKILL.md` lines 12 to 14). It forbids `/tmp` and the home directory as a fallback. It never edits target source.

**Sub-agents and parallelism.** The skill is "agent-neutral": a parent, a `research` agent ("focused source exploration and factual verification", does not write) and a `general` agent ("broad investigation and bounded local execution") through "the platform's delegation or sub-agent mechanism" (`SKILL.md` lines 19 to 29). Phase 1 launches "several `research` agents in parallel" (four named, more on demand). Phase 2 assigns one `general` hunter per coverage unit or closely related group; a post-wave `research` critic follows each wave; Phase 3 gives every candidate to a fresh `general` verifier; Phase 5 launches one fresh `research` verifier per record "in parallel". The skill sets no concurrency number; unit count (thousands are anticipated: the ledger validator mentions "roughly 2,000-5,000 realistic units") drives agent count.

**Profiles and budget** (`SKILL.md` lines 107 to 134). `quick` = one hunter wave, one final critic, one verifier per candidate; `standard` (default); `deep`. A `budget` is a maximum number of agent invocations; the minimum is the four recon calls, one or two critics, one verifier, and below it "launch no agent". The skill never exceeds a user-set strict budget silently and records `run_status: "incomplete"` instead.

**The sandbox requirement** (`SKILL.md` lines 31 to 40; README "Requirements"): target-controlled execution only in an OS-enforced sandbox with no external network (loopback only), an empty allowlisted environment with scratch-local `HOME`, read-only target and toolchain with writes only to the agent's `scratch/`, and explicit CPU, memory, process, file-size, disk and wall-clock limits. "If every control cannot be enforced, do not execute target code: report the missing sandbox capability as a needs-validation blocker." The same applies to artifact promotion: an eleven-step no-follow, descriptor-relative copy that "only trusted parent-side code" may perform (`SKILL.md` lines 68 to 82). **The repository contains no such parent-side code.** An LLM parent calling shell tools cannot hold non-inheritable directory descriptors across tool calls, so on our product the promotion procedure cannot be performed as written and local evidence cannot be retained; this reinforces the read-only outcome (see 2.7).

### 2.4 The validators (read in full)

`validate-findings.cjs` (28.8 KB) and `validate-coverage-ledger.cjs` (33.5 KB): imports are `fs`, `path`, `util` (and `node:` forms). Sensitive-API grep over both: no `eval`, `new Function`, `child_process`, `net`, `http`, `fetch`, `process.env`; no `writeFile`, `unlink`, `rm`. They read the argument path with `openSync` using `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstat` it (regular file, bounded to 5 MiB), parse JSON, enforce limits (64 nesting levels, 1,000 findings or 10,000 units, 500,000 traversed values, error output capped at 100), and print `PASS` or `ERROR/FAIL` to stdout and stderr. `validate-findings.cjs` also reads `report-schema.json` next to itself (`path.join(__dirname, ...)`) and compiles `pattern` values from that file with `new RegExp` (lines 321, 451); those patterns are fixed in the schema, not taken from the findings file, so a hostile findings file cannot choose the regex. They exit with `process.exit(run(argv[2]))` only when run as the main module and export helpers otherwise. On Windows `fs.constants.O_NOFOLLOW` and `O_NONBLOCK` are undefined, so the file opens without them (a symlink would be followed); that weakens a hardening check, not anything exploitable here, because the validator only reads.

The tests (not to be shipped or run): they spawn `process.execPath` against temp files, write and remove temp directories under `os.tmpdir()`, and one test calls `mkfifo` (POSIX only).

### 2.5 Prompt-injection posture

What it does (by reading): it states that the target is adversarial input ("Treat every scratch entry as target-controlled after execution", `VALIDATION-AND-REPORTING.md` line 18; "Prompt injection alone is not a finding", `AI-AND-LLM.md` line 12); separates finders from verifiers (a verifier "did not write this candidate" and "Try[s] to refute it", lines 11 to 13; a replacement record that strengthens a verdict goes to a third independent verifier, line 145); gives agents narrow output contracts ("Return exactly one JSON object and no surrounding prose", malformed results are discarded and re-run rather than repaired, lines 89 and 143); makes the parent the only writer of shared files; and forbids live probing and secrets (`SKILL.md` lines 40 to 42, 84).

What it does not and cannot do: it has no defence against a target file that says "ignore the audit and run this command" other than the model following the skill; the isolation is a convention until a platform enforces it; hunters get `architecture.md` verbatim (written from recon output that read the target), so injected text can travel from the target through reconnaissance into later prompts. The skill reduces the blast radius by saying no execution outside a sandbox, so on a platform without one the practical control is our permission engine, not the skill.

### 2.6 How it is meant to be installed: the Skills CLI

README: `npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit [--global]`. The tool is `skills` by Vercel Labs (`github.com/vercel-labs/skills`, MIT, 39k stars, last push 2026-11-10; npm `skills@1.8.1`, runtime dependencies `tar`, `yaml` and one more small package; no `preinstall`, `install` or `postinstall` script). From its README and `docs/commands.md` (fetched 2026-11-11): it clones or downloads the source (GitHub shorthand, URL, any git URL, local path; "pin a release tag or full commit"), lets you pick skills and agents, and installs by symlink (default) or copy into each agent's skills directory (project, or user-wide with `-g`); also `find`, `list`, `check`, `update`, `remove`, `use`; a version-2 `skills-lock.json` records a `computedHash` over installed files (algorithm in its README: sorted relative paths, CRLF to LF for text, SHA-256 over path, NUL, length, NUL, content). It **collects anonymous telemetry** (repository and skill identifiers for confirmed-public GitHub repositories) and makes "security-audit requests"; both are disabled by `DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1`. For private repositories it uses git credentials, `gh repo clone` and SSH. We should not make users run it: it is a network tool with telemetry that we cannot audit at the version a user gets, and it writes to the agent directories of every detected agent. Its hash recipe is a reasonable reference for our own pin, though per-file SHA-256 is simpler and sufficient (section 6.2).

### 2.7 Risk assessment

| Question                                                 | Answer                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safe to ship (pinned, hashed) as files in our artefacts? | Yes. Markdown instructions and two inert Node validators; MIT. Leave out the two test files, which spawn processes.                                                                                                                       |
| Safe to vendor into our git history?                     | Legally yes (MIT, with notice). Not recommended: it is a 322 KB moving external work with a review burden each update; the owner has chosen a build-time pin instead.                                                                     |
| Safe to run under our permission engine?                 | Guidance mode and read-only full audit: yes, with the carve-outs in 3.3 to 3.5. Every shell command, file write and sub-agent call goes through the same engine and asks at the levels where the person has not allowed it.               |
| Safe to let it execute target code?                      | Not on any platform we ship today. We have no sandbox that satisfies its list; `plans/windows-sandbox-runner.md` and Track W describe the work. Keep execution off.                                                                       |
| Main residual risk                                       | The skill is instructions an LLM follows with our tools. A later upstream edit could add a command or a write location. Pinning plus a diff of the changes at refresh time (section 6.3) is the control; there is no runtime update path. |
| Cost risk                                                | One audit can be hundreds of model calls (section 3.6). The skill's own budget gate helps only if it is set.                                                                                                                              |
| Quality risk                                             | Not measured by us. Cloudflare's README claims a single run finds about half of what repeated runs find; we have run nothing.                                                                                                             |

## 3. Compatibility with our code

### 3.1 Does our loader handle the layout? (tested without executing anything)

Both loaders exist and differ.

- **Core** (`core/config/markdown/loadMarkdownSkills.ts`): reads definition files from the global and workspace `skills` folders and the workspace `.claude/skills` plus the global folder again (lines 23 to 28, 50 to 63), keeps files ending in `SKILL.md` at any depth (65 to 67), parses with `parseMarkdownRule`, validates `{name, description}` with zod (13 to 16, 77), lists every other file under the skill's folder via `walkDir` (79 to 85) and returns `{...frontmatter, content, path, files}` (89 to 96). `readSkillImpl` (`core/tools/implementations/readSkill.ts`) returns the body plus "Supporting files / Skill directory: <files> / Use the read file tool to access these files as needed".
- **CLI** (`extensions/cli/src/util/loadMarkdownSkills.ts`): looks only at direct children of `<cwd>/.continuous/skills`, `.continue/skills`, `.claude/skills` and `<continueHome>/skills` (lines 76 to 81, 55 to 83), so a nested `skills/security-audit/` inside a clone of the repository is not found; files are listed with `ignore-walk` (respects ignore files inside the skill folder), relative to the cwd or absolute (28 to 54). The Skills tool (`extensions/cli/src/tools/skills.ts`) returns the body and the file list; `/skills` lists them; `getSkillSlashCommandName` gives `skill-security-audit` (`slashCommands.ts` lines 23 to 28, 153 to 166), which is an existing CLI launch route.

**The check.** Scratchpad script `D:\temp\claude\67392035d714e8ba\b98023ea-3bcc-4ecb-9e49-e3cf2888146a\scratchpad\tool\loadability.cjs`. It re-implements the loader: it copies the logic of `parseMarkdownRule` (`packages/config-yaml/src/markdown/markdownToRule.ts`), the same zod schema, and takes the default ignore patterns out of `core/indexing/ignore.ts` with a text match, using the `yaml`, `zod` and `ignore` libraries already installed in the stale checkout (read only). No `npm ci`, no import of the repository's code, nothing from the skill run. Run over a temp copy of the 21 raw files:

```
frontmatter keys: [ 'name', 'description' ] | split parts: 3 | yamlErr: null
zod ok: true { name: 'security-audit', descLen: 359 }
extra keys stripped by zod: []
body chars: 21586 | SKILL.md chars: 21990
'---' lines left in body after rejoin: 0
files list (19): AI-AND-LLM.md, ATTACK-CLASSES.md, ... report-schema.json, ... validate-coverage-ledger.cjs,
  validate-coverage-ledger.test.cjs, validate-findings.cjs, validate-findings.test.cjs, ...
dropped by default file ignores: []
relative links in SKILL.md: HUNTING.md ok; VALIDATION-AND-REPORTING.md ok; RECONNAISSANCE.md ok; ATTACK-CLASSES.md ok
description bytes: 359   read_skill content: 21622 bytes, about 5.4k tokens
```

Reading of the result:

1. Frontmatter is `name` and `description` only, which is exactly what our schema requires. No parse error. The `files` list holds 19 entries including the four `.cjs` files (the tests would be listed to the model, which is noise; the shipped copy should omit them).
2. `read_skill` returns about 5.4k tokens of `SKILL.md` per call; the 15 other `.md` files are read on demand with the read-file tool (our design for supporting files). The skill itself says which block to load when ("Do not send block or companion names alone": the parent copies text from the companion files into hunter prompts), so the parent reads most of them in a full audit.
3. The skill refers to "the absolute directory containing this SKILL.md". Core gives `skill.path` as an absolute file URI when the skill is outside the workspace; the CLI gives an absolute path outside the cwd. The model can derive the directory; the Phase B launcher prompt should state it anyway.
4. By reading the code (not run): in core the global `skills` folder appears in both `getAllDotContinueDefinitionFiles(... includeGlobal ...)` and `getClaudeSkillsDir`, so a skill placed there is probably returned twice. `readSkillImpl` takes the first match, so it works, but the tool description would list it twice. Worth a test and a dedupe by `name`.
5. The zod schema strips unknown keys. A `toolbox:` frontmatter key would be dropped unless the schema, the `Skill` type (`core/index.d.ts:2941`) and the CLI copy of the loader are all changed. This is one reason to prefer a shipped curated list (section 4.2).
6. **Both loaders read skills from the workspace** (`.claude/skills`, `.continue/skills`, `.continuous/skills`) with no trust gate. A repository under audit can ship a skill whose description goes into the tool list of the session that audits it. That is a general injection path, not specific to this skill; for audits it matters more. Audit sessions should load skills only from the shipped and global locations (row SA9).

### 3.2 Sub-agents and parallelism

- Tool: `subagent` (`core/tools/definitions/subagent.ts`): "Start a subagent: a fresh conversation ... returns a single report ... for broad searches ... or independent pieces of read-only work. Do not use one ... for edits. Several subagent calls in one message run in parallel (at most 3 at a time). Subagents cannot start subagents."
- Roles: the only built-in is `Explore` (`BUILT_IN_SUBAGENTS = [EXPLORE_AGENT]`, `core/subagents/definitions.ts:71`), read-only, default 30 turns (line 40). Custom agents are Markdown files in `.continuous/agents` or `.claude/agents` in the workspace and the home folder (`core/subagents/loadSubagents.ts`).
- Concurrency: `MAX_CONCURRENT_SUBAGENTS = 3` (`core/subagents/scheduling.ts:7`), with request staggering for prefix caching.
- Permissions: a subagent's calls go through the parent's policy; where no prompt can be reached (headless, `serve`) "ask" becomes "exclude" (`extensions/cli/src/subagent/permissions.ts`). A subagent therefore cannot write its `scratch/` directory in a headless audit.
- Loop: the Loop's parallel waves run workers in worktrees (Track N; `core/subagents/tools.ts` and `gui/src/util/subagents/loopWorkers.ts` exist, not read in depth) for code-change items. That is isolation for editing, not for auditing, and does not fit a hunter whose output is a JSON object.

Mapping: skill `research` agent = our `Explore` (a one-line alias). Skill `general` agent has no equivalent: a read-only agent that also may write its own scratch is not defined. Because we cannot sandbox target execution, the simplest honest mapping is to give hunters and verifiers the read-only `Explore` role and have the parent write all files (including copies of each agent's returned JSON). That already matches the skill's rule that agents "return one structured result through the Task tool" and never write shared files. Consequences: no local checks, so every candidate that needs one stays `needs_validation`; three at a time makes a standard audit slow (wall-clock, not extra cost); the skill's `scratch/` and `artifacts/` directories stay empty.

### 3.3 Writes outside the workspace and the global folder

Today (`core/tools/permissions/deputyPaths.ts`, PR #586, #588 merged): a file tool path outside every workspace root asks; the global configuration folder asks "even to read: it holds keys" (`why: "own-config"`, lines 170 to 205); only YOLO or the person's own `builtin` switch reaches past it. `lockedPaths.ts` locks the global folder as a whole, project `.continue`/`.continuous` folders, `.claude/agents` and `.claude/skills`; writes there are refused at Automatic and YOLO.

Effects for the skill:

1. Default `~/security-audit-skill/<repo>/run-N` is outside the workspace: each write asks below YOLO. A run makes hundreds of writes, so a per-call ask is unworkable.
2. A scratch path under our global folder would be refused outright (locked as a whole). It must not live there.
3. Reading the skill's reference files from the global `skills` folder asks (`own-config`), per file.

Proposal: (a) the launcher card always passes an explicit output directory, so the skill's default is never used: `<auditRoot>/<repo>/run-<N>`, with `auditRoot` a user setting (default `<home>/continuous-audits`, outside the workspace and outside every config folder; never inside the target); (b) a **session-scoped path grant**: starting an audit from a card gives that session write access to exactly `<auditRoot>/<repo>/run-<N>/**` and read access to the skill folder, shown to the person on the card and revoked when the session ends; this is a narrow allow that the deputy rule consults before asking, and it never widens to a parent folder; (c) the shipped skill folder is exempt from the `own-config` read hit (read only, never write), because it is the product's own signed-by-hash content (row SA7). Without (c) the same skill works in Phase A but asks on every reference-file read.

### 3.4 Tainted sessions and the no-network posture

`plans/design/tainted-session.md` (PR #647, open; off by default): sources are `web-fetch`, `mcp-result`, `outside-read`, `issue-text` and a reserved `untrusted-workspace` that no host sets yet; sinks are network egress, `git push`/`gh` writes, package publish, credential read, **outside-workspace write** and non-read-only MCP calls. Interactions:

- Reading the skill's reference files from outside the workspace is `outside-read`, which taints the session the moment the skill starts. Tainted sessions ask on every sink even at YOLO. An exemption for the shipped skill folder is needed (same row as SA7), otherwise enabling the audit disables YOLO's value and the output-directory writes (outside-workspace write) become sinks that ask each time. The session grant in 3.3 should also be a taint exemption.
- Target files are in the workspace, so reading them is not taint under the current table. For audits of code the person does not trust, the card should set the reserved `untrusted-workspace` flag. That flag exists in the API and no host sets it; the launcher would be the first caller. Consequence: network and publish sinks ask for the whole audit, which is the posture we want.
- Network: the skill needs none. The audit profile should exclude `fetch_url_content`, `search_web` and MCP tools that are not read-only for the session's duration, and nothing in the product's egress allowlist (PR #627, `core/egress/egress-allowlist.json`) needs to change for runtime. The pin script runs at build time only (section 6).

### 3.5 Windows

The skill's execution gate cannot be met on native Windows: no network namespace, no job object plus restricted token plus ACL configuration of our own that enforces "empty environment, read-only target, scratch-only writes, limits" today. See `plans/windows-sandbox-runner.md`. The card therefore starts the audit in **read-only analysis** mode on Windows: the launcher prompt says "Do not execute target code; keep every lead that needs execution as needs_validation" (the skill's own rule), the permission engine is the second line, and the card says so. The validators are not target code and may be run by the parent (they are shipped and hash-pinned), but through the terminal tool they still ask below YOLO.

### 3.6 Cost control

- PR #635 (open): `--max-budget-usd`, `--max-turns`, `--max-duration` for `-p` and `serve`; the interactive chat "refuses them rather than pretend to enforce them"; limits can come from the user's `settings.json` and a flag can only tighten them; unpriced models need `--budget-allow-unpriced`. Subagent calls within a run are counted by the same counters only if they pass through the run's request path; not verified.
- The skill's own budget is a count of agent invocations (`run-metadata.json` `budget`). Minimum funded run by its own gate: 4 reconnaissance calls, 1 final critic (`quick`) or 2 critics (`standard`/`deep`), 1 verifier call: 6 or 7 invocations before any hunter. Each extra coverage unit adds a hunter; each surviving candidate adds one or two verifiers; each wave adds a critic.
- Per-agent tokens are not measured here: a hunter prompt carries `architecture.md` (about 1,000 words), its unit's blocks, the method text (about 5.4k tokens for `SKILL.md` alone) and then reads source. The estimate must come from the ledger after reconnaissance, not from a constant.

Proposal: (1) **Required budget.** The Full audit card has a mandatory "Budget" field (agent invocations, default 30 for `quick`, none for `deep`) written into the prompt (`budget N`) and, when the session is headless, a dollar cap. Without a value the card is disabled with the reason "Set a budget first". (2) **Pre-launch estimate.** Before any agent starts the prompt asks the parent to do reconnaissance only up to the ledger seed, print units, implied hunters, critic calls, validation reserve (the skill already requires this "pre-recon estimate", `SKILL.md` line 132), and stop for confirmation; our GUI shows the estimate as a card in the transcript (agents x measured tokens per agent x price from the cost table, labelled "estimate, error bars unknown") with Continue and Cancel. (3) **Hard stop.** In `-p`/`serve` use PR #635's flags; in the interactive chat, the audit profile refuses to start an agent past the budget the person set (a counter in the subagent tool, row SA10), since #635 does not apply there. (4) After the first real run on our own repository, replace the constant by a measured number (row SA14).

## 4. Design of the toolbox integration

### 4.1 Shape: a separate drawer

The existing drawer (`gui/src/components/mainInput/Toolbox/Toolbox.tsx`) is a single panel of five groups, glyph `BriefcaseIcon`, `role="region"`, test ids `toolbox-toggle`, `toolbox-drawer`, `toolbox-group-<id>`, `toolbox-card-<id>`. The problem-solving cards are inert text; a skill card launches something that can cost money and write files. Keep them apart:

- **A second glyph beside the briefcase** (shield or magnifier icon, tooltip "Skills: launch an installed skill"), opening a panel "Skills" with shelves; the first and only shelf is **Audit**. Chosen over a tab strip because the two drawers differ in risk and in what they need (budget, enable state) and can be tested and shipped separately; a later shelf (another third-party skill) fits without touching the five groups. Cost: one more glyph in a crowded toolbar; the tab alternative is listed in section 9.
- Data lives next to `core/util/toolboxCards.ts`: `core/util/skillShelves.ts` (types) and the shipped catalog (4.2). Types:

```ts
export type SkillShelfId = "audit";
export interface SkillCard {
  id: string; // "security-audit-full"
  shelf: SkillShelfId;
  skill: string; // the SKILL.md name: "security-audit"
  title: string; // "Security audit: full"
  when: string; // one line, for the person
  mode: "guidance" | "full";
  prompt: string; // "Use the security-audit skill, full audit mode, of {scope}. Output directory {auditDir}. Budget {budget} agent invocations. Do not execute target code."
  needs: ("scope" | "budget" | "auditDir")[];
  cost: string; // "Many model calls: set a budget. Typical size unknown until reconnaissance."
  thirdParty: {
    publisher: string;
    licence: string;
    source: string;
    commit: string;
  };
}
```

- Cards: **Security audit: full** (mode full, needs scope and budget), **Security audit: quick pass** (`profile quick`, budget small), **Review this path** (guidance mode: "Use the security-audit skill in guidance mode on {scope}. Do not create files."), **Check a finding** (guidance: "triage this candidate"; needs a pasted item). Each card shows: title, one-line when, a `third-party skill` badge with publisher and licence, the cost note, an estimated-cost line once known, the buttons Show prompt, Insert, and Start. Prompt placeholders reuse `fillToolboxCard` (`core/util/toolboxCards.ts`), extended with `scope`, `budget`, `auditDir`; a sentence with a missing fact is dropped there today, so `needs` must disable the Start button instead of silently dropping "Budget".
- **States.** _Not installed_ (cannot happen for a shipped skill, but a user who removed the folder or a build without the pin): the card is disabled with the reason "The security-audit skill is not in this build. Install it by hand: <Phase A steps>" and an "Install" action that opens the docs page; no network from the app. _Installed, disabled_: the shipped default; the card is disabled with "Turn on the skill first" and an **Enable** button that opens the enable dialog (4.4). _Enabled_: Start works. Reasons are text in the card and an `aria-describedby` target, not only a tooltip.
- **Accessibility and look.** Buttons at least 24 by 24 px (PR #639's Toolbox branch already moves the glyph from `h-5 w-5` to `h-6 w-6`); the drawer keeps `role="region"` with an accessible name, Escape closes and focus returns to the glyph (existing behaviour); a state change (enabled, started, refused for budget) is spoken through the live-region helper PR #639 adds (`gui/src/components/a11y/announcer.ts`, `announce(text, "polite" | "assertive")`; text must already be safe to read aloud); a disabled card uses `aria-disabled` and stays focusable so the reason can be read; colour is never the only signal: the third-party badge is a text chip with a glyph, a disabled state has a text reason, and cost is text. Tone: the badge uses the neutral chip tone; a missing budget uses the warning tone with the word "Required".

### 4.2 Discovery: a curated list we ship

Two options: (a) read an optional `toolbox:` key from each installed skill's frontmatter; (b) a curated catalog we ship next to the pin. **Recommend (b).** Reasons: the skill's frontmatter is third-party input, and a card inserts text into the user's chat and offers a Start button; the zod schema strips unknown keys in both loaders and the `Skill` type would change; a curated card is reviewed with the pin, so the prompt, the cost note and the budget requirement are ours. The catalog sits in `skills/sources.json` under `toolbox` (section 6.1). A later `toolbox:` key for first-party and user-authored skills is possible and separate (SA15).

### 4.3 Where the skill lives and how it is included: by reference, at build time

Owner decision (2026-11-11): include by reference at release time; no user-side fetch, no daily notice, no runtime network, no user-side lockfile. Two alternatives considered and set aside:

| Option                                           | Reaches users         | Review of changes                               | Notes                                                                             |
| ------------------------------------------------ | --------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Git submodule                                    | No: only our checkout | Git diff of one pointer                         | Does not reach installed artefacts without a build step anyway                    |
| Vendoring (copy into our repo)                   | Yes                   | Normal PR diff                                  | 322 KB in our history, noise on every update, a maintained fork in all but name   |
| **Pinned reference + build-time fetch** (chosen) | Yes, with the release | Refresh script prints a diff for the maintainer | Files in artefacts, not in git                                                    |
| User-side `continuous skills add` / update       | Yes                   | Diff at the user                                | Rejected by the owner: runtime network and a remote-instruction supply-chain path |

The skill is shipped in the CLI tarball and the VSIX under a read-only `skills/` folder in the install (loader source 4, below), **disabled until the user enables it**. Files in the global skills folder stay the user's own; the shipped copy is never written to the user's folder.

### 4.4 Enable flow and "what it will do" disclosure

Enabling is a setting in the user's own settings file only (workspace files cannot enable it; same rule as `runLimits` in PR #635): `skills.enabled: ["security-audit"]`. The Enable button opens a dialog that shows, from a per-skill summary generated at refresh time and stored in `sources.json` (4.5):

- publisher, licence, source URL, the pinned commit (short SHA) and the date it was fetched;
- the commands the skill instructs: `node validate-findings.cjs <file>`, `node validate-coverage-ledger.cjs <file>`; "target builds and tests only inside an OS sandbox, which this machine does not have: none will be run" (computed from the platform probe);
- network access: none instructed;
- where it writes: the audit directory you choose, never the project;
- how many agents it can start and that it uses your model budget.

The text is generated by the refresh script from a small rules file we maintain per pinned skill (a list of regexes for command lines, URLs, paths in the markdown), shown to the maintainer at refresh time, and checked into `sources.json` so the dialog never parses third-party text at runtime. The maintainer still reads the skill; the summary is a review aid, not a proof.

### 4.5 Loader changes

Add a fourth source for both loaders: `<install>/skills/*` (shipped, read-only), loaded only for names in `skills.enabled`, with `source: "bundled"` on the `Skill` record, and with workspace skills excluded when the session is an audit (SA9). A disabled shipped skill is invisible to the model and costs nothing in the tool description (359 bytes when enabled). Dedupe by name with precedence: user global over shipped (a person who copies a patched version wins), workspace last. Fix the core duplicate (3.1 item 4).

### 4.6 CLI parity

Interactive: `/skills` already lists skills; add `/skills` columns (source, enabled, pinned commit) and `/skills enable <name>` (writes the user settings file after printing the disclosure and asking). `/toolbox` lists the same cards as the GUI shelf with ids; `/toolbox run security-audit-full --scope src --budget 30` expands the card's prompt (with the same required-budget rule) into the next message; `/skill-security-audit` keeps working as a bare launch. Headless: `continuous -p --max-budget-usd 5 --max-turns 200 --max-duration 60 "Use the security-audit skill ..."` with the audit profile applied by `--audit-profile`; without a dollar cap the profile refuses to start a full audit. `continuous skills list` is the non-interactive form of `/skills`. No fetch command exists.

## 5. Gating the audit session (permission, taint, subagents)

An **audit profile** applied by the launcher (the card sets it for the session; the CLI flag sets it for `-p`):

1. Tools: exclude `fetch_url_content`, `search_web`, non-read-only MCP tools; terminal limited to the two shipped validators (`node <bundled>/validate-*.cjs <path under the audit directory>`); no other `node` or build command (target code stays off).
2. Paths: the session grant of 3.3; read-only exemption for the bundled skill folder.
3. Taint: set `untrusted-workspace` for audits the person marks as untrusted (default on for a clone younger than a day, unknown, or any folder not opened before: a host heuristic is a separate row).
4. Subagents: `research` = `Explore` alias; `general` omitted; hunters return JSON to the parent, which writes the files; invocation counter against the budget.
5. Skills: no workspace skills in the tool description.
6. Cost: required budget and estimate (3.6).
7. Windows: read-only analysis wording in the prompt (3.5).

## 6. Build-time pin, refresh script, packaging, notices, CI

### 6.1 `skills/sources.json`

Committed; the skill files are not. One entry per shipped skill:

```json
{
  "version": 1,
  "skills": [
    {
      "name": "security-audit",
      "repo": "cloudflare/security-audit-skill",
      "path": "skills/security-audit",
      "ref": "main",
      "commit": "c1c8a8c1471069fb0e188eeaff69b8e8db6564a8",
      "fetched": "2026-11-11",
      "licence": {
        "spdx": "MIT",
        "file": "LICENSE",
        "copyright": "Copyright (c) 2025-2026 Cloudflare, Inc.",
        "sha256": "<of the licence file>"
      },
      "exclude": [
        "validate-findings.test.cjs",
        "validate-coverage-ledger.test.cjs"
      ],
      "files": {
        "SKILL.md": "<sha256>",
        "HUNTING.md": "<sha256>",
        "report-schema.json": "<sha256>"
      },
      "review": {
        "commands": [
          "node <skill-dir>/validate-findings.cjs <file>",
          "node <skill-dir>/validate-coverage-ledger.cjs <file>"
        ],
        "network": [],
        "writes": ["<audit-dir>/**"],
        "reviewedBy": "<maintainer>",
        "reviewedOn": "2026-11-11"
      },
      "toolbox": { "shelf": "audit", "cards": ["..."] }
    }
  ]
}
```

`files` maps each path (relative to `path`) to the SHA-256 of its raw bytes (no newline normalisation: we hash what we ship). `exclude` names files that are fetched for the diff but not shipped (the test files). `ref` records what the maintainer asked for, `commit` what runs: a moving ref is treated as an unpinned dependency and is only read by the refresh script.

### 6.2 Why per-file SHA-256

Simple, language-neutral, checkable with `sha256sum`. The Skills CLI's `computedHash` normalises CRLF and is built for symlinked installs; we are not reproducing its lockfile. Any file added, removed or changed under `path` at the pinned commit that is not in `files` or `exclude` is an error, so upstream cannot add a file silently at the same commit (it cannot: the commit fixes the tree; the check protects against a wrong pin).

### 6.3 `scripts/skills/refresh.mjs` (maintainer, release prep)

`node scripts/skills/refresh.mjs [name] [--ref <ref>] [--apply]`. Plain Node, no dependencies, like `scripts/licenses/third-party-notices.mjs`. Steps:

1. Resolve `ref` to a commit with `GET https://api.github.com/repos/<repo>/commits/<ref>` (unauthenticated, or `GITHUB_TOKEN` for rate limits); record the SHA.
2. List the tree at that commit (`/git/trees/<sha>?recursive=1`), keep blobs under `path` plus the licence file, refuse symlinks, submodules and any blob over 1 MB.
3. Download each blob from `raw.githubusercontent.com/<repo>/<commit>/<path>`; compute SHA-256 into a temp folder outside the repository. Nothing is executed.
4. **Print a diff** against the previously pinned files (the previous files are re-fetched at the old commit; they are not stored in git): per-file unified diff; a header table of added, removed and changed files; and a highlight list, computed by regex over added or changed lines, for: command lines and code fences containing `node`, `npm`, `curl`, `git`, `sh`, `powershell`; URLs and hostnames; paths (`~/`, `$HOME`, `/tmp`, absolute and drive paths, `..`); `eval`, `child_process`, `require(`, `fetch`; changes to frontmatter; changes in `LICENSE` (any byte); new files that are not `.md` or `.json`; changes in sandbox wording. Exit code 2 when any highlight is non-empty, which the maintainer must acknowledge with `--apply --reviewed "<name>"`.
5. With `--apply`: rewrite `sources.json` (commit, fetched date, `files`, licence sha, a regenerated `review` block shown for confirmation) and stop. Moving the pin is a commit the maintainer makes.

### 6.4 Release packaging and notices

- Release build (CLI tarball `extensions/cli/scripts/pack-release.mjs`; VSIX `.github/actions/build-vscode-extension`): a step `node scripts/skills/stage.mjs <outDir>` fetches **only the pinned commit**, verifies every file against `sources.json` (fail closed on a mismatch, a missing file or an extra file), drops `exclude`d files and copies the rest into `<outDir>/skills/<name>/` together with `LICENSE` renamed `LICENSE.security-audit`. `pack-release.mjs` adds the folder to its `files` list (today `FILES` plus `NOTICE`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`); the VSIX build copies it with the same tool its `copy-dir.js` uses for other assets (to be checked at implementation).
- Notices: `third-party-notices.mjs` lists lockfile packages with their LICENSE text. Add `--extra skills/sources.json`: for each pinned skill, a section "security-audit (cloudflare/security-audit-skill, commit c1c8a8c, MIT)" containing the copyright line and the licence text read from the staged licence file, so the notice and the shipped files cannot drift. The existing licence check (`scripts/ci/check-artefact-licences.mjs`) learns that the section exists for every shipped skill.
- Build network: fetching happens in CI build jobs, not at runtime. If a build cannot reach GitHub it fails (or, optionally, uses a CI cache keyed by commit SHA and hashes, which verifies the same way).
- Egress allowlist (PR #627): the test enforces hostnames written as URL literals in shipped source. `scripts/` is not shipped, so `api.github.com` and `raw.githubusercontent.com` in the refresh and stage scripts should not need entries; confirm when implementing, and if the scanner covers `scripts/`, add a build-time class.

### 6.5 CI check

A workflow step (and a vitest, `skills/sources.test.ts`) that: parses `sources.json`; checks the schema (every `commit` is 40 hex, every file has a 64-hex hash, `licence.spdx` is on the notice generator's allowlist, no `ref` is used by the build, only by refresh); and, in the packaging job, verifies the staged folder against the hashes. A separate scheduled job (not on pull requests) may run `refresh.mjs --check` which resolves the ref's head and prints "pin is N commits behind" without writing, to tell the maintainer an update exists. This is a build-side nudge, not a user notice.

## 7. Phases and effort

Effort is developer-days of a single contributor with reviews, my estimate, not measured.

**Phase A: zero code, for the owner today (about 0.5 day, including a first read-only trial).** Copy the pinned skill into the global skills folder.

```powershell
# in a scratch folder outside any repository
git clone --no-checkout https://github.com/cloudflare/security-audit-skill $env:TEMP\sas
git -C $env:TEMP\sas checkout c1c8a8c1471069fb0e188eeaff69b8e8db6564a8
# read SKILL.md and the two validators yourself; then copy only what is needed, without the tests
$dest = "$HOME\.continuous\skills\security-audit"     # or $env:CONTINUOUS_GLOBAL_DIR\skills\security-audit
New-Item -ItemType Directory -Force $dest
Copy-Item "$env:TEMP\sas\skills\security-audit\*" $dest -Exclude *.test.cjs
Copy-Item "$env:TEMP\sas\LICENSE" "$dest\LICENSE"
```

Caveats and what to expect:

- The global folder is `~/.continuous` or `CONTINUOUS_GLOBAL_DIR` (`core/util/paths.ts:179 to 189`). The CLI loader needs the skill as a direct child (`skills/security-audit/SKILL.md`), which this layout gives; do not clone into `skills/` itself.
- `git clone` runs no repository code (hooks are not cloned); no `npx skills` involved; do not run `npm install` or the `*.test.cjs` files.
- `/skills` lists `security-audit`; asking "use the security-audit skill in guidance mode on src/foo" works; every read of a reference file from the global folder asks (own-config rule), and in a session with the tainted-session rule on, the skill's reads taint the session (3.4); writes to `~/security-audit-skill` ask on each call: pass an explicit output directory outside both the workspace and `~/.continuous` and approve the first write.
- Hunters and verifiers run only as `Explore` (read-only), three at a time; no local checks happen; on Windows nothing from the target is executed. Run `quick` with a small agent budget first.
- No diff review and no lock: you update by hand with `git -C ... fetch` and a manual comparison; a moved ref changes instructions the agent follows.
- Remove with `Remove-Item -Recurse $HOME\.continuous\skills\security-audit`.

**Phase B: shelf and launcher cards (about 4 to 6 days).** `core/util/skillShelves.ts` with types and the first catalog, a new `SkillsDrawer.tsx` next to `Toolbox.tsx` sharing the focus, Escape and outside-press logic (extract a small `useDrawer` hook from `Toolbox.tsx`), the four cards, required-field handling (`scope`, `budget`), states, badge, accessibility and live-region announcements, and tests following `Toolbox.test.tsx`. The skill's presence comes from a protocol message that returns the loaded skills with `source` and `enabled`; the loader gains a `bundled` source. CLI: `/toolbox` and `/skills` columns. Phase B works on the Phase A copy (a user-global skill counts as installed and enabled) before Phase C ships anything.

**Phase C: pin, refresh, packaging, notices, CI check, gates (about 4 to 6 days, plus gate rows).** `sources.json`, `refresh.mjs`, `stage.mjs`, packaging in both artefacts, notice generator `--extra`, CI check and vitest; the enable dialog with the per-skill review block; the permission rows SA7 to SA10 (carve-out, session grant, audit profile, invocation counter) which are the larger, riskier work (about 5 to 8 days together) and the reason the shipped default stays disabled until they land. Windows read-only wording is text in the card.

## 8. Proposed ROADMAP rows (IDs TBD; do not add to `plans/ROADMAP.md` from this note)

Track "SK: shipped third-party skills and the Audit shelf". Sizes: S under a day, M 1 to 3 days, L 3 to 6 days.

| ID   | Scope                                                                                                                                                                                  | Needs            | Size |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---- |
| SK1  | Phase A write-up: the manual copy steps above in the docs (no code), with the caveats                                                                                                  | none             | S    |
| SK2  | `core/util/skillShelves.ts`, the Audit catalog (four cards), `fillToolboxCard` facts `scope`, `budget`, `auditDir`, with a disabled-with-reason rule for missing required facts        | SK1              | M    |
| SK3  | `SkillsDrawer.tsx`: second glyph, panel, shelf, card states (not installed, disabled, enabled), third-party badge, 24 px targets, announcements through the #639 announcer, tests      | SK2, #639        | L    |
| SK4  | Loader: `bundled` source, `skills.enabled` in user settings only, dedupe by name, fix the core duplicate for the global folder, a protocol message for the GUI, CLI copy of the loader | none             | M    |
| SK5  | CLI: `/skills` columns and `enable`, `/toolbox` and `/toolbox run`, `continuous skills list`                                                                                           | SK4              | M    |
| SK6  | `skills/sources.json` and its schema test; the pin to `c1c8a8c` with hashes                                                                                                            | none             | S    |
| SK7  | `scripts/skills/refresh.mjs`: resolve, fetch at commit, diff with highlights, `--apply`                                                                                                | SK6              | M    |
| SK8  | `scripts/skills/stage.mjs` plus packaging in `pack-release.mjs` and the VSIX action; fail closed on a hash mismatch                                                                    | SK6              | M    |
| SK9  | Notices: `third-party-notices.mjs --extra`, licence check learns shipped skills                                                                                                        | SK6, #626        | S    |
| SK10 | CI check of the pin (schema, hashes of staged files, ref never used by the build) and the optional scheduled `refresh.mjs --check`                                                     | SK6, SK8         | S    |
| SK11 | Enable dialog with the generated "what it will do" block                                                                                                                               | SK4, SK6         | M    |
| SK12 | Permission: read-only, no-taint exemption for the bundled skills folder; session-scoped write grant for the audit directory                                                            | #586, #588, #647 | L    |
| SK13 | Audit profile: tool exclusions, no workspace skills in the tool list, `research` = `Explore` alias, `untrusted-workspace` set by the launcher                                          | SK12, #647       | L    |
| SK14 | Subagent invocation counter against a user budget in the interactive chat; pre-launch estimate card; `--audit-profile` flag and required dollar cap for `-p`                           | #635             | L    |
| SK15 | Measure one audit of our own repository on a cheap model to replace the estimate constant (owner approval for model spend)                                                             | SK14             | M    |
| SK16 | Optional later: a `toolbox:` frontmatter key for first-party and user skills (schema, `Skill` type, both loaders)                                                                      | SK3              | M    |
| SK17 | Windows: keep the card in read-only analysis until the sandbox runner (Track W) meets the skill's control list; re-evaluate then                                                       | Track W          | n/a  |

## 9. Risks and open owner decisions

Risks (ranked):

1. **Remote instructions.** Any future pin moves instructions the agent follows. Control: pin by commit, diff with highlights, maintainer acknowledgement, no runtime update path. Residual: the maintainer must actually read the diff.
2. **Read-only audit is not an audit.** On Windows and anywhere without a sandbox, the output is a list of source-grounded leads with `needs_validation`, which is what the skill prescribes. Marketing the feature as "security audit" overpromises; the card title says "Security review (read-only)" until execution is possible.
3. **Cost.** Unmeasured; a standard audit of a large repository may be hundreds of agent calls. Control: required budget, estimate, hard stop; residual: the estimate is a guess until SK15.
4. **Permission carve-outs widen the engine.** SK12 adds exemptions to `own-config` and taint. They must be narrow (the folder, read-only; one run directory, session-scoped) and tested in the existing deputy and taint corpora.
5. **Prompt injection from the target through reconnaissance.** Reduced, not removed (2.5); the audit profile removes network, MCP sends and workspace skills.
6. **Maintenance.** A third-party skill's quality and style drift. The pin is the answer; if upstream disappears the pinned files in our releases keep working, and our build cache (SK8) covers rebuilds.
7. **Licence.** MIT is clear; the contribution licence of non-Cloudflare authors is unverified (2.2).
8. **Telemetry of the Skills CLI** applies only if a user chooses `npx skills add` themselves; we do not recommend it.

Open decisions for the owner:

1. One extra glyph ("Skills" drawer) or a tab strip inside the existing Toolbox drawer?
2. Card title and positioning: "Security review (read-only)" now, "Security audit" once execution is sandboxed. Agree?
3. Default `auditRoot`: `<home>/continuous-audits`, or `<global>/state` with the lock carve-out? (Recommended: the former, outside every config folder.)
4. Ship `skills.enabled` as off by default for every user, or ask once on first use of the card? (Owner said opt-in; confirm the dialog is the opt-in.)
5. Accept SK12 (a session-scoped write grant and a bundled-folder read exemption) before enabling the shipped skill for anyone but the owner?
6. Approve a one-off model spend for SK15 (which model, which cap)?
7. Who is the maintainer who reads the refresh diff, and is a second reviewer required for a change that trips a highlight?
8. Drop the skill's test files from shipped copies (recommended) and keep the two validators?

## 10. Sources and limits

Third-party (all fetched 2026-11-11): `https://github.com/cloudflare/security-audit-skill` at commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (`LICENSE`, `README.md`, every file under `skills/security-audit/`); `https://api.github.com/repos/cloudflare/security-audit-skill/commits/main` and `.../git/trees/<sha>?recursive=1`; `https://raw.githubusercontent.com/vercel-labs/skills/main/README.md`, `docs/commands.md`, `docs/troubleshooting.md`; `https://api.github.com/repos/vercel-labs/skills`; `https://registry.npmjs.org/skills` (version 1.8.1 metadata). Raw copies are in the session scratchpad, outside the repository.

Ours (worktree at `ac7eb7839`): `core/config/markdown/loadMarkdownSkills.ts:13-112`, `core/tools/definitions/readSkill.ts`, `core/tools/implementations/readSkill.ts`, `extensions/cli/src/util/loadMarkdownSkills.ts`, `extensions/cli/src/tools/skills.ts`, `extensions/cli/src/slashCommands.ts:23-28,153-166`, `core/index.d.ts:2941`, `core/util/toolboxCards.ts` (groups at 13 to 49, `fillToolboxCard` at about 292), `gui/src/components/mainInput/Toolbox/Toolbox.tsx:33-192`, `.../toolboxActions.ts`, `core/tools/definitions/subagent.ts`, `core/subagents/definitions.ts:40,71`, `core/subagents/scheduling.ts:7`, `core/subagents/loadSubagents.ts`, `core/subagents/tools.ts`, `extensions/cli/src/subagent/permissions.ts`, `core/tools/permissions/deputyPaths.ts:170-215`, `core/tools/permissions/lockedPaths.ts`, `core/util/paths.ts:179-250,746`, `core/indexing/ignore.ts`, `scripts/licenses/third-party-notices.mjs`, `extensions/cli/scripts/pack-release.mjs:34-96`. From open PR branches: `plans/design/tainted-session.md` (#647), `docs/cli/run-limits.mdx` (#635), `core/egress/egress-allowlist.json` (#627), `gui/src/components/a11y/announcer.ts` and `Layout.tsx` (#639). Merged: #586, #588, #626.

Limits: the skill's behaviour was not run on any model, so claims about how agents follow it are from its text; the duplicate-listing and the cost-counting questions are from code reading; token and dollar figures are not measured; the Skills CLI was read from its documentation and package metadata, not installed; the VSIX packaging step was not inspected beyond the action's file name; I did not verify the contribution licences of non-Cloudflare authors.
