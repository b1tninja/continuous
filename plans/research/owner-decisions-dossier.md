# Owner decisions dossier

Status: synthesis, 2026-11-12, documents only. Read from `main` at `35cb36d` (after #779), PR #782 at `f49fe03fe`, the `Open decisions` section and Track DR of `plans/ROADMAP.md`, and the bodies of the open pull requests (REST, 2026-11-12). Nothing was built, run or measured for this note, and `plans/ROADMAP.md` is not edited. Every default below is the one a note recommended, "recommended, pending owner"; where this dossier had to choose between notes, or fill a gap, it says so.

## How to use this

1. Read the [decide-first list](#decide-first-top-10). Ten replies settle the decisions that unblock the most ROADMAP rows soonest.
2. Skim the [decisions already made](#decisions-already-made-do-not-re-ask) so nothing is asked twice.
3. Reply in any of these forms, one line each:
   - `D-007: accept default`
   - `D-007: option B`
   - `D-007: accept default, except <part>: <your answer>`
   - `Theme 3: accept all defaults` (a whole section)
   - `D-001 to D-025: accept defaults`

The integrator then records the answers in `plans/ROADMAP.md` (Open decisions and the rows named under "Unblocks").

## Counts and method

| Source                                                                                                                          | Notes or items | Raw entries |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------- |
| Research notes with an owner-questions section (on `main`, plus #782)                                                           | 37 notes       | 396         |
| Research notes with owner flags only inside ranked-recommendation tables                                                        | 10 notes       | 43          |
| `plans/ROADMAP.md` Open decisions: rows flagged "yes" under "Needs an owner" (80) or open without a flag (12)                   | 92 rows        | 92          |
| `plans/ROADMAP.md` Track DR rows still waiting for the owner (DR1 flip, DR5, DR6, DR9, DR10, DR11, DR13, DR14)                  | 8 rows         | 8           |
| Open pull request bodies (#744, #758, #751, #750, #765, #747, #746, #625, #622, #606, #655, #650, #753, #784, #772, #783, #787) | 17 PRs         | 43          |
| **Total raw**                                                                                                                   |                | **582**     |
| **Deduplicated decisions in this dossier**                                                                                      |                | **136**     |

Five notes raise no owner decision: `rq10-sample-sizes.md`, `rq12-grok.md` (follow-ups only), `rq28-template-hash.md`, `toolbox-default-catalogue.md` and `tool-exposure-roles-prompts.md` (its decisions are in `tr-owner-decisions.md`). 86 track rows elsewhere in the ROADMAP mention an owner decision; each restates an entry counted above and was used only to cross-check.

Deduplication: the same question in several notes became one decision; the note quoted for the default is the one with the most evidence behind it (a measurement or a built PR over a reading), and later notes over earlier ones when the evidence is equal. Small related questions from one note are bundled into one decision with a list of sub-defaults, so one reply settles them.

"Unblocks" counts ROADMAP rows. **Gated** is the number of named rows that wait on the decision; **downstream** is every row that depends on those, directly or through other rows, by the `Depends on` and `Needs` columns of `plans/ROADMAP.md` (computed 2026-11-12). Downstream measures blast radius, not effort, and it overstates a decision that only sets a wording inside a large row (for example B8). Rows that notes only propose (QA, PERF, GAP, PAR, SK) are not in the ROADMAP yet and count as zero.

Urgency: **2.16.0** means it should be settled before the 2.16.0 release now being cut (#792, draft); **2.18.0** the next even minor; **later** everything after. Notes that still name 2.17.0 are read as 2.18.0 (odd minors are not released).

## Decide first (top 10)

Score = (gated + downstream) x urgency weight (2.16.0 = 3, 2.18.0 = 2, later = 1).

| Rank | Decision                                                                                         | Default in one line                                                                                                            | Gated + downstream | Urgency | Score |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------- | ----- |
| 1    | [D-065](#d-065-branch-protection-on-main) Branch protection                                      | Apply once, `merge-gate` the only required check, `strict: true`, `enforce_admins: false`, right after #751 merges             | 5 + 42             | now     | 141   |
| 2    | [D-003](#d-003-permissions-vocabulary) Vocabulary                                                | "Locked rules"; Never, Ask, Always; `deny` written; "Automatic (reviewer)"; `--auto` a deprecated alias of `--policy idgaf`    | 5 + 56             | 2.18.0  | 122   |
| 3    | [D-086](#d-086-benchmark-run-plans-about-usd-40) Bench spend                                     | Approve the run plans per plan, in order (about USD 40), stop a series on a 2x overrun                                         | 8 + 51             | 2.18.0  | 118   |
| 4    | [D-087](#d-087-reviewer-measurement-spend-about-usd-3) Reviewer spend                            | Approve B53 (USD 0.48), Nova B83/B84 (USD 0.7), DR5 v3 (USD 1.70), Q44 (cents); review the B46 labels in one sitting           | 6 + 31             | 2.18.0  | 74    |
| 5    | [D-117](#d-117-one-prompt-byte-train) Prompt-byte train                                          | One 2.18.0 train for every prompt-byte change (#750, #765, TR10, the environment block); nothing of it in 2.16.0               | 6 + 14             | 2.16.0  | 60    |
| 6    | [D-043](#d-043-ide-environment-block-and-editor-context) IDE environment block                   | The IDE gets the CLI's environment lines from one shared function, and an editor delta with a visible chip                     | 3 + 27             | 2.18.0  | 60    |
| 7    | [D-115](#d-115-tool-call-recovery-policy) Recovery policy                                        | Recovery on by default only for a named dialect with a live leak and a Wilson lower bound above zero; Python booleans accepted | 5 + 24             | 2.18.0  | 58    |
| 8    | [D-051](#d-051-session-log-format-resource-view-name-and-repository-notes) Session log and notes | JSON lines for V4; `/resources` for V1; repository notes opt-in, off, with the poisoned-note defence                           | 3 + 36             | later   | 39    |
| 9    | [D-071](#d-071-sandbox-gate-before-2160) Sandbox gate                                            | Run the sandbox matrix before 2.16.0 and attach the result to the release                                                      | 2 + 10             | 2.16.0  | 36    |
| 10   | [D-036](#d-036-refusal-detection-defaults) Refusal detection                                     | "Declined by the model"; budget 2; independent items continue; no persuasion; fallback model later and off                     | 8 + 9              | 2.18.0  | 34    |

**Also settle now, whatever the score.** These touch few rows but affect every user of 2.16.0 or are one switch: [D-001](#d-001-what-still-binds-at-idgaf) (what binds at IDGAF; the 2.16.0 release notes already describe it), [D-068](#d-068-private-vulnerability-reporting) (private vulnerability reporting, one switch; `SECURITY.md` links a form that does not load), [D-069](#d-069-where-a-bug-report-goes) (where bug reports go; `bugs.url` ships pointing at disabled Issues), [D-070](#d-070-release-pipeline) (release by dispatch with you as the required reviewer), [D-113](#d-113-one-plan-and-act-switch-in-2160) (A7 in 2.16.0 or not), [D-034](#d-034-waves-in-2160) (waves scope in 2.16.0), [D-026](#d-026-headless-default-policy) (headless default, every `-p` and `serve` user) and [D-027](#d-027-a-token-for-loopback-serve) (loopback `serve` token).

## Decisions already made (do not re-ask)

| Decision                                                           | Made              | What it settles in the notes                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Releases use even minors; the next is 2.16.0                       | owner, 2026-11-12 | `area-ci-privacy-release.md` §11 Q4. Every "2.17.0" in a note is read as 2.18.0 here (hooks §8 Q3, UX §12 Q9 and Q11, isolation §9 Q12, paste D2)                                                                                                                  |
| YOLO is renamed IDGAF                                              | owner             | `area-permissions-command-safety.md` §9 Q1 vocabulary; existing `yolo` settings are read as `idgaf` (UNRELEASED.md)                                                                                                                                                |
| IDGAF asks no questions and may edit outside the workspace         | owner             | Any default that would "ask at IDGAF" must become refuse or allow: permissions §9 Q1 (a), injection §10 Q1, the S5 "ask at YOLO when the change came from a workspace file" idea. See D-001 and D-011                                                              |
| A loop continues when the level is permissive                      | owner             | Re-plans and questions are answered by the system at Automatic, Permissive and IDGAF (UNRELEASED.md). D-035 (Y4) and D-036 (refusal budget) are stops at start or at a budget, not questions                                                                       |
| Keep `cn` as the short binary                                      | owner             | `area-ci-privacy-release.md` §11 Q8 third part                                                                                                                                                                                                                     |
| Remove the continue.dev calls                                      | owner             | #622 memo OD1 (delete the headers stub, no upstream proxy for `search_web`); D-046 reduces to confirming "hidden until configured"                                                                                                                                 |
| Credential rotation is not needed                                  | owner             | Dropped from every list. D-094 asks for new, limited CI keys, which is not rotation (`test-quality-strategy.md` §7 Q2 says the same)                                                                                                                               |
| Publish only on the owner's explicit word                          | owner             | D-070 (dispatch-only release with you as required reviewer) and D-073 (mirrors) are consistent with it; #792 stays draft until you say                                                                                                                             |
| DR1 to DR8                                                         | owner, 2026-11-11 | MCP OAuth callback, sandbox test of it, sampling guard, whitespace `old_string`, reviewer v3 off by default, taint rule off with `ask` only, CLI Plan drops Bash, contrast. Only DR1's host flip (D-108) and the DR5 and DR6 measurements (D-087, D-006) stay open |
| Workspace or hub `allow` never loosens headless or anything else   | owner, 2026-11-10 | H5 in its old form is superseded; Adopt (B8) is the only path. The permissions note's "does H5 build now" is folded into D-026                                                                                                                                     |
| One written dialect (core `toolPermissions`)                       | owner, 2026-11-10 | No note re-asks it                                                                                                                                                                                                                                                 |
| Project hook `allow` ignored; hook fingerprint covers the script   | owner, 2026-11-11 | Built in #541                                                                                                                                                                                                                                                      |
| Runtime-built write path is not trusted at IDGAF                   | owner, 2026-11-11 | Was "asks at YOLO"; with "IDGAF asks nothing" it is refused (D-001)                                                                                                                                                                                                |
| `continuous-lab` holds world-measuring code                        | owner, 2026-11-10 | Only the timing of MR7b is open (D-112)                                                                                                                                                                                                                            |
| W-D2: WSL2 plus sandbox-runtime, no native Windows sandbox project | owner             | Isolation §9 Q7 asks only for a dated re-check (D-072)                                                                                                                                                                                                             |
| R17 (persistent PowerShell parse helper) stays deferred            | owner             | `benchmarks-toolcalls-loops.md` §7 rank 8                                                                                                                                                                                                                          |

Can be closed without a decision: **CI23** (Actions did not stop; 100 runs were stuck, `area-ci-privacy-release.md` §3.1), **the 2.12.x web-search release-note sentence** (written in `UNRELEASED.md`, ships with 2.16.0), **odd minor versions** (decided), **PERF2 cache location** (#791 implements the note's default; D-081 only confirms it).

## Disagreements between notes

| Topic                                | One side                                                                                           | Other side                                                                                                              | Dossier default and why                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Prompt-byte train (D-117)            | `area-caching-cost-visibility.md` §9 Q6: one release, 2.16.0; #750: 2.16.0 if green                | `env-disclosure-master-plan.md` §8 #1, privacy §10 Q5, workspace §7 Q6, ROADMAP Open decisions: one 2.18.0 train        | 2.18.0: four sources, the latest ROADMAP row, and the IDE fix needs its executor link         |
| Loopback `serve` token (D-027)       | ROADMAP Open decisions (S1-L1) and #622 memo §3: token by default, `--no-token` opt-out            | Product review open Q2 and `surface-parity.md` §8 Q6: no token, print the risk, token-only beyond loopback              | No token now, startup line, revisit with CO2: the two later notes; flagged as a security call |
| `-p` error contract (D-028)          | `area-isolation-sandbox-gate.md` §9 Q1: JSON on stderr                                             | `user-journeys-and-recovery.md` §17 Q7: a sentence by default, JSON with `--format json`                                | The sentence: later note, and #789 already carries machine output under `--format`            |
| Lock word (D-003)                    | UX §12 Q1, design review §8 Q6, ROADMAP UX7 update: "Locked rules"                                 | `docs-audit.md` Q5: keep "Always-on rule"; product review §3.5: "Always on"                                             | "Locked rules": three sources, and "Always-on" reads as "Always"                              |
| `~/.claude` hooks (D-023)            | `area-hooks-upstream-imports.md` §8 Q5 (and `hooks-wiring.md`): load with a notice                 | Product review Q10 and ROADMAP CO14: opt-in, default off                                                                | Opt-in: the ROADMAP row is written that way and it is the conservative side                   |
| Bug reports (D-069)                  | DR14 and `docs-audit.md` Q1: enable Issues                                                         | `user-journeys-and-recovery.md` §17 Q1: Discussions only                                                                | Issues: two sources plus the ROADMAP row, and the nightly-red issue needs it                  |
| Branch protection timing (D-065)     | Product review §3.5 rank 3 and Q13: apply now                                                      | ROADMAP precondition (2026-11-12) and CI note §11 Q2: after CI30 (#751), or 20 ready PRs starve the runners             | After #751: the starvation is measured (14 of 19 running jobs were gate pollers)              |
| Taint default (D-006)                | DR6 (decided): off, only `ask`                                                                     | Injection §10 Q1: `ask` for new installs at Permissive, Automatic and IDGAF                                             | DR6 until the replay; then `ask` for new installs below IDGAF, never at IDGAF                 |
| Home directory in the prompt (D-039) | Master plan §8 #2 and privacy §10 Q1: mask as `~` for every provider                               | `env-disclosure-current-state-and-peers.md` §6 Q8: no change for 2.18.0, `privacy.redactCwd` later                      | Mask: the master plan supersedes the current-state note, after the free grid                  |
| Exact token counts (D-053)           | ROADMAP Open decisions (J9): yes where credentials exist and the call is free                      | Caching §9 Q3: off by default, an explicit setting naming the provider                                                  | Off by default: later note; it sends prompt text                                              |
| Git status cap (D-044)               | `env-nonwindows-remote-and-facts.md` §10 Q4: 2,000 characters, 2-second timeout                    | #750 (C65, built): 40 files or 4,000 characters                                                                         | #750's numbers (built and tested) plus the 2-second timeout                                   |
| OAuth loopback host (D-108)          | DR1 (decided): `localhost` with `redirectHost`                                                     | ROADMAP PL15 recommendation: `127.0.0.1`                                                                                | Keep `localhost` until SB11 verifies Okta and Auth0                                           |
| `mcp-remote` removal (D-109)         | `area-models-providers.md` §8 Q7 and ROADMAP: after the CLI uses core's fetch, OAuth, proxy and CA | `user-journeys-and-recovery.md` §17 Q3: now, before `mcp login`, with a one-release opt-in                              | After the core path: removing it first leaves remote servers with no sign-in                  |
| Bedrock token generator (D-110)      | ROADMAP Open decisions (K26): accept                                                               | `area-models-providers.md` §8 Q2: not yet                                                                               | Not yet: later note; ship the long-term-key warning first                                     |
| GGUF downloads (D-092)               | `local-inference-lab.md` §10 and ROADMAP: approve about 40 GB                                      | `area-benchmark-toolcall-styles.md` §9 Q4: not now, after the free contrasts                                            | Not now                                                                                       |
| Date and zone (D-040)                | Current state §6 Q9, non-Windows §10 Q3: local date with offset                                    | Privacy §10 Q4: time zone and locale off                                                                                | Local day with the numeric offset, no zone name or locale                                     |
| Spotlighting default (D-047)         | ROADMAP (WB7): on now                                                                              | Injection §10 Q6, `agent-security.md` R13: on after the paired E3 measurement                                           | After E3 (USD 0.7, D-088)                                                                     |
| Managed tier timing (D-020)          | `agent-security.md` R11: earlier than deferred                                                     | Product review: design in 2.18.0, build after; hooks §8 Q3: with B19 in "2.17.0"                                        | Design in 2.18.0, build on the first real request                                             |
| Settings-import order (D-112)        | ROADMAP planning default: Claude Code, Cursor, OpenCode first                                      | ROADMAP recommendation and `providers-models-import.md` rank 5: Claude Code, Codex, Aider, Goose and Kilo, Copilot Chat | The recommendation (secrets handling decides it)                                              |
| External edit anchor (D-097)         | `area-benchmark-toolcall-styles.md` §9 Q11: no                                                     | ROADMAP: "when time allows"                                                                                             | No for now                                                                                    |
| Broken-settings override (D-029)     | Hooks §8 Q2: `--ignore-broken-settings`                                                            | User journeys §17 Q2 and Q10: `--safe`                                                                                  | `--safe` only: one flag                                                                       |
| DS9 unknown shells (D-005)           | `env-nonwindows-remote-and-facts.md` §10 Q8 calls it decided                                       | `design-and-security-review.md` §8 Q8 and #758 list it as open                                                          | Open; accepting D-005 records it                                                              |
| Raising to IDGAF (D-001)             | Owner: IDGAF asks no questions                                                                     | ROADMAP CO6: `/policy` asks to confirm a raise, "IDGAF: type the word"                                                  | Compatible if the confirmation is a settings change, not a run-time question; confirm         |

## Theme 1. Permissions and IDGAF floors

### D-001 What still binds at IDGAF

- **Question.** At IDGAF, which guards still bind, and do they refuse (since IDGAF asks nothing)?
- **Why.** The 2.16.0 release notes (`UNRELEASED.md`) already say a hidden command is refused at IDGAF and list what still binds (locked policy files, a switched-off tool, an organisation ceiling, your `floor:` rules, secret-file name checks). The permissions note could not verify the taint rule and the secret-name check at IDGAF. The level must say honestly what it still does.
- **Options.** A) Ship as `UNRELEASED.md` describes: hidden-command and runtime-built write path refused; locks, switched-off tools, ceiling, `floor:` rules and secret-file names bind; taint does not apply (DR6 default off). B) All guards refuse, taint included. C) Only locks bind.
- **Default.** A, plus one start line naming what still binds. Source: `area-permissions-command-safety.md` §9 Q1 (written there as "ask"; restated as refuse because of the owner's "IDGAF asks no questions", which `UNRELEASED.md` implements).
- **Unblocks** B89, B90, B92 (3 gated, 0 downstream) · **Cost** none · **Urgency** 2.16.0
- **Reply** `D-001: accept default`

### D-002 The IDGAF start line

- **Question.** What does the session say once when IDGAF is on?
- **Options.** A) "Your rules are ignored; locked rules and protected files still hold." once per session, no question. B) A confirmation dialog (contradicts the owner's decision).
- **Default.** A. Sources: `design-and-security-review.md` §8 Q7 (wording), `user-journeys-and-recovery.md` §17 Q5 (one sentence, no question). The word "locked" depends on D-003.
- **Unblocks** wording in B21 and CO10 · **Cost** none · **Urgency** 2.16.0
- **Reply** `D-002: accept default`

### D-003 Permissions vocabulary

- **Question.** Which words do the Permissions page, CLI and docs use?
- **Why.** Product review §3.5 rank 1: the rule editor and 40-odd rows wait on one set of words; four spellings of the lock idea exist today.
- **Options.** Lock section: A) "Locked rules" (UX §12 Q1, design review §8 Q6, ROADMAP UX7 update); B) "Always-on rules" (`docs-audit.md` Q5); C) "Always on" (product review §3.5). Rest, as one package (product review open Q5): Never / Ask / Always headings; `deny` as the written verb; "Automatic (reviewer)" instead of "Auto mode"; `--auto` a deprecated alias of `--policy idgaf` with a warning (CO10); keep "Accept" on the approve button for now (design review §8 Q5).
- **Default.** A plus the package. Disagreement recorded above.
- **Unblocks** B8, UX7, UX12, CO10, DS16 (5 gated, 56 downstream; B8 is a large build row, so the downstream overstates) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-003: accept default`

### D-004 #744: PowerShell allow rules read the way the shell does

- **Question.** Accept that an allow rule no longer covers a PowerShell command holding `$`, `(`, `{`, `#`, `!`, `@`, a backtick, `&&` or `||`, or a redirect other than to `$null` (those ask)?
- **Why.** #744 showed allow rules covering commands the real shells run as two or three statements (tested against `bash -c`, Windows PowerShell 5.1 and `cmd /c`). The change only tightens, but some routine allowed commands will start asking.
- **Options.** A) Accept. B) The bypass described as S1 in the review.
- **Default.** A. Source: `design-and-security-review.md` §8 Q1; #744 body.
- **Unblocks** #744 out of draft (B87 family) · **Cost** more asks for PowerShell users · **Urgency** the release #744 merges into (2.18.0 unless you want it in 2.16.0)
- **Reply** `D-004: accept default`

### D-005 #758: decide a command by the shell that will read it

- **Question.** Accept the three behaviour changes #758 lists before it leaves draft?
- **Options and defaults.** (1) In a remote window, terminal commands are never vouched read-only nor covered by an allow rule until SH2 learns the remote shell: accept. (2) With `$SHELL` fish, nushell or ksh, allow rules stop applying to terminal commands (DS9): accept and document on the Permissions page. (3) An undecodable `-EncodedCommand` matches every deny and ask rule (fail closed): keep.
- **Sources.** `shell-awareness.md` §10 Q1 to Q3; `env-disclosure-master-plan.md` §8 #7; `design-and-security-review.md` §8 Q8 (ask for unknown shells); `env-nonwindows-remote-and-facts.md` §10 Q8.
- **Unblocks** SH2, SH3, DS9 (3 gated, 5 downstream) · **Cost** more prompts for remote and fish users until SH2 · **Urgency** 2.18.0
- **Reply** `D-005: accept default`

### D-006 Tainted-session rule default

- **Question.** When does the tainted-session rule (state change and egress ask after untrusted input) become a default?
- **Options.** A) Keep DR6 (off, `ask` only) until the replay of your audit directory (X17) is read; then `ask` for new installs at Permissive and Automatic, never at IDGAF. B) `ask` now for new installs at Permissive, Automatic and IDGAF (injection §10 Q1; IDGAF part impossible under the owner's decision). C) Leave off.
- **Default.** A. Needs your consent to the local replay (D-054). Sources: DR6; `agent-security.md` R2; `area-injection-tool-exposure-web.md` §10 Q1; permissions §9 Q1 (c).
- **Unblocks** X4, X17, X5 (3 gated, 11 downstream) · **Cost** extra asks after a fetch or MCP result · **Urgency** 2.18.0
- **Reply** `D-006: accept default`

### D-007 Instruction files from an untrusted folder

- **Question.** Is `AGENTS.md` (and rules, skills, agent definitions) from a folder you have not trusted read at all?
- **Options.** A) Read it, strip hidden Unicode (tag, bidi, zero-width), label the source and taint the session until the folder's instructions are accepted. B) Do not read it until accepted.
- **Default.** A, with one scope for all repository-supplied text (index §10.5 Q14). Note: while taint is off (D-006) the "taint" half gives no protection, so B is the safer choice if D-006 stays at C. Sources: injection §10 Q5; `agent-security.md` R9; ROADMAP X20.
- **Unblocks** X20 (1 gated, 4 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-007: accept default`

### D-008 MCP trust: Plan mode, background runs, new tools, annotations

- **Question.** Decide the MCP trust story as one (`tr-owner-decisions.md` says 1, 3 and 4 are one story).
- **Defaults.** Plan mode offers only user-trusted read-only MCP tools, or tools you list for Plan (TR2). Unattended and background runs get no MCP tool unless listed in `background.mcpTools` (TR1, TR3; a deliberate difference from Claude Code; splits the agent and background cache prefixes). New or changed tools from a server you have not marked trusted are hidden until approved; a trusted server may opt into "enable new tools" (TR4). `readOnlyHint` is believed only for trusted servers (TR22, partly built in #740).
- **Sources.** `tr-owner-decisions.md` rows 1, 3, 4; `area-injection-tool-exposure-web.md` §10 Q2 to Q4; #622 memo §6.
- **Unblocks** TR1, TR2, TR4, TR22 (4 gated, 10 downstream) · **Cost** more prompts after server updates; Plan loses untrusted MCP tools · **Urgency** 2.18.0
- **Reply** `D-008: accept default`

### D-009 Mid-session MCP toggles and disabled tools

- **Defaults.** A toggle applies at the next request and the UI says it costs one cache miss (TR3, `tr-owner-decisions.md` row 2). A tool disabled while the cache is warm is withheld at execution with a visible refusal, then removed when the cache is cold (C88, caching).
- **Unblocks** TR3, C88 (2 gated, 1 downstream) · **Cost** one uncached re-read per toggle · **Urgency** 2.18.0
- **Reply** `D-009: accept default`

### D-010 Reviewer tools and script excerpt

- **Defaults.** The reviewer gets no model-callable tools; a 4 KB script excerpt (a detector hit forces ask) is added behind a flag that stays off until the reviewer eval (M8) scores it. The #622 memo says "defer"; a flag that stays off is the same in effect.
- **Sources.** `tr-owner-decisions.md` row 5; #622 memo §6.
- **Unblocks** TR8 (1 gated, 1 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-010: accept default`

### D-011 MCP launch pin at IDGAF, first-approval and loosening notices

- **Defaults.** Confirm that a changed MCP launch definition does not stop an IDGAF session, and make IDGAF announce and audit the re-pin. The idea "ask at IDGAF when the change came from a workspace file" becomes "refuse at IDGAF when the change came from a workspace file" or is dropped, since IDGAF asks nothing: dossier suggestion, refuse. Accept the first-approval dialog that lists the tools it pins (S5-P2) and the start-up line that tells a session-only IDGAF from one that came from the environment (B21).
- **Sources.** ROADMAP Open decisions (S5, X1b, S5-P2, B21); #622 memo §2.
- **Unblocks** wording in B20, B21 (4 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-011: accept default`

### D-012 The `protect-config` class at Automatic

- **Default.** Locks for policy files and hook-loading files (already), ask at Automatic for the rest of the class, refuse only the new PowerShell profile paths; revisit with audit data.
- **Source.** `area-permissions-command-safety.md` §9 Q3.
- **Unblocks** B18 (1 gated, 1 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-012: accept default`

### D-013 Project `prompts/` writable by the agent

- **Default.** Lock it like the rest of `.continue`; the agent proposes a prompt, you save it. A prompt file is later fed to a model as your own text.
- **Sources.** ROADMAP Open decisions (S3-F4); #622 memo §3.
- **Unblocks** S3-F4 (not a ROADMAP id) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-013: accept default`

### D-014 #625: exact-command exemption and trusted-host GET allow

- **Question.** Take #625 out of draft, and which hosts may a trusted-host allow never accept?
- **Defaults.** Merge #625 (an exact Always rule exempts one command line from the destructive and dependency asks; a trusted-host GET settles without the reviewer). Hosts never accepted: exact label match only, and a deny list of `huggingface.co`, `raw.githubusercontent.com`, gist and paste hosts, object storage and `*.github.io` (CVE-2026-24052 and CVE-2026-54316 are the failure shapes). A session approval scope (UX52) waits for #625 and the Trusted list (B20).
- **Sources.** DR13; #625 body; ROADMAP WB11; `agent-security.md` R6; UX §12 Q12.
- **Unblocks** B55, B56, B60, WB11, UX52 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-014: accept default`

### D-015 Approval card design

- **Defaults.** When a mask would swallow a separator, mask per word, never show raw text (DS2). "Accept all" sits below the list and is enabled once the list is scrolled through (DS13). "Always allow" always shows the rule and takes a second click (DS14). Account ids in errors masked in the page, full text on request (DS19). The zero-width joiner and non-joiner are left alone (#746). Still undecided in #744's notes: what the CLI's "Always allow" writes, and the loop inbox's 300-character cut (#746 now says it was cut); dossier suggestion: bind the grant to the full text in #700/#701.
- **Source.** `design-and-security-review.md` §8 Q2 to Q4, Q9, Q10.
- **Unblocks** DS2, DS13, DS14, DS19 (proposed) · **Cost** one extra click per saved rule · **Urgency** 2.18.0
- **Reply** `D-015: accept default`

### D-016 UI wording pull requests #746 and #747

- **Question.** Take both out of draft as written? They change no vocabulary that waits on D-003.
- **Default.** Yes (no note objects; dossier suggestion).
- **Unblocks** #746, #747 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-016: accept default`

### D-017 Repository-supplied definitions only narrow

- **Defaults.** An agent file's `tools:` can narrow your policy, never widen it (CO4). A subagent `permissionMode` from a repository file accepts only `plan` and `default` (index §7 Q6). A CLI loop worker is never looser than its parent (surface §8 Q3). `commandLint` is user config only (permissions §9 Q5). #787 implements CO4 and the worker rule.
- **Unblocks** CO4, PAR7 (proposed) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-017: accept default`

### D-018 B28 blocks on typed operands

- **Default.** Yes; ship the 15-program slice first and leave everything else unresolved. Source: permissions §9 Q4.
- **Unblocks** B28 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-018: accept default`

### D-019 Sandbox `readPolicy` default

- **Default.** Deny reads of the policy folders, `~/.ssh`, `~/.aws`, `~/.config/gh` and the OS credential stores by default, with a short allow list (`~/.gitconfig`, `~/.npmrc`) (ROADMAP S9-X3, #622 memo §3); build it after the toolchain measurement the permissions note asks for (§9 Q7), not in 2.16.0.
- **Unblocks** B76 · **Cost** some tools fail until allow-listed · **Urgency** 2.18.0
- **Reply** `D-019: accept default`

### D-020 Managed policy tier

- **Question.** Where the administrator file lives and what it may lock (B19, D9, CO19, the managed-only hooks switch).
- **Default.** Design now (`product-review-controls-and-roadmap.md` §4.2: `requirements.yaml` and `defaults.yaml` per OS, ownership check, applied last, shown as locked), build on the first real request. Disagreement on timing recorded above.
- **Sources.** Product review §3.5 rank 5 and Q8; hooks §8 Q3; hooks index §7 Q3; `agent-security.md` R11.
- **Unblocks** B19, D9, CO19 (3 gated, 4 downstream) · **Cost** none · **Urgency** 2.18.0 (design), later (build)
- **Reply** `D-020: accept default`

### D-021 Command-analysis parsers and housekeeping

- **Defaults.** tree-sitter-bash with our gate on top (D1; its licence goes in the notices). Our own strict PowerShell subset at run time with PowerShell's parser as a CI oracle; never start `powershell.exe` to parse (D2). Do not evaluate second readers (`unbash`, `tree-sitter-powershell`, R23) until R24 shows aliases still leak. Publish the corpus oracle runner as a dev-only tool under `bench/`. Correct `command-analysis.md` and `command-lint.md` in the ROADMAP truth-pass PR.
- **Sources.** ROADMAP Open decisions; #622 memo §5; permissions §9 Q8 to Q10.
- **Unblocks** R23 · **Cost** bundle size for tree-sitter-bash · **Urgency** 2.18.0
- **Reply** `D-021: accept default`

### D-022 `Stop` hook continuation cap

- **Default.** Three consecutive continuations per user turn (`hooks.stopContinuationLimit`), reset on the next prompt, then the turn ends with a notice (Cursor uses 5). Sources agree: hooks §8 Q1, hooks index §7 Q2, ROADMAP D4.
- **Unblocks** D4 (1 gated, 1 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-022: accept default`

### D-023 Hooks from `~/.claude/settings.json`

- **Options.** A) Opt-in, `hooks.readClaudeSettings: true`, default false, existing users see a one-time notice (CO14, product review Q10). B) Load with a notice once per definition hash (hooks §8 Q5, `hooks-wiring.md`).
- **Default.** A. Disagreement recorded above.
- **Unblocks** CO14, G11 (2 gated, 1 downstream) · **Cost** Claude Code users enable it once · **Urgency** 2.18.0
- **Reply** `D-023: accept default`

### D-024 Hook failure and matcher semantics

- **Defaults.** A failed hook blocks by default, and the docs say a shared Claude Code file will block here where it continues there (D6; hooks index §7 Q1). An `if` that does not parse lets the hook run, with a log line (hooks §8 Q4). A hook that exits 0 with non-JSON output stays "no decision" (#753 notes it). Matcher anchoring (D14): #753 proposes adopting Claude Code's rule (a plain name or list is exact, anything else an unanchored regex); it is a behaviour change in the less safe direction for guard hooks, so it needs a release note. Dossier default: adopt with the release note, as #753 proposes.
- **Unblocks** D6, D14 (2 gated, 1 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-024: accept default`

### D-025 Hooks in the IDE

- **Default.** Not a 2.16.0 headline (hooks §8 Q10). Whether to move the runner into `core` or keep it CLI only has no recommendation in any note; decide for 2.18.0 planning.
- **Unblocks** D5 · **Cost** M if moved · **Urgency** later
- **Reply** `D-025: accept default` or `D-025: move the runner to core`

## Theme 2. Headless and `serve` safety

### D-026 Headless default policy

- **Question.** Keep the built-in `Bash` and `*` allows for `-p` and `serve`, or run at your levels with asks refused?
- **Default.** Run at your levels with asks refused, capped at Permissive unless `--auto` or `--policy`; one stderr line names the levels; a one-release escape hatch `CONTINUOUS_HEADLESS_LEGACY_ALLOW=1` and a release-note line. Then build H5 after CO2 (permissions §9 Q6 asks whether H5 builds now: it depends on CO2). The bench harness passes `--policy`.
- **Sources.** Product review §3.5 rank 4 and Q1; ROADMAP Open decisions; #787 (leaves CO2 to you).
- **Unblocks** CO2, CO3, H5 (3 gated); every `-p` and `serve` user · **Cost** headless scripts that relied on the allows break once · **Urgency** 2.18.0
- **Reply** `D-026: accept default`

### D-027 A token for loopback `serve`

- **Options.** A) No token on loopback; print the risk at start-up; anything beyond loopback is token-only (product review Q2, surface §8 Q6). B) A token by default, printed once, stored user-only, `--no-token` as a loud opt-out (ROADMAP S1-L1, #622 memo §3).
- **Default.** A, revisited with CO2. This is a security trade-off the notes disagree on: B protects against other local processes and browser pages that reach loopback, at the cost of one break for scripts.
- **Unblocks** X11 · **Cost** B breaks existing scripts once · **Urgency** 2.18.0
- **Reply** `D-027: accept default` or `D-027: option B`

### D-028 Error contract for `-p`

- **Options.** A) A plain sentence on stderr by default, JSON only with `--format json` (user journeys §17 Q7). B) `{"status":"error","message":...}` on stderr in `-p` (isolation §9 Q1; change the harness assertion).
- **Default.** A. #789 (stream-json, exit codes) is where machine output lives.
- **Unblocks** SB5 · **Cost** harness assertion changes either way · **Urgency** 2.18.0
- **Reply** `D-028: accept default`

### D-029 A broken hook or policy file refuses a headless start

- **Default.** Yes: refuse with exit code 2; the terminal UI shows a banner and runs; `--safe` is the one way out (no separate `--ignore-broken-settings`). Fail closed when `permissions.yaml` cannot be read. #739 implements it.
- **Sources.** Hooks §8 Q2; user journeys §17 Q2 and Q10; ROADMAP D10, E10.
- **Unblocks** D10, E10 (2 gated, 2 downstream) · **Cost** a typo stops a session · **Urgency** 2.18.0
- **Reply** `D-029: accept default`

### D-030 Is `serve` public?

- **Default.** Unhide it in `--help` once CO2 lands (`docs-audit.md` Q6), but do not commit to it as a public API in 2.18.0; freeze a schema first (`competitive-gap-analysis.md` §9 Q9).
- **Unblocks** GAP18 (proposed) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-030: accept default`

### D-031 ACP

- **Defaults.** `--auto` allowed over ACP with a warning (surface §8 Q7). Zed is the reference client for PAR18 (unverified that it is the most used). List the CLI in the ACP registry only after the first end-to-end editor run and a published CLI package, and ask whether an empty `authMethods` qualifies (index §10.5 Q12; competitive §9 Q8 says after O24).
- **Unblocks** O24, PAR18, GAP27 · **Cost** none · **Urgency** later
- **Reply** `D-031: accept default`

### D-032 Headless start waits for every MCP server

- **Default.** Keep it (fail early); log each server's connection time in the phase log (PERF23); revisit on reports. Source: `performance-startup-resources.md` §11 Q7.
- **Unblocks** PERF23 (proposed) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-032: accept default`

### D-033 Budget caps for loops and `serve`

- **Defaults.** `maxCostUsd` for loops with no default (off until set). At the limit: ask when a person is watching, stop when not, always stop at IDGAF. `--max-budget-usd` stays the whole-process cap in `serve` (exit 20); the loop cap ends only the loop. In the IDE, Agent mode gets run limits as a setting with no default limit.
- **Sources.** `area-budgets-stuck-memory.md` §10 Q1 to Q3; surface §8 Q10.
- **Unblocks** Y5 (1 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-033: accept default`

### D-034 Waves in 2.16.0

- **Options.** A) Ship N0b, N2, N6 and N5a together with the deterministic harness. B) Only the harness and N0b. C) Nothing of waves in 2.16.0.
- **Default.** A; if the harness slips, N0b alone. Source: `area-loop-planning-waves-reliability.md` §10 Q1. With 2.16.0 being cut (#792), this is the first decision of that release.
- **Unblocks** N0b, N2, N6 (3 gated, 5 downstream) · **Cost** none · **Urgency** 2.16.0
- **Reply** `D-034: accept default`

### D-035 Wave and loop defaults

- **Defaults.** Undeclared files: `allow-disjoint`, lockfiles and build output stripped. Node worktrees: link `node_modules` only when a lockfile exists, with a prompt line forbidding installs. Y4: block the start when the baseline fails, with three actions (a stop at start, not a mid-loop question; consistent with "the loop continues when permissive"). Progress file `.continuous/plans/<slug>.<loop id>.progress.md`, append-only, host-written, scrubbed. F6 superseded. F5a "Continue in a new session" on the cold-cache notice, the plan card and after compaction. N3 and N5b thresholds 10% of a wave's tokens; default-on waves at 25% faster for at most 1.3x tokens (labelled proposed). The reviewer is not shown the item goal. IntelliJ: a diff test (N8b) first. CLI Ctrl+T as the expand key if no handler clashes.
- **Source.** `area-loop-planning-waves-reliability.md` §10 Q2 to Q9, Q11, Q12.
- **Unblocks** N3, Y4, F6 and proposed rows (4 gated, 7 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-035: accept default`

### D-036 Refusal detection defaults

- **Defaults.** "Declined by the model" for people, "refused" stays for rule refusals. Refusal budget 2 consecutive declined items (setting 1 to 5). After a declined item, independent items continue, dependents are held, stop at the budget, the same at IDGAF. A fallback model later (RF6), off by default, only among configured models, never local to remote implicitly (D-056). No clarifying re-ask now (RF8 needs a separate go-ahead). A question-loop signal for IDGAF (RF7). A `refusal` kind in the audit trail with RF3.
- **Source.** `loop-refusal-detection.md` §7.
- **Unblocks** RF1 to RF8 (8 gated, 9 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-036: accept default`

### D-037 Stuck detection default

- **Default.** `stuckDetection: notes`; `full` unavailable until S3 reports; a user-level setting only. Source: budgets §10 Q4. The S3 spend is D-091.
- **Unblocks** S3 (3 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-037: accept default`

### D-038 Loop and agent behaviour without a recommendation

- **Question.** Confirm the planning defaults the ROADMAP flags "yes" but no note picked.
- **Defaults (as used for planning).** A repair re-plan may not drop a check outright; the person sees a hold (H7). A tool call written as text counts as an announcement so the act nudge fires, on every provider (H13). A call written only inside a `<think>` block keeps its nudge (H22; `rq7-false-calls.md` reading). `modeModels.subagent.model` does not apply in the CLI (K13).
- **Unblocks** H7, H13, H22, K13 (2 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-038: accept default`

## Theme 3. Privacy and disclosure

### D-039 The home directory in the prompt

- **Options.** A) Mask the home directory as `~` for every provider at `standard`, local ones included; `full` is the opt-in. B) Keep sending `C:\Users\<name>`; offer `privacy.redactCwd` later.
- **Default.** A, measured on the free grid first (EV155). Sources: master plan §8 #2; privacy §10 Q1; disagreement with current-state §6 Q8.
- **Unblocks** EV155, EV62, EV63 (2 gated, 3 downstream) · **Cost** free on Strata, then about USD 3 for the fence arm · **Urgency** 2.18.0
- **Reply** `D-039: accept default`

### D-040 Disclosure levels and environment facts

- **Defaults.** `environment.detail` with three levels; `full` never inferred from a loopback URL (master #6). OS family and major version only, even at `full`; a name and version (`Windows 11`, `macOS 15`) plus the Node identifier (privacy Q7, current state Q4). Git remote off by default, `full` only, credentials removed (privacy Q3). Repository identity: name and branch; host and owner opt-in (workspace Q3). Date: local day with the numeric offset, once per session; no zone name, no locale (reconciles current state Q9, non-Windows Q3 and privacy Q4). Linux distribution from `/etc/os-release`, labelled, for install hints only (non-Windows Q7). A static environment sentence (about 40 tokens) from `known` or `likely` facts only (non-Windows Q2).
- **Unblocks** EV70, EV72, EV49, EV57 (2 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-040: accept default`

### D-041 The model is not told its permission level

- **Default.** Not disclosed, never in the system message; the escalation recipe stays out of model-facing text; revisit only if EV73 measures a benefit. Sources agree: master #12, privacy Q2, non-Windows Q5.
- **Unblocks** EV59, EV73 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-041: accept default`

### D-042 Where the fence sentence lives

- **Default.** In the first user message header, not the system message. Source: privacy §10 Q6.
- **Unblocks** EV65 (1 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-042: accept default`

### D-043 IDE environment block and editor context

- **Defaults.** The IDE gets the system line and the identity block (date, roots, branch; no status), from the same function as the CLI; `describeShell` moves to `core/util/shell.ts` (EV1). Root folders as basenames and workspace-relative paths; absolute only at `full`. No git status in the IDE identity block (the CLI keeps it, capped). The editor delta (path and line range, about 40 tokens) on by default with a visible chip and a toolbar toggle, on user turns only, in 2.20.0. Keep `read_currently_open_file`. One shell text for every model family until EV37 measures. Ships in the 2.18.0 prompt-byte train (D-117).
- **Sources.** Master §8 #3 and #8; current state §6 Q1, Q3; workspace §7 Q1 to Q7; Windows §11 Q9.
- **Unblocks** EV1, EV44, EV117 (3 gated, 27 downstream) · **Cost** one cold cache, shared with D-117 · **Urgency** 2.18.0
- **Reply** `D-043: accept default`

### D-044 Git status cap in the environment block

- **Default.** #750's built cap (40 files or 4,000 characters, sorted, "... and N more") plus EV50's 2-second timeout. Disagreement recorded above.
- **Unblocks** EV50, C65 (2 gated, 12 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-044: accept default`

### D-045 Third-party fetches the product makes

- **Default.** Ask once per host with per-host consent; deny in headless runs. Source: `area-ci-privacy-release.md` §11 Q7 (§6.3); ROADMAP PL27.
- **Unblocks** PL27 (3 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-045: accept default`

### D-046 Web search: configured or hidden

- **Default.** The tool is absent until your own config names a backend; no default backend; first backends SearXNG, Brave, Tavily and any MCP search tool. Never built: JavaScript rendering for fetch, a cloud reader proxy as a default, a bundled headless browser. Delete `core/continueServer/` with L7, and anyway if L7 slips past 2.18.0 (the headers stub goes now, #627). Your "remove the continue.dev calls" already settles the proxy; this confirms "hidden".
- **Sources.** ROADMAP WB1; `web-search-and-fetch.md` §1 #1, #10; #622 memo §1; index §7 Q9.
- **Unblocks** WB1, L7 (2 gated, 10 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-046: accept default`

### D-047 Web gates

- **Defaults.** A search query with a secret finding is refused (not redacted); a workspace path or multi-line code asks; a masked audit line (WB3; injection Q10 adds one consent card per backend per session). A fetch URL carrying a credential-shaped string is refused (ROADMAP reading; the web note leaves ask or refuse open) (WB6). An unseen URL with a query string, or an unseen host, asks (injection Q9). Spotlighting on by default for fetch, search and MCP results after the E3 measurement (D-088), about 100 tokens a call (WB7, X2).
- **Sources.** Product review §3.5 rank 9; injection §10 Q6, Q9, Q10; `web-search-and-fetch.md` §1.
- **Unblocks** WB3, WB6, WB7 (3 gated, 6 downstream) · **Cost** E3 USD 0.7 · **Urgency** 2.18.0
- **Reply** `D-047: accept default`

### D-048 Provider-native web search

- **Options.** A) Offer per model, opt-in, off by default, with a consent line naming the provider and a cost line. B) Do not offer it: our permission engine cannot see these calls.
- **Default.** A, never on by default (`web-search-and-fetch.md` §1 #8; the ROADMAP lists both).
- **Unblocks** WB10 (1 downstream) · **Cost** M to L · **Urgency** later
- **Reply** `D-048: accept default` or `D-048: option B`

### D-049 MCP output limits and app pages

- **Defaults.** MCP text results capped at 50,000 characters per item, spilled to a file in the CLI. An MCP App's declared domains are restricted to its own origin unless you approve (X26). No malware or reputation feed for MCP servers (it needs a third-party feed).
- **Sources.** Injection §10 Q7, Q8; MCP wizard §10 Q10.
- **Unblocks** X26 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-049: accept default`

### D-050 Session retention

- **Default.** Add `history.retentionDays` (off: no deletion), `--no-session-persistence` for `-p`, and `continuous sessions prune --older-than`. Source: budgets §10 Q6.
- **Unblocks** V11 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-050: accept default`

### D-051 Session log format, resource view name and repository notes

- **Defaults.** V4 session log as JSON lines (decide after V0). V1's command is `/resources` (or `/usage memory`), leaving `/memory` for notes. V9 repository notes: build only with the poisoned-note defence (notes load as untrusted context, never as rules; no verbatim tool text; a diff shown per write at your approval level; a "poisoned note" injection test), opt-in per repository, default off, scrubbed on write.
- **Sources.** Budgets §10 Q7 to Q9 and §V9; ROADMAP V9; `interop-memory-ux-release.md` rank 6.
- **Unblocks** V9, V1, V4 (3 gated, 36 downstream) · **Cost** none · **Urgency** later
- **Reply** `D-051: accept default`

### D-052 Prompt logs in saved sessions

- **Default.** Keep the last request's prompt in memory only, save none, and a debug setting saves them for people who ask (26.8 MB modelled at 300 messages against 0.4 MB). Source: `performance-startup-resources.md` §11 Q3.
- **Unblocks** PERF10 (proposed) · **Cost** feedback buttons lose older prompts · **Urgency** 2.18.0
- **Reply** `D-052: accept default`

### D-053 Exact token counts from the provider

- **Options.** A) Off by default; an explicit "exact token counts" setting that names the provider the prompt is sent to; ship the per-family factor first (caching §9 Q3). B) On where credentials exist and the call is free (ROADMAP J9).
- **Default.** A.
- **Unblocks** J9 (1 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-053: accept default`

### D-054 Using your own sessions as data

- **Question.** May agents read your local data, locally, for counts only?
- **Defaults.** Allow a local, aggregate-only pass over your Claude Code transcripts (EV161; counts by class, nothing written to the repository). Allow a read-only RQ7 rerun over local sessions that reports counts only. Allow the taint replay over your audit directory (D-006). For copy-as-markdown fixtures, real answers may be committed only after redaction by hand (`copy-as-markdown.md` Q11).
- **Sources.** Master §8 #10; evaluation §11 Q5; ROADMAP RQ7 row; `copy-as-markdown.md` §10 Q11.
- **Unblocks** EV161, X17 (via D-006) · **Cost** free, about an hour · **Urgency** 2.18.0
- **Reply** `D-054: accept default`

### D-055 `git-ai` integration

- **Default.** Opt-in, off by default, absolute path only (CO5; #743 implements). Source: product review Q4.
- **Unblocks** CO5 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-055: accept default`

### D-056 Fallback from a local model to a remote one

- **Default.** Never implicitly; only when you list the remote model. Source: `competitive-gap-analysis.md` §9 Q7 (GAP20); consistent with RF6.
- **Unblocks** GAP20 (proposed) · **Cost** none · **Urgency** later
- **Reply** `D-056: accept default`

### D-057 Local skill use counts

- **Default.** Keep them: a local file, salted ids for project entries, a clear button. Source: `skills-vs-prompts-toolbox.md` §8 D6.
- **Unblocks** proposed toolbox rows · **Cost** none · **Urgency** later
- **Reply** `D-057: accept default`

## Theme 4. Environment and shell

### D-058 Stay on Windows PowerShell 5.1

- **Defaults.** Windows PowerShell 5.1 stays the default shell for 2.18.0; no Git Bash executor; no `prefer-wsl` routing; revisit `pwsh` after the grid (EV92) with a migration note for rules. Keep the profile and say on the Permissions page that it runs first. One shell tool, not two. No shell-version probe while only 5.1 is spawned.
- **Sources.** Master §8 #13; Windows §11 Q1, Q5; shell §10 Q7, Q8; current state §6 Q6, Q7.
- **Unblocks** SH8, EV40, EV33 (3 gated, 5 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-058: accept default`

### D-059 Refuse certain parse errors before the approval card

- **Defaults.** Certain lint findings are answered before the card; `&&` and `||` under 5.1 become errors; never rewrite a command silently (a suggestion can later be accepted as a button, EV39). Measure A5 only with certain signals; a pre-flight reject that blocks a command the shell would have run is a defect. #772 waits on this (warning or reject).
- **Sources.** Master §8 #4; Windows §11 Q2, Q3; evaluation §11 Q7.
- **Unblocks** EV26, EV28, EV27 (3 gated, 9 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-059: accept default`

### D-060 Executor fixes (#790)

- **Defaults.** Yes to all: `-NonInteractive` and closed stdin, `PAGER=cat` and `GIT_PAGER=cat`, real exit codes, UTF-8 output set before the command with the Constrained Language Mode guard. `a; b` keeps the last statement's result (#790 leaves it).
- **Sources.** Master §8 #5; Windows §11 Q7, Q8; non-Windows §10 Q6.
- **Unblocks** EV24, EV25, EV58 (3 gated, 2 downstream) · **Cost** scripts that relied on prompts or code pages change · **Urgency** 2.18.0
- **Reply** `D-060: accept default`

### D-061 WSL

- **Defaults.** One machine-scoped setting `terminalShell: wsl`, no first-run question; the "PowerShell is still reachable" sentence only with a Windows host. A WSL notice to the person once per session after three certain bash-isms (2.20.0, needs ENV24 counts). "Forced" becomes a managed-policy flag later. A dedicated WSL distribution is a candidate after W4b, not 2.16.0.
- **Sources.** Master §8 #11; Windows §11 Q4 to Q6; current state §6 Q5; isolation §9 Q11.
- **Unblocks** EV29, W18 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-061: accept default`

### D-062 Remote windows: prompt text and terminal

- **Defaults.** Drop the OS and shell sentence when `remoteName` is not `local` (EV42) until EV41 is answered. A dedicated terminal named "Continuous" for remote commands, created once per window (SH2). Shells outside bash and zsh: the family and one dialect sentence, not parsed (EV46).
- **Sources.** Non-Windows §10 Q1, Q8; shell §10 Q9.
- **Unblocks** EV42, EV46 (2 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-062: accept default`

### D-063 The shell line on the approval card

- **Defaults.** Name it "Runs through" (alternatives "Interpreter", "Read by"). `npm test`, `make`, `python x.py` get no line. Shebangs: first line only, inside the workspace, literal path, 64 KB cap, a description never a licence.
- **Source.** `shell-awareness.md` §10 Q4 to Q6.
- **Unblocks** SH5, SH7 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-063: accept default`

### D-064 Wording of the Windows sentence and the A3 text

- **Defaults.** The full sentence (current state §5.3) at `full`, the first two clauses at `short`, measured claims only. The peers' Environment block v2 replaces the A3 placeholder before any paid run, so no paid result is spent on a throwaway text.
- **Sources.** Current state §6 Q2; evaluation §11 Q6.
- **Unblocks** EV87 wording · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-064: accept default`

## Theme 5. Release and CI

### D-065 Branch protection on `main`

- **Question.** When and how to protect `main` (CI1; duplicates CI14, CI16, SB9, DR11)?
- **Options.** A) Right after #751 (CI30) merges: `merge-gate` the only required check, `strict: true` (three to four merges an hour; serial `gh pr update-branch`), `enforce_admins: false` so you can break glass, rollback command kept. B) Now, with the polling gate (product review). C) `strict: false` with the post-merge check.
- **Default.** A. Sources: `area-ci-privacy-release.md` §11 Q2; ROADMAP CI1 precondition; `interop-memory-ux-release.md` §6; product review §3.5 rank 3 (B).
- **Unblocks** CI1, CI14, CI16, SB9, DR11 (5 gated, 42 downstream) · **Cost** serial merges · **Urgency** now
- **Reply** `D-065: accept default`

### D-066 #751: merge-gate semantics

- **Question.** The four owner questions in #751.
- **Defaults.** (1) A draft's gate passes with a notice (Actions has no neutral; CI note §11 Q3 agrees). (2)-(4) have no recommendation in the PR; dossier suggestions: no `merge-gate-v2` window (the PR explains it is neither cheap nor safe); keep the skip list as is until five PRs have been observed, and docs-only PRs keep skipping prettier; yes, try the e2e merge (10 legs to 2 jobs) on a scratch branch next.
- **Unblocks** CI30, CI33 (2 gated, 3 downstream) · **Cost** none · **Urgency** 2.18.0 (#751 is marked for 2.18.0, but D-065 waits on it)
- **Reply** `D-066: accept default`

### D-067 CI capacity and the fork network

- **Defaults.** Stay on GitHub Free (20 concurrent jobs): no support ticket and no move to an organisation now; fix the gate and the job count first; cancel the stuck runs and keep at most four PRs ready. Ask GitHub Support to detach the repository from the `continuedev/continue` fork network when convenient (removes the default-target hazard for `gh` in a fork clone; support response time unverified).
- **Source.** `area-ci-privacy-release.md` §11 Q1, Q10, T2.
- **Unblocks** CI capacity rows · **Cost** none · **Urgency** now
- **Reply** `D-067: accept default`

### D-068 Private vulnerability reporting

- **Default.** Enable it today (Settings, Code security). `SECURITY.md` and `PRIVACY.md` link a form that does not load for outsiders (`enabled: false`, 2026-11-12). One switch.
- **Sources.** DR10; `docs-audit.md` Q3; CI note §12.
- **Unblocks** DR10, PV8 (2 gated, 2 downstream) · **Cost** none · **Urgency** 2.16.0
- **Reply** `D-068: done` once switched on

### D-069 Where a bug report goes

- **Options.** A) Enable Issues, `blank_issues_enabled: false`, a contact link to private vulnerability reporting for security (DR14, `docs-audit.md` Q1). B) Discussions only, with `doctor --copy` output to paste (user journeys §17 Q1). C) Pull requests only, said in one sentence everywhere.
- **Default.** A, then point `bugs.url` (both `package.json`), the README, `CONTRIBUTING.md` and the issue templates at it. The nightly-red issue (D-078) needs it.
- **Unblocks** DR14 · **Cost** triage duty · **Urgency** 2.16.0 (`bugs.url` ships pointing at disabled Issues)
- **Reply** `D-069: accept default`

### D-070 Release pipeline

- **Defaults.** Release by `release_tag` dispatch only, with `environment: marketplace` and you as the required reviewer (matches "publish only on explicit word"). Gate the workflow run that will publish and republish that run (`republish_run_id`), so the hashes match by construction. The sandbox gate runs on your machine (`tools/sandbox/gate.ps1`), its result committed as `release-gates/<tag>.json` and checked by a `gate-verify` job; no self-hosted runner.
- **Sources.** CI note §11 Q5; isolation §9 Q2, Q3.
- **Unblocks** CI28 (1 gated, 3 downstream) · **Cost** none · **Urgency** 2.16.0
- **Reply** `D-070: accept default`

### D-071 Sandbox gate before 2.16.0

- **Defaults.** Run the sandbox matrix (SB1, SB13) before 2.16.0 and attach the result to the release. From 2.18.0, a release is also blocked by the full three-platform run, and by the live run for providers that have a key (otherwise "not run" in the release notes); about an hour more per release.
- **Sources.** CI note §11 Q14; `test-quality-strategy.md` §7 Q7.
- **Unblocks** SB1, SB13 (2 gated, 10 downstream) · **Cost** your machine's time · **Urgency** 2.16.0
- **Reply** `D-071: accept default`

### D-072 Sandbox harness policy

- **Defaults.** Move the harness into `tools/sandbox` with Node and VS Code downloads pinned by SHA-256 and cached outside git (confirm `.vscodeignore` and the CLI `files` list exclude `tools/`). VS Code's own telemetry is out of scope for the egress test; the guest VS Code runs with telemetry and updates off. Waivers in `tools/sandbox/expected.json`, at most 30 days, each with a ticket. Try `ProtectedClient` once; adopt only if all cases pass and screenshots work. No Hyper-V VM now. W-D2 re-check dated after 2.16.0 (W18). `sandbox-runtime`: exact pin, optional dependency installed with `--omit=optional --ignore-scripts`, loaded only when selected, a CI job that fails on a new version until the probes pass. W4b in 2.16.0 only as a flagged slice if you accept the Linux and WSL first scope; otherwise it leads 2.18.0.
- **Source.** `area-isolation-sandbox-gate.md` §9 Q4 to Q12.
- **Unblocks** W4b, SB12 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-072: accept default`

### D-073 Distribution channel, Open VSX and verified publisher

- **Defaults.** Record as decided: GitHub Releases is the reference, the Marketplace and Open VSX are mirrors; add `PRIVACY.md`, the notices, an SBOM and an attestation (PV4, PV6). Defer Open VSX until the Eclipse Publisher Agreement is signed and the namespace claimed (the job reports its skip). Defer the verified publisher until a domain exists.
- **Sources.** ROADMAP Open decisions; CI note §2.4, §6.1, §11 Q6; #622 memo §1.
- **Unblocks** PV4, PV6 · **Cost** none · **Urgency** 2.16.0 (the channel), later (Open VSX)
- **Reply** `D-073: accept default`

### D-074 CodeQL and action pinning

- **Defaults.** CodeQL default setup on a schedule and on `main` only. Pin every action by SHA, `actions/*` included, in one PR after CI30, then set `sha_pinning_required`.
- **Source.** CI note §11 Q12, Q13.
- **Unblocks** CI22 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-074: accept default`

### D-075 Dependabot configuration

- **Defaults.** Group `ai` and `@ai-sdk/*` (or ignore their majors until `openai-adapters` is migrated); `open-pull-requests-limit: 3` for npm; version updates off for gradle, pip and docker; monthly npm and cargo; explicit `cooldown`. Dossier suggestion that follows: close the open gradle and pip bumps (#679, #676, #681) once the config lands.
- **Source.** `area-ci-privacy-release.md` T6 and CI34.
- **Unblocks** CI34 · **Cost** none · **Urgency** 2.16.0 (CI note: "do now, before 2.16.0")
- **Reply** `D-075: accept default`

### D-076 Which CI jobs run on a pull request

- **Defaults.** E2E only when the extension, `gui` or `core` change, two jobs, everything nightly. A Windows job only when Windows-sensitive paths change, always after a merge, full at night. `jetbrains-tests` path-filtered and not required. The surface conformance suite is report-only until PAR4, then a gate on undeclared differences.
- **Sources.** CI note §11 Q15; test quality §7 Q4, Q8; surface §8 Q2, Q4.
- **Unblocks** CI36, CI37 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-076: accept default`

### D-077 Flaky-test budget

- **Default.** At most 3 quarantined entries, 14-day expiry, never under the permissions, secret-scanning or `terminal-security` code; `merge-gate` retries a quarantined test once. Sources agree: CO23, product review Q12, test quality §7 Q5.
- **Unblocks** CO23, QA10 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-077: accept default`

### D-078 How a red nightly reaches you

- **Default.** GitHub's email for a failed scheduled workflow plus the agents' session-start check now; one "nightly is red" issue once D-069 enables Issues. Source: test quality §7 Q1.
- **Unblocks** QA4 (proposed) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-078: accept default`

### D-079 Golden changes declared in the PR description

- **Default.** Yes: a PR that changes a prompt golden carries one declaration line. Source: test quality §7 Q6.
- **Unblocks** proposed QA rows · **Cost** one line per prompt PR · **Urgency** 2.18.0
- **Reply** `D-079: accept default`

### D-080 Measurement policy for tests and start-up

- **Defaults.** Mutation testing and coverage as measurements without thresholds for two months, then thresholds from data. CI stays on the supported Node versions; `doctor-dev` warns on Node 25. A PR fails on start-up sizes and on a `--version` ratio at 1.5x the budget only; timings are reported nightly. Budgets use the reference desktop, with a laptop column after PERF25.
- **Sources.** Test quality §7 Q9, Q10; performance §11 Q4, Q5.
- **Unblocks** QA9 and PERF rows (proposed) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-080: accept default`

### D-081 Build: minification and the CLI compile cache

- **Defaults.** Minify the VS Code extension with `keepNames`, and keep the source map as a release asset, not in the package (46.7 MB, 80 ms faster load measured). The CLI compile cache lives in `<global dir>/cache/compile` (2.7 MB), off with `NODE_DISABLE_COMPILE_CACHE=1`, documented. #791 implements both defaults; this confirms them.
- **Source.** Performance §11 Q1, Q2; #791.
- **Unblocks** PERF2, PERF8 (proposed) · **Cost** harder stack traces without the map · **Urgency** 2.18.0
- **Reply** `D-081: accept default`

### D-082 CI caching policy and accessibility checks

- **Defaults.** Accept `docs/ci-caching.md` from #650 (you asked for it; it estimates about 20% less runner time per PR Checks run and keeps caches out of release builds). Add the axe run as a non-blocking check first (UX36); it needs Chromium on the runner.
- **Sources.** #650; UX §12 Q8.
- **Unblocks** UX36 (1 gated, 14 downstream) · **Cost** runner time for Chromium · **Urgency** 2.18.0
- **Reply** `D-082: accept default`

### D-083 Open pull requests waiting on you

- **Question.** What happens to these drafts? No note recommends; dossier suggestions.
- **Suggestions.** #765 (IDE terminal sentence): superseded by the environment plan; fold into the 2.18.0 train (D-117) as EV1 to EV3 and close. #655 (release-notes draft after 2.12.1): superseded by #792, which builds notes from `UNRELEASED.md`; close. #622 (privacy research and open-decisions memo): its recommendations are now in the ROADMAP's Open decisions and in this dossier; merge as the record or close. #606 (logo border): a taste call; no note has a view.
- **Reply** `D-083: accept suggestions` or one line per PR

## Theme 6. Spend approvals

### D-084 Free Strata grid

- **Default.** Approve EV82: 455 runs, about 1,600 requests, about 4 to 8 GPU-hours (planning figure), overnight, one model, arm order as built, no Strata restart. Confirm Strata is stopped, and not started by other work, during each GPU window. The loop's N1 local run goes on the same grid.
- **Sources.** Evaluation §11 Q1; master §8 #9 step 0; lab §10 Q6; loop §10 Q10.
- **Unblocks** EV82 (1 gated, 13 downstream) · **Cost** USD 0 · **Urgency** 2.18.0
- **Reply** `D-084: accept default`

### D-085 Environment-disclosure paid ladder

- **Defaults.** Step 1 (EV87, Haiku 5.5 and Sonnet 5.5, 780 runs): expected USD 4.9, upper bound USD 9.9, after EV82 shows a first-command effect; the home-mask fence arm about USD 3. Step 2 (12 reps, Sonnet 5.5 and Haiku 4.5, 1,872 runs): expected USD 16.8, upper bound about USD 34, decided on step 1's numbers. Nova 2 Lite (USD 1.0 per 390 runs) as the cheap non-Claude family; no Opus 5.5 unless a result needs a ceiling. Raw runs in `D:\temp\env-eval\`; only a verdict row and the report travel in a PR.
- **Sources.** Evaluation §11 Q2 to Q4, Q8; master §8 #9.
- **Unblocks** EV87 · **Cost** about USD 8 expected for step 1 and the fence arm, then USD 16.8, then USD 1.0 · **Urgency** 2.18.0
- **Reply** `D-085: accept default`

### D-086 Benchmark run plans (about USD 40)

- **Defaults.** Approve per plan, in this order, and stop a series when a plan's actual cost exceeds 2x its estimate: P-I23 (about USD 3), P-Q44 (under USD 1), P-I19 (under USD 0.5), P-Q3 and P-Q2 on Qwen3-Coder 30B only (about USD 12), P-M5 (USD 3 to 5), P-I5 with Haiku 5.5 and Sonnet 5.5 (USD 3 to 10), P-M1 smoke (about USD 1.2). Price the plans from the pricing pages; score with #696's OpenRouter prices once merged. The bench runner may resolve the first-party key through `${{ secrets.ANTHROPIC_API_KEY }}` (never written or printed). Confirm the note's §8.5 drop list.
- **Sources.** `area-benchmark-toolcall-styles.md` §9 Q1, Q2, Q9, Q12; ROADMAP Open decisions (the plans now target 2.18.0).
- **Unblocks** I23, Q44, I19, Q3, Q2, I5, M1, M5 (8 gated, 51 downstream, most through I23 into Track MR) · **Cost** about USD 40 · **Urgency** 2.18.0
- **Reply** `D-086: accept default`

### D-087 Reviewer measurement spend (about USD 3)

- **Defaults.** Approve B53 (`--repeat 3`, Haiku 4.5, about USD 0.48) now; the Nova 2 Lite run with `promptV3` and `tightenAllow` (B83, B84, about USD 0.7) after B12a, reporting the union of false allows over repeats; the DR5 v3 false-allow measurement (about USD 1.70); Q44 at n of 30 (cents). Review the relabelled B46 cases in one sitting (your time). Nova 2 Lite stays off the Adopt list until it passes alone. Product review rank 2 quotes "about USD 2 for B53 and Q44"; the sum above adds the Nova and v3 runs.
- **Sources.** Product review §3.5 rank 2; permissions §9 Q2; `agent-security.md` R10; `b54-nova-false-allows.md`; DR5; ROADMAP Open decisions.
- **Unblocks** B4, B46, B53, DR5, B83, B84 (6 gated, 31 downstream) · **Cost** about USD 3 · **Urgency** 2.18.0
- **Reply** `D-087: accept default`

### D-088 Spotlighting measurement

- **Default.** Approve the paired injection set (B48) on Haiku 4.5 with and without spotlighting, about USD 0.35 per arm, about USD 0.7 in all; it decides the default in D-047. Source: `agent-security.md` E3 and R13; injection §10 Q6.
- **Unblocks** B48, WB7 · **Cost** about USD 0.7 · **Urgency** 2.18.0
- **Reply** `D-088: accept default`

### D-089 Tool-exposure confirmation runs

- **Default.** Hold until the free lab results; then approve up to USD 30 on one Sonnet-class model for the tool-count sweep (E2) and the role test (E3): about 540 runs of about 15k input tokens, about 8 million tokens, about USD 24 uncached at an assumed USD 3 per million (confirm the price first). Skip it if the lab shows no tool-count effect.
- **Sources.** `tr-owner-decisions.md` row 9; #622 memo §4; ROADMAP TR12.
- **Unblocks** TR12 · **Cost** up to USD 30 · **Urgency** 2.18.0
- **Reply** `D-089: accept default`

### D-090 Cache measurements

- **Defaults.** Yes to the live DeepSeek and Gemini 4 checks (cents) and the Converse system-role probe (under USD 1; decides C8, C44, C69). Z4 only on Nova and one local family first (single-digit dollars); no Claude arm until the cheap families show a signal.
- **Source.** Caching §9 Q8; ROADMAP C86.
- **Unblocks** C86, Z4 (1 downstream) · **Cost** under about USD 10 · **Urgency** 2.18.0
- **Reply** `D-090: accept default`

### D-091 Stuck-detection calibration

- **Default.** Approve S3 (two models, 40 runs each, cents to a few dollars hosted) after S1b and S5a land, so the check-in is tested in the loop it runs in; E4 stuck-decoy as pre-registered in `stuck-calibration.md` §6.
- **Sources.** Budgets §10 Q5; `benchmarks-toolcalls-loops.md` rank 6.
- **Unblocks** S3 (3 downstream) · **Cost** a few dollars · **Urgency** 2.18.0
- **Reply** `D-091: accept default`

### D-092 Local lab and model store

- **Defaults.** Approve GPU time for E1 to E3 (about 3 GPU-hours, no downloads). Downloads of about 40 GB of GGUFs (Qwen3.6-35B-A3B, Qwen3.8-27B) on M: not now; revisit after the free contrasts (disagreement recorded). Grant write access on the A: shares so the archive tier can be tested. The default local coding model is chosen after E7. vLLM and SGLang stay deferred. The canonical Ollama store is `M:\ai\models`; restarting the server is your approval; archive to A: with `robocopy /E`, never `/MIR` (DR9). Lab imports go through `ollama create` or llama-server, never from the NAS share.
- **Sources.** `local-inference-lab.md` §10; bench §9 Q3, Q4; DR9; ROADMAP Open decisions.
- **Unblocks** RQ35, DR9 (1 downstream) · **Cost** GPU time; 40 GB disk if approved later · **Urgency** 2.18.0
- **Reply** `D-092: accept default`

### D-093 AWS reads, the Claude route and free calls with your keys

- **Defaults.** Approve the non-billed reads `ListServiceQuotas` and MR10's `CountTokens` sweep on the torgate account, run by you. Claude 5.x arms use the first-party API; stop pursuing AWS Support (two requests were auto-closed) and file one more case only for a Mantle-specific need. No Grok dollar quota. No spend on K1 and K2 probes in 2.16.0 (the K1b config key does not need it). Free calls with your keys: two `GET /v1/models` calls to see whether the Anthropic list returns `capabilities` and `lifecycle`, and two Ollama cloud `api/tags` calls.
- **Sources.** Models §8 Q4, Q10; bench §9 Q10; ROADMAP Open decisions; `providers-models-import.md` E1, E6.
- **Unblocks** MR10, K1, K2 (3 downstream) · **Cost** free · **Urgency** 2.18.0
- **Reply** `D-093: accept default`

### D-094 Provider keys for a nightly live run in CI

- **Defaults.** Yes: one Anthropic key and one OpenAI-compatible key made for CI, in an environment named `live-keys`, each with the provider's lowest spend limit; delete the eleven unused secrets. Bedrock joins later through OIDC and a narrow role, after two stable weeks. New limited keys, not rotation.
- **Source.** `test-quality-strategy.md` §7 Q2, Q3; QA8.
- **Unblocks** QA8 (proposed) · **Cost** each key's spend limit · **Urgency** 2.18.0
- **Reply** `D-094: accept default`

### D-095 Paid loop runs

- **Default.** N1 and Y6: one local-model run on Strata (free), then one cheap Bedrock row. U4's injection extension waits for the DR5 approval (D-087). Source: loop §10 Q10.
- **Unblocks** N1, Y6 (2 gated, 10 downstream) · **Cost** cents · **Urgency** 2.18.0
- **Reply** `D-095: accept default`

### D-096 Security-audit skill measurement

- **Question.** Which model and which cap for the one-off SK15 run? No note gives a default; the skill's cost is unmeasured and could be hundreds of agent calls on a large repository.
- **Dossier suggestion.** Haiku 4.5 with a USD 5 hard cap on one medium repository.
- **Unblocks** SK15 (proposed) · **Cost** your cap · **Urgency** later
- **Reply** `D-096: <model>, <cap>`

### D-097 External anchors and extra recovery dialects

- **Defaults.** No Aider-polyglot-style anchor run for now; use Q3 on our own scenarios (bench §9 Q11; the ROADMAP says "when time allows"). GLM and Kimi text-form recovery dialects only if a served engine lacks the parser (`benchmarks-toolcalls-loops.md` rank 10).
- **Unblocks** none · **Cost** M if run · **Urgency** later
- **Reply** `D-097: accept default`

## Theme 7. Product scope

### D-098 JetBrains

- **Options.** A) Park: remove the `release: prereleased` trigger, keep build-only dispatch, say so in the README and docs, keep one parity test and run the JetBrains job only when its paths change; ACP is the route to JetBrains IDEs. B) Maintain minimal. C) Rebrand (plugin id, name, vendor, the licence-key action) and ship.
- **Default.** A; L5 moves to Later; promise nothing on drag and drop until UX54 measures a windowed browser; no off-screen rendering change until PERF20. Fixing E8 (one line, #734 adds the 2026.2 JCEF dependency) is fine while parked.
- **Sources.** CO18; product review §3.5 rank 7 and Q7; surface §8 Q1; test quality §7 Q8; index §7 Q7; hooks §8 Q9; UX §12 Q14; performance §11 Q8; `docs-audit.md` Q7.
- **Unblocks** CO18, UX65, UX21, L5 (4 gated, 7 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-098: accept default`

### D-099 MCP server wizard

- **Defaults.** Save to your own `config.yaml`; "This project" writes `.continuous/mcpServers/<name>.yaml` as an explicit choice. No change for hand-edited entries (the launch pin already asks on change). The probe may run before Save, behind an explicit "Run this command and test" button. Block Test and Save on pipe-to-shell installers until an explicit acknowledgement, and never allow one from a deeplink or the registry. Eight templates: filesystem, git, fetch, memory, sequential-thinking, GitHub (remote, OAuth), Playwright, SQLite, each pinned to a version we looked at. Registry in slice 3; deeplinks in slice 3 as a review screen with a banner (or drop MCPW15). Pin at Add, after TR4. A per-server `enabled` key in slice 2. Show the MVP wireframes to five people new to MCP before building MCPW4.
- **Source.** `mcp-server-wizard.md` §10.
- **Unblocks** MCPW15, MCPW4 (2 gated, 6 downstream) · **Cost** none · **Urgency** later
- **Reply** `D-099: accept default`

### D-100 Checkpoints

- **Defaults.** Do not rely on git; snapshot named targets only (GAP3). Terminal checkpoints are session-file snapshots of the files the agent writes, not a shadow repository.
- **Sources.** Competitive §9 Q3; user journeys §17 Q6.
- **Unblocks** GAP3 (proposed) · **Cost** none · **Urgency** later
- **Reply** `D-100: accept default`

### D-101 CI recipe and a GitHub Action

- **Defaults.** A CI recipe is in scope as documentation and a sample that sends a diff to the model host you configured, on your runner; no hosted app (GAP6). No published GitHub Action until the recipe has run on our own PRs for one release (GAP7). Delete the upstream `actions/` directory meanwhile (D-134).
- **Source.** Competitive §9 Q1, Q2.
- **Unblocks** GAP6, GAP7 (proposed) · **Cost** none · **Urgency** later
- **Reply** `D-101: accept default`

### D-102 Voice input

- **Default.** Later, only with an endpoint you configure, no default (GAP12). Source: competitive §9 Q4.
- **Unblocks** GAP12 (proposed) · **Cost** none · **Urgency** later
- **Reply** `D-102: accept default`

### D-103 Plugins and scheduled runs

- **Defaults.** Read other tools' plugin manifests read-only and locally; no catalogue (GAP15). Scheduled runs use the OS scheduler; no daemon (GAP10).
- **Source.** Competitive §9 Q5, Q6.
- **Unblocks** GAP10, GAP15 (proposed) · **Cost** none · **Urgency** later
- **Reply** `D-103: accept default`

### D-104 Notifications

- **Defaults.** Off by default, opt-in (GAP9). IDE host notifications: off, a 30-second threshold, never show the command (UX51). #789 builds the CLI attention notifications this way.
- **Sources.** Competitive §9 Q10; UX §12 Q13.
- **Unblocks** UX51 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-104: accept default`

### D-105 Security-audit skill

- **Defaults where given.** Title "Security review (read-only)" until execution is sandboxed. `auditRoot` is `<home>/continuous-audits`, outside every config folder. Drop the skill's test files from shipped copies and keep the two validators. You said skills are opt-in: confirm that the first-use dialog is the opt-in.
- **No default given.** One "Skills" drawer glyph or a tab strip inside the Toolbox drawer; whether to accept SK12 (a session-scoped write grant and a bundled-folder read exemption) before anyone but you uses it; who reads the refresh diff, and whether a highlighted change needs a second reviewer.
- **Source.** `security-audit-skill.md` §9.
- **Unblocks** SK12 (proposed) · **Cost** see D-096 · **Urgency** later
- **Reply** `D-105: accept defaults; drawer: <choice>; SK12: <yes/no>; maintainer: <name>`

### D-106 Skills toolbox format

- **Defaults.** `metadata.toolbox` as the opt-in key (valid under the spec). A person-launched skill is sent as the user message. Built-in entries are not `/` commands by default; user and project entries are. Read `.agents/skills` with a source badge; precedence `.continuous` over `.agents` over `.claude`, project over user. `allowed-tools` in a third-party skill is never applied in v1.
- **Sources.** `skills-vs-prompts-toolbox.md` §8 D1 to D5; index §7 Q4.
- **Unblocks** toolbox rows (proposed) · **Cost** none · **Urgency** later
- **Reply** `D-106: accept default`

### D-107 Index and instruction files

- **Defaults.** Full-text and snippet indexing on by default for repositories under 20,000 files, off with a one-line prompt above that; nothing leaves the machine (L0). `AGENTS.md` first, `CLAUDE.md` as fallback, a setting to load both; `CODEX.md` kept in one shared list. 32 KiB cap across nested files, truncation shown. Subagent `maxDepth` default 1, maximum 3, after O4. Embeddings stay an opt-in layer; decide L13 after L11; never bundle a non-commercial model, and a CC-BY-NC model is acceptable only as your own choice, undocumented. Restate O23 now.
- **Sources.** `area-index-interop-later.md` §7, §10.5; hooks index §7 Q5; ROADMAP L13.
- **Unblocks** L0, L13, L11 (3 gated, 13 downstream) · **Cost** none · **Urgency** later
- **Reply** `D-107: accept default`

### D-108 OAuth loopback host

- **Options.** A) Keep `localhost` with the per-server `redirectHost` override (DR1) until SB11 verifies Okta and Auth0. B) Flip to `127.0.0.1`, the literal RFC 8252 prefers, with `redirectHost` for servers that registered `localhost` (ROADMAP PL15 recommendation). Slack requires HTTPS redirect URIs either way; GitHub and Entra ignore the port and recommend `127.0.0.1`.
- **Default.** A.
- **Unblocks** PL15, DR1 (2 gated, 4 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-108: accept default`

### D-109 Removing the `mcp-remote` fallback

- **Options.** A) Remove it once the CLI uses core's fetch and OAuth provider and has a proxy and CA test (models §8 Q7; ROADMAP PL16; `enterprise-network-auth.md` rank 2). B) Remove it now, before `mcp login` exists, saying "sign-in needed", with an opt-in setting for one release (user journeys §17 Q3).
- **Default.** A: removing it first leaves remote servers without a sign-in path; the unpinned package run is the cost of waiting.
- **Unblocks** PL16 (1 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-109: accept default`

### D-110 Bedrock short-term keys

- **Options.** A) Not yet: ship the long-term-key warning and the streaming check first (models §8 Q2). B) Accept `@aws/bedrock-token-generator` now (ROADMAP K26).
- **Default.** A.
- **Unblocks** K26 · **Cost** a new dependency for B · **Urgency** 2.18.0
- **Reply** `D-110: accept default`

### D-111 CLI secret store, client metadata documents and proxies

- **Defaults.** CLI secrets through OS tools behind a `SecretBackend` interface, no native module, a 0600 file fallback with a warning (PL23). Static MCP client ids now; a Client ID Metadata Document only for servers that require it, since it needs a public HTTPS host (PL25). PAC, NTLM and Kerberos: document a local forwarder, promise no native NTLM (PL26).
- **Sources.** Models §8 Q8; index §7 Q5; ROADMAP Open decisions; `enterprise-network-auth.md` ranks 9, 12, 13.
- **Unblocks** PL23, PL25, PL26 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-111: accept default`

### D-112 Provider surfaces and settings import

- **Defaults.** Bedrock `bedrock-runtime /openai/v1` as a `surface` option next to Mantle, Mantle stays the default until MR10 and E3 show parity; discovery through `ListFoundationModels` and `ListInferenceProfiles` (K25). Show OpenAI and OpenRouter retirement dates from data already fetched, no button (K22). Keep the Messages `anthropic-version`; send the newer one on the list call only; bump later by decision (K23). Ollama cloud models as a provider variant with a bearer key (K29). Settings-import order: Claude Code providers and models (G3), then Codex, Aider, then Goose and Kilo, then Copilot Chat. Keep research tooling here until X7, then move it (MR7b). Narrow C9 to Vertex once #696 merges. Leave upstream Nova cache points (C56) as an idea.
- **Sources.** Models §8 Q1, Q3, Q5, Q6; ROADMAP Open decisions; `providers-models-import.md` ranks 2, 5, 6, 13; caching §9 Q9, Q10.
- **Unblocks** K25, K22, K23, K29, G3 (3 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-112: accept default`

### D-113 One Plan and Act switch in 2.16.0

- **Question.** Ship A7 (a single "different models for Plan and Act" switch, default off, the seven uses behind Advanced) in 2.16.0, although it changes how the Models tab looks?
- **Default.** Yes; default off keeps today's data. Sources: models §8 Q9; ROADMAP Open decisions; `providers-models-import.md` rank 12.
- **Unblocks** A7 (1 downstream) · **Cost** none · **Urgency** 2.16.0
- **Reply** `D-113: accept default`

### D-114 Haiku 5.5 as the Plan mode default

- **Default.** Not yet; measure it through the direct Anthropic API instead of waiting for Bedrock quota, and ship it only with n of at least 5 on the harder seeds. Sources: ROADMAP Open decisions; #622 memo §4.
- **Unblocks** the Plan default row · **Cost** within D-086 · **Urgency** 2.18.0
- **Reply** `D-114: accept default`

### D-115 Tool-call recovery policy

- **Defaults.** Recovery on by default only for a family with a named dialect, a live leak and a Wilson lower bound above zero (today only Llama 3.3 70B); opt-in everywhere else (Q5). Accept Python `True` and `False` for a boolean-typed parameter only (Q53). Send `force_nonempty_content` for Nemotron 3 with tools as a preset fact after one test (Q54). Record Q9 and Q11 as built and final; Q24 as "intercept in core, do not reverse the import". M3 escalation, if built: one per item, three per loop, off; defer the build. A recovered call shows a badge with its raw text.
- **Sources.** Bench §9 Q5 to Q8; `rq8-templates.md`; ROADMAP Open decisions.
- **Unblocks** Q5, Q53, Q54, Q24, M3 (5 gated, 24 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-115: accept default`

### D-116 Prompt cache behaviour

- **Defaults.** Read rules and `AGENTS.md` once per session, rebuild on `/reload`, record in the audit trail that a file changed, append a "date changed" line after midnight; measure on one real session first (C55). Freeze the CLI tool list at the first request; a late MCP server's tools wait for `/reload` or are offered deferred (C80). Subagent cache lifetime 5 minutes with an opt-in `cacheBehavior.subagentTtl` (C46, C85). Offer `TaskList` from the first Agent request behind a one-release flag (C70). Tool search stays off; its budget becomes a function of the model's read ratio (Z9). A resumed CLI session keeps its saved system message and environment block until compaction or `/reload` (C87; #750 notes this needs a session-format change). A debug override `CONTINUOUS_FORCE_CACHE_5M=1` (C90).
- **Sources.** Caching §9 Q1, Q2, Q4, Q5, Q7; ROADMAP Open decisions.
- **Unblocks** C55, C80, C85, C70, Z9, C87, C88, C90 (8 gated, 7 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-116: accept default`

### D-117 One prompt-byte train

- **Question.** Which release carries the changes that alter prompt bytes (so every user's provider cache goes cold once)?
- **Options.** A) One 2.18.0 train: #750 (C65, Z2, Z8, Z10), C66, C70, C74, #765's IDE sentence, the environment block (D-043), the tagged rules format (TR10, one form in IDE and CLI); mode text stays put until K18 slice 2; orchestrator and background stay modes of `agent` and `loop` (TR13). B) #750 in 2.16.0 if green, the rest in 2.18.0 (two cold caches).
- **Default.** A, listed together in the release notes. About USD 0.014 per user per provider, once.
- **Sources.** Master §8 #1; privacy §10 Q5; workspace §7 Q6; ROADMAP Open decisions; `tr-owner-decisions.md` rows 6 to 8; caching §9 Q6 and #750 (B).
- **Unblocks** C65, C66, C70, Z2, C74, TR10 (6 gated, 14 downstream) · **Cost** one cold cache · **Urgency** 2.16.0 (decide before #792 is finalised)
- **Reply** `D-117: accept default`

### D-118 Paste, drop and images in the chat input

- **Defaults (D1 to D9).** Paste mode `plain` (`input.pasteMode: plain` or `markdown`), no `ask`. Paste as Markdown on Ctrl+Alt+V and Cmd+Alt+V plus a menu item and a palette command; Ctrl+Shift+V repaired as plain text. Images: 10 per message, 5 MB each, long edge 1568 px (2,576 px for Claude 4.7 and later), never upscaled, PNG for screenshots after the legibility check. A dropped folder is a search scope with a chip. A no-vision model: say so at paste with a Switch model action; "Attach image" visible but disabled with the reason. A dropped credential file: confirm with the file named; whether `.env` and private keys are refused rather than confirmed is yours (UX recommends refuse). SVG refused as an image, accepted as text. Hidden characters removed with a notice (joiners and variation selectors kept). JetBrains: plain text and images first. Drag and drop and Paste as Markdown in 2.18.0.
- **Sources.** `input-drag-drop-paste-context.md` §12; UX §12 Q2 to Q6, Q9; ROADMAP UX32.
- **Unblocks** UX32 (1 gated, 2 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-118: accept default`

### D-119 Copy as Markdown

- **Defaults (Q1 to Q11).** The plain Copy button copies Markdown; the menu offers plain text. No reasoning in any copy by default (a checkbox in the conversation export only). `Ctrl+Alt+C` / `Cmd+Alt+C` on a focused message, AltGr layouts tested, palette command always. The action row is a roving-tabindex toolbar. No `text/html` in v1. Links copied as written. `\n` everywhere; CRLF only by setting. No clipboard clearing; document the clipboard-history caveat. No "Share as gist". Export header: title and date only. Real answers from your sessions committed only after redaction by hand (D-054).
- **Source.** `copy-as-markdown.md` §10.
- **Unblocks** UX38 to UX44 (7 gated, 8 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-119: accept default`

### D-120 UX scope and release labels

- **Defaults.** First run: no wizard; one link from each notice to the next. Per-change accept and reject (the Claude Code peer feature) is not planned in Track UX. The UX note's section 10 "2.16.0 candidates" (which its Q11 already moved to 2.17.0) read as 2.18.0 candidates, since 2.17.0 is not a release; UX45, UX46, UX47, UX48 and UX50 stay 2.18.0 candidates, as the note says. Its seven-item scope stands for 2.18.0.
- **Source.** UX §12 Q7, Q9 to Q11.
- **Unblocks** UX labels · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-120: accept default`

### D-121 Recovery and upgrade experience

- **Defaults.** "Plan edits: Automatic" until a reviewer exists: reword and cap it like Permissive (hiding it changes stored settings). `continuous reset --all` never touches `~/.continue` and says so. Upgrade notice: one line per behaviour change that matches your settings, at most three, then a link. `--safe` on the command line with the help text "start without project config, hooks and MCP servers"; "safe mode" in the docs.
- **Source.** `user-journeys-and-recovery.md` §17 Q4, Q8 to Q10.
- **Unblocks** journey rows (proposed); #783 leaves these to you · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-121: accept default`

### D-122 Surface parity

- **Defaults.** Core enforces decisions (PAR8) in 2.20.0, after PAR5, although it changes the webview protocol. Tool names do not converge (`Read` and `read_file` both stay); the catalogue is shared (PAR22).
- **Source.** `surface-parity.md` §8 Q5, Q9.
- **Unblocks** PAR8, PAR22 (proposed) · **Cost** none · **Urgency** later
- **Reply** `D-122: accept default`

### D-123 Long-chat design target

- **Default.** Design for 300 messages feeling instant and 1,000 being usable; decide virtualisation (PERF16) from the numbers after PERF11 and PERF12 land; measure `retainContextWhenHidden` before changing it (PERF19).
- **Source.** Performance §11 Q6; PERF19.
- **Unblocks** PERF16, PERF19 (proposed) · **Cost** none · **Urgency** later
- **Reply** `D-123: accept default`

### D-124 Where plan files live

- **Question.** Plan files in the workspace or the home directory by default (F7, `task-planning.md` open question 3)? No note picks.
- **Dossier suggestion.** The workspace, `.continuous/plans/`, because the waves progress file (D-035) is defined beside the plan there and the project-folder lock already leaves `plans/` writable by the host.
- **Unblocks** F7 (2 downstream) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-124: workspace` or `D-124: home`

### D-125 Imports from other tools and upstream code

- **Defaults.** Cursor `hooks.json` is listed as not importable. `allow` permission rules are never imported in the first scope (G12 imports `deny` and `ask`; `allow` behind a second confirmation, later). Rule files from `.cursor/rules` and `.clinerules` are copied into `.continuous/rules/` after a dry run with a provenance comment, never read in place. Where an open upstream PR has a useful test, rewrite from the description and credit the PR number in the commit message.
- **Source.** Hooks §8 Q6 to Q8, Q11; ROADMAP Open decisions.
- **Unblocks** G12 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-125: accept default`

### D-126 Peer set and the 2.18.0 gap list

- **Defaults.** Change the peer set in our comparison documents: replace Roo Code, upstream Continue and "Windsurf" with ZooCode, Antigravity CLI, OpenCode and Devin Desktop; mark Aider as dormant. The eleven small 2.18.0 gap rows do not displace the critical path (none touches the sandbox gate).
- **Source.** Competitive §9 Q11, Q12.
- **Unblocks** comparison docs · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-126: accept default`

## Theme 8. Docs and identity

### D-127 Code of conduct contact

- **Default.** The private vulnerability form (once D-068 is done) until a mailbox exists; `hi@continue.dev` is upstream's. Source: `docs-audit.md` Q2.
- **Unblocks** `CODE_OF_CONDUCT.md` · **Cost** none · **Urgency** 2.16.0
- **Reply** `D-127: accept default` or `D-127: <address>`

### D-128 `CONTRIBUTING.md`

- **Default.** Rewrite it for this fork: nine links send contributors to `continuedev/continue`, four table-of-contents entries have no heading, and the docs preview section describes Mintlify. Point bug reports where D-069 says. Source: `docs-audit.md` §2.2.
- **Unblocks** docs rows · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-128: accept default`

### D-129 Telemetry settings

- **Default.** Deprecate with a message now, delete in 2.20.0; remove the `allowAnonymousTelemetry: true` default and the unused `disableTelemetryToggle`; tag settings that call the network `usesOnlineServices` (CO11). Both settings default to `true` and do nothing today.
- **Sources.** Product review §3.5 rank 10 and Q9; `docs-audit.md` §2.2.
- **Unblocks** CO11 and the trust claim in `PRIVACY.md` · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-129: accept default`

### D-130 Environment-variable and name deprecation policy

- **Default.** `CONTINUOUS_*` canonical; `CONTINUE_*` read with a once-per-process warning for two even minors (2.18.0, 2.20.0) and removed in 2.22.0; the same policy for `.continue/`, `yolo` and `--auto`; opt-in metrics renamed `continuous_cli_*`; `cn` stays (decided).
- **Sources.** Product review §3.5 rank 6 and Q6; CI note §11 Q8; ROADMAP CO21, PV10.
- **Unblocks** PV10, CO21, CO15 (about 40 variables and every page that names them) · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-130: accept default`

### D-131 Product name

- **Default.** Keep "Continuous" with the disclaimer until a Marketplace listing has real users, then revisit; decide before any wider announcement. Source: CI note §11 Q11.
- **Unblocks** none · **Cost** none · **Urgency** later
- **Reply** `D-131: accept default`

### D-132 The Instinct prompt's "developed by Continue.dev"

- **Default.** Keep it verbatim with a comment; it is the fine-tuned model's trained identity (PV11). Sources: CI note §11 Q9; `docs-audit.md` §2.2.
- **Unblocks** PV11 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-132: accept default`

### D-133 "Terminal agent" or "CLI"

- **Default.** "Terminal agent" in prose and titles, `continuous` for the command, "CLI" only in file and flag names. Source: `docs-audit.md` Q4 (25 uses of one, 54 of the other today).
- **Unblocks** docs · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-133: accept default`

### D-134 Upstream leftovers

- **Defaults.** Delete `actions/` ("Powered by Continue", Continue Hub checks). Remove the "Enter Enterprise License Key" command and the `remoteConfigServerUrl`, `userToken` and `remoteConfigSyncPeriod` settings. Delete all 239 upstream redirects (none was ever this fork's). Keep the legacy pages under one "Legacy configuration" entry until `config.json` loading is deprecated. Rename the `running-continue-without-internet` slug with a redirect after #754. Also from #784's list: the SambaNova link's `utm_source=continue`, `--org <slug>` help and hub mentions in comments (CO17).
- **Sources.** `docs-audit.md` §2.2 and Q7, Q8, Q9, Q11; #784.
- **Unblocks** CO17 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-134: accept default`

### D-135 `PRIVACY.md` on the docs site

- **Default.** Yes, as the first page of the Privacy group, with the root file kept as the source. Source: `docs-audit.md` Q10.
- **Unblocks** docs · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-135: accept default`

### D-136 ROADMAP restructure

- **Default.** After 2.16.0 is cut, the integrator splits the ROADMAP into Now, Next, Later and Decisions with theme files and adds `scripts/ci/roadmap-lint.mjs` (no row without a state, even-minor targets only, unique ids) in one docs PR (CO20); the plan files' states are corrected in the same truth pass.
- **Sources.** Product review Q11; permissions §9 Q8; index §7 Q10.
- **Unblocks** CO20 · **Cost** none · **Urgency** 2.18.0
- **Reply** `D-136: accept default`
