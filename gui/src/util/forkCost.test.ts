import type { ChatHistoryItem, ModelDescription } from "core";
import { describe, expect, it } from "vitest";
import type { CacheLedgerEntry } from "./cacheLedger";
import {
  forkCost,
  formatForkCost,
  forkPromptCacheRecord,
  ledgerUpTo,
  sentHistoryItems,
  type ForkCostArgs,
} from "./forkCost";
import type { PromptCacheSessionState } from "./promptCache";

// Claude Opus 5.5: $4 input, $5 write (5 min), $8 write (1 h), $0.20 read
const opus: ModelDescription = {
  title: "Claude Opus 5.5",
  provider: "anthropic",
  model: "claude-opus-5-5",
  underlyingProviderName: "anthropic",
};

const T0 = 1_763_000_000_000;
const SEC = 1000;

const item = (role: "user" | "assistant", content: string): ChatHistoryItem =>
  ({ message: { role, content }, contextItems: [] }) as ChatHistoryItem;

/** Three turns: u1 a1 u2 a2 u3 a3. */
const history: ChatHistoryItem[] = [
  item("user", "u1"),
  item("assistant", "a1"),
  item("user", "u2"),
  item("assistant", "a2"),
  item("user", "u3"),
  item("assistant", "a3"),
];

function entry(
  at: number,
  historyItems: number,
  read: number,
  write5m: number,
  output: number,
  extra: Partial<CacheLedgerEntry> = {},
): CacheLedgerEntry {
  return {
    at,
    mode: "agent",
    provider: "anthropic",
    model: "claude-opus-5-5",
    cachingOn: true,
    ttl: "5m",
    oneHour: true,
    uncached: 0,
    read,
    write5m,
    write1h: 0,
    output,
    historyItems,
    ...extra,
  };
}

/**
 * The three requests that wrote that history, a minute apart: 52k, 122k and
 * 210k tokens with their replies.
 */
const ledger: CacheLedgerEntry[] = [
  entry(T0, 1, 0, 50_000, 2_000),
  entry(T0 + 60 * SEC, 3, 50_000, 70_000, 2_000),
  entry(T0 + 120 * SEC, 5, 120_000, 80_000, 10_000),
];

const state: PromptCacheSessionState = {
  escalated: false,
  lastRequestAt: T0 + 120 * SEC,
  lastInputTokens: 200_000,
  lastTtl: "5m",
  ledger,
};

function args(over: Partial<ForkCostArgs> = {}): ForkCostArgs {
  return {
    model: opus,
    setting: "5m",
    state,
    history,
    forkIndex: 5,
    mode: "agent",
    now: T0 + 180 * SEC,
    ...over,
  };
}

const line = (over: Partial<ForkCostArgs> = {}) => {
  const a = args(over);
  return formatForkCost(forkCost(a)!, a.now);
};

describe("forkCost on a ledger fixture (Claude Opus 5.5)", () => {
  it("at the latest message: the whole prefix is warm, only the last reply is written", () => {
    const cost = forkCost(args())!;
    expect(cost.tokens).toBe(210_000);
    expect(cost.tokensEstimated).toBe(false);
    expect(cost.warmTokens).toBe(200_000);
    // 210k written at $5 = $1.05; 200k read at $0.20 + 10k written at $5
    expect(cost.coldUsd).toBeCloseTo(1.05, 6);
    expect(cost.warmUsd).toBeCloseTo(0.09, 6);
    expect(cost.partlyWarmEstimate).toBe(false);
    expect(line()).toBe(
      "Fork re-reads 210k tokens ≈ $1.05; within the cache window (4 min left) ≈ $0.09",
    );
  });

  it("at an earlier message: the entry the next request read is warm, and the price is labelled an estimate", () => {
    const cost = forkCost(args({ forkIndex: 3 }))!;
    expect(cost.tokens).toBe(122_000);
    expect(cost.warmTokens).toBe(120_000);
    expect(cost.coldUsd).toBeCloseTo(0.61, 6);
    // 120k read ($0.024) + 2k written ($0.01)
    expect(cost.warmUsd).toBeCloseTo(0.034, 6);
    expect(cost.partlyWarmEstimate).toBe(true);
    expect(line({ forkIndex: 3 })).toBe(
      "Fork re-reads 122k tokens ≈ $0.61; within the cache window (4 min left) ≈ $0.03 (estimate: how long an earlier point stays cached is not measured yet)",
    );
  });

  it("at the first turn: its entry was last read a minute after it was written", () => {
    const cost = forkCost(args({ forkIndex: 1 }))!;
    expect(cost.tokens).toBe(52_000);
    expect(cost.warmTokens).toBe(50_000);
    expect(cost.warmUntil).toBe(T0 + 60 * SEC + 5 * 60 * SEC);
    expect(cost.warmUsd).toBeCloseTo(0.02, 6);
  });

  it("an earlier point expires before the latest one does", () => {
    const now = T0 + 400 * SEC;
    expect(line({ forkIndex: 1, now })).toBe(
      "Fork re-reads 52k tokens ≈ $0.26; nothing is cached for this point now",
    );
    expect(line({ forkIndex: 5, now })).toBe(
      "Fork re-reads 210k tokens ≈ $1.05; within the cache window (20 s left) ≈ $0.09",
    );
  });

  it("after the lifetime nothing is warm at any point", () => {
    const cost = forkCost(args({ now: T0 + 30 * 60 * SEC }))!;
    expect(cost.warmTokens).toBe(0);
    expect(cost.warmUsd).toBeUndefined();
  });

  it("writes at the 1-hour price when the fork would ask for an hour", () => {
    const cost = forkCost(
      args({ setting: "auto", state: { ...state, escalated: true } }),
    )!;
    // 210k at $8
    expect(cost.coldUsd).toBeCloseTo(1.68, 6);
    // 200k read + 10k at $8
    expect(cost.warmUsd).toBeCloseTo(0.12, 6);
  });

  it("with caching off, everything is at the input price", () => {
    const cost = forkCost(args({ setting: "off" }))!;
    expect(cost.cachingOff).toBe(true);
    expect(cost.coldUsd).toBeCloseTo(0.84, 6);
    expect(line({ setting: "off" })).toBe(
      "Fork re-reads 210k tokens ≈ $0.84 at full price (prompt caching is off)",
    );
  });

  it("ignores requests made in another mode: they had another system prompt and tools", () => {
    const cost = forkCost(args({ mode: "chat" }))!;
    expect(cost.tokensEstimated).toBe(true);
  });

  it("ignores pruned requests and requests to another model", () => {
    const other = ledger.map((e) => ({ ...e, model: "claude-sonnet-4-6" }));
    expect(
      forkCost(args({ state: { ...state, ledger: other } }))!.tokensEstimated,
    ).toBe(true);
    const pruned = ledger.map((e) => ({ ...e, pruned: true }));
    expect(
      forkCost(args({ state: { ...state, ledger: pruned } }))!.tokensEstimated,
    ).toBe(true);
  });
});

