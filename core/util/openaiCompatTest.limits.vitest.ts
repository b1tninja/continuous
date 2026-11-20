import { describe, expect, it } from "vitest";
import { testOpenAICompatConnection, type TestFetch } from "./openaiCompatTest";

const reply = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Answers by URL path; records what was asked. */
function server(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchFn: TestFetch = async (url) => {
    const path = new URL(url).pathname;
    asked.push(`${path}`);
    return path in routes ? reply(routes[path]) : reply({}, false, 404);
  };
  return { fetchFn, asked };
}

const base = {
  record: false,
  measuredFile: "nonexistent-measured.json",
} as const;

describe("testOpenAICompatConnection: the window the server reports", () => {
  it("reads vLLM's max_model_len from the model's /models entry", async () => {
    const { fetchFn } = server({
      "/v1/models": { data: [{ id: "qwen", max_model_len: 131072 }] },
    });
    const r = await testOpenAICompatConnection({
      ...base,
      provider: "openai",
      apiBase: "http://localhost:8000/v1",
      checkModel: "qwen",
      fetchFn,
    });
    expect(r.ok && r.listedLimits).toMatchObject({
      contextLength: 131072,
      kind: "max",
      note: expect.stringContaining("131,072"),
    });
  });

  it("has no listedLimits when the entry says nothing", async () => {
    const { fetchFn } = server({ "/v1/models": { data: [{ id: "qwen" }] } });
    const r = await testOpenAICompatConnection({
      ...base,
      provider: "openai",
      apiBase: "http://localhost:8000/v1",
      checkModel: "qwen",
      fetchFn,
    });
    expect(r.ok && r.listedLimits).toBeUndefined();
  });

  it("prefers llama.cpp's running window from /props", async () => {
    const { fetchFn, asked } = server({
      "/v1/models": { data: [{ id: "m", meta: { n_ctx_train: 262144 } }] },
      "/props": { default_generation_settings: { n_ctx: 16384 } },
    });
    const r = await testOpenAICompatConnection({
      ...base,
      provider: "llama.cpp",
      apiBase: "http://localhost:8080/v1",
      checkModel: "m",
      fetchFn,
    });
    expect(asked).toContain("/props");
    expect(r.ok && r.listedLimits).toMatchObject({
      contextLength: 16384,
      kind: "loaded",
    });
  });

  it("reads Ollama's num_ctx from /api/show", async () => {
    const { fetchFn } = server({
      "/v1/models": { data: [{ id: "llama3" }] },
      "/api/show": {
        parameters: "num_ctx 8192",
        model_info: { "llama.context_length": 131072 },
      },
    });
    const r = await testOpenAICompatConnection({
      ...base,
      provider: "ollama",
      apiBase: "http://localhost:11434/v1",
      checkModel: "llama3",
      fetchFn,
    });
    expect(r.ok && r.listedLimits).toMatchObject({
      contextLength: 8192,
      kind: "loaded",
    });
  });

  it("still connects when the extra routes are missing", async () => {
    const { fetchFn } = server({ "/v1/models": { data: [{ id: "m" }] } });
    const r = await testOpenAICompatConnection({
      ...base,
      provider: "llama.cpp",
      apiBase: "http://localhost:8080/v1",
      checkModel: "m",
      fetchFn,
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.listedLimits).toBeUndefined();
  });
});
