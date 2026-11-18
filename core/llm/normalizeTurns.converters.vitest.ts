/**
 * The audit's converter tests (plans/research/provider-message-validity-
 * audit.md, "Tests needed" 3, 4 and 7), without any network call:
 *
 * - a valid tool loop compiles to requests where each one starts with the
 *   bytes of the one before, for every converter, so the prompt cache hits;
 * - every case in the audit table, compiled and then converted, gives no
 *   empty turn, no unanswered call, no result without a call, no "thinking"
 *   role and no undefined id or name;
 * - converting twice gives the same request and leaves the messages as they
 *   were (WatsonX used to `delete` fields on them).
 */
import { constructLlmApi } from "@continuedev/openai-adapters";
import { toResponsesInput } from "@continuedev/openai-adapters/dist/apis/openaiResponses.js";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../index.js";
import { compileChatMessages } from "./countTokens.js";
import Anthropic from "./llms/Anthropic.js";
import Ollama from "./llms/Ollama.js";
import WatsonX from "./llms/WatsonX.js";
import {
  assistant,
  call,
  thinking,
  tool,
  turnCases,
  user,
  validHistories,
} from "./normalizeTurns.fixtures.js";
import { toChatBody } from "./openaiTypeConverters.js";

const SYSTEM: ChatMessage = { role: "system", content: "You are helpful." };

function compile(
  msgs: ChatMessage[],
  requiresAlternation = false,
): ChatMessage[] {
  return compileChatMessages({
    modelName: "gpt-4o",
    msgs,
    knownContextLength: 200_000,
    maxTokens: 4096,
    supportsImages: true,
    requiresAlternation,
  }).compiledChatMessages;
}

const anthropicNative = new Anthropic({
  apiKey: "k",
  model: "claude-sonnet-4-6",
} as any);
const anthropicAdapter = constructLlmApi({
  provider: "anthropic",
  apiKey: "k",
} as any) as any;
const geminiAdapter = constructLlmApi({
  provider: "gemini",
  apiKey: "k",
} as any) as any;
const ollama = new Ollama({ model: "llama3.1" } as any) as any;
const watsonx = new WatsonX({
  model: "ibm/granite-3-8b-instruct",
  apiKey: "k",
  apiBase: "https://example.invalid",
  env: {},
} as any) as any;

const openAiMessages = (msgs: ChatMessage[]) =>
  toChatBody(msgs, { model: "gpt-4o" } as any).messages;

/** Each converter, from compiled ChatMessages to what goes on the wire. */
const converters: Record<string, (msgs: ChatMessage[]) => unknown[]> = {
  "Anthropic (native)": (msgs) => anthropicNative.convertMessages(msgs, false),
  toChatBody: openAiMessages,
  "Anthropic adapter": (msgs) =>
    anthropicAdapter._convertMessages(openAiMessages(msgs)),
  "Gemini adapter": (msgs) =>
    geminiAdapter._convertBody(
      { model: "gemini-2.5-pro", messages: openAiMessages(msgs) },
      false,
      true,
    ).contents,
  "OpenAI Responses": (msgs) => toResponsesInput(openAiMessages(msgs)),
  Ollama: (msgs) => ollama._convertMessages(msgs),
  WatsonX: (msgs) => watsonx._convertArgs({ model: "m" }, msgs).messages,
};

