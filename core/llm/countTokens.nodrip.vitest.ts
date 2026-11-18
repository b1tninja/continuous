import { describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../index.js";
import { contextLimits, type ContextClass } from "./contextThresholds";
import { compileChatMessages, estimatePromptTokens } from "./countTokens";
import { SUMMARY_MESSAGE_PREFIX } from "../util/summaryMessage";

// One token per character, so 300 turns of up to 20k tokens each count in
// milliseconds and every size below is exact
vi.mock("js-tiktoken", () => ({
  Tiktoken: class {},
  encodingForModel: () => ({
    encode: (text: string) => ({ length: text.length }),
    decode: () => "",
  }),
}));

const MODEL = "gpt-4";
/** No simulated message is larger than this, overhead included. */
const LARGEST_MESSAGE = 20_100;

/** A small seeded generator (mulberry32), so a failure can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Message `id`'s text, `size` characters (tokens) long. */
const text = (id: number, size: number) => {
  const tag = `#${id}|`;
  return tag + "x".repeat(Math.max(0, size - tag.length));
};
const idOf = (m: ChatMessage) => {
  const content = typeof m.content === "string" ? m.content : "";
  const match = /^#(\d+)\|/.exec(content);
  return match ? Number(match[1]) : -1;
};

interface Simulation {
  /** First kept message id after the system prompt, per request. */
  firstKept: number[];
  /** Where each request first differs from the one before, if not at its end. */
  changedAt: (number | undefined)[];
  /** Tokens dropped at each move of the cut. */
  dropped: number[];
  /** Each request's prompt, as counted. */
  sent: number[];
  /** Largest prompt sent. */
  largest: number;
  /** How much the conversation grew over the run. */
  growth: number;
  block: number;
  forceAt: number;
  /** Requests whose first message after the system message was the summary. */
  summaryKept: number;
}

/**
 * Runs `turns` turns: the person's message, a tool call with its result, the
 * model's reply. A request is compiled after the message and after the
 * result, the way the IDE sends them, with sizes drawn from `rand`.
 */
function simulate(
  cls: ContextClass,
  window: number,
  maxTokens: number,
  turns: number,
  seed: number,
  /** A compacted conversation: a summary of this size after the system message. */
  summaryTokens = 0,
): Simulation {
  const rand = random(seed);
  const between = (low: number, high: number) =>
    Math.floor(low + rand() * (high - low));
  const limits = contextLimits(window, maxTokens, cls);
  let nextId = 0;
  const msgs: ChatMessage[] = [
    { role: "system", content: text(nextId++, 16_000) },
  ];
  if (summaryTokens > 0) {
    msgs.push({
      role: "user",
      content: SUMMARY_MESSAGE_PREFIX + "x".repeat(summaryTokens),
    });
  }
  const sim: Simulation = {
    firstKept: [],
    changedAt: [],
    dropped: [],
    sent: [],
    largest: 0,
    growth: 0,
    block: limits.block,
    forceAt: limits.forceAt,
    summaryKept: 0,
  };
  const sizes = new Map<number, number>();
  let previous: number[] = [];

  const request = () => {
    const { compiledChatMessages } = compileChatMessages({
      modelName: MODEL,
      msgs,
      knownContextLength: window,
      maxTokens,
      supportsImages: false,
      contextClass: cls,
    });
    const head = compiledChatMessages[1]?.content;
    const hasSummary =
      typeof head === "string" && head.startsWith(SUMMARY_MESSAGE_PREFIX);
    if (hasSummary) sim.summaryKept++;
    const ids = compiledChatMessages.slice(hasSummary ? 2 : 1).map(idOf);
    const size = estimatePromptTokens(MODEL, compiledChatMessages);
    sim.sent.push(size);
    sim.largest = Math.max(sim.largest, size);
    const first = ids[0];
    const before = sim.firstKept.at(-1);
    if (before !== undefined && first !== before) {
      let tokens = 0;
      for (const [id, size] of sizes) {
        if (id >= before && id < first) tokens += size;
      }
      sim.dropped.push(tokens);
    }
    sim.firstKept.push(first);
    const diverges = previous.findIndex((id, i) => ids[i] !== id);
    sim.changedAt.push(diverges === -1 ? undefined : diverges);
    previous = ids;
  };

  const add = (message: ChatMessage) => {
    msgs.push(message);
    const tokens = estimatePromptTokens(MODEL, [message]);
    sizes.set(idOf(message), tokens);
    sim.growth += tokens;
  };

  for (let turn = 0; turn < turns; turn++) {
    add({ role: "user", content: text(nextId++, between(100, 2_000)) });
    request();
    const callId = `call_${turn}`;
    add({
      role: "assistant",
      content: text(nextId++, between(20, 200)),
      toolCalls: [
        {
          id: callId,
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    });
    add({
      role: "tool",
      content: text(nextId++, between(100, 20_000)),
      toolCallId: callId,
    });
    request();
    add({ role: "assistant", content: text(nextId++, between(100, 2_000)) });
  }
  return sim;
}

describe("compileChatMessages drops whole blocks, never a few messages", () => {
  it.each([
    ["local", 524_288, 4096, 1],
    ["local", 524_288, 4096, 2],
    ["cloud", 200_000, 32_000, 3],
    ["cloud", 1_000_000, 64_000, 4],
  ] as const)(
    "%s, %i-token window: 300 turns of random sizes",
    (cls, window, maxTokens, seed) => {
      const sim = simulate(cls, window, maxTokens, 300, seed);

      // The cut never moves back
      for (let i = 1; i < sim.firstKept.length; i++) {
        expect(sim.firstKept[i]).toBeGreaterThanOrEqual(sim.firstKept[i - 1]);
      }

      // Between moves the prompt only grows at its end: every request is the
      // one before plus new messages
      const moves = sim.firstKept.filter(
        (id, i) => i > 0 && id !== sim.firstKept[i - 1],
      ).length;
      const changes = sim.changedAt.filter((at) => at !== undefined).length;
      expect(changes).toBe(moves);

      // It moves at most once per block of growth, and the run did prune
      expect(moves).toBeGreaterThan(0);
      expect(moves).toBeLessThanOrEqual(Math.floor(sim.growth / sim.block) + 1);

      // Every move drops a whole block, never just a few messages. The cut
      // lands on the first message boundary past each block, so one move can
      // overshoot by up to a message and the next one is short by as much.
      for (const tokens of sim.dropped) {
        expect(tokens).toBeGreaterThan(sim.block - LARGEST_MESSAGE);
      }

      // And every request fits under the force threshold
      expect(sim.largest).toBeLessThanOrEqual(sim.forceAt);
    },
  );

  it("leaves a conversation under the force threshold alone", () => {
    const sim = simulate("local", 524_288, 4096, 20, 5);
    expect(new Set(sim.firstKept)).toEqual(new Set([1]));
    expect(sim.changedAt.every((at) => at === undefined)).toBe(true);
  });

  it("drops down to the block-drop target, then grows append-only", () => {
    const limits = contextLimits(524_288, 4096, "local");
    // The local block is a quarter of the window: from 85% down to 60%
    expect(limits.forceAt).toBe(Math.floor(524_288 * 0.85));
    expect(limits.dropTo).toBe(Math.floor(524_288 * 0.6));
    expect(limits.block).toBe(limits.forceAt - limits.dropTo);

    const sim = simulate("local", 524_288, 4096, 300, 6);
    const moves = sim.firstKept
      .map((id, i) => (i > 0 && id !== sim.firstKept[i - 1] ? i : -1))
      .filter((i) => i > 0);
    expect(moves.length).toBeGreaterThan(1);
    // Right after each move the prompt is back near the target: within one
    // message (at most 20k tokens here) of it
    for (const i of moves) {
      expect(Math.abs(sim.sent[i] - limits.dropTo)).toBeLessThan(25_000);
    }
    // Between moves it grows on every request
    for (let i = 1; i < sim.sent.length; i++) {
      if (!moves.includes(i)) {
        expect(sim.sent[i]).toBeGreaterThan(sim.sent[i - 1]);
      }
    }
  });

  it("keeps a compaction summary at the head and drops the oldest turns after it", () => {
    const summaryTokens = 30_000;
    const sim = simulate("local", 524_288, 4096, 300, 7, summaryTokens);
    // The summary is in every request, right after the system message
    expect(sim.summaryKept).toBe(sim.firstKept.length);
    // The oldest turn after it went first, and the cut only moved forward
    expect(sim.firstKept.at(-1)).toBeGreaterThan(1);
    for (let i = 1; i < sim.firstKept.length; i++) {
      expect(sim.firstKept[i]).toBeGreaterThanOrEqual(sim.firstKept[i - 1]);
    }
    // Each move still drops a block of turns: the summary does not count
    // toward one, so it is never what a block is made of
    expect(sim.dropped.length).toBeGreaterThan(0);
    for (const tokens of sim.dropped) {
      expect(tokens).toBeGreaterThan(sim.block - LARGEST_MESSAGE);
    }
    expect(sim.largest).toBeLessThanOrEqual(sim.forceAt);
  });

  it("drops the first tail turn of a compacted conversation over the threshold, not the summary", () => {
    const summary = SUMMARY_MESSAGE_PREFIX + "x".repeat(40_000);
    const msgs: ChatMessage[] = [
      { role: "system", content: text(0, 16_000) },
      { role: "user", content: summary },
    ];
    for (let i = 1; i <= 30; i++) {
      msgs.push({
        role: i % 2 ? "assistant" : "user",
        content: text(i, 15_000),
      });
    }
    msgs.push({ role: "user", content: text(99, 500) });
    const limits = contextLimits(524_288, 4096, "local");
    expect(estimatePromptTokens(MODEL, msgs)).toBeGreaterThan(limits.forceAt);
    const { compiledChatMessages, didPrune } = compileChatMessages({
      modelName: MODEL,
      msgs,
      knownContextLength: 524_288,
      maxTokens: 4096,
      supportsImages: false,
      contextClass: "local",
    });
    expect(didPrune).toBe(true);
    expect(compiledChatMessages[1].content).toBe(summary);
    const ids = compiledChatMessages.slice(2).map(idOf);
    expect(ids).not.toContain(1);
    expect(ids.at(-1)).toBe(99);
    // One block after the summary is gone: 131k tokens, the first nine messages
    expect(Math.min(...ids)).toBe(10);
    expect(
      estimatePromptTokens(MODEL, compiledChatMessages),
    ).toBeLessThanOrEqual(limits.forceAt);
  });
});
