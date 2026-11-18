import { describe, expect, it } from "vitest";

import { LLMOptions } from "..";
import { BaseLLM } from ".";

class FakeAnthropic extends BaseLLM {
  static providerName = "anthropic";
  protected async *_streamChat() {
    yield { role: "assistant" as const, content: "ok" };
  }
  protected async *_streamComplete() {
    yield "ok";
  }
  protected async _complete() {
    return "ok";
  }
}

const errorFor = (model: string, status: number) =>
  (
    new FakeAnthropic({ model, title: "t", apiKey: "k" } as LLMOptions) as any
  ).parseError({
    status,
    statusText: "x",
    url: "https://api.anthropic.com/v1/messages",
    text: async () => '{"type":"error"}',
  }) as Promise<Error>;

describe("hint when the requested model is retired", () => {
  it("names the retirement and the replacement on a 404", async () => {
    const err = await errorFor("claude-opus-4-1-20250805", 404);
    expect(err.message).toContain("HTTP 404");
    expect(err.message).toContain("was retired");
    expect(err.message).toContain("claude-opus-4-8");
  });

  it("adds nothing for a model that is not retired", async () => {
    const err = await errorFor("claude-opus-4-8", 404);
    expect(err.message).not.toContain("retired");
  });

  it("adds nothing for other statuses", async () => {
    const err = await errorFor("claude-opus-4-1-20250805", 500);
    expect(err.message).not.toContain("retired");
  });
});
