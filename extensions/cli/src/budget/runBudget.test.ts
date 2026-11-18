import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import {
  COMMUNITY_CATALOG_SCHEMA_VERSION,
  MODELS_DEV_URL,
  parseModelsDev,
} from "core/llm/communityCatalog.js";
import { MODELS_DEV_TRIMMED } from "core/llm/communityCatalogFixtures.js";
import { setCommunityCatalog } from "core/llm/utils/communityPricing.js";
import { costOf } from "core/util/costOf.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamChatResponse } from "../stream/streamChatResponse.js";
import { countTotalInputTokens } from "../util/tokenizer.js";

import {
  RunBudget,
  tightenLimits,
  unpricedBudgetProblem,
  type RunLimits,
} from "./runBudget.js";
import { setActiveRunBudget } from "./runLimits.js";

vi.mock("../session.js", async () => {
  const actual = await vi.importActual<object>("../session.js");
  return { ...actual, trackSessionUsage: vi.fn() };
});
vi.mock("./../stream/handleToolCalls.js", async () => {
  const actual = await vi.importActual<object>("../stream/handleToolCalls.js");
  return {
    ...actual,
    getRequestTools: vi.fn(async () => []),
    handleToolCalls: vi.fn(async () => false),
  };
});
vi.mock("../services/index.js", () => ({
  services: {
    systemMessage: {
      getSystemMessage: vi.fn(async () => "sys"),
      turnTail: vi.fn(() => undefined),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
      isHeadless: vi.fn(() => true),
    },
    chatHistory: {
      isReady: vi.fn(() => false),
      getHistory: vi.fn(() => []),
    },
  },
}));
vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const modelId = { provider: "anthropic", model: "claude-sonnet-5-5" };
const model = {
  provider: "anthropic",
  model: modelId.model,
  defaultCompletionOptions: { contextLength: 200_000, maxTokens: 1000 },
} as ModelConfig;

const history = () => [
  { message: { role: "user" as const, content: "go" }, contextItems: [] },
];

interface Scripted {
  promptTokens: number;
  completionTokens: number;
}

/**
 * A model client that replays scripted usage and makes every reply a tool
 * call, so streamChatResponse keeps asking for another request. `spent`
 * advances by the price of each scripted reply, as the session totals would.
 */
