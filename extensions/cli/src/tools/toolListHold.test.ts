import type { ChatHistoryItem } from "core/index.js";
import type { ChatCompletionTool } from "openai/resources.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyCliToolChangesNow,
  cliPendingToolChangesLine,
  cliToolListForRequest,
  cliWithheldRefusal,
  isSignificantReread,
  noteToolHoldRequest,
  resetCliToolListHold,
  rereadLoss,
  TOOL_HOLD_DEFAULT_LIFETIME_MS,
  withoutReasoningBefore,
} from "./toolListHold.js";

const tool = (name: string, description = name): ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object" } },
});
const names = (tools: ChatCompletionTool[]) =>
  tools.map((t) => t.function.name);

const MODEL = "claude-sonnet-4-6";
const T0 = 1_000_000;
const KEY = JSON.stringify(["normal", "anthropic", MODEL, false, false]);

/** A first request at T0 with tools a and b, which read or wrote `tokens`. */
function firstRequest(tokens = 366_000, model = MODEL) {
  const first = cliToolListForRequest({
    live: [tool("a"), tool("b")],
    key: KEY,
    model,
    historyLength: 2,
    now: T0,
  });
  noteToolHoldRequest({
    provider: "anthropic",
    model,
    usage: {
      promptTokens: 1000,
      completionTokens: 10,
      promptTokensDetails: { cachedTokens: tokens - 1000, cacheWriteTokens: 0 },
    },
    at: T0,
  });
  return first;
}

const next = (
  live: ChatCompletionTool[],
  at: number,
  model = MODEL,
  historyLength = 4,
) => cliToolListForRequest({ live, key: KEY, model, historyLength, now: at });

describe("the CLI's tool list while the prompt cache is warm (C80, C88)", () => {
  const saved = process.env.CONTINUE_TOOL_CHANGES;
  beforeEach(() => resetCliToolListHold());
  afterEach(() => {
    if (saved === undefined) delete process.env.CONTINUE_TOOL_CHANGES;
    else process.env.CONTINUE_TOOL_CHANGES = saved;
  });

  it("keeps the list while warm, says so once, and refuses the withheld tool", () => {
    firstRequest();
    const held = next([tool("a"), tool("c")], T0 + 30_000);
    expect(names(held.tools)).toEqual(["a", "b"]);
    expect(held.notice).toMatch(
      /^2 tool changes waiting for the cache to cool \(\+c, -b\)\. Prompt cache is warm: changing the tool list re-reads about 366k tokens at full price \(about \$\d+\.\d\d more\) on the next request\. .*\/tools apply applies it now\.$/,
    );
    // Said once per set of changes
    expect(next([tool("a"), tool("c")], T0 + 40_000).notice).toBeUndefined();

    expect(cliWithheldRefusal("b", true)).toMatch(
      /^b is turned off for this session; the change applies when the prompt cache goes cold\./,
    );
    expect(cliWithheldRefusal("b", false)).toMatch(/no longer available/);
    expect(cliWithheldRefusal("a", true)).toBeUndefined();
    expect(cliPendingToolChangesLine()).toBe(
      "2 tool changes waiting for the cache to cool: +c, -b. Run /tools apply to apply now.",
    );
  });

  it("applies the change on the first request after the cache is cold", () => {
    firstRequest();
    next([tool("a")], T0 + 30_000);
    const cold = next([tool("a")], T0 + TOOL_HOLD_DEFAULT_LIFETIME_MS + 1);
    expect(names(cold.tools)).toEqual(["a"]);
    expect(cliWithheldRefusal("b", true)).toBeUndefined();
  });

  it("applies at the next request after /tools apply", () => {
    firstRequest();
    expect(applyCliToolChangesNow()).toBe("No tool changes are waiting.");
    next([tool("a")], T0 + 30_000);
    expect(applyCliToolChangesNow()).toMatch(
      /^1 tool change will apply at the next request and re-reads 366k tokens/,
    );
    expect(names(next([tool("a")], T0 + 31_000).tools)).toEqual(["a"]);
  });

  it("applies after /compact, /clear or a new session (reset)", () => {
    firstRequest();
    next([tool("a")], T0 + 30_000);
    resetCliToolListHold();
    expect(names(next([tool("a")], T0 + 31_000).tools)).toEqual(["a"]);
  });

  it("applies at once for a small conversation or with CONTINUE_TOOL_CHANGES=now", () => {
    firstRequest(5_000);
    expect(names(next([tool("a")], T0 + 30_000).tools)).toEqual(["a"]);
    resetCliToolListHold();
    process.env.CONTINUE_TOOL_CHANGES = "now";
    firstRequest();
    expect(names(next([tool("a")], T0 + 30_000).tools)).toEqual(["a"]);
  });

  it("does not offer a late MCP server's tools until the change applies", () => {
    firstRequest();
    const held = next([tool("a"), tool("b"), tool("late_x")], T0 + 30_000);
    expect(names(held.tools)).toEqual(["a", "b"]);
    expect(held.notice).toContain("+late_x");
  });

  it("prices a re-read as the GUI does", () => {
    expect(isSignificantReread(rereadLoss(MODEL, 366_000))).toBe(true);
    expect(isSignificantReread(rereadLoss(MODEL, 5_000))).toBe(false);
    expect(isSignificantReread({ tokens: 150_000 })).toBe(true);
  });
});

