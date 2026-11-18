import { afterEach, describe, expect, it, vi } from "vitest";
import { BedrockMantleApi, resetLearnedMantleQuirks } from "./BedrockMantle.js";
import { OpenAIApi } from "./OpenAI.js";

const make = (config: any = {}) =>
  new BedrockMantleApi({
    provider: "bedrock-mantle",
    apiKey: "bedrock-key",
    ...config,
  } as any) as any;

const body = (extra: any = {}) =>
  ({
    model: "openai.gpt-oss-120b",
    messages: [],
    max_tokens: 100,
    ...extra,
  }) as any;
const signal = new AbortController().signal;
const wrongRoute = () =>
  new Error("400 model `openai.gpt-oss-120b` isn't supported on this route");

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  // What a model refused is kept per process; each test starts clean
  resetLearnedMantleQuirks();
});

describe("BedrockMantleApi setup", () => {
  it("defaults to us-east-1 and the /v1 prefix", () => {
    expect(make().apiBase).toBe("https://bedrock-mantle.us-east-1.api.aws/v1/");
  });

  it("builds the URL from region and an explicit prefix", () => {
    expect(
      make({ env: { region: "eu-west-1", mantlePathPrefix: "openai/v1" } })
        .apiBase,
    ).toBe("https://bedrock-mantle.eu-west-1.api.aws/openai/v1/");
  });

  it("honours a custom apiBase (e.g. bedrock-runtime /openai/v1)", () => {
    const base = "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/";
    expect(make({ apiBase: base }).apiBase).toBe(base);
  });

  it("falls back to AWS_BEARER_TOKEN_BEDROCK for the key", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "from-env";
    expect(make({ apiKey: "" }).openai.apiKey).toBe("from-env");
    expect(make({ apiKey: "explicit" }).openai.apiKey).toBe("explicit");
  });
});