function fakeClient(script: Scripted[]) {
  const state = { calls: 0, spent: 0 };
  const llmApi = {
    chatCompletionStream: vi.fn(async () => {
      const step = script[Math.min(state.calls, script.length - 1)];
      state.calls += 1;
      const r = costOf(
        { ...zero, input: step.promptTokens, output: step.completionTokens },
        modelId,
      );
      state.spent += r.amount === "unknown" ? 0 : r.amount;
      return (async function* () {
        yield {
          choices: [
            {
              delta: {
                content: "x",
                tool_calls: [
                  {
                    index: 0,
                    id: `c${state.calls}`,
                    function: { name: "Noop", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        };
        yield {
          choices: [],
          usage: {
            prompt_tokens: step.promptTokens,
            completion_tokens: step.completionTokens,
          },
        };
      })();
    }),
  } as unknown as BaseLlmApi;
  return { llmApi, state };
}
const zero = { cacheRead: 0, cacheWrite: 0 };

function run(
  limits: RunLimits,
  script: Scripted[],
  now: () => number = () => 0,
) {
  const { llmApi, state } = fakeClient(script);
  const budget = new RunBudget({
    limits,
    model: modelId,
    now,
    spentUsd: () => state.spent,
  });
  setActiveRunBudget(budget);
  return { budget, state, llmApi };
}

describe("run limits around streamChatResponse", () => {
  beforeEach(() => setActiveRunBudget(undefined));

  it("refuses the request that would pass the budget, before sending it", async () => {
    // A large history, so the estimate and the scripted real usage agree
    const big = [
      {
        message: {
          role: "user" as const,
          content: "lorem ipsum ".repeat(20000),
        },
        contextItems: [],
      },
    ];
    const promptTokens = countTotalInputTokens({
      chatHistory: big,
      model,
      systemMessage: "sys",
      tools: [],
    });
    const per = costOf({ input: promptTokens, output: 1000, ...zero }, modelId)
      .amount as number;
    const cap = per * 2.5;
    const { budget, state, llmApi } = run({ maxBudgetUsd: cap }, [
      { promptTokens, completionTokens: 1000 },
    ]);
    await streamChatResponse(big, model, llmApi, new AbortController());
    expect(budget.stop?.reason).toBe("budget");
    expect(budget.stop?.phase).toBe("before-call");
    // two requests fit, the third was refused before it was sent
    expect(state.calls).toBe(2);
    expect(state.spent).toBeLessThanOrEqual(cap);
  });

  it("never passes the budget by more than one request's estimate error", async () => {
    // Replies come back far longer than the 1024 tokens assumed for the
    // first request: the estimate is wrong by one request, no more
    const cap = 0.5;
    const { budget, state, llmApi } = run({ maxBudgetUsd: cap }, [
      { promptTokens: 10_000, completionTokens: 8000 },
    ]);
    await streamChatResponse(history(), model, llmApi, new AbortController());
    expect(budget.stop?.reason).toBe("budget");
    const firstError =
      (costOf({ input: 10_000, output: 8000, ...zero }, modelId)
        .amount as number) - (budget.estimateUsd(0) ?? 0);
    expect(state.spent).toBeLessThanOrEqual(cap + Math.max(0, firstError));
    // after the first reply the run knows the reply size, so the estimate
    // tightens: at most one request overshoots
    expect(state.calls).toBeLessThanOrEqual(
      Math.ceil(cap / (state.spent / state.calls)) + 1,
    );
  });

  it("stops after a request whose real usage reached the cap", async () => {
    const { budget, state, llmApi } = run({ maxBudgetUsd: 0.001 }, [
      { promptTokens: 10, completionTokens: 5 },
      { promptTokens: 200_000, completionTokens: 5 },
    ]);
    // First request fits the estimate (tiny history) but its real cost reaches the cap
    const small = costOf({ input: 1000, output: 1000, ...zero }, modelId);
    expect(small.amount).toBeGreaterThan(0);
    await streamChatResponse(history(), model, llmApi, new AbortController());
    expect(budget.stop).toBeDefined();
    expect(state.calls).toBeLessThanOrEqual(2);
  });

  it("stops at the turn limit before the next request", async () => {
    const { budget, state, llmApi } = run({ maxTurns: 3 }, [
      { promptTokens: 10, completionTokens: 5 },
    ]);
    await streamChatResponse(history(), model, llmApi, new AbortController());
    expect(state.calls).toBe(3);
    expect(budget.stop).toMatchObject({
      reason: "turns",
      phase: "before-call",
    });
  });

  it("stops at the duration limit using the injected clock", async () => {
    let clock = 0;
    const { budget, state, llmApi } = run(
      { maxDurationMinutes: 2 },
      [{ promptTokens: 10, completionTokens: 5 }],
      () => clock,
    );
    llmApi.chatCompletionStream = vi.fn(async () => {
      clock += 60_000; // each request takes a minute
      state.calls += 1;
      return (async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `c${state.calls}`,
                    function: { name: "Noop", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        };
      })();
    }) as never;
    await streamChatResponse(history(), model, llmApi, new AbortController());
    expect(budget.stop?.reason).toBe("duration");
    expect(state.calls).toBe(2);
  });
});

describe("RunBudget", () => {
  it("does not stop a run that ends on its last allowed request", () => {
    const b = new RunBudget({
      limits: { maxTurns: 1 },
      model: modelId,
      spentUsd: () => 0,
    });
    expect(b.beforeCall(10)).toBeUndefined();
    expect(b.afterCall(5)).toBeUndefined();
    expect(b.stop).toBeUndefined();
  });

  it("keeps the first stop", () => {
    const b = new RunBudget({
      limits: { maxTurns: 1 },
      model: modelId,
      spentUsd: () => 0,
    });
    b.beforeCall(10);
    const stop = b.beforeCall(10);
    expect(stop?.reason).toBe("turns");
    expect(b.afterCall()).toBe(stop);
  });

  it("does not enforce a dollar cap on an unpriced model", () => {
    const b = new RunBudget({
      limits: { maxBudgetUsd: 0.01 },
      model: { provider: "ollama", model: "llama3" },
      spentUsd: () => "unknown",
    });
    expect(b.beforeCall(1_000_000)).toBeUndefined();
    expect(b.dollarCapActive).toBe(false);
  });
});

describe("unpriced models", () => {
  const local = { provider: "ollama", model: "llama3" };
  it("refuses a dollar budget on a model with no price", () => {
    expect(unpricedBudgetProblem({ maxBudgetUsd: 1 }, local, false)).toMatch(
      /--budget-allow-unpriced/,
    );
  });
  it("allows it with --budget-allow-unpriced, and without a dollar budget", () => {
    expect(
      unpricedBudgetProblem({ maxBudgetUsd: 1 }, local, true),
    ).toBeUndefined();
    expect(
      unpricedBudgetProblem({ maxTurns: 3 }, local, false),
    ).toBeUndefined();
  });
  it("accepts a priced model", () => {
    expect(
      unpricedBudgetProblem({ maxBudgetUsd: 1 }, modelId, false),
    ).toBeUndefined();
  });
});

describe("a price from the community catalogue only", () => {
  const mistral = { provider: "mistral", model: "mistral-large-latest" };
  beforeEach(() =>
    setCommunityCatalog({
      schemaVersion: COMMUNITY_CATALOG_SCHEMA_VERSION,
      source: MODELS_DEV_URL,
      fetchedAt: "2026-11-10T08:00:00.000Z",
      prices: parseModelsDev(MODELS_DEV_TRIMMED),
    }),
  );
  afterEach(() => setCommunityCatalog(undefined));

  it("refuses --max-budget-usd, naming the catalogue and its date", () => {
    const problem = unpricedBudgetProblem({ maxBudgetUsd: 1 }, mistral, false);
    expect(problem).toMatch(
      /only price is from the community catalogue \(models\.dev, 2026-11-10\)/,
    );
    expect(problem).toMatch(/--budget-allow-unpriced/);
  });

  it("holds the cap on the community estimate with --budget-allow-unpriced", () => {
    expect(
      unpricedBudgetProblem({ maxBudgetUsd: 1 }, mistral, true),
    ).toBeUndefined();
    const b = new RunBudget({
      limits: { maxBudgetUsd: 0.000001 },
      model: mistral,
      allowCommunityPrice: true,
      spentUsd: () => 0,
    });
    expect(b.dollarCapActive).toBe(true);
    expect(b.priceNote).toBe(
      "prices from the community catalogue (models.dev) as of 2026-11-10",
    );
    expect(b.beforeCall(1_000_000)?.reason).toBe("budget");
  });

  it("without the flag the run does not treat it as priced", () => {
    const b = new RunBudget({
      limits: { maxBudgetUsd: 1 },
      model: mistral,
      spentUsd: () => 0,
    });
    expect(b.dollarCapActive).toBe(false);
  });

  it("does not affect a model the tables price", () => {
    expect(
      unpricedBudgetProblem({ maxBudgetUsd: 1 }, modelId, false),
    ).toBeUndefined();
  });
});

describe("tightenLimits", () => {
  it("lets a flag tighten a configured cap", () => {
    const r = tightenLimits(
      { maxBudgetUsd: 5, maxTurns: 50 },
      { maxBudgetUsd: 2 },
    );
    expect(r.limits).toEqual({ maxBudgetUsd: 2, maxTurns: 50 });
    expect(r.ignored).toEqual([]);
  });
  it("never lets a flag loosen one, and says so", () => {
    const r = tightenLimits({ maxTurns: 10 }, { maxTurns: 99 });
    expect(r.limits.maxTurns).toBe(10);
    expect(r.ignored[0]).toMatch(/--max-turns 99 is looser/);
  });
  it("applies a flag where nothing is configured", () => {
    expect(tightenLimits({}, { maxDurationMinutes: 3 }).limits).toEqual({
      maxDurationMinutes: 3,
    });
  });
});
