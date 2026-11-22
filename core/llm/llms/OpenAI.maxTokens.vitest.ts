import { beforeEach, describe, expect, it, vi } from "vitest";

const bodies: any[] = [];

vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchwithRequestOptions: (_url: URL, init: any) => {
    if (init?.body) bodies.push(JSON.parse(init.body));
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  },
}));

import type { LLMOptions } from "../../index";
import LMStudio from "./LMStudio";
import OpenAI from "./OpenAI";

async function chat(llm: OpenAI) {
  for await (const _ of llm.streamChat(
    [{ role: "user", content: "hi" }],
    new AbortController().signal,
  )) {
    // drained
  }
  const body = bodies.find((b) => Array.isArray(b.messages));
  expect(body).toBeDefined();
  return body;
}

let n = 0;
/** A fresh address each time: what a server said about a model is kept per address. */
const local = (options: Partial<LLMOptions> = {}) =>
  new OpenAI({
    model: "nobody-published-this-model",
    apiBase: `http://127.0.0.1:${9300 + n++}/v1/`,
    apiKey: "k",
    ...options,
  });

const CAP_FIELDS = ["max_tokens", "max_completion_tokens"];

describe("the output cap on a chat request (owner decision Q6)", () => {
  beforeEach(() => {
    bodies.length = 0;
  });

  it("a local OpenAI-compatible server with no known cap is sent none", async () => {
    const llm = local();
    expect(llm.maxTokensSource).toBe("none");
    expect(llm.completionOptions.maxTokens).toBeUndefined();
    const body = await chat(llm);
    for (const field of CAP_FIELDS) expect(body[field]).toBeUndefined();
  });

  it("a provider whose own default address is local is the same", async () => {
    const llm = new LMStudio({ model: "nobody-published-this-model" });
    expect(llm.maxTokensSource).toBe("none");
    const body = await chat(llm);
    for (const field of CAP_FIELDS) expect(body[field]).toBeUndefined();
  });

  it("a person's own value is always sent", async () => {
    const llm = local({ completionOptions: { model: "x", maxTokens: 900 } });
    expect(llm.maxTokensSource).toBe("config");
    const body = await chat(llm);
    expect(body.max_tokens).toBe(900);
  });

  it("a local server with a published cap for the model still sends it", async () => {
    const llm = local({ model: "gpt-4" });
    expect(llm.maxTokensSource).toBe("published");
    const body = await chat(llm);
    expect(body.max_tokens ?? body.max_completion_tokens).toBeGreaterThan(0);
  });

  it("a cloud model still sends its cap", async () => {
    const llm = new OpenAI({ model: "gpt-4", apiKey: "k" });
    expect(llm.maxTokensSource).toBe("published");
    const body = await chat(llm);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(
      llm.completionOptions.maxTokens,
    );
  });

  it("a cloud model nobody published a cap for keeps the 4,096 fallback", async () => {
    const llm = new OpenAI({
      model: "nobody-published-this-model",
      apiBase: "https://api.example.com/v1/",
      apiKey: "k",
    });
    expect(llm.maxTokensSource).toBe("fallback");
    const body = await chat(llm);
    expect(body.max_tokens).toBe(4096);
  });
});
