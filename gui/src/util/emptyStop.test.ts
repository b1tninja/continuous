import { describe, expect, it } from "vitest";

import { emptyStopDetail, modelTurnLacksReply } from "./emptyStop";

const user = { message: { role: "user", content: "hi" } };

describe("modelTurnLacksReply", () => {
  it("is true when the only text is thinking", () => {
    expect(
      modelTurnLacksReply([
        user,
        { message: { role: "thinking", content: "The last word is Goodbye." } },
      ]),
    ).toBe(true);
  });

  it("is false when the assistant answered or called a tool", () => {
    expect(
      modelTurnLacksReply([
        user,
        { message: { role: "thinking", content: "looking" } },
        { message: { role: "assistant", content: "Goodbye" } },
      ]),
    ).toBe(false);
    expect(
      modelTurnLacksReply([
        user,
        {
          message: { role: "assistant", content: "" },
          toolCallStates: [{}],
        },
      ]),
    ).toBe(false);
  });

  it("is false when the history still ends on the person or a tool result", () => {
    expect(modelTurnLacksReply([user])).toBe(false);
    expect(
      modelTurnLacksReply([
        user,
        { message: { role: "assistant", content: "" }, toolCallStates: [{}] },
        { message: { role: "tool", content: "Hello from the readme." } },
      ]),
    ).toBe(false);
  });
});

describe("emptyStopDetail", () => {
  it("names the output limit when the stop is the cap", () => {
    expect(
      emptyStopDetail({
        history: [user, { message: { role: "assistant", content: "" } }],
        stopReason: "max_tokens",
        maxTokens: 300,
        contextLength: 32768,
      }),
    ).toBe(
      "The model stopped without a reply because the output limit was reached (300 tokens). The context window in use is 32768 tokens. Change either under Models → Configure → Context & cost.",
    );
  });

  it("says the turn stopped, and that reasoning is not the reply", () => {
    expect(
      emptyStopDetail({
        history: [
          user,
          {
            message: {
              role: "thinking",
              content:
                'The first word of README.md is "Hello" and the last word is "Goodbye".',
            },
          },
        ],
        stopReason: "end_turn",
      }),
    ).toBe(
      "The model stopped without a reply and without a tool call. Reasoning from this turn is not a reply.",
    );
  });

  it("says nothing when the turn has an answer", () => {
    expect(
      emptyStopDetail({
        history: [user, { message: { role: "assistant", content: "4" } }],
        stopReason: "end_turn",
      }),
    ).toBeUndefined();
  });
});
