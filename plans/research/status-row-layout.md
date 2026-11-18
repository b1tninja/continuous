# The row under the prompt: what stays visible at each width

Design note, 2026-11-13. It records why the usage readout and the reasoning and prompt cache controls left the "..." menu, the order in which the row gives up space, and the steps it uses. The code is `gui/src/components/mainInput/InputToolbar.tsx` and `InputToolbar/widthTier.ts`; the tests that hold it are `InputToolbar/InputToolbar.widthLadder.test.tsx`.

## 1. What was wrong

UX2 (#546, commit `caefa991c`) put four things behind one "..." button (`InputToolbar/OverflowMenu.tsx`): the reasoning switch, the prompt cache control, the model tips and the usage readout (context percent and estimated cost). The menu was not a narrow-width fallback: it was rendered at every width, so cost and context were never on screen unless someone opened a menu whose button said only "More options". Before UX2 the bulb and the cache icon were in the row (hidden below 250 px by an `xs:` class).

The only meter left in the row was `ContextStatus`, a 7 px battery that appears from 60 percent full or from a size threshold, and whose explanation was a hover tooltip.

## 2. Priority

From most to least important. A lower item gives up space before a higher one; items marked "never hidden" only shrink.

| #   | Item                                      | Never hidden | How it shrinks                                                                   |
| --- | ----------------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| 1   | Send                                      | yes          | "⏎ Enter" becomes "⏎" (the word stays for screen readers)                        |
| 2   | Context used (percent and bar)            | yes          | "Context 42%" becomes "42%"; the bar narrows from 24 to 12 px                    |
| 3   | Estimated cost                            | yes          | none: "$0.12" is already the short form                                          |
| 4   | Reasoning switch                          | yes          | "Reasoning off" becomes the bulb alone (outlined off, filled on)                 |
| 5   | Prompt cache control and state            | yes          | "Cache 4:12" becomes "4:12", then the ring or database icon alone                |
| 6   | Tips about the model (when there are any) | yes          | "2 tips" becomes "2"                                                             |
| 7   | Model name                                | yes          | truncates with an ellipsis; it is the item that absorbs the squeeze              |
| 8   | Route note ("via account")                | narrow only  | dropped from the visible text in the narrow step; it stays in the readout's name |
| 9   | Active-file hint (Ctrl+⏎ Active file)     | below wide   | dropped; the shortcut still works                                                |
| 10  | "Esc to exit Edit" hint                   | narrow only  | dropped; Esc still works                                                         |

Items 2 to 6 sit in one group that shrinks no further than its short forms. When that group and a model name cut to 48 px do not fit side by side, the row wraps and the group moves to a second line; in a panel too narrow even for that line, the group wraps its own items. Nothing is moved into a menu.

## 3. Width steps

The steps measure the row itself with a `ResizeObserver` (`useWidthTier`), not the window, so the same code works in the VS Code sidebar, an editor tab and the JetBrains tool window. Before the first measurement, or where the row has no layout, the window width stands in. The row is about 40 px narrower than the panel (the input's border and padding). The steps were set from measured widths in the screenshot harness: the short status group is about 200 px, the one with the cache time about 240 px, and the labelled one about 520 px, so labels come back only where they leave the model name room.

| Step     | Row width     | Panel width (about) | Shows                                                                                          |
| -------- | ------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `narrow` | below 300 px  | below 340 px        | icons and numbers: bar 12 px, "42% · $0.12", bulb, cache icon, tips count, "⏎"                 |
| `medium` | 300 to 599 px | 340 to 639 px       | adds the cache state word or time left ("4:12", "cold", "off"), the route note, the "Esc" hint |
| `wide`   | 600 px and up | 640 px and up       | adds labels: "Context 42%", "Reasoning off", "Cache 4:12", "2 tips", active-file, "⏎ Enter"    |

## 4. Mockups

ASCII only: `[=-]` is the context bar, `(R)` the reasoning bulb, `(o)` the prompt cache ring that drains toward expiry (the database icon when cold or off), `!` the tips icon, `[Send]` the send button showing "⏎". In the product they are Heroicons.

About 280 px panel (narrow). The model name truncates first; every status item keeps its number or icon:

```
+----------------------------------------------+
| Clau...  [=-] 43% . $0.27  (R) (o)  !1 [Send] |
+----------------------------------------------+
```

About 240 px panel: the status group wraps to its own line instead of hiding:

```
+-------------------------------------+
| Claude Sonnet                       |
| [=-] 43% . $0.27  (R) (o)  !1 [Send] |
+-------------------------------------+
```

About 360 px panel (medium):

```
+----------------------------------------------------------+
| Claude So...  [==-] 43% . $0.27  (R)  (o) 4:00  !1 [Send] |
+----------------------------------------------------------+
```

Wide (about 640 px panel and up):

```
+--------------------------------------------------------------------------------------------------------------+
| Claude Sonnet   [==-] Context 43%  $0.27  (R) Reasoning on  (o) Cache 4:00  ! 1 tip  Ctrl+Enter Active file  [Send: Enter] |
+--------------------------------------------------------------------------------------------------------------+
```

The prompt editor and the "+" button sit above the row and are not drawn. The pull request has screenshots of the same five widths from `bench/screenshots` (view `status-row`).

## 5. Accessibility

- Every control is a real `button` in the Tab order: model, usage, reasoning, cache, tips, active file (wide), send. Nothing is revealed on hover.
- Each name starts with the text the row shows (axe `label-content-name-mismatch`) and then carries the state, so no tooltip is needed to know it: "Context 43% used" for the context meter and "$0.27: estimated cost $0.27. Show usage details" for the cost beside it (two controls since the context breakdown, `context-usage-breakdown.md`), "Reasoning off" with `aria-pressed`, "Prompt cache 4:00 left" (or "cold", "off", "on, nothing cached yet"), "1 tip about this model (needs attention)".
- The usage breakdown (tokens in and out, cache reads and writes, per-model cost, the price list date, the route) used to be a hover tooltip. It is now a popover opened with Enter or a click and closed with Escape.
- The "..." button is gone, and with it the `aria-hidden-focus` finding the axe baseline recorded for its open view.

## 6. What did not change

What the model receives, permissions and approvals are untouched: the controls dispatch the same actions as before (`setHasReasoningEnabled`, `setReasoningSetting`, `setPromptCacheSetting`), and the cache state shown is `promptCacheStatus` read aloud, with no new state. No VS Code API is used; `ResizeObserver` is available in the JetBrains JCEF webview as in VS Code.

## 7. Open questions for the owner

1. **Two meters.** `ContextStatus` (the battery from 60 percent, with Compact and New session in its tooltip) and the usage readout both show context. Merge them, with Compact and New session in the usage popover, or keep the battery as a warning that appears late? **Answered: merge.** The battery is gone; the context meter beside the cost opens what the context holds, with Compact now and New session (`plans/research/context-usage-breakdown.md`).
2. **Before the first reply.** The usage readout is absent until a request reports usage, because there is no number to show. A placeholder ("–") would hold the space and make the readout findable in a new chat.
3. **Reasoning effort.** The row switches reasoning on and off. A per-mode effort (`modeModels.<use>.reasoningEffort`) is shown in the mode picker, not here; an effort picker in the row would need a session-level effort the store does not have today.
