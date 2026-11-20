import { beforeEach, describe, expect, it } from "vitest";
import { resetLearned, rememberLearned } from "./learnedLimits";
import OpenAI from "./llms/OpenAI";

beforeEach(resetLearned);

const options = {
  model: "some-unpublished-model-xyz",
  apiBase: "http://127.0.0.1:9/v1",
  apiKey: "k",
};

describe("a model whose window nobody published", () => {
  it("assumes the default until its server's answer is remembered", () => {
    const before = new OpenAI(options);
    expect(before.contextLengthSource).toBe("unknown");
    expect(before.contextLength).toBe(32768);

    rememberLearned(before.limitsKey, { contextLength: 131072 });
    const after = new OpenAI(options);
    expect(after.contextLength).toBe(131072);
    expect(after.contextLengthSource).toBe("provider");
  });

  it("keeps the person's own contextLength over what the server said", () => {
    const probe = new OpenAI(options);
    rememberLearned(probe.limitsKey, { contextLength: 131072 });
    const own = new OpenAI({ ...options, contextLength: 20000 });
    expect(own.contextLength).toBe(20000);
    expect(own.contextLengthSource).toBe("config");
  });

  it("does not apply to another endpoint or model", () => {
    const probe = new OpenAI(options);
    rememberLearned(probe.limitsKey, { contextLength: 131072 });
    expect(
      new OpenAI({ ...options, apiBase: "http://127.0.0.1:10/v1" })
        .contextLength,
    ).toBe(32768);
    expect(new OpenAI({ ...options, model: "other-xyz" }).contextLength).toBe(
      32768,
    );
  });
});
