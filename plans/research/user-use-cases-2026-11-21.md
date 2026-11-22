# Research: who uses the fork, and for what

Date: 2026-11-21. Code read at `origin/main` (`2f0924f78`, release 2.38.5). Nothing was built, run in an editor or reproduced. Issues and pull requests were read with `gh`; none was changed.

## What this note is

A read of the people outside the project who filed issues and opened pull requests on `b1tninja/continuous`, and of the open issues filed on `continuedev/continue` since 2026-08-01. It asks what those people were doing, where the product failed them, and which roadmap rows would help. It is the outside view that `usage-review-2026-11-21.md` could not give: that note had one person's data, the developer's.

Evidence marks:

- **V**: read in this fork's code at `origin/main`, or read through `gh`.
- **R**: inferred from a report, a screenshot or a log line; not confirmed.

People are named by issue or pull request number only.

## Inputs and limits

- **The fork's tracker.** 9 issues in all: 6 from outside people, 3 from the CI bot ("main is red"). 987 pull requests: 802 by the owner, 170 by Dependabot, 14 from a second account, 1 from an outside person (V).
- **The numbers are very small.** The 6 outside issues come from **two people**, three each. Every profile below rests on one or two people. They show what can go wrong, not how often.
- **No maintainer comment exists on any of the 6 issues** (V, timelines). What the reporters thought of the fixes is unknown.
- **Repository:** 6 stars (first 2026-11-08, last 2026-11-21), 2 forks, 1 watcher (V). Neither fork has a commit of its own on `main` (0 ahead; 19 and 2,094 behind). One fork holds the branch of PR 989. The other holds branches named like this repository's own work branches.
- **The 14 pull requests from the second account** (419 to 432, all opened within 5 minutes on 2026-11-10, all merged the same day) are hardening batches whose bodies cite internal review finding ids. They read as the project's own review pipeline, not as an outside user (R). They are left out of the profiles.
- **Upstream.** 126 open issues created since 2026-08-01 (V). Reactions are near zero (the highest is 6), so counts show clusters, not rank. Bodies were read for about 40; the rest were grouped by title.
- **"Still present" means the code path was read**, not that the bug was reproduced.
- `plans/upstream-signals.md` still says this fork has issues turned off. They are on (V, `has_issues: true`).

## 1. Who is using it

| #   | Profile                                               | Evidence in the fork                                                                                                                                                                                               | Upstream support                                |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| P1  | Local small models on a laptop                        | 988 (V): macOS, Ollama only, several chat entries from 4B to 9B, most with an 8,192 window and 2,048 output tokens, an empty base system message, thinking switched per entry through extra body properties        | 12 local-model issues, plus 13406, 13374, 13231 |
| P2  | Chat for study and maths, not code                    | 988 (V): a pasted precalculus paragraph and "I did not understand, can you help me?". PR 989 (V): the same person fixed the crash and turned inline `$…$` on                                                       | none in the window                              |
| P3  | Arrived from upstream Continue, both installed        | 981 (V): the log shows `continue.continue-2.0.0` and this extension loading together, and the reporter compares with Continue. 988: the config is upstream's local template, extended. PR 989 compares screenshots | 13446                                           |
| P4  | Uses Copilot Chat next to it and expects its controls | 945 (V): asks for the Thinking selector "as it is used in the Copilot Chat". 981 (V): the log shows Copilot Chat's storage on the same machine                                                                     | none                                            |
| P5  | Narrow sidebar, custom theme, judges by first look    | 982 (V): setup form clipped; the screenshot is 338 pixels wide. 981 (V): a marketplace theme with a JSON error stopped the sidebar; screenshot 319 pixels wide                                                     | 8 layout and theme issues                       |
| P6  | Windows agent user who wants fewer interruptions      | 944, 954, 945 (V): one person, Windows 11, VS Code 1.146, a workspace on drive D: with a space in the path; asked to switch off the confirmation on permission changes; got a false "outside the workspace" ask    | 13101, 13303, 13420, 13478                      |
| P7  | Contributor                                           | PR 989 (V): 172 lines added with tests, merged in 4.4 hours. 981: offered to clone and debug                                                                                                                       | not applicable                                  |

Notes:

