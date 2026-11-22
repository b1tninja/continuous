import type { Tool } from "core";
import { describe, expect, it } from "vitest";
import { setupTokensOf, smallWindowCost, smallWindowLine } from "./smallWindow";

const model = (
  contextLength: number | undefined,
  maxTokens?: number,
  contextLengthSource:
    "config" | "provider" | "published" | "unknown" = "config",
) => ({ contextLength, contextLengthSource, completionOptions: { maxTokens } });

describe("setupTokensOf", () => {
  const tool = (name: string, description: string) =>
    ({
      type: "function",
      displayTitle: "A title only the GUI shows",
      wouldLikeTo: "text only the GUI shows",
      group: "Built-In",
      readonly: true,
      function: { name, description, parameters: { type: "object" } },
    }) as Tool;

  it("sizes a tool as the model receives it, at four characters per token", () => {
    const sent = JSON.stringify({
      name: "read_file",
      description: "d".repeat(400),
      parameters: { type: "object" },
    });
    expect(setupTokensOf({ tools: [tool("read_file", "d".repeat(400))] })).toBe(
      Math.ceil(sent.length / 4),
    );
  });

  it("adds the system message to the tools", () => {
    const tools = [tool("a", "one"), tool("b", "two")];
    const alone = setupTokensOf({ tools });
    expect(setupTokensOf({ tools, systemMessage: "x".repeat(3_200) })).toBe(
      alone + 800,
    );
    expect(setupTokensOf({ systemMessage: "x".repeat(3_200) })).toBe(800);
    expect(setupTokensOf({})).toBe(0);
  });
});

describe("smallWindowCost", () => {
  it("reports a setup above half of the window less the reply", () => {
    // (8,192 - 2,048) / 2 = 3,072
    expect(
      smallWindowCost({ setupTokens: 3_651, model: model(8_192, 2_048) }),
    ).toEqual({
      setupTokens: 3_651,
      window: 8_192,
      replyTokens: 2_048,
      leftTokens: 2_493,
    });
  });

  it("says nothing at exactly half, and reports one token above", () => {
    const at = (setupTokens: number) =>
      smallWindowCost({ setupTokens, model: model(8_192, 2_048) });
    expect(at(3_072)).toBeUndefined();
    expect(at(3_073)?.leftTokens).toBe(3_071);
  });

  it("says nothing at 32,768 with the same setup", () => {
    expect(
      smallWindowCost({ setupTokens: 3_651, model: model(32_768, 2_048) }),
    ).toBeUndefined();
  });

  it("uses the whole window when no reply size is set", () => {
    expect(
      smallWindowCost({ setupTokens: 3_651, model: model(8_192) }),
    ).toBeUndefined();
    expect(
      smallWindowCost({ setupTokens: 4_097, model: model(8_192) }),
    ).toMatchObject({ replyTokens: 0, leftTokens: 4_095 });
  });

  it("says nothing while the window is not known", () => {
    expect(
      smallWindowCost({ setupTokens: 30_000, model: model(undefined) }),
    ).toBeUndefined();
    // 32,768 is assumed for a model with no known window
    expect(
      smallWindowCost({
        setupTokens: 30_000,
        model: model(32_768, 2_048, "unknown"),
      }),
    ).toBeUndefined();
  });

  it("never reports less than nothing left", () => {
    expect(
      smallWindowCost({ setupTokens: 9_000, model: model(8_192, 2_048) })
        ?.leftTokens,
    ).toBe(0);
  });
});

describe("smallWindowLine", () => {
  it("gives the setup, the window, the reply and what is left", () => {
    expect(
      smallWindowLine({
        setupTokens: 3_651,
        window: 8_192,
        replyTokens: 2_048,
        leftTokens: 2_493,
      }),
    ).toBe(
      "Tools and instructions take about 3,700 of this model's 8,192 tokens. With 2,048 kept for the reply, about 2,500 are left for the conversation.",
    );
  });

  it("leaves the reply out when none is kept", () => {
    expect(
      smallWindowLine({
        setupTokens: 4_500,
        window: 8_192,
        replyTokens: 0,
        leftTokens: 3_692,
      }),
    ).toBe(
      "Tools and instructions take about 4,500 of this model's 8,192 tokens, so about 3,700 are left for the conversation.",
    );
  });

  it("says so when nothing is left", () => {
    expect(
      smallWindowLine({
        setupTokens: 9_000,
        window: 8_192,
        replyTokens: 2_048,
        leftTokens: 0,
      }),
    ).toContain("nothing is left for the conversation.");
  });
});