describe("path prefix auto-detection", () => {
  it("retries once on the other prefix when the route is wrong", async () => {
    const api = make();
    const spy = vi
      .spyOn(OpenAIApi.prototype, "chatCompletionNonStream")
      .mockRejectedValueOnce(wrongRoute())
      .mockResolvedValueOnce({ id: "ok" } as any);

    await expect(api.chatCompletionNonStream(body(), signal)).resolves.toEqual({
      id: "ok",
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(api.apiBase).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/openai/v1/",
    );
    expect(api.openai.baseURL).toBe(api.apiBase);
  });

  it("does not switch when the prefix was set explicitly", async () => {
    const api = make({ env: { mantlePathPrefix: "/v1" } });
    vi.spyOn(OpenAIApi.prototype, "chatCompletionNonStream").mockRejectedValue(
      wrongRoute(),
    );
    await expect(api.chatCompletionNonStream(body(), signal)).rejects.toThrow(
      /mantlePathPrefix/,
    );
    expect(api.apiBase).toBe("https://bedrock-mantle.us-east-1.api.aws/v1/");
  });

  it("gives up (with a hint) when neither prefix works", async () => {
    const api = make();
    const spy = vi
      .spyOn(OpenAIApi.prototype, "chatCompletionNonStream")
      .mockRejectedValue(wrongRoute());
    await expect(api.chatCompletionNonStream(body(), signal)).rejects.toThrow(
      /mantlePathPrefix/,
    );
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("token-limit parameter", () => {
  const quirk = () =>
    new Error(
      "400 Unsupported parameter: 'max_tokens' is not supported with this model",
    );

  it("learns to use max_completion_tokens after a rejection", async () => {
    const api = make();
    vi.spyOn(OpenAIApi.prototype, "chatCompletionNonStream")
      .mockRejectedValueOnce(quirk())
      .mockResolvedValueOnce({ id: "ok" } as any);
    await api.chatCompletionNonStream(body(), signal);

    const sent = api.modifyChatBody(body());
    expect(sent.max_completion_tokens).toBe(100);
    expect(sent.max_tokens).toBeUndefined();
  });

  it("can be set explicitly, in either direction", () => {
    const a = make({ env: { maxTokensParam: "max_completion_tokens" } });
    expect(a.modifyChatBody(body()).max_completion_tokens).toBe(100);
    const b = make({ env: { maxTokensParam: "max_tokens" } });
    const sent = b.modifyChatBody(
      body({ max_tokens: undefined, max_completion_tokens: 50 }),
    );
    expect(sent.max_tokens).toBe(50);
    expect(sent.max_completion_tokens).toBeUndefined();
  });

  it("leaves max_tokens alone by default", () => {
    const sent = make().modifyChatBody(body());
    expect(sent.max_tokens).toBe(100);
    expect(sent.max_completion_tokens).toBeUndefined();
  });
});

// The refusals Daybreak Blue gave live (us-east-2, 2026-11-14)
const DAYBREAK = "openai.gpt-daybreak-blue-5.6-sol";
const stopRefused = () =>
  new Error(
    "400 Unsupported parameter: 'stop' is not supported with this model.",
  );
const toolsNeedReasoningOff = () =>
  new Error(
    "400 Function tools with reasoning_effort are not supported for gpt-daybreak-blue-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
  );
const weatherTool = {
  type: "function",
  function: { name: "get_weather", parameters: { type: "object" } },
};

describe("learned refusals", () => {
  it("drops a refused stop and retries", async () => {
    const api = make();
    const spy = vi
      .spyOn(OpenAIApi.prototype, "chatCompletionNonStream")
      .mockRejectedValueOnce(stopRefused())
      .mockResolvedValueOnce({ id: "ok" } as any);
    await expect(
      api.chatCompletionNonStream(
        body({ model: DAYBREAK, stop: ["END"] }),
        signal,
      ),
    ).resolves.toEqual({ id: "ok" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(
      api.modifyChatBody(body({ model: DAYBREAK, stop: ["END"] })).stop,
    ).toBeUndefined();
  });

  it("sends reasoning_effort none with tools once the model asks for it", async () => {
    const api = make();
    vi.spyOn(OpenAIApi.prototype, "chatCompletionNonStream")
      .mockRejectedValueOnce(toolsNeedReasoningOff())
      .mockResolvedValueOnce({ id: "ok" } as any);
    await api.chatCompletionNonStream(
      body({ model: DAYBREAK, tools: [weatherTool] }),
      signal,
    );
    const withTools = api.modifyChatBody(
      body({ model: DAYBREAK, tools: [weatherTool] }),
    );
    expect(withTools.reasoning_effort).toBe("none");
    // Without tools the model keeps its own reasoning default
    expect(
      api.modifyChatBody(body({ model: DAYBREAK })).reasoning_effort,
    ).toBeUndefined();
  });

  it("keeps what it learned for a new adapter of the same region and model", async () => {
    vi.spyOn(OpenAIApi.prototype, "chatCompletionNonStream")
      .mockRejectedValueOnce(stopRefused())
      .mockResolvedValueOnce({ id: "ok" } as any);
    await make().chatCompletionNonStream(
      body({ model: DAYBREAK, stop: ["END"] }),
      signal,
    );
    const fresh = make();
    expect(
      fresh.modifyChatBody(body({ model: DAYBREAK, stop: ["END"] })).stop,
    ).toBeUndefined();
    // Another model, or another region, is not affected
    expect(fresh.modifyChatBody(body({ stop: ["END"] })).stop).toEqual(["END"]);
    expect(
      make({ env: { region: "us-east-2" } }).modifyChatBody(
        body({ model: DAYBREAK, stop: ["END"] }),
      ).stop,
    ).toEqual(["END"]);
  });

  it("starts a new adapter on the path the model was found on", async () => {
    const spy = vi
      .spyOn(OpenAIApi.prototype, "chatCompletionNonStream")
      .mockRejectedValueOnce(wrongRoute())
      .mockResolvedValueOnce({ id: "ok" } as any);
    await make().chatCompletionNonStream(body(), signal);
    spy.mockClear();
    spy.mockResolvedValueOnce({ id: "ok" } as any);
    const fresh = make();
    await fresh.chatCompletionNonStream(body(), signal);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fresh.apiBase).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/openai/v1/",
    );
  });

  it("does not retry the same refusal twice", async () => {
    const api = make();
    vi.spyOn(OpenAIApi.prototype, "chatCompletionNonStream")
      .mockRejectedValueOnce(stopRefused())
      .mockRejectedValueOnce(stopRefused());
    await expect(
      api.chatCompletionNonStream(
        body({ model: DAYBREAK, stop: ["END"] }),
        signal,
      ),
    ).rejects.toThrow(/stop/);
  });
});

describe("streaming", () => {
  async function collect(gen: AsyncGenerator<any>) {
    const out: any[] = [];
    for await (const c of gen) out.push(c);
    return out;
  }

  it("retries on the other prefix before any output", async () => {
    const api = make();
    let calls = 0;
    vi.spyOn(OpenAIApi.prototype, "chatCompletionStream").mockImplementation(
      async function* () {
        if (calls++ === 0) throw wrongRoute();
        yield { id: "c1" } as any;
      },
    );
    const out = await collect(
      api.chatCompletionStream(body({ stream: true }), signal),
    );
    expect(out).toEqual([{ id: "c1" }]);
    expect(calls).toBe(2);
  });

  it("never retries after output has started", async () => {
    const api = make();
    let calls = 0;
    vi.spyOn(OpenAIApi.prototype, "chatCompletionStream").mockImplementation(
      async function* () {
        calls++;
        yield { id: "partial" } as any;
        throw wrongRoute();
      },
    );
    await expect(
      collect(api.chatCompletionStream(body({ stream: true }), signal)),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