describe("forkCost without a ledger (a session reopened from disk)", () => {
  const saved: PromptCacheSessionState = {
    escalated: false,
    lastRequestAt: T0 + 120 * SEC,
    lastInputTokens: 200_000,
    lastTtl: "5m",
  };

  it("uses the saved record for the latest point and says the size is a count", () => {
    const cost = forkCost(args({ state: saved }))!;
    expect(cost.tokensEstimated).toBe(true);
    expect(cost.tokens).toBe(200_000);
    expect(cost.warmTokens).toBe(200_000);
    expect(line({ state: saved })).toBe(
      "Fork re-reads about 200k tokens ≈ $1.00; within the cache window (4 min left) ≈ $0.04",
    );
  });

  it("says nothing is cached for an earlier point it knows nothing about", () => {
    const cost = forkCost(args({ state: saved, forkIndex: 1 }))!;
    expect(cost.warmTokens).toBe(0);
    expect(cost.tokens).toBeLessThan(200_000);
  });
});

describe("forkCost on a model server the user runs", () => {
  const local: ModelDescription = {
    title: "Llama",
    provider: "ollama",
    model: "llama3",
    underlyingProviderName: "ollama",
  };

  it("names the time it takes, not dollars", () => {
    const a = args({
      model: local,
      state: { escalated: false, promptTokensPerSecond: 1000 },
    });
    const text = formatForkCost(forkCost(a)!, a.now);
    expect(text).toContain("from scratch on the model server");
    expect(text).not.toContain("$");
  });
});

describe("sentHistoryItems", () => {
  it("leaves out the empty reply the request is about to fill", () => {
    expect(sentHistoryItems([item("user", "u1"), item("assistant", "")])).toBe(
      1,
    );
  });

  it("counts every item when the last one has content (a tool result)", () => {
    expect(sentHistoryItems(history)).toBe(6);
  });

  it("is unknown for a Loop run in a fresh context", () => {
    expect(
      sentHistoryItems(history, {
        current: { historyIndex: 2 },
      } as any),
    ).toBeUndefined();
  });
});

describe("the fork's cache record and ledger", () => {
  it("for an earlier point: when that entry was last read, and its size", () => {
    const cost = forkCost(args({ forkIndex: 3 }));
    expect(forkPromptCacheRecord(state, cost, false)).toEqual({
      lastRequestAt: T0 + 120 * SEC,
      lastTtl: "5m",
      lastInputTokens: 122_000,
    });
  });

  it("for the latest point: the parent's record is the right one", () => {
    expect(
      forkPromptCacheRecord(state, forkCost(args()), true),
    ).toBeUndefined();
  });

  it("keeps the requests that end at or before the fork point", () => {
    expect(ledgerUpTo(ledger, 3).map((e) => e.historyItems)).toEqual([1, 3]);
    expect(ledgerUpTo(ledger, 5)).toHaveLength(3);
  });
});
