# Tainted-session rule: design and replay (ROADMAP X4, X17)

Status: built behind `taintedSessionRule: off | ask`, default `off`. No behaviour changes until the owner has read the replay numbers in section 7 and turned it on. Research: `plans/research/agent-security.md` (sections 2, 8 and 10).

## 1. What it does

Once untrusted content has entered a session, a call that can send data out or change state beyond the workspace asks, at every level, until the person acknowledges the content or starts a new session. It only raises an allow to an ask. A refusal, a floor rule, a protected path and a call that already asks are left exactly as they were, and no level, allow rule or reviewer verdict turns the ask back into an allow. This is the structural half of Meta's Rule of Two: the session may hold untrusted input and the ability to act, but not both without a person in the loop. CaMeL-style data-flow tracking is not attempted; the report judges it infeasible for an open-ended coding agent.

## 2. Taint sources (content enters the conversation)

Judged from the call that fetched the content, never from the content.

| Kind                  | Set by                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `web-fetch`           | `fetch_url_content`, `search_web`; a terminal command whose program is curl, wget, httpie or Invoke-WebRequest               |
| `mcp-result`          | any MCP tool result (whoever runs the server)                                                                                |
| `outside-read`        | `read_file`, `read_file_range`, `code_navigation`, `ls`, `view_subdirectory` on a path outside every workspace folder        |
| `issue-text`          | `gh issue/pr/release/gist/run view\|list\|diff\|checks\|status`, `gh api` (the text of issues and pull requests)             |
| `untrusted-workspace` | reserved for a host that knows the folder was just cloned or is not trusted; the flag and the API exist, no host sets it yet |