- P1, P2, P3, P5 and P7 are **one person** (981, 982, 988, PR 989). P6 and half of P4 are the other.
- The person in 982 said the clipped form "felt a bit like vibe coded" and tied care for the interface to keeping users. That is the only direct statement of why someone might leave (V).
- In 981 and 982 the model field says "Not set": both were filed before a model was configured. The first two things this person saw were a sidebar that did not load and a form that did not fit (V).
- The empty base system message in 988 may be a way to save window space (R). Nobody said so.

## 2. The fork's outside reports

| Number | Use case                                   | Area                            | Time to fix                           | Fixed in                                                            |
| ------ | ------------------------------------------ | ------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| 944    | P6: stop the warning on permission changes | Permissions page                | 3 days 18 hours                       | #969 (V)                                                            |
| 945    | P4, P6: thinking-effort selector           | Chat input                      | 3 days 18 hours; **issue still open** | #970 (V)                                                            |
| 954    | P6: edit asked as "outside the workspace"  | Windows path comparison         | 2 days 9 hours                        | #973 (V)                                                            |
| 981    | P3, P5: custom theme stopped the sidebar   | VS Code start-up, theme parsing | open, about 1 day                     | not merged; uncommitted work in the tree (`parseThemeJson.ts`) (V)  |
| 982    | P5: setup form clipped when narrow         | Provider setup flow             | open, about 1 day                     | not merged; uncommitted work in the tree (`ModelChecklist.tsx`) (V) |
| 988    | P1, P2: a formula crashed the chat         | Markdown and KaTeX rendering    | 6.5 hours; **issue still open**       | #989, by the reporter (V)                                           |
| PR 989 | P2, P7                                     | Markdown and KaTeX rendering    | merged 4.4 hours after it was opened  | itself                                                              |

Findings:

- **Fixes land in days, but the loop to the reporter is not closed** (V). No issue has a reply. 945 and 988 are open after their fixes merged, because the pull requests mention the issue without closing it. A reporter cannot tell which version to install.
- **Three of six reports are start-up or first-screen failures** (981, 982, 988). Two of them happened before any model was set.
- **Three of six are about being interrupted or controls missing** (944, 945, 954), from the one person who uses the agent for work.

## 3. Upstream demand since 2026-08-01

126 open issues. 35 are noise: 13 empty, test or off-topic, and 22 that advertise a provider, an MCP service or a tool. The other 91:

| Group                                                     | Count | Examples                                                                           |
| --------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------- |
| Auto-filed "Error: model - status" with no useful detail  |    17 | 8 say "Unknown error" (13211, 13328, 13392, 13406, 13421, 13470, 13480, 13492)     |
| Local models: tool calling, edits, thinking, autocomplete |    12 | 13225, 13254, 13268, 13383, 13350, 13362, 13363, 13076, 13137, 13307, 13214, 13242 |
| Provider streams, parameters and cost                     |    11 | 13223, 13417, 13442, 13347, 13104, 13184, 13128, 13318, 13368, 13370, 13371        |
| JetBrains                                                 |    10 | 13185, 13119, 13152, 13134, 13248, 13282, 13468, 13489; two CI                     |
| Layout at narrow width and zoom, themes                   |     8 | 13075, 13125, 13217, 13219, 13267, 13483, 13424, 13175                             |
| Security reports                                          |     8 | 13178, 13288, 13289, 13290, 13310, 13429, 13453, 13461                             |
| WSL, Remote-SSH, Codespaces                               |     6 | 13158, 13335, 13339, 13135, 13249, 13120                                           |
| Windows encoding and paths                                |     4 | 13231, 13372, 13233, 13420                                                         |
| Config errors that lock the extension, first setup        |     3 | 13331, 13374, 13304                                                                |
| Permissions and MCP tool lists                            |     3 | 13101, 13303, 13478                                                                |
| Freezes and blank panels                                  |     3 | 13408, 13437, 13443                                                                |
| CLI input and tests                                       |     2 | 13265, 13273                                                                       |
| Docs                                                      |     2 | 13130, 13295                                                                       |
| Enterprise proxy                                          |     1 | 13366 (13211 and 13190 are also behind company gateways)                           |
| "No longer maintained, however"                           |     1 | 13446                                                                              |

Reading across the groups (R):