describe("preserved thinking after a tool change in the CLI (PR #893)", () => {
  beforeEach(() => resetCliToolListHold());

  const item = (role: "user" | "assistant", withDetails: boolean) =>
    ({
      message: { role, content: role },
      contextItems: [],
      ...(withDetails && {
        reasoning: {
          active: false,
          text: "earlier",
          startAt: 0,
          details: [{ type: "thinking", signature: "s" }],
        },
      }),
    }) as ChatHistoryItem;

  it("cuts the earlier reasoning when a change applies on Opus 5.5, and keeps the cut", () => {
    firstRequest(366_000, "claude-opus-5-5");
    next([tool("a")], T0 + 30_000, "claude-opus-5-5", 4);
    const applied = next(
      [tool("a")],
      T0 + TOOL_HOLD_DEFAULT_LIFETIME_MS + 1,
      "claude-opus-5-5",
      6,
    );
    expect(applied.thinkingCut).toBe(6);
    const history = [
      item("user", false),
      item("assistant", true),
      item("user", false),
      item("assistant", true),
      item("user", false),
      item("assistant", true),
      item("user", false),
      item("assistant", true),
    ];
    const sent = withoutReasoningBefore(history, applied.thinkingCut);
    expect(sent.slice(0, 6).some((h) => h.reasoning?.details)).toBe(false);
    expect(sent[7].reasoning?.details).toHaveLength(1);
    // The history itself keeps it, for display
    expect(history[1].reasoning?.details).toHaveLength(1);
    expect(
      next(
        [tool("a")],
        T0 + TOOL_HOLD_DEFAULT_LIFETIME_MS + 2,
        "claude-opus-5-5",
        8,
      ).thinkingCut,
    ).toBe(6);
  });

  it("says that applying drops earlier reasoning on Fable 5.2", () => {
    firstRequest(366_000, "claude-fable-5-2");
    const held = next([tool("a")], T0 + 30_000, "claude-fable-5-2");
    expect(held.notice).toContain(
      "on this model it rebuilds the cache and drops earlier reasoning",
    );
    expect(applyCliToolChangesNow()).toContain("drops earlier reasoning");
  });

  it("keeps the reasoning on a model without the prefix check", () => {
    firstRequest();
    expect(
      next([tool("a")], T0 + TOOL_HOLD_DEFAULT_LIFETIME_MS + 1).thinkingCut,
    ).toBeUndefined();
  });
});
