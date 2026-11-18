import { describe, expect, it } from "vitest";
import { familyRuleFor } from "./bedrockFamilyRules";
import {
  bedrockMinMaxTokens,
  bedrockOmitUnsupportedInference,
  bedrockReasoningFields,
} from "./bedrockHelpers";

// What a live run on 2026-11-14 measured for OpenAI's closed GPT models on
// bedrock-runtime: stopSequences refused, reasoning_effort refused, a small
// budget spent on reasoning.
const CLOSED_GPT = [
  "us.openai.gpt-6-luna",
  "us.openai.gpt-6-sol",
  "us.openai.gpt-6.1-sol",
  "us.openai.gpt-5.6-sol",
  "us.openai.gpt-5.6-terra",
  "global.openai.gpt-5.6-luna",
];

describe("OpenAI's closed GPT models on Bedrock", () => {
  it.each(CLOSED_GPT)("%s has the gpt-closed rule", (id) => {
    expect(familyRuleFor(id)?.id).toBe("gpt-closed");
  });

  it("does not match GPT OSS or Daybreak Blue", () => {
    expect(familyRuleFor("openai.gpt-oss-120b-1:0")?.id).toBe("gpt-oss");
    expect(familyRuleFor("openai.gpt-daybreak-blue-5.6-sol")).toBeUndefined();
  });

  it.each(CLOSED_GPT)("%s gets no stopSequences", (id) => {
    expect(
      bedrockOmitUnsupportedInference(id, {
        maxTokens: 2000,
        stopSequences: ["END"],
        temperature: 0.5,
      }),
    ).toEqual({ maxTokens: 2000, temperature: 0.5 });
  });

  it.each(CLOSED_GPT)("%s raises a tiny maxTokens to 1024", (id) => {
    expect(bedrockMinMaxTokens(id, 60)).toBe(1024);
    expect(bedrockMinMaxTokens(id, 4096)).toBe(4096);
    expect(bedrockMinMaxTokens(id, undefined)).toBeUndefined();
  });

  it.each(CLOSED_GPT)("%s is sent no reasoning field", (id) => {
    for (const reasoning of [true, false, undefined]) {
      expect(
        bedrockReasoningFields(id, reasoning, 4096)
          .additionalModelRequestFields,
      ).toEqual({});
    }
  });
});