- **Local models are the largest real group**, and most of its reports name Ollama with a Qwen model on Windows or macOS. That matches P1.
- **The "Unknown error" genre is 8 issues with one line of content**, usually `fetch failed` or a gateway's JSON. People press the report button because the dialog gave them nothing to act on.
- **Layout is the group that matches the fork's own reports most closely**: 982 is the same kind of failure as 13219 and 13483, in a form upstream does not have.

## 4. Upstream issues checked against this fork

| Number              | Still present in the fork?        | Where                                                                                                                                                                                                              |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 13254               | **Yes** (V)                       | `core/llm/llms/Ollama.ts:543`: tools are attached only when the last message is from the user, so the request after a tool result carries none. Not in the roadmap                                                 |
| 13225               | **Yes** (V)                       | `extensions/cli/src/stream/streamChatResponse.helpers.ts:973`: a delta with an index, no id and no earlier mapping is dropped. Noted in `plans/tool-dialect-reference.md`; no row                                  |
| 13339               | **Yes** (V)                       | `packages/fetch/src/fetch.ts:102` and `:156` rewrite `localhost` to `127.0.0.1`. A server on IPv6 loopback only is not reached. U7 lists it as "not checked"                                                       |
| 13335               | **Yes** (V); tracked as SH2       | `core/tools/implementations/runTerminalCommand.ts:828`: "Output capture is not yet available for remote environments"                                                                                              |
| 13372               | **Yes** (V)                       | `packages/config-yaml/src/interfaces/slugs.ts:98`: only `.`, `/`, `file://` and `~` mean a file, so `C:\…` and `\\server\…` become slugs                                                                           |
| 13362, 13363        | **Yes** (V, by reading)           | `gui/src/pages/gui/ToolCallDiv/FunctionSpecificToolCallDiv.tsx:25` passes `args.contents` as it is; `CreateFile.tsx:15` puts it in a template string                                                               |
| 13429, 13453        | **Yes** (V); tracked as UJ7, PL16 | `extensions/cli/src/services/MCPService.ts:595`: `npx -y mcp-remote` with no version                                                                                                                               |
| 13318               | **Yes** (V)                       | `core/llm/llms/VertexAI.ts:180` builds `${region}-aiplatform.googleapis.com` for every region; no multi-region case                                                                                                |
| 13249               | Likely (R)                        | `extensions/vscode/src/util/FileSearch.ts:34` indexes every result of `walkDirs` with no cap of its own; `walkDirs` was not read                                                                                   |
| 13158               | Likely (R)                        | `extensions/vscode/package.json:10`: `extensionKind` is `ui` and `workspace`, as upstream; not tried in WSL                                                                                                        |
| 13303               | Partly (V)                        | `gui/src/pages/config/components/ToolPoliciesGroup.tsx:86` switches a whole group on or off; nothing sets a whole server to "ask" or "automatic"                                                                   |
| 13406, 13374        | Partly (V)                        | `core/llm/index.ts:710` gives the "Ollama may not be running" sentence only for `http://127.0.0.1:11434`. Another host or port gets the raw error. `StreamError.tsx:350` does handle lost connections as retryable |
| 13265               | Not settled                       | `extensions/cli/src/ui/TextBuffer.ts:466` handles Delete apart from Backspace, but `:504` treats both as backward deletion                                                                                         |
| 13424               | Not settled; UX17 says built      | `gui/src/components/StyledMarkdownPreview/index.tsx:124` sets only the font of inline code; the colours were not traced                                                                                            |
| 13223               | Fixed in core (V)                 | `core/llm/openaiTypeConverters.ts:493` keeps `index`; the GUI merge was not read                                                                                                                                   |
| 13233               | Fixed (V)                         | `core/indexing/LanceDbIndex.ts:367` and `:421` use filter helpers                                                                                                                                                  |
| 13184, 13104        | Fixed (V)                         | `core/llm/utils/calculateRequestCost.ts:825`; E2                                                                                                                                                                   |
| 13383               | Fixed; E2 (#268)                  |                                                                                                                                                                                                                    |
| 13366, 13347        | Fixed; E4 (#424)                  |                                                                                                                                                                                                                    |
| 13289, 13310        | Fixed; E1 (#265, #302, #304)      |                                                                                                                                                                                                                    |
| 13461               | Fixed; E10 (#739, merged 11-13)   | The E10 row still says "PR #739 open"                                                                                                                                                                              |
| 13185               | Partly; E8 (#734, merged 11-13)   | The E8 row still says "PR #734 open"; not tried in a 2026.2 IDE                                                                                                                                                    |
| 13307               | Partly; E3                        | Open in the IDE                                                                                                                                                                                                    |
| 13483, 13217, 13219 | Tracked as E9                     | Not re-checked at a zoom level                                                                                                                                                                                     |

Not checked: 13134 and 13489 (JetBrains), 13135 (rule globs with spaces), 13420 (the `Private` folder filter), 13331 (which file "open config" opens), 13214 (switching thinking off on llama.cpp), 13231 (Chinese text on Windows; ENV21 covers PowerShell output).

## 5. What each profile needs

### P1: local small models on a laptop

Works today (V): the onboarding card has a Local tab that lists installed Ollama models (`LocalModelChooser.tsx`). `/api/show` is read for `num_ctx` (`Ollama.ts:235`). A lost connection is retryable and the message is kept (`StreamError.tsx:350`). A prompt that cannot fit says "Not enough context" (`countTokens.ts:494`).

Most likely points of failure:

1. **The agent stops after one tool call** (V, `Ollama.ts:543`). This is upstream 13254. The person sees the model describe its next step and do nothing.
2. **An 8,192 window is mostly spent before the first message** (V for the numbers, R for the effect). Agent mode's built-in tools cost 2,701 tokens (`plans/tool-overhead.md`, Z0). With 2,048 reserved for output, about 3,400 remain for the system message, rules, files and history. The base system message file is 3.7 KB in total, so under about 950 tokens; the environment text and rules were not measured. Nothing tells the person that Chat mode costs no tool tokens. Ollama cuts a prompt longer than `num_ctx` without an error (RQ23 asks this; not answered).
3. **With no context length set, the request asks Ollama for 32,768** (V: `core/llm/constants.ts:2`, sent as `num_ctx` at `Ollama.ts:336` unless the Modelfile has one). On a laptop that can mean a slow load or a model that no longer fits in memory (R).

Also: the Ollama error sentence matches one literal address (`core/llm/index.ts:710`), so a server on another machine (13374) gets `fetch failed`.

Would make it clearly better: tools on every turn of a loop; a line with real numbers when a mode's fixed cost takes most of the window; the context value in use shown next to the model; one sentence for "cannot reach the local server" that names host and port.

### P2: chat for study and maths

Works today (V): inline `$…$` and display `$$…$$` render after #989 (`StyledMarkdownPreview/index.tsx:252`). Each message has its own error boundary (`Chat.tsx:624`).

Most likely points of failure:

1. **Inline dollars are now always on, with no setting** (V). Text such as two prices in one line can turn into a formula. PR 989 asked whether to gate it; nobody answered.
2. **A message that fails to render offers only "Restart", which starts a new session** (V, `Chat.tsx:626`). The person loses sight of the answer they were reading. The source text is still in the session.
3. **Copying a formula** (R): `plans/research/copy-as-markdown.md` says the source should keep `$…$`; no "copy as LaTeX" exists in `gui/src` (V, by grep).

Not checked: how a half-received formula looks while the answer streams.

Would make it clearly better: a setting for inline maths with a fixture file of prose that must not become maths; a failed message shown as its source text with "Copy"; copy of a formula gives its LaTeX.

### P3: upstream Continue installed at the same time

Works today (V): a different extension id and command prefix (`continuous.*`), its own folder `~/.continuous`, copied once from `~/.continue` (`core/util/paths.ts:154`; the README says so).

Most likely points of failure:

1. **Both extensions register the grammar scope `source.prompt`** (V, `extensions/vscode/package.json:143`; the 981 log shows VS Code overwriting one with the other).
2. **Both bind the same keys** (V, `package.json:642` and `:693`: `ctrl+l`, `ctrl+i`, as upstream; `ctrl+i` is also Copilot's inline chat). Which one answers is up to VS Code (R).
3. **The config is copied once and then drifts** (V for the copy). A model added in Continue later does not appear here, and nothing says the copy happened or when (R).

Also (V, 981 log): both extensions print the same theme and YAML-schema errors, so a person cannot tell whose fault a line is.

Would make it clearly better: an own grammar scope; one line on first start when the upstream extension is present, saying what was copied, that the two do not share config, and which keys overlap.

### P4: used to Copilot Chat

Works today (V): the Thinking menu beside the model (#970). Planned: UX63 and UX64 (approval scopes and "Manage approvals" as Copilot has them), G8 (import Copilot's own models).

Likely points of failure (R): the menu shows only for models whose reasoning support is known, so a local model with a `think` switch (988 uses two config entries per model for this) may get no menu. Not checked.

### P5: narrow sidebar, custom theme

Works today (V): the chat was fixed for narrow panels in #298 (E9). High contrast and forced colours are handled (UX17).

Most likely points of failure:

1. **Surfaces other than the chat at 320 to 340 pixels** (V, 982). E9's open part is a narrow test of the chat only. The setup flow and onboarding card are what a new person sees first.
2. **One bad optional input at start-up stops the sidebar** (V, 981: a theme file). The same activation reads a YAML schema setting and a proposed API, and both also log errors in 981.
3. **Zoom** (R, upstream 13483): not re-checked here.

Would make it clearly better: the narrow screenshot pass extended to setup, onboarding and settings; a start-up test in which each optional input throws and the sidebar still renders.

### P6: Windows agent user who wants fewer interruptions

Works today (V): #969, #973 and #970 answered all three reports.

Most likely points of failure:

1. **Asks that are always answered yes** (R; `usage-review-2026-11-21.md` 2.5 found 39 of 39 allowed). UX63 (allow for this session) is the planned answer.
2. **Windows paths in other places** (V): `slugs.ts:98` still reads a drive path as a package slug.
3. **Many MCP tools, one by one** (V, 13303): no "set all" per server.

### P7: contributor

PR 989 was merged in 4.4 hours with no review comment (V). The question in its body about the default went unanswered. A reply, even one line, is what tells a first contributor the door is open (R).

## 6. Proposed rows

Placeholder ids. "Tracked as" items from section 4 are not repeated here: SH2 (remote terminal output), UJ7 and PL16 (`mcp-remote`), E9 (chat at narrow width), UX63 (session-scoped allow), UJ30 (setup dead ends), UJ33 (crash page), K37 (Ollama capabilities).

| ID   | Scope                                                                                                                                                                                                                                        | Size | Needs            | Acceptance                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| US1  | Ollama: send the tool list on every request of a tool loop, not only when the last message is the user's (`Ollama.ts:543`; upstream 13254). First find why the gate was added                                                                | S    | none             | A unit test: the request built after a tool result carries `tools`. One live two-step task on a local model makes both calls                          |
| US2  | Terminal agent: a tool-call delta with an index and no id starts a call under a made-up id instead of being dropped (`streamChatResponse.helpers.ts:973`; upstream 13225)                                                                    | S    | none             | A test with an id-less first delta yields one tool call with parsed arguments, and no argument text in the reply                                      |
| US3  | Small-window notice: when the tools and system message of the current mode take more than half of `contextLength - maxTokens`, show one line with the numbers and offer Chat mode or the short prompt profile                                | M    | J0, K1           | With an 8,192 window in Agent mode the line shows the three numbers; a unit test of the arithmetic; no line at 32,768                                 |
| US4  | Ollama context default: when the person set no context length and the Modelfile has none, do not send `num_ctx: 32768`; use what `/api/show` reports or leave it to the server, and show the value in use beside the model                   | S    | K37              | A test: no explicit length and no Modelfile value gives a request without the 32,768 default; the model row shows the number                          |
| US5  | Local server errors by kind, not by one address: any refused or failed connection to a loopback or private-range `apiBase` says which host and port, and what to check (is it running, is the port right, is it listening on that interface) | S    | UJ11             | Tests for Ollama on a LAN address, llama.cpp on 8080 and LM Studio on 1234: each gives the sentence; "fetch failed" alone is never the whole message  |
| US6  | Stop rewriting `localhost` to `127.0.0.1` in `packages/fetch` (`fetch.ts:102`, `:156`), or try both address families; keep the packaged-binary case if it still needs it (upstream 13339)                                                    | S    | none             | A test server bound to `::1` only is reached through `http://localhost:port`                                                                          |
| US7  | Inline maths setting (on, off, default on) and a fixture of prose that must stay prose: two prices in a line, shell variables, a lone `$`; answer the open question in PR 989                                                                | S    | none             | The fixture passes with the setting on; with it off no `$…$` becomes maths and `\(…\)` still does                                                     |
| US8  | A message that fails to render shows its source text with Copy and "Try rendering again"; it does not offer a new session (`Chat.tsx:626`). Overlaps UJ33, which is the whole-panel page                                                     | S    | UJ11             | A test: a renderer that throws for one message leaves the other messages and the input usable, and the failed one shows its text                      |
| US9  | Copy LaTeX: selecting or right-clicking a rendered formula copies its source, and "Copy as Markdown" keeps `$…$` (research: `copy-as-markdown.md` row 8)                                                                                     | S    | GAP8's copy path | A test: copying a message with one inline and one display formula gives the original source                                                           |
| US10 | Own grammar scope for `.prompt` files (`package.json:143` shares `source.prompt` with upstream)                                                                                                                                              | S    | none             | With both extensions installed the developer console has no "Overwriting grammar scope" line; a manifest test fails on `source.prompt`                |
| US11 | Side-by-side notice: when `Continue.continue` is installed, one dismissible line on first start says the config was copied from `~/.continue` and is now separate, and names the shared key bindings with a link to change them              | S    | UJ28             | A test with a stubbed extension list shows the line once; the docs install page has the same three facts                                              |
| US12 | Start-up cannot be stopped by an optional input: theme parsing, the YAML schema clean-up and the agent-sessions API each fail to a default with one log line that names this extension (981)                                                 | S    | none             | A test in which each of the three throws and `getSidebarContent` still returns the page; the 981 theme file is a fixture                              |
| US13 | Narrow pass beyond the chat: screenshot states at 300, 320 and 340 pixels and at two zoom levels for the setup flow, the onboarding card and Settings; extends E9's open part (982, upstream 13483)                                          | S    | E9, I30          | The named states are in the screenshot harness and no control is clipped or needs sideways scrolling                                                  |
| US14 | Close the loop with reporters: a fix pull request closes its issue ("Fixes #n"), and the release that carries it posts the version on the issue; close 945 and 988; correct `upstream-signals.md` (issues are on)                            | S    | UJ6, DR14        | A check in the PR template or CI warns when a branch name carries an issue number and the body has no closing keyword; no open issue has a merged fix |
| US15 | Windows drive and UNC paths are files, not package slugs (`slugs.ts:98`; upstream 13372)                                                                                                                                                     | S    | none             | Tests for `C:\a\b.yaml`, `C:/a/b.yaml` and `\\server\share\b.yaml` return `uriType: "file"`                                                           |
| US16 | `create_new_file` with `contents` sent as a JSON value: show and write pretty-printed JSON, not `[object Object]` or one line (`FunctionSpecificToolCallDiv.tsx:25`; upstream 13362, 13363)                                                  | S    | none             | A test with an object `contents` renders the JSON text; the written file is indented                                                                  |
| US17 | Set a whole MCP server's tools to Ask or Automatic in one step (upstream 13303; the group switch today is only on or off)                                                                                                                    | S    | Track TR         | A test: one action changes every tool of the server; a tool set by hand afterwards keeps its own value                                                |

Order by who it helps (R): US1 and US12 remove failures that stop a new person in the first minutes. US14 costs almost nothing and is the only row about people who already wrote in. US3 to US5 are for P1, the largest group upstream. US7 to US9 serve one known person.

Rows that need the owner: US7 (the default was changed by an outside pull request and never decided), US14 (how to answer reporters).

Stale roadmap text found on the way (V): E10 and E8 say their pull requests are open; #739 and #734 merged on 2026-11-13.

## 7. Not verified

- Nothing was run in VS Code, in a JetBrains IDE or against a local model. Every "still present" is from reading.
- Why upstream attached Ollama tools only after a user message. US1 must find out before removing the gate.
- Whether the second account is the owner's. It is treated as internal.
- The size of the full agent system message with environment text and rules.
- Whether `walkDirs` has a cap (13249), and whether both extension hosts load in WSL (13158).
- Streaming of a half-received formula, zoom levels, high-contrast inline code, and the Thinking menu on local models with a `think` switch.
- What the uncommitted changes in the working tree do for 981 and 982. Only the file names were read.
