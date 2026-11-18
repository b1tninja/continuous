# What the context holds: the context meter and its breakdown

Design note, 2026-11-13. It records how other tools show context use, how ours counts it today, and the design of the context meter in the row under the prompt: a short bar and a percent beside the session cost that opens a breakdown of the context, with Compact now and New session. It stacks on the status row note (`status-row-layout.md`, #817) and answers that note's owner question 1: the `ContextStatus` battery and the usage readout are merged. It is a first IDE slice of rows J0 and J1 of `area-caching-cost-visibility.md`. Section 8 designs a selective compaction dialog; section 8.1 records what was built of it (#833's follow-up).

Code: `core/llm/contextBreakdown.ts` (the computation), `gui/src/components/mainInput/ContextMeter.tsx` (the meter and the details), `gui/src/util/contextLevel.ts` (the colour steps), `gui/src/hooks/useLastRequestContext.ts` (the number shared with the cost readout). Tests: `core/llm/contextBreakdown.vitest.ts`, `gui/src/components/mainInput/ContextMeter.test.tsx`, `gui/src/util/contextLevel.test.ts`, and the width ladder tests of #817.

## 1. How other tools show it

**Claude Code.** `/context` "Visualize[s] current context usage as a colored grid", with "optimization suggestions for context-heavy tools, memory bloat, and capacity warnings" ([commands](https://code.claude.com/docs/en/commands)). The rows are per category: system prompt, system tools, MCP tools, memory files, custom agents, skills, messages, free space and an autocompact buffer; third-party write-ups quote lines such as "Free space: 145.4k (72.7%)" and "Autocompact buffer: 33k tokens (16.5%)", and an issue (closed in February 2026) objected that the buffer was counted as used ([claudeissues #14785](https://claudeissues.com/issue/14785-bug-context-command-shows-misleading-usage-percentage-by-including-autocompact-b), [blog.vincentqiao.com](https://blog.vincentqiao.com/en/posts/claude-code-context/)). The exact labels move between versions, so treat the list as indicative. The status line receives `context_window.used_percentage`, computed "from input tokens only: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`", and `current_usage` is "`null` before the first API call in a session, and again immediately after `/compact` until the next API call repopulates it" ([status line](https://code.claude.com/docs/en/statusline)). `/compact [instructions]` takes an optional focus ("`/compact focus on the API changes`"); compaction is automatic as the window fills ([how Claude Code works](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up)), at the model's limit by default, about 967K tokens on 1M-window models, adjustable with `/autocompact` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` ([model config](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds)). [Explore the context window](https://code.claude.com/docs/en/context-window) lists what survives compaction per mechanism.

**Cursor.** A context ring beside the prompt; a staff answer says "the ring stays visible all the time, and the percentage number shows only on hover". Clicking the ring opens a tray with a horizontal stacked bar and a per-row list: system prompt, tools (definitions only), rules, skills, MCP (server instructions and tool lists), subagents, summarized conversation, conversation. Users ask for drill-down per MCP server, rule and skill; staff say it is in progress ([forum: context usage breakdown](https://forum.cursor.com/t/context-usage-breakdown/159913), [forum: always-visible percentage](https://forum.cursor.com/t/please-bring-back-the-always-visible-context-usage-percentage/165379)). Third-party sources only; no official Cursor page found.

**GitHub Copilot in VS Code.** "The context window control in the chat input shows how much context the active chat uses. Hover over it for token counts, a category breakdown, and the session's total AI credits." `/compact`, "optionally adding what to retain", compacts by hand; automatic compaction can be turned off with `github.copilot.chat.summarizeAgentConversationHistory.enabled` ([manage sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions), [context concepts](https://code.visualstudio.com/docs/agents/concepts/context)).

What the three share and this design takes: a small always-visible meter next to the prompt, a stacked bar with a legend by category, free space shown as space, and compaction one action away. What it does not take: a breakdown that only opens on hover (Copilot), and a percent visible only on hover (Cursor).

## 2. How we count today

- **The meter before this change** was `ContextStatus.tsx` (removed here): a 7 px battery from `session.contextPercentage`, shown from 60 percent, when pruning, or from a size threshold (`contextMeterTokens`, `gui/src/util/cacheNotices.ts:61`), with Compact and New session in a hover tooltip.
- **Core's estimate.** Before every request the chat calls `llm/compileChat` (`gui/src/redux/thunks/streamNormalInput.ts:186`), which runs `compileChatMessages` (`core/llm/countTokens.ts:427`). It counts with tiktoken: `countChatMessageTokens` (`:181`, 4 tokens per message, tool call JSON, thinking signature, 10 extra per tool result), `countToolsTokens` (`:137`), and a flat 1,024 per image (`countImageTokens`, `:89`). It keeps back a safety buffer of 2 percent of the window, at most 1,000 (`getTokenCountingBufferSafety`, `:372`), and `min(1000, maxTokens)` for the reply (`MIN_RESPONSE_TOKENS`, `:379`), drops the oldest messages in steps of 10 percent of the budget when over (`PRUNE_STEP_FRACTION`, `:382`; `didPrune`, `:578`), and returns `contextPercentage = inputTokens / availableTokens` (`:626`), a share of the input budget, not of the window. The thunk stores it with `setIsPruned` and `setContextPercentage` (`streamNormalInput.ts:222-223`).
- **The provider's count.** The last chunk carries `usage`; `totalInputTokens` (`core/llm/utils/cacheStats.ts:30`) adds cache reads and writes where the provider reports them apart. The thunk stores it as `promptCache.lastInputTokens` (`streamNormalInput.ts:357`) and adds the request to `session.usage` (`:370`, `addRequestUsage`, `core/llm/utils/sessionUsage.ts:31`), whose `lastRequest` (`:84`) holds input and output tokens. `contextUsage` (`:145`) is `(input + output) / contextLength`: what #817's readout showed.
- **Segments.** `describeChatRequest` (`gui/src/redux/util/describeChatRequest.ts:225`) describes the request `buildChatRequest` builds without changing it: tools (built-in and MCP), the system message split into the mode text, the tools-as-text block, each applied rule and the compaction summary, the per-use tail and the task list. Sizes are characters divided by four (`core/llm/promptSegments.ts`).
- **The history the request carries** is built by `constructMessages` (`gui/src/redux/util/constructMessages.ts`): the newest `conversationSummary` cuts everything before it, context items become text parts ahead of the user's text, and tool messages are rebuilt from each assistant item's `toolCallStates` (terminal output with its status).
- **Prompt cache state.** `session.promptCache` (`PromptCacheSessionState`, `gui/src/util/promptCache.ts:55`); `promptCacheStatus` and `promptCacheTooltip` turn it into "warm, expires at ..." text.
- **Compaction.** `useCompactConversation` (`gui/src/util/compactConversation.ts`) sends `conversation/compact` with an index and, while the cache is warm, the conversation prefix (`compactionPrefix`, `gui/src/util/compactionPrefix.ts:39`); core's `compactConversation` (`core/util/conversationCompaction.ts:48`, handler `core/core.ts:1710`) asks the model for a summary with a fixed prompt and stores it on that history item. There is no instructions field. The reply toolbar has its own Compact link past 80 percent (`ResponseActions.tsx:46`). **The IDE has no automatic compaction**: when the conversation passes the budget, the oldest messages are left out of the request (pruning). The CLI does compact automatically (`getAutoCompactThreshold`, `extensions/cli/src/compaction.ts:279`), and history ageing (masking old tool results, `core/util/contextAgeing.ts:133`) is off unless `CONTINUE_HISTORY_AGEING` is set (`core/llm/index.ts:1083`).

So: the provider's count is the truth for the total but has no split; our split is an estimate (four characters per token in the webview, tiktoken in core) of a request that grows after the count was taken.

## 3. Categories

Derived from what the request contains, in the request's order. `computeContextBreakdown` takes `describeChatRequest`'s segments for the tools and the system message and walks the history as `constructMessages` does.

| Category               | From                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| System prompt          | the mode or custom system text (`turn.*`, `system.unsplit`)              |
| Tool definitions       | built-in and MCP tools, or the tools-as-text block for text-tool models  |
| Rules and instructions | applied rules, the per-use tail, the task list                           |
| Conversation summary   | the compaction summary in the system message                             |
| Attached context       | context items on user messages (files, `@` items)                        |
| Your messages          | the user's own text                                                      |
| Replies                | assistant text                                                           |
| Tool calls             | the calls' JSON                                                          |
| Tool results           | tool outputs other than the terminal                                     |
| Terminal output        | `run_terminal_command` output with its status                            |
| Images                 | 1,024 each, as core counts                                               |
| Reasoning              | thinking messages, their signatures and redacted thinking                |
| Not itemised           | only when the provider's count is more than twice the estimate (below)   |
| Free space             | window less used less reserved                                           |
| Reserved for the reply | core's safety buffer plus `min(1000, maxTokens)`, exactly as it reserves |

**Scaling.** With a provider count (the last request's input plus its reply, the same number the meter shows) the total is that count, and each category is scaled by `count / estimate`, so the shares add up and the panel says "Estimated split". If the count is more than twice the estimate, the estimate does not describe that request (after a compaction, or tools tokenised very differently), scaling would inflate every row, so the categories stay as estimated and the difference is "Not itemised", with a sentence that it updates with the next request. Without a count the panel says the figures are estimated at four characters per token.

**Largest items.** The three biggest single items of at least 500 tokens, named by what they are: "Read src/config/parseConfig.ts", "run_terminal_command npm test", "README.md" (an attached file), "Your message".

## 4. The meter

```
narrow (row < 300 px)      medium                     wide (row >= 600 px)
[=-] 43%  $0.27            [==-] 43%  $0.27           [==-] Context 43%  $0.27
```

- The 3 px bar of #817, 12 px narrow and 24 px otherwise, now a control of its own beside the cost. A bar rather than a ring: the prompt cache control beside it is already a ring that drains, and two rings would read as one kind of thing.
- Colour by `contextLevel`: the description colour below 60 percent, the warning colour from 60 percent (where the battery used to appear) or from the size where each message costs real money (`contextMeterTokens`, so a 1M window still warns at 250k), the error colour from 80 percent (where the reply's Compact link appears) or once messages are being left out. Colour is never the only signal: the percent is always shown.
- Accessible name "Context 43% used", with ", oldest messages left out" while pruning. Headless UI adds `aria-expanded` and `aria-controls`.
- The number: the provider's count against the window of the model that answered (`useLastRequestContext`, shared with the cost readout); before any count, core's `contextPercentage`. Hidden until one exists (#817's question 2 stays open).
- The cost readout keeps its popover and now shows only the cost, or "4.1k tokens" when no price is known.

## 5. The details

Opened by a click, Enter or Space, or by resting the pointer on the meter for 300 ms. A hover-opened panel closes 250 ms after the pointer leaves both the meter and the panel; clicking the meter while it is hover-open pins it. Escape closes and returns focus to the meter; a click outside closes. It is a Headless UI popover anchored above the meter, so it is not clipped by the input box.

```
+------------------------------------------------+
| Context: 15k of 200k tokens (8%)               |
| Estimated split: the total is the provider's   |
| count for the last request, shared out by size.|
| [##=====---................................/|] |
|  # System prompt              839   <1%        |
|  = Attached context           3.4k    2%       |
|    Your messages               10   <1%        |
|    Replies                    107   <1%        |
|    Tool calls                  36   <1%        |
|  - Tool results               11k     5%       |
|    Terminal output             32   <1%        |
|  . Free space                 183k   91%       |
|  / Reserved for the reply     2.0k    1%       |
| Past 198k tokens (the line on the bar) the     |
| oldest messages are left out of each request.  |
| Largest items                                  |
|   Read src/config/parseConfig.ts         11k   |
|   README.md                             3.4k   |
| Prompt cache: warm, Auto (5 minutes). Expires  |
| at 4:04 PM (in about 4 min) unless you send... |
| [Compact now] [New session]                    |
| Settings: Rules  Tools  Models                 |
+------------------------------------------------+
```

- The bar is `aria-hidden`; its text equivalent is the legend, a real `<table>` with caption "What the context holds", a row header per part and the tokens and share in cells, so a screen reader reads "Tool results, 11k, 5%".
- The marker on the bar is where the chat starts leaving out the oldest messages (window less the reserve). The IDE has no automatic compaction, so this is the threshold to mark; a future automatic compaction would move the marker to its own threshold (owner decision 3).
- The notes of the old battery move here unchanged: what one more message costs with the cache warm and cold, the quality note, the long-context price note, "Oldest messages are being left out of each request", and the compaction cache warning (`useCompactionCacheNote`).
- **Compact now** calls the existing `useCompactConversation` with the last index, as the battery did: no new compaction semantics, no instructions field (core's compaction has none; owner decision 2). Disabled while a reply is streaming or the conversation is empty. **New session** dispatches `saveCurrentSession({ openNewSession: true })`, as before. **Settings** links go to the Rules, Tools and Models tabs, the three things that set the fixed part of the context.
- Computed only while open: `describeChatRequest` builds the request description once per open (and when the history or usage changes while open).

## 6. Accessibility

- Both controls are real buttons in the Tab order (`HoverButton`), at least 24 by 24 px. Nothing needs hover: hover only opens what a click or Enter opens.
- The name "Context 43% used" contains the visible "43%" (narrow and medium) and starts with the visible "Context 43%" (wide); axe's `label-content-name-mismatch` checks containment.
- The axe baseline gains the `context-open` view with the same findings as `usage-open` (Headless UI focus sentinels and the existing code-block and terminal contrast findings); nothing in the panel itself is flagged.

## 7. What did not change

What the model is sent: the breakdown reads `buildChatRequest`'s output through `describeChatRequest` and the history; it writes nothing. Compaction, pruning, the cache settings and the reply toolbar's Compact link are unchanged. The JetBrains webview gets the same component; the chart colours are VS Code's `--vscode-charts-*` with fallbacks.

## 8. Selective compaction ("Choose what to keep")

The owner asked for a dialog beside Compact now, like the old Disk Cleanup wizard: the context by category and by largest item, with checkboxes, a live total, then apply. Automatic compaction (where there is one) stays the default and needs no dialog.

```
+-- Choose what to keep ------------------------------------------+
| Context now: 86k of 200k (43%)        After: 41k (21%)          |
| [######====----.....]  ->  [###==.........................]     |
|                                                                 |
| [x] Keep  System prompt, tools, rules               9.1k  fixed |
| [ ] Keep  Tool results (14)                          38k        |
|        [ ] Read src/config/parseConfig.ts            12k        |
|        [ ] Read src/app.ts                            9k        |
|        [x] grep_search "parseConfig"                 1.1k       |
|        ... 11 more                                              |
| [ ] Keep  Terminal output (3)                         6k        |
| [x] Keep  Attached context (2)                       4.2k       |
| [x] Keep  Images (1)                                 1.0k       |
| [ ] Keep  Reasoning (older turns)                     3k        |
| [x] Keep  Your messages and replies                  24k        |
|                                                                 |
| ! This edits the conversation from turn 3 on: the next request  |
|   re-reads 77k tokens (about $0.29) instead of reading the      |
|   cache (about $0.02). Removed items can be put back.           |
|                                       [Cancel] [Remove 45k]     |
+-----------------------------------------------------------------+
```

- **What removing means for the request.** Nothing is deleted from the session. A removed tool result is sent as a one-line stub, "[output removed by you: 12k tokens, Read src/config/parseConfig.ts]", in the same tool message with the same `toolCallId`, so every call keeps its result and the request stays valid for every provider. That is history ageing's masking (`maskOldToolResults`, `core/util/contextAgeing.ts:133`, stub prefix `AGEING_STUB_PREFIX`) applied to a chosen set instead of an age rule, and its `unmaskToolResults` (`:201`) is the undo. Terminal output is the same. An attached context item becomes "[file README.md removed by you]". An image becomes "[image removed by you]" (the part goes, the text stays). Older reasoning is dropped only where the provider accepts a request without it, to be checked per provider before building; the latest assistant turn's reasoning is always kept, since a tool loop in progress may need it. Your messages and replies are not offered item by item: removing a turn changes what later turns refer to; that is what Compact (a summary) is for.
- **Reversible.** The session keeps the originals and a per-item `removedByUser` mark; the dialog lists removed items with "Put back". Putting back is another edit of the prefix, with the same cache warning.
- **Prompt cache.** Any edit before the end of the prompt invalidates the cache from the first edited message on. The dialog computes the first edited position and shows "this will re-read N tokens (about $X) on the next request" from the tokens after it, priced with `perMessageCost` warm against cold, and the local-server wording of `warmCacheLoss` (`gui/src/util/cacheSafeguards.ts:152`) for local models. Removing only items after the last cache point costs nothing extra; the dialog says so.
- **With compaction.** The dialog is offered as "Choose what to keep..." beside Compact now. A summary made after a selective removal summarises the stubs, not the removed text. Automatic compaction, where it exists (the CLI), runs on what is left; the removed items stay removed after it.
- **Why not built here.** It needs a new history edit (a removal mark that `constructMessages` honours), its persistence, the undo, the cost line and a dialog with nested checkboxes and keyboard support; it changes what the model is sent, which this slice must not. The breakdown and largest-items list built here are its input. Estimate: M.

### 8.1 As built

Code: `core/util/contextRemoval.ts` (the stubs, and `maskRemovedToolResults` over ageing's `maskOldToolResults`), `gui/src/util/selectiveCompaction.ts` (what can be removed, the selection, the marks, the totals and the cache cost), `gui/src/components/mainInput/SelectiveCompactDialog.tsx` (the dialog), the `applyContextRemovals` / `undoContextRemovals` reducers in `sessionSlice.ts`. Tests beside each.

- **Marks.** `ChatHistoryItem.removedByUser` holds what was removed from that item: `toolResults` (call ids, on the assistant item), `contextItems` and `images` (indexes, on the user item) and `turn`. It is saved with the session. `constructMessages` and `computeContextBreakdown` both read it, so the meter and the request agree; core's compaction leaves out removed turns when it has no prefix. Editing and resending a message clears that message's marks.
- **Stubs.** A tool result becomes "[output removed by you: 12k tokens, Read src/config/parseConfig.ts]" in its own tool message (`maskOldToolResults` with a `stub` option and a chosen set, `minChars` 0, nothing protected; ageing's metadata marks it, so ageing leaves it alone). For a model that takes tools as text the same line replaces the output before it is turned into text. An attached item becomes "[attached README.md removed by you]", an image "[image removed by you]".
- **Turns.** Turns start at each user message after the newest summary; only the oldest can go (unticking turn 3 removes 1 to 3, ticking turn 1 keeps all), the latest is never offered, and a turn's items are disabled while it is removed. A tool exchange never spans two turns, so pairing holds.
- **Not offered.** Reasoning (the per-provider check of section 8 is not done) and single messages or replies.
- **Totals.** Sizes are four characters per token, scaled by the same factor as the meter's split. "After" is the provider's count less the estimated change. The re-read is the estimate of the history from the first changed item on, after the change.
- **Cost.** `editCacheLoss` takes `warmCacheLoss` for the whole cached conversation and keeps the share after the first change (time for a local server), shown with `formatRereadCost`. The dialog warns up front while the cache is warm, and says "nothing extra" when it is not.
- **Undo.** The session keeps, in memory and not saved, each changed item's marks from before the first change since the last request (`contextRemovalUndo`). Undo in the context panel restores them all; the request thunk clears them when the next request is compiled, since from then the stubs are in the cache and putting back is another edit. Nothing is ever deleted, so the dialog still lists removed items ("removed now") and ticking one puts it back, with the cost line.
- **Keyboard.** Headless UI's `Dialog` traps focus and closes on Escape; focus returns to the meter. Each group has a checkbox with a mixed state, every item is a labelled checkbox, the totals are a polite live region. The app's shared `TextDialog` still has no focus trap; this dialog does not use it.

## 9. Owner decisions

1. **Two controls.** The meter and the cost are now separate buttons (each with its own details) instead of one readout. Keep, or fold the cost into the context details?
2. **Compact with instructions.** Claude Code and Copilot take a focus ("`/compact focus on ...`"). Ours sends a fixed prompt. Add an optional instructions field to `conversation/compact` (core and the dialog, an S), or keep the fixed prompt?
3. **Automatic compaction in the IDE.** The IDE prunes; the CLI compacts at a threshold. Bring the CLI's threshold to the IDE (the marker then shows it, as Claude Code's autocompact buffer does), or keep pruning?
4. **Selective compaction** (section 8): build it next (M), or wait for history ageing's replay results?
5. **Converge with J0.** This `ContextBreakdown` is IDE-shaped (categories, largest items). J0 asks for a versioned object shared with the CLI's `/context` and `cn serve`'s `/state.context`, with a cache section. Grow this into J0, or keep both?
6. **Hover delay.** 300 ms to open, 250 ms to close. Copilot opens on hover; Cursor opens on click. Keep both ways, or click only?
