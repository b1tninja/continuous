import { describe, expect, it } from "vitest";
import type { ChatHistoryItem } from "..";
import {
  COMPACTION_THRESHOLDS,
  type CompactionPlan,
  type CompactionPlanResult,
  isCompactionPlan,
  planCompaction,
  spanHash,
  tailBudget,
  turnBoundaries,
} from "./compactionPlan";

const LOCAL = COMPACTION_THRESHOLDS.local;
const CLOUD = COMPACTION_THRESHOLDS.cloud;

function user(text: string): ChatHistoryItem {
  return { message: { role: "user", content: text }, contextItems: [] };
}
function reply(text: string): ChatHistoryItem {
  return { message: { role: "assistant", content: text }, contextItems: [] };
}
function call(id: string): ChatHistoryItem {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    },
    contextItems: [],
  };
}
function toolResult(id: string): ChatHistoryItem {
  return {
    message: { role: "tool", content: `result ${id}`, toolCallId: id },
    contextItems: [],
  };
}

/** Turns of `[user, reply]` with the given sizes per item. */
function turns(sizes: number[][]): {
  history: ChatHistoryItem[];
  itemTokens: number[];
} {
  const history: ChatHistoryItem[] = [];
  const itemTokens: number[] = [];
  sizes.forEach(([u, a], t) => {
    history.push(user(`question ${t}`), reply(`answer ${t}`));
    itemTokens.push(u, a);
  });
  return { history, itemTokens };
}

function plan(
  history: ChatHistoryItem[],
  itemTokens: number[],
  overrides: Partial<Parameters<typeof planCompaction>[0]> = {},
): CompactionPlanResult {
  return planCompaction({
    history,
    itemTokens,
    headTokens: 1_000,
    window: 100_000,
    thresholds: LOCAL,
    modelKey: "llama.cpp/qwen",
    ...overrides,
  });
}

function expectPlan(result: CompactionPlanResult): CompactionPlan {
  if (!isCompactionPlan(result)) {
    throw new Error(`expected a plan, got ${JSON.stringify(result)}`);
  }
  return result;
}

