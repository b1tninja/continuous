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
import {
  resetFullPromptCountServers,
  resetStrataServers,
} from "./localServers";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

type Kind = "strata" | "llama.cpp" | "vllm" | "ollama" | "lmstudio";

/**
 * A local server's read-only endpoints, as each kind answers them. Only GETs
 * are answered; the chat itself is the test class's `_streamChat`.
 */
function server(kind: Kind) {
  return vi.fn(async (url: URL | string) => {
    const p = new URL(String(url)).pathname;
    if (p === "/v1/status") {
      return kind === "strata" ? json({ service: "strata" }) : json({}, 404);
    }
    if (p === "/props") {
      return kind === "strata" || kind === "llama.cpp"
        ? json({
            total_slots: 1,
            default_generation_settings: { n_ctx: 524_288 },
          })
        : json({}, 404);
    }
    if (p === "/v1/models") {
      const owner =
        kind === "vllm"
          ? { owned_by: "vllm", max_model_len: 131_072 }
          : kind === "ollama"
            ? { owned_by: "library" }
            : { owned_by: "organization_owner" };
      return json({ object: "list", data: [{ id: MODEL, ...owner }] });
    }
    return json({ error: "not found" }, 404);
  });
}

const local = (port: number) => ({
  model: MODEL,
  apiBase: `http://127.0.0.1:${port}/v1/`,
  contextLength: 524_288,
});

afterEach(() => {
  resetContextCorrections();
  resetFullPromptCountServers();
  resetStrataServers();
  vi.unstubAllGlobals();
});

describe("the usage hook calibrates the token estimate", () => {
  it.each([
    ["strata", 8086],
    ["llama.cpp", 8080],
    ["vllm", 8000],
  ] as const)(
    "learns %s's ratio, below 1, and widens the budget",
    async (kind, port) => {
      const fetch = server(kind);
      vi.stubGlobal("fetch", fetch);
      const llm = new UsageLLM(local(port), reporting(FIXTURE_FACTOR));
      await send(llm);
      expect(tokenCalibrationFor(MODEL)).toBeCloseTo(FIXTURE_FACTOR, 3);
      expect(contextCorrectionFor(MODEL)).toBeCloseTo(FIXTURE_FACTOR * 1.05, 3);
      expect(correctedContextLength(524_288, MODEL)).toBe(
        Math.floor(524_288 / contextCorrectionFor(MODEL)),
      );
      // A second request with the same ratio leaves it where it is, and the
      // server is not asked again what it is
      const calls = fetch.mock.calls.length;
      await send(llm);
      expect(tokenCalibrationFor(MODEL)).toBeCloseTo(FIXTURE_FACTOR, 3);
      expect(fetch.mock.calls.length).toBe(calls);
      // Only GETs were sent
      for (const [, init] of fetch.mock.calls as unknown as [
        unknown,
        RequestInit | undefined,
      ][]) {
        expect(init?.method ?? "GET").toBe("GET");
      }
    },
  );

  it.each([
    ["ollama", 11434],
    ["lmstudio", 1234],
  ] as const)(
    "keeps only the overflow correction for %s, which may leave out cached tokens",
    async (kind, port) => {
      vi.stubGlobal("fetch", server(kind));
      // As Ollama's native count does on a cache hit: only the new part
      const llm = new UsageLLM(local(port), reporting(0.05));
      await send(llm);
      expect(tokenCalibrationFor(MODEL)).toBeUndefined();
      expect(contextCorrectionFor(MODEL)).toBe(1);
    },
  );

  it("ignores one odd request after the ratio is known", async () => {
    vi.stubGlobal("fetch", server("strata"));
    let factor = FIXTURE_FACTOR;
    const llm = new UsageLLM(local(8086), (sent) => reporting(factor)(sent));
    await send(llm);
    factor = 0.3; // a request the server counted from elsewhere
    await send(llm);
    expect(tokenCalibrationFor(MODEL)).toBeCloseTo(FIXTURE_FACTOR, 3);
    factor = 1.9;
    await send(llm);
    expect(tokenCalibrationFor(MODEL)).toBeCloseTo(FIXTURE_FACTOR, 3);
  });

  it("leaves a hosted provider as it was", async () => {
    const fetch = vi.fn(async () => json({}, 404));
    vi.stubGlobal("fetch", fetch);
    const llm = new UsageLLM(
      { model: MODEL, apiBase: "https://api.example.com/v1/" },
      reporting(FIXTURE_FACTOR),
    );
    await send(llm);
    expect(tokenCalibrationFor(MODEL)).toBeUndefined();
    expect(contextCorrectionFor(MODEL)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("learns nothing from a reply without usage", async () => {
    vi.stubGlobal("fetch", server("strata"));
    const llm = new UsageLLM(local(8086), () => undefined);
    await send(llm);
    expect(tokenCalibrationFor(MODEL)).toBeUndefined();
  });
});
