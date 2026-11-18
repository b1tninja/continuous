import { describe, expect, it } from "vitest";

import { ChatMessage, Tool } from "../../index.js";
import Bedrock from "./Bedrock";

/**
 * Live check that a conversation holding Claude thinking without a signature
 * is accepted. Bedrock refused such a request as a whole: "messages.249.
 * content.0.thinking.signature: Field required" (2026-11-14). A signature
 * arrives last in a thinking block's stream, so a reply stopped or cut off
 * while thinking leaves one; so does thinking from a model that does not sign,
 * before a switch to Claude. The converter now leaves those blocks out.
 *
 * Opt-in, paid (well under a cent):
 *
 *   RUN_LIVE_PROVIDER_TESTS=1 RUN_BEDROCK_LIVE=1 npx vitest run llm/llms/Bedrock.thinkingSignature.live.vitest.ts
 *
 * Knobs: LIVE_MODELS (comma-separated Claude ids), AWS_REGION. Credentials:
 * AWS_BEARER_TOKEN_BEDROCK or the default chain.
 */
const live =
  process.env.RUN_LIVE_PROVIDER_TESTS === "1" &&
  process.env.RUN_BEDROCK_LIVE === "1"
    ? describe
    : (name: string, fn: () => void) =>
        describe.skip(
          `${name} (skipped: set RUN_LIVE_PROVIDER_TESTS=1 and RUN_BEDROCK_LIVE=1)`,
          fn,
        );

const MODELS = (
  process.env.LIVE_MODELS ??
  "us.anthropic.claude-sonnet-5-5,us.anthropic.claude-haiku-4-5-20251001-v1:0"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const weather: Tool = {
  type: "function",
  displayTitle: "Get weather",
  readonly: true,
  group: "test",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const HISTORIES: Record<string, ChatMessage[]> = {
  "an unsigned block in a past turn": [
    { role: "user", content: "What is 12*13? Answer briefly." },
    { role: "thinking", content: "Twelve times thirteen is" },
    { role: "assistant", content: "156" },
    { role: "user", content: "And 14*15? Answer briefly." },
  ],
  "an unsigned block in the current tool-use turn": [
    { role: "user", content: "What's the weather in Paris? Use the tool." },
    { role: "thinking", content: "I should call the tool for Paris." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tooluse_live_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    },
    { role: "tool", toolCallId: "tooluse_live_1", content: "Sunny, 21C" },
  ],
};

live("Bedrock Claude: thinking without a signature (live)", () => {
  describe.each(MODELS)("%s", (model) => {
    it.each(Object.keys(HISTORIES))(
      "accepts: %s",
      async (name) => {
        const llm = new Bedrock({
          model,
          region: process.env.AWS_REGION ?? "us-east-1",
          capabilities: { tools: true },
        });
        let text = "";
        for await (const message of llm.streamChat(
          HISTORIES[name],
          new AbortController().signal,
          // Above the default thinking budget, which Claude requires
          { tools: [weather], maxTokens: 8192, reasoning: true },
        )) {
          if (
            message.role === "assistant" &&
            typeof message.content === "string"
          ) {
            text += message.content;
          }
        }
        console.log(
          `LIVE thinking ${model} | ${name} | ${JSON.stringify(text.slice(0, 80))}`,
        );
        expect(text.trim().length).toBeGreaterThan(0);
      },
      120_000,
    );
  });
});