/** Deterministic PRNG, so the growth tests are the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("planCompaction: thresholds and shape", () => {
  // window 100k, head 1k. Ten turns of 3.5k + 3.5k = 70k + 1k = 71% (local prepare 70%)
  const cases: {
    name: string;
    sizes: number[][];
    thresholds?: typeof LOCAL;
    window?: number;
    expected: Partial<CompactionPlanResult> & { spanEnd?: number };
  }[] = [
    {
      name: "below the prepare threshold: no plan",
      sizes: Array.from({ length: 10 }, () => [3_000, 3_000]),
      expected: { state: "idle", reason: "below-threshold" } as never,
    },
    {
      name: "local, at 71%: prepared, tail fits in 15% of the window",
      sizes: Array.from({ length: 10 }, () => [3_500, 3_500]),
      // tail budget 15k: two turns (14k) fit, three (21k) do not
      expected: { state: "prepare", spanEnd: 16 },
    },
    {
      name: "local, at 86%: forced",
      sizes: Array.from({ length: 10 }, () => [4_250, 4_250]),
      expected: { state: "force", spanEnd: 18 },
    },
    {
      name: "cloud, at 71%: below its 75% threshold",
      sizes: Array.from({ length: 10 }, () => [3_500, 3_500]),
      thresholds: CLOUD,
      expected: { state: "idle", reason: "below-threshold" } as never,
    },
    {
      name: "cloud, at 76%: prepared, tail fits in 10% of the window",
      sizes: Array.from({ length: 10 }, () => [3_750, 3_750]),
      thresholds: CLOUD,
      // budget 10k: one turn (7.5k) fits, two do not
      expected: { state: "prepare", spanEnd: 18 },
    },
    {
      name: "cloud, at 91%: forced",
      sizes: Array.from({ length: 10 }, () => [4_500, 4_500]),
      thresholds: CLOUD,
      expected: { state: "force" },
    },
    {
      name: "the last turn alone exceeds the tail: the tail is that turn",
      sizes: [
        ...Array.from({ length: 9 }, () => [2_000, 2_000]),
        [5_000, 30_000],
      ],
      expected: { state: "prepare", spanEnd: 18 },
    },
    {
      name: "one turn holds everything: nothing to summarise",
      sizes: [[40_000, 40_000]],
      expected: { state: "idle", reason: "nothing-to-summarise" } as never,
    },
    {
      name: "no window known: no plan",
      sizes: Array.from({ length: 10 }, () => [9_000, 9_000]),
      window: 0,
      expected: { state: "idle", reason: "no-window" } as never,
    },
  ];

  it.each(cases)("$name", ({ sizes, thresholds, window, expected }) => {
    const { history, itemTokens } = turns(sizes);
    const result = plan(history, itemTokens, {
      ...(thresholds && { thresholds }),
      ...(window !== undefined && { window }),
    });
    expect(result).toMatchObject(expected);
    if (isCompactionPlan(result)) {
      expect(history[result.spanEnd].message.role).toBe("user");
      expect(result.tokens.head + result.tokens.span + result.tokens.tail).toBe(
        result.tokens.total,
      );
    }
  });

  it.each([
    { window: 100_000, thresholds: LOCAL, budget: 15_000 },
    { window: 524_288, thresholds: LOCAL, budget: 64_000 },
    { window: 200_000, thresholds: CLOUD, budget: 20_000 },
    { window: 1_000_000, thresholds: CLOUD, budget: 64_000 },
  ])(
    "tail budget for window $window is $budget",
    ({ window, thresholds, budget }) => {
      expect(tailBudget({ window, thresholds })).toBe(budget);
    },
  );
});

describe("planCompaction: boundaries", () => {
  it("never splits a tool call from its result", () => {
    // A tool result recorded after a user message (a steer while the tool ran)
    // still answers the call before it: the tail cannot start at that user item.
    const history = [
      user("q0"),
      reply("a0"),
      user("q1"),
      call("t1"),
      user("steer"),
      toolResult("t1"),
      reply("a1"),
      user("q2"),
      reply("a2"),
    ];
    expect(turnBoundaries(history)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    const itemTokens = [
      30_000, 30_000, 500, 500, 500, 5_000, 500, 1_000, 6_000,
    ];
    const result = expectPlan(plan(history, itemTokens));
    // q1's turns (14k) fit in the 15k tail; "steer" is never a boundary
    expect(result.spanEnd).toBe(2);
  });

  it("keeps the tool calls and results inside whole turns", () => {
    const history: ChatHistoryItem[] = [];
    const itemTokens: number[] = [];
    for (let t = 0; t < 12; t++) {
      history.push(
        user(`q${t}`),
        call(`c${t}`),
        toolResult(`c${t}`),
        reply(`a${t}`),
      );
      itemTokens.push(500, 300, 4_000, 1_200);
    }
    const result = expectPlan(plan(history, itemTokens));
    expect(result.spanEnd % 4).toBe(0);
    const tailIds = new Set(
      history
        .slice(result.spanEnd)
        .flatMap((h) =>
          h.message.role === "assistant"
            ? (h.message.toolCalls ?? []).map((c) => c.id)
            : [],
        ),
    );
    for (const item of history.slice(result.spanEnd)) {
      if (item.message.role === "tool") {
        expect(tailIds.has(item.message.toolCallId)).toBe(true);
      }
    }
  });

  it("starts after the newest summary and does not count what it covers", () => {
    const { history, itemTokens } = turns(
      Array.from({ length: 14 }, () => [3_500, 3_500]),
    );
    history[15] = { ...history[15], conversationSummary: "earlier work" };
    // items 0-15 are not sent: 6 turns after it = 42k + 1k head = 43%
    expect(plan(history, itemTokens)).toMatchObject({
      state: "idle",
      reason: "below-threshold",
    });
    const result = expectPlan(plan(history, itemTokens, { window: 60_000 }));
    expect(result.spanStart).toBe(16);
    expect(result.spanEnd).toBe(26);
    expect(result.tokens.total).toBe(1_000 + 6 * 7_000);
  });

  it("counts a turn removed with Choose what to keep as nothing", () => {
    const { history, itemTokens } = turns(
      Array.from({ length: 10 }, () => [3_500, 3_500]),
    );
    history[0] = { ...history[0], removedByUser: { turn: true } };
    history[1] = { ...history[1], removedByUser: { turn: true } };
    expect(plan(history, itemTokens)).toMatchObject({
      state: "idle",
      reason: "below-threshold",
    });
  });

  it.each([
    { name: "a short first request is quoted", first: 1_500, quoted: 0 },
    { name: "a long first request is not", first: 2_500, quoted: undefined },
  ])("$name", ({ first, quoted }) => {
    const { history, itemTokens } = turns([
      [first, 2_000],
      ...Array.from({ length: 10 }, () => [3_500, 3_500]),
    ]);
    const result = expectPlan(plan(history, itemTokens));
    expect(result.quoteFirstUser).toBe(quoted);
  });
});

describe("planCompaction: a stable boundary", () => {
  function grow(seed: number, count: number) {
    const random = rng(seed);
    const history: ChatHistoryItem[] = [];
    const itemTokens: number[] = [];
    return {
      history,
      itemTokens,
      addTurn(t: number) {
        // Tails from 100 to 20k tokens, as in the note's drip-drop test
        const big = random() < 0.2;
        history.push(
          user(`q${t}`),
          call(`c${t}`),
          toolResult(`c${t}`),
          reply(`a${t}`),
        );
        itemTokens.push(
          100 + Math.floor(random() * 400),
          200,
          big
            ? 5_000 + Math.floor(random() * 15_000)
            : 100 + Math.floor(random() * 2_000),
          100 + Math.floor(random() * 1_500),
        );
      },
      count,
    };
  }

  it.each([
    { seed: 1, turns: 100, window: 131_072 },
    { seed: 7, turns: 100, window: 200_000 },
    { seed: 42, turns: 600, window: 524_288 },
  ])(
    "one plan for $turns growing turns (seed $seed) until it is applied",
    ({ seed, turns: count, window }) => {
      const g = grow(seed, count);
      let previous: CompactionPlan | undefined;
      const ids = new Set<string>();
      let applied = 0;
      for (let t = 0; t < g.count; t++) {
        g.addTurn(t);
        const result = plan(g.history, g.itemTokens, { window, previous });
        if (!isCompactionPlan(result)) {
          // Only before a plan exists, or after one is applied
          expect(previous).toBeUndefined();
          continue;
        }
        if (previous) {
          expect(result.id).toBe(previous.id);
          expect(result.spanEnd).toBe(previous.spanEnd);
          expect(result.hash).toBe(previous.hash);
        }
        ids.add(result.id);
        previous = result;
        if (result.state === "force") {
          // Apply: the summary goes on the span's last item
          g.history[result.spanEnd - 1] = {
            ...g.history[result.spanEnd - 1],
            conversationSummary: `summary ${applied++}`,
          };
          previous = undefined;
        }
      }
      expect(ids.size).toBe(applied + (previous ? 1 : 0));
      expect(applied).toBeGreaterThan(0);
    },
  );

  it("the boundary does not move while the tail grows past the tail budget", () => {
    const { history, itemTokens } = turns(
      Array.from({ length: 10 }, () => [3_500, 3_500]),
    );
    const first = expectPlan(plan(history, itemTokens));
    history.push(user("more"), reply("more"));
    itemTokens.push(2_000, 9_000);
    const second = expectPlan(plan(history, itemTokens, { previous: first }));
    expect(second.spanEnd).toBe(first.spanEnd);
    expect(second.id).toBe(first.id);
    expect(second.tokens.tail).toBeGreaterThan(
      tailBudget({ window: 100_000, thresholds: LOCAL }),
    );
    // Without the previous plan the boundary would have moved
    expect(expectPlan(plan(history, itemTokens)).spanEnd).toBeGreaterThan(
      first.spanEnd,
    );
  });

  it("the same history gives the same id and hash", () => {
    const a = turns(Array.from({ length: 10 }, () => [3_500, 3_500]));
    const b = turns(Array.from({ length: 10 }, () => [3_500, 3_500]));
    const pa = expectPlan(plan(a.history, a.itemTokens));
    const pb = expectPlan(plan(structuredClone(b.history), b.itemTokens));
    expect(pa.id).toBe(pb.id);
    expect(pa.hash).toBe(pb.hash);
    expect(pa.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(pa.id).toMatch(/^cp-0-16-[0-9a-f]{12}$/);
  });

  const invalidations: {
    name: string;
    change: (h: ChatHistoryItem[]) => void;
    overrides?: Partial<Parameters<typeof planCompaction>[0]>;
    replans: boolean;
  }[] = [
    {
      name: "an edit before the boundary replans",
      change: (h) => {
        h[3] = reply("edited answer");
      },
      replans: true,
    },
    {
      name: "Choose what to keep in the span replans",
      change: (h) => {
        h[5] = { ...h[5], removedByUser: { toolResults: ["x"] } };
      },
      replans: true,
    },
    {
      name: "an edit in the tail keeps the plan",
      change: (h) => {
        h[h.length - 1] = reply("edited last answer");
      },
      replans: false,
    },
    {
      name: "a new window replans",
      change: () => {},
      overrides: { window: 101_000 },
      replans: true,
    },
    {
      name: "another model replans",
      change: () => {},
      overrides: { modelKey: "ollama/llama" },
      replans: true,
    },
    {
      name: "a rewind into the span replans",
      change: (h) => {
        h.splice(14);
        h.push(user("new direction"), reply("ok"));
      },
      replans: true,
    },
  ];

  it.each(invalidations)("$name", ({ change, overrides, replans }) => {
    const { history, itemTokens } = turns(
      Array.from({ length: 10 }, () => [3_500, 3_500]),
    );
    const first = expectPlan(plan(history, itemTokens));
    change(history);
    const next = plan(history, itemTokens.slice(0, history.length), {
      previous: first,
      ...overrides,
    });
    if (replans) {
      expect(isCompactionPlan(next) ? next.id : "idle").not.toBe(first.id);
    } else {
      expect(expectPlan(next).id).toBe(first.id);
    }
  });

  it("spanHash ignores ids and UI state, not content", () => {
    const { history } = turns([
      [1, 1],
      [1, 1],
    ]);
    const before = spanHash(history, 0, 2);
    const withUi = history.map((h) => ({ ...h, id: "x", promptLogs: [] }));
    expect(spanHash(withUi as ChatHistoryItem[], 0, 2)).toBe(before);
    history[1] = reply("different");
    expect(spanHash(history, 0, 2)).not.toBe(before);
  });
});