A source is recorded when the result is returned, success or not is not distinguished for MCP and fetch (an error message can carry the attacker's text). The path check does not follow links; the policy-time check does. It errs toward "outside", which costs a few asks and never a miss.

## 3. Sinks (what asks while tainted)

Read with the engine's own readers: `commandCandidateSet` (wrappers, nested scripts), `destinationsOf`, `secretWordLabel`, the tool's resolved path. No new parser.

| Class             | Calls                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network-egress`  | a destination that is not in the person's own `trustedDomains` or cannot be read; curl, wget, nc, ssh, scp, rsync and the like with no resolved destination; `gh api`; `fetch_url_content` to an untrusted host |
| `vcs-publish`     | `git push`; `gh` verbs that change something on the host (`pr create`, `issue comment`, `release create`, and so on)                                                                                            |
| `package-publish` | `npm`, `pnpm`, `yarn`, `bun`, `cargo`, `poetry`, `flit` publish; `twine upload`; `docker`, `podman`, `helm` push; `gem push`; `nuget push`                                                                      |
| `credential-read` | a command that prints the environment or a variable that looks like a credential (`env`, `printenv TOKEN`, `$AWS_SECRET_ACCESS_KEY`, jq `env`)                                                                  |
| `outside-write`   | a file-tool write whose resolved target is outside the workspace                                                                                                                                                |
| `mcp-send`        | an MCP tool not marked `readOnlyHint` by its server                                                                                                                                                             |

Not sinks, on purpose, so the rule stays a small increase: `npm test`, builds, `git status|diff|commit`, `ls`, reads, `npm install` (the dependency-change rule already asks), `git fetch|pull` (the host is the configured remote), and `search_web` (the query goes to the provider the person chose; recorded as residual risk). A terminal command that writes outside the workspace by redirect is covered by the existing runtime-write and protected-path rules, not here. An unknown interpreter running a script (`python x.py`) is not a sink; that is the sandbox's job (W4b to W8c).

The corpus labels cover the first five classes (45 calls). It has no MCP calls, so `mcp-send` is covered by unit tests only.

## 4. Tracking per session

A monotone set of source kinds, each with the turn it first entered, in a registry keyed by session id (`core/tools/permissions/taint/taintState.ts`). No text, no URL, no hash: a few bytes per session. The evaluator receives a `TaintFact { kinds, firstTurn }` as an input; with no fact it behaves exactly as before. Every host function returns nothing when the setting is `off`, so off means no mark, no fact, no audit field.

- Where it is set: the tool result path. In core, `callTool` calls `noteCoreToolResult` after a tool returns (one line); in the CLI, `executeStreamedToolCalls` calls `noteCliToolResult` after `executeToolCall` (one line).
- Where it is read: `evaluateToolPolicyWithRules` wraps its result with `applyTaintedSessionRule`; the IDE's `tools/evaluatePolicy` handler, the Auto reviewer handler and the CLI core-rules layer each add `...taintInput(session, callId)` to the evaluator input. The IDE binds the call id to its session at evaluation time, so a result that carries only a call id finds it.
- The setting is `toolPermissions.auto.environment.taintedSessionRule`, read from the person's own `config.yaml` only (a workspace file that could set it to `off` would switch the rule off for the content it came with). Anything but the word `ask` is `off`.
- Audit: the `decision` record gains `tainted: <source kinds>`, present only when the rule is on and the session is tainted. The call that the rule asked on has `source: "tainted-session"`.

## 5. Interactions

**Auto reviewer.** The deterministic rule runs first, inside the evaluator, so it is already settled before the reviewer is asked. A sink in a tainted session is returned as an ask by rules (`tainted-session` joins the sources the reviewer cannot move); the reviewer is not called for it. A call that is not a sink still goes to the reviewer, and its prompt gains one structured line in the ENVIRONMENT block: `Session taint: untrusted content entered this session (web-fetch, mcp-result) from turn 3; ...`. The reviewer's cache key includes the kinds so a verdict reached in a clean session is not reused in a tainted one. The system prompt is not edited (it is versioned and measured by the reviewer eval); a sentence telling the reviewer what to do with the line is a follow-up that needs an eval run.

**Subagents.** The CLI and the IDE (`getState().session.id`) run subagents under the parent's session id, so taint reaches the child and returns with no copying. For a host that gives a child its own id, `fork(parent, child)` copies the kinds as inherited and `join(child, parent)` hands back only what the child itself met, so an acknowledgement the person made in the parent meanwhile is not undone.

**Clearing.** Only a person's act or a new session: `/untaint` in the CLI (built); an "I reviewed it" control on the approval card and a clear on new session in the IDE (the registry call `untaintSession(session, reason)` exists; the card is a follow-up). Approving one ask does not clear: the next sink asks again. The next untrusted source taints again after a clear. No timer and no model verdict clears it.

**Levels.** It applies at every level including YOLO, as specified. Section 7 shows YOLO is where it costs the most, because YOLO allowed every sink before.

## 6. Friction measures

1. Sinks are narrow (section 3); local work never asks.
2. `trustedDomains` hosts are not egress, for commands and fetches.
3. A read-only MCP tool is not a sink.
4. One acknowledgement ends it for the session; the interrupted-traces column below is how often that single acknowledgement would be needed.
5. The reason names the source kinds and the sink class, so the person sees why.
6. Not built, to decide after the numbers: a per-session list of hosts the person already approved before the taint, exempt from egress; an "approve and acknowledge" button; exempting YOLO.

## 7. Replay (measure only)

`taint/taintReplay.ts` replays synthetic traces: 400 traces of 100 calls, sampled with a fixed seed from the 287 labelled calls (135 allow, 50 ask, 102 deny), taint injected at 0, 25, 50 and 75 percent of the trace. No audit directory is read and no model is called. Two mixes: the corpus as labelled (adversarial, far more asks and refusals than a real session), and a benign-weighted mix (90 allow, 8 ask, 2 deny). Run it with `npx vitest run tools/permissions/taint/taintReplay.measure.vitest.ts --silent=false` in `core/`.

Four baselines: `labels` (what the whole system should come to, reviewer included, from the corpus label), and the real evaluator at Cautious, Permissive and YOLO in every area.

Over the 287 rows once each (sinks, of which already ask, new asks):

| Baseline   | network-egress | outside-write | credential-read | vcs-publish | new asks |
| ---------- | -------------- | ------------- | --------------- | ----------- | -------- |
| labels     | 5 / 5 / 0      | 2 / 2 / 0     | 1 / 1 / 0       | 5 / 2 / 3   | 3        |
| Cautious   | 25 / 25 / 0    | 2 / 2 / 0     | 3 / 3 / 0       | 15 / 15 / 0 | 0        |
| Permissive | 25 / 24 / 1    | 2 / 2 / 0     | 3 / 3 / 0       | 15 / 9 / 6  | 7        |
| YOLO       | 26 / 3 / 23    | 2 / 0 / 2     | 3 / 1 / 2       | 15 / 0 / 15 | 42       |

(`package-publish` and `mcp-send` have no corpus rows.) The three new asks under `labels` are the three `git push` calls the corpus labels allow.

New asks per 100 calls of a trace (all calls, taint entering at 0 / 25 / 50 / 75 percent), and the share of traces with at least one new ask, which is how often the single acknowledgement would be needed:

| Baseline   | Mix                | New asks per 100 calls      | Per 100 tainted calls | Traces interrupted    |
| ---------- | ------------------ | --------------------------- | --------------------- | --------------------- |
| labels     | corpus as labelled | 1.02 / 0.81 / 0.52 / 0.29   | 1.02 to 1.16          | 67 / 57 / 42 / 26%    |
| labels     | benign-weighted    | 1.98 / 1.51 / 1.01 / 0.53   | 1.98 to 2.11          | 88 / 81 / 65 / 42%    |
| Cautious   | both               | 0.00                        | 0.00                  | 0%                    |
| Permissive | corpus as labelled | 2.44 / 1.86 / 1.20 / 0.63   | 2.40 to 2.51          | 95 / 88 / 72 / 47%    |
| Permissive | benign-weighted    | 2.35 / 1.79 / 1.17 / 0.61   | 2.33 to 2.45          | 92 / 86 / 70 / 47%    |
| YOLO       | corpus as labelled | 14.76 / 10.98 / 7.36 / 3.73 | 14.65 to 14.93        | 100 / 100 / 100 / 98% |
| YOLO       | benign-weighted    | 3.87 / 2.92 / 1.94 / 1.02   | 3.87 to 4.09          | 98 / 95 / 88 / 67%    |

Reading: about 1 to 2 new asks per 100 tainted calls where a person is already deciding (labels, Permissive); none at Cautious, because the engine already asks on every sink there. At YOLO it is 4 per 100 on a benign mix and 15 per 100 on the adversarial corpus, because the rule is the only thing asking. The new asks are the ones the rule exists for: pushes, outbound requests, publishes. The rule never loosened a call and never changed a refusal in any cell (asserted by the test).

Limits of the numbers: the corpus is a safety corpus, not a record of real work, and the traces are i.i.d. draws, not sessions; real sessions cluster their pushes. The benign mix is an assumption, not a measurement. The real figure needs the audit trail replay (X17's original wording) on the owner's own directory, which this change does not read. `mcp-send`, `package-publish` and `outside-write` through the IDE's resolved paths are under-represented.

## 8. Not built, and why

- A UI control for "I reviewed it" on the approval card, and clear on new session in the IDE (needs a protocol message and a GUI change; the core call exists).
- `untrusted-workspace` marking (a host must know the folder is untrusted; there is no such signal in the CLI today).
- A sentence in the reviewer's system prompt (needs an eval run; B53 is unrun).
- Marking from `search_web` results in the CLI (the CLI has no such tool name).
- Hosts approved before the taint, an acknowledge button, a YOLO exemption: decisions for the owner after reading section 7.

## 9. Files

New: `core/tools/permissions/taint/` (`taintState`, `taintSources`, `taintSinks`, `taintRule`, `taintSetting`, `taintWiring`, `taintReplay`, tests), `core/tools/taintResult.ts`, `extensions/cli/src/permissions/cliTaint.ts`. Touched, a few lines each: `evaluate.ts` (one wrapper call, one field), `decide.ts` (a source name), `auto/handler.ts`, `auto/prompt.ts`, `audit/record.ts`, `audit/hook.ts`, `testToolCall.ts` (a `taint` input for the replay), `callTool.ts`, `core.ts`, the config-yaml schema, and in the CLI `coreRules.ts`, `cliAudit.ts`, `streamChatResponse.helpers.ts`, `slashCommands.ts`, `commands.ts`; in the GUI two source checks in `evaluateToolPolicies.ts`.
