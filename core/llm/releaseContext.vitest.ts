import { describe, expect, it } from "vitest";

import type { ChatHistoryItem, ChatMessage } from "../index.js";
import { summaryMessageText } from "../util/summaryMessage.js";
import {
  planCompaction,
  type CompactionPlanResult,
} from "../util/compactionPlan.js";
import {
  CONTEXT_THRESHOLDS,
  MIN_RESPONSE_TOKENS,
  blocksToDrop,
  contextLimits,
  countingSafetyBuffer,
} from "./contextThresholds.js";
import {
  compileChatMessages,
  countTokens,
  estimatePromptTokens,
} from "./countTokens.js";
import { fitRequestMaxTokens } from "./requestBudget.js";

/**
 * Release gate. Compaction and the reply cap at the windows Claude is run
 * with: 200k/64k (Sonnet and Haiku 4.5), 200k/32k (Opus 4.1), 1M/128k
 * (Claude 5), and a configured 100k window with a 128k reply. A 1,300-token
 * fixture never reaches a block drop or a summary.
 */

const MODEL = "gpt-4";

const PROFILES = [
  {
    name: "Sonnet and Haiku 4.5 published",
    window: 200_000,
    maxTokens: 64_000,
    modelMax: 64_000,
  },
  {
    name: "Opus 4.1 published",
    window: 200_000,
    maxTokens: 32_000,
    modelMax: 32_000,
  },
  {
    name: "Claude 5 catalog",
    window: 1_000_000,
    maxTokens: 128_000,
    modelMax: 128_000,
  },
  {
    name: "configured 100k window, 128k reply, 128k model",
    window: 100_000,
    maxTokens: 128_000,
    modelMax: 128_000,
  },
  {
    name: "configured 100k window, 128k reply, 64k model",
    window: 100_000,
    maxTokens: 128_000,
    modelMax: 64_000,
  },
] as const;

let pieceTokens = 0;
const PIECE = "alpha bravo charlie delta echo foxtrot ";

function tokensOf(text: string): number {
  return countTokens(text, MODEL);
}

/** About `target` tokens. Counted, not assumed. */
function filler(target: number): string {
  if (pieceTokens === 0) {
    pieceTokens = tokensOf(PIECE.repeat(40)) / 40;
  }
  const copies = Math.max(1, Math.ceil(target / pieceTokens));
  return PIECE.repeat(copies);
}

function user(text: string): ChatHistoryItem {
  return { message: { role: "user", content: text }, contextItems: [] };
}
function reply(text: string): ChatHistoryItem {
  return { message: { role: "assistant", content: text }, contextItems: [] };
}

function historyOf(
  turnTokens: number,
  turns: number,
): {
  history: ChatHistoryItem[];
  itemTokens: number[];
} {
  const history: ChatHistoryItem[] = [];
  const itemTokens: number[] = [];
  for (let i = 0; i < turns; i++) {
    history.push(user(`question ${i}`), reply(`answer ${i}`));
    itemTokens.push(turnTokens, turnTokens);
  }
  return { history, itemTokens };
}

function stateOf(result: CompactionPlanResult): string {
  return result.state;
}

describe("compaction at the real windows", () => {
  it.each(PROFILES)(
    "$name: idle, then prepare, then force",
    ({ window, maxTokens }) => {
      const shares = CONTEXT_THRESHOLDS.cloud;
      const head = 2_000;
      const below = historyOf(1_000, 4);
      expect(
        stateOf(
          planCompaction({
            history: below.history,
            itemTokens: below.itemTokens,
            headTokens: head,
            window,
            thresholds: shares,
            modelKey: "anthropic/claude",
          }),
        ),
      ).toBe("idle");

      const prepareTokens = Math.floor(window * 0.8);
      const prepare = historyOf(Math.floor(prepareTokens / 8), 4);
      const prepared = planCompaction({
        history: prepare.history,
        itemTokens: prepare.itemTokens,
        headTokens: head,
        window,
        thresholds: shares,
        modelKey: "anthropic/claude",
      });
      expect(prepared.state).toBe("prepare");

      const forceTokens = Math.floor(window * 0.95);
      const forced = historyOf(Math.floor(forceTokens / 8), 4);
      const plan = planCompaction({
        history: forced.history,
        itemTokens: forced.itemTokens,
        headTokens: head,
        window,
        thresholds: shares,
        modelKey: "anthropic/claude",
      });
      expect(plan.state).toBe("force");
      if (plan.state === "force") {
        const tail = forced.history.slice(plan.spanEnd);
        expect(tail.length).toBeGreaterThan(0);
        expect(tail.some((item) => item.message.role === "user")).toBe(true);
      }
    },
  );

  it("the block drop only moves forward as the conversation grows", () => {
    const limits = contextLimits(200_000, 64_000, "cloud");
    let previous = 0;
    for (const extra of [0, 1, 2, 5]) {
      const blocks = blocksToDrop(
        limits.forceAt + extra * limits.block,
        limits,
      );
      expect(blocks).toBeGreaterThanOrEqual(previous);
      previous = blocks;
    }
    expect(previous).toBeGreaterThan(0);
  });
});