describe("cache prefix: a valid tool loop keeps every earlier byte", () => {
  // The request at each step of a loop of four tool rounds, with signed
  // reasoning before each call and a text answer at the end
  const steps: ChatMessage[][] = [];
  let history: ChatMessage[] = [SYSTEM, user("Read the four files.")];
  steps.push(history);
  for (let round = 1; round <= 4; round++) {
    history = [
      ...history,
      thinking(`Next is file ${round}.`, `sig-${round}`),
      assistant(round % 2 ? "" : `Reading file ${round}.`, [
        call(`c${round}`, "read_file", `{"path":"f${round}.ts"}`),
      ]),
      tool(`c${round}`, `export const f${round} = ${round};`),
    ];
    steps.push(history);
  }
  steps.push([...history, assistant("All four read."), user("Thanks.")]);

  it.each(Object.keys(converters))("%s", (name) => {
    const convert = converters[name];
    const wire = steps.map((step) => JSON.stringify(convert(compile(step))));
    for (let n = 0; n + 1 < wire.length; n++) {
      // The array's closing bracket is the only byte that may change
      expect(wire[n + 1].startsWith(wire[n].slice(0, -1))).toBe(true);
    }
  });

  it("compile sends each valid history byte for byte as given", () => {
    for (const [name, h] of Object.entries(validHistories)) {
      const compiled = compile([SYSTEM, ...h]);
      expect(compiled.slice(1), name).toEqual(
        // The only change compile makes to a valid history: the " " that
        // stands in for empty content (messages.ts addSpaceToAnyEmptyMessages)
        h.map((m) =>
          typeof m.content === "string" && m.content.trim() === ""
            ? { ...m, content: " " }
            : m,
        ),
      );
    }
  });
});

type Block = Record<string, any>;

/**
 * A history whose every user turn is empty keeps its last one, which compile
 * pads to " ": the one case where a whitespace user text block is left.
 */
const ONLY_EMPTY_USERS = "2. every user empty keeps the last one";

/** Anthropic messages: every invariant the API states for turns and tool blocks. */
function checkAnthropic(name: string, messages: Block[]) {
  messages.forEach((message, i) => {
    expect(message.content.length, `${name}: empty turn ${i}`).toBeGreaterThan(
      0,
    );
    const toolUses = message.content.filter(
      (b: Block) => b.type === "tool_use",
    );
    for (const block of message.content) {
      if (
        block.type === "text" &&
        block.text.trim() === "" &&
        name !== ONLY_EMPTY_USERS
      ) {
        // The " " compile puts in a text-less tool-call turn is the one
        // whitespace block left (the audit's rule 6 is not applied)
        expect(toolUses.length, `${name}: whitespace text`).toBeGreaterThan(0);
      }
      if (block.type === "tool_use") {
        expect(block.id, name).toBeTruthy();
        expect(block.name, name).toBeTruthy();
      }
    }
    if (toolUses.length > 0) {
      const next = messages[i + 1];
      expect(next?.role, `${name}: tool_use unanswered`).toBe("user");
      const results = next.content.filter(
        (b: Block) => b.type === "tool_result",
      );
      expect(results.map((b: Block) => b.tool_use_id).sort()).toEqual(
        toolUses.map((b: Block) => b.id).sort(),
      );
      // tool_result blocks come first in the turn
      expect(
        next.content
          .slice(0, results.length)
          .every((b: Block) => b.type === "tool_result"),
        `${name}: tool_result not first`,
      ).toBe(true);
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const previous = messages[i - 1];
        expect(
          previous?.content.some(
            (b: Block) => b.type === "tool_use" && b.id === block.tool_use_id,
          ),
          `${name}: tool_result answers no tool_use`,
        ).toBe(true);
      }
    }
  });
}

/** OpenAI messages: no empty turn, no undefined field, results answer calls. */
function checkOpenAi(name: string, messages: Block[]) {
  const unanswered = new Set<string>();
  for (const message of messages) {
    expect(message.role, name).not.toBe("thinking");
    if (message.role === "assistant") {
      expect(unanswered.size, `${name}: call unanswered`).toBe(0);
      const hasCalls = (message.tool_calls ?? []).length > 0;
      expect(
        hasCalls ||
          (typeof message.content === "string"
            ? message.content.length > 0
            : message.content.length > 0),
        `${name}: empty assistant`,
      ).toBe(true);
      if (message.tool_calls) {
        expect(
          message.tool_calls.length,
          `${name}: tool_calls []`,
        ).toBeGreaterThan(0);
      }
      for (const c of message.tool_calls ?? []) {
        expect(c.id, name).toBeTruthy();
        expect(c.function.name, name).toBeTruthy();
        unanswered.add(c.id);
      }
    } else if (message.role === "tool") {
      expect(
        unanswered.delete(message.tool_call_id),
        `${name}: result answers no call`,
      ).toBe(true);
    } else {
      expect(unanswered.size, `${name}: call unanswered`).toBe(0);
      if (message.role === "user") {
        expect(message.content.length, `${name}: empty user`).toBeGreaterThan(
          0,
        );
      }
    }
  }
}

