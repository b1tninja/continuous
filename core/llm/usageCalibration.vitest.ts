import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChatMessage,
  CompletionOptions,
  LLMOptions,
  Usage,
} from "../index.js";
import {
  contextCorrectionFor,
  correctedContextLength,
  resetContextCorrections,
  tokenCalibrationFor,
} from "./contextOverflow";
import { estimatePromptTokens } from "./countTokens";
import { BaseLLM } from "./index.js";

/** The ratio the research note measured on Strata for a Qwen model. */
const FIXTURE_FACTOR = 0.81;
const MODEL = "qwen3.8-flash-next";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a coding assistant. ".repeat(80) },
  {
    role: "user",
    content: "Explain this file. " + "const x = 1;\n".repeat(400),
  },
];

/** Answers once and reports the prompt as `factor` times our estimate. */
class UsageLLM extends BaseLLM {
  static providerName = "test-usage";
  constructor(
    options: LLMOptions,
    private readonly usage: (sent: ChatMessage[]) => Usage | undefined,
  ) {
    super(options);
    this.templateMessages = undefined;
  }
  protected async *_streamChat(
    messages: ChatMessage[],
    _signal: AbortSignal,
    _options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    yield { role: "assistant", content: "ok" };
    const usage = this.usage(messages);
    if (usage) yield { role: "assistant", content: "", usage };
  }
}

/** Usage at `factor` times our estimate, saying how much was cached. */
const reporting =
  (factor: number) =>
  (sent: ChatMessage[]): Usage => ({
    promptTokens: Math.round(factor * estimatePromptTokens(MODEL, sent)),
    completionTokens: 1,
    // Set, so no /metrics read is attempted for the cache figure
    promptTokensDetails: { cachedTokens: 0 },
  });

async function send(llm: BaseLLM) {
  const gen = llm.streamChat(
    MESSAGES,
    new AbortController().signal,
    {},
    { precompiled: true },
  );
  for (let next = await gen.next(); !next.done; next = await gen.next()) {
    // drain
  }
}

afterEach(() => {
  resetContextCorrections();
  vi.unstubAllGlobals();
});

describe("the usage hook calibrates the token estimate", () => {
  it("learns a local server's ratio, below 1, and widens the budget", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const llm = new UsageLLM(
      {
        model: MODEL,
        apiBase: "http://127.0.0.1:8086/v1/",
        contextLength: 524_288,
      },
      reporting(FIXTURE_FACTOR),
    );
    await send(llm);
    expect(tokenCalibrationFor(MODEL)).toBeCloseTo(FIXTURE_FACTOR, 3);
    expect(contextCorrectionFor(MODEL)).toBeCloseTo(FIXTURE_FACTOR * 1.05, 3);
    expect(correctedContextLength(524_288, MODEL)).toBe(
      Math.floor(524_288 / contextCorrectionFor(MODEL)),
    );
    // A second request with the same ratio leaves it where it is
    await send(llm);
    expect(tokenCalibrationFor(MODEL)).toBeCloseTo(FIXTURE_FACTOR, 3);
    // Nothing was fetched from the server for this
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a hosted provider as it was", async () => {
    const llm = new UsageLLM(
      { model: MODEL, apiBase: "https://api.example.com/v1/" },
      reporting(FIXTURE_FACTOR),
    );
    await send(llm);
    expect(tokenCalibrationFor(MODEL)).toBeUndefined();
    expect(contextCorrectionFor(MODEL)).toBe(1);
  });

  it("learns nothing from a reply without usage", async () => {
    const llm = new UsageLLM(
      { model: MODEL, apiBase: "http://localhost:8080/v1/" },
      () => undefined,
    );
    await send(llm);
    expect(tokenCalibrationFor(MODEL)).toBeUndefined();
  });
});