describe("compileChatMessages at a 200k Claude window", () => {
  const window = 200_000;
  const maxTokens = 64_000;
  const modelMax = 64_000;

  const call = (id: string): ChatMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ],
  });
  const result = (id: string, text: string): ChatMessage => ({
    role: "tool",
    content: text,
    toolCallId: id,
  });

  function compile(msgs: ChatMessage[]) {
    return compileChatMessages({
      modelName: MODEL,
      msgs,
      knownContextLength: window,
      maxTokens,
      supportsImages: false,
      contextClass: "cloud",
    });
  }

  it("drops old turns once the prompt passes the force line, and keeps the summary and the latest turn", () => {
    const old = filler(30_000);
    const msgs: ChatMessage[] = [
      { role: "system", content: "You are a coding agent." },
      {
        role: "user",
        content: summaryMessageText("The ledger spec was read."),
      },
    ];
    for (let i = 0; i < 6; i++) {
      msgs.push(
        { role: "user", content: `old question ${i} ${old}` },
        { role: "assistant", content: `old answer ${i} ${old}` },
      );
    }
    msgs.push(
      { role: "user", content: "LATEST implement the ledger" },
      call("t-last"),
      result("t-last", "spec: integer cents"),
    );

    const compiled = compile(msgs);
    expect(compiled.didPrune).toBe(true);
    const text = compiled.compiledChatMessages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(text).toContain("Previous conversation summary:");
    expect(text).toContain("LATEST implement the ledger");
    const ids = new Set(
      compiled.compiledChatMessages.flatMap((m) =>
        m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [],
      ),
    );
    expect(ids.has("t-last")).toBe(true);
    for (const m of compiled.compiledChatMessages) {
      if (m.role === "tool") expect(ids.has(m.toolCallId)).toBe(true);
    }

    const promptTokens = estimatePromptTokens(
      MODEL,
      compiled.compiledChatMessages,
    );
    const budget = fitRequestMaxTokens({
      configured: maxTokens,
      modelMax,
      window,
      promptTokens,
    });
    expect(budget.maxTokens).toBeLessThanOrEqual(modelMax);
    expect(promptTokens + budget.maxTokens + 1_000).toBeLessThanOrEqual(window);
  });

  it("a tool result that does not fit beside the minimum reply is refused", () => {
    const huge = filler(
      window - countingSafetyBuffer(window) - MIN_RESPONSE_TOKENS + 8_000,
    );
    expect(() =>
      compile([
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Read the journal and implement seed." },
        call("journal"),
        result("journal", huge),
      ]),
    ).toThrow(/Not enough context/);
  });
});

describe("compileChatMessages at the configured 100k window", () => {
  it("a 90k tool result is sent, and the reply reserve shrinks so it fits", () => {
    const huge = filler(90_000);
    const compiled = compileChatMessages({
      modelName: MODEL,
      msgs: [
        { role: "user", content: "Implement seed from the journal." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "j",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: huge, toolCallId: "j" },
      ],
      knownContextLength: 100_000,
      maxTokens: 128_000,
      supportsImages: false,
      contextClass: "cloud",
    });
    expect(compiled.outputTokensAvailable).toBeGreaterThanOrEqual(
      MIN_RESPONSE_TOKENS,
    );
    const promptTokens = estimatePromptTokens(
      MODEL,
      compiled.compiledChatMessages,
    );
    const budget = fitRequestMaxTokens({
      configured: 128_000,
      modelMax: 64_000,
      window: 100_000,
      promptTokens,
    });
    expect(budget.maxTokens).toBeGreaterThanOrEqual(MIN_RESPONSE_TOKENS);
    expect(budget.maxTokens).toBeLessThan(10_000);
    expect(promptTokens + budget.maxTokens + 1_000).toBeLessThanOrEqual(
      100_000,
    );
  });
});