function checkGemini(name: string, contents: Block[]) {
  for (const content of contents) {
    expect(content.parts.length, `${name}: parts []`).toBeGreaterThan(0);
    for (const part of content.parts) {
      if (part.functionCall) expect(part.functionCall.name, name).toBeTruthy();
      if (part.inlineData) expect(part.inlineData.data, name).toBeTruthy();
    }
  }
}

function checkResponses(name: string, items: Block[]) {
  const calls = new Set<string>();
  for (const item of items) {
    if (item.type === "function_call") {
      expect(item.call_id, name).toBeTruthy();
      expect(item.name, name).toBeTruthy();
      calls.add(item.call_id);
    }
    if (item.type === "function_call_output") {
      expect(calls.has(item.call_id), `${name}: output answers no call`).toBe(
        true,
      );
    }
  }
}

function checkNoThinkingRole(name: string, messages: Block[]) {
  for (const message of messages) {
    expect(message.role, name).not.toBe("thinking");
  }
}

function checkWatsonX(name: string, messages: Block[]) {
  checkNoThinkingRole(name, messages);
  for (const message of messages) {
    if (message.role === "tool") {
      expect(message.tool_call_id, `${name}: tool_call_id`).toBeTruthy();
      expect(message).not.toHaveProperty("toolCallId");
    }
    for (const c of message.tool_calls ?? []) {
      expect(c.id, name).toBeTruthy();
      expect(c.function?.name, name).toBeTruthy();
    }
  }
}

describe("converter invariants over the audit's cases", () => {
  const inputs = [
    ...turnCases.map((c) => ({
      name: c.name,
      input: c.input,
      requiresAlternation: c.requiresAlternation,
    })),
    ...Object.entries(validHistories).map(([name, input]) => ({
      name,
      input,
      requiresAlternation: false,
    })),
  ];

  it.each(inputs)("$name", ({ name, input, requiresAlternation }) => {
    const compiled = compile([SYSTEM, ...input], requiresAlternation);
    checkAnthropic(name, converters["Anthropic (native)"](compiled) as Block[]);
    checkAnthropic(name, converters["Anthropic adapter"](compiled) as Block[]);
    checkOpenAi(name, converters.toChatBody(compiled) as Block[]);
    checkGemini(name, converters["Gemini adapter"](compiled) as Block[]);
    checkResponses(name, converters["OpenAI Responses"](compiled) as Block[]);
    checkNoThinkingRole(name, converters.Ollama(compiled) as Block[]);
    checkWatsonX(name, converters.WatsonX(compiled) as Block[]);
  });
});

describe("converters do not change their input", () => {
  const history = validHistories["signed thinking with a call"];

  it.each(Object.keys(converters))("%s", (name) => {
    const compiled = compile([SYSTEM, ...history]);
    const before = JSON.stringify(compiled);
    const first = JSON.stringify(converters[name](compiled));
    const second = JSON.stringify(converters[name](compiled));
    expect(second).toBe(first);
    expect(JSON.stringify(compiled)).toBe(before);
  });

  it("WatsonX: a retry sends tool_call_id, not undefined", () => {
    const compiled = compile([SYSTEM, ...validHistories["tool loop"]]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const sent = converters.WatsonX(compiled) as Block[];
      const results = sent.filter((m) => m.role === "tool");
      expect(results.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
      expect(
        sent.find((m) => m.role === "assistant" && m.tool_calls),
      ).toBeTruthy();
    }
    expect(compiled.find((m) => m.role === "tool")).toHaveProperty(
      "toolCallId",
      "c1",
    );
  });
});
