import { describe, expect, it } from "vitest";
import {
  LOCAL_ONBOARDING_CHAT_MODEL,
  setupLocalConfig,
  validateLocalApiBase,
  validateLocalModelName,
} from "./onboarding";

const base = { name: "n", version: "1.0.0", models: [] as any[] };

describe("setupLocalConfig", () => {
  it("writes the suggested Ollama setup when no choice is given", () => {
    const models = setupLocalConfig(base).models!;
    expect(models.map((m: any) => [m.provider, m.model, m.roles])).toEqual([
      ["ollama", LOCAL_ONBOARDING_CHAT_MODEL, ["chat", "edit", "apply"]],
      ["ollama", "qwen2.5-coder:1.5b-base", ["autocomplete"]],
      ["ollama", "nomic-embed-text:latest", ["embed"]],
    ]);
    expect((models[0] as any).name).toBe("Llama 3.1 8B");
  });

  it("keeps the models already in the config after the local ones", () => {
    const existing = { name: "x", provider: "openai", model: "gpt" };
    const models = setupLocalConfig({ ...base, models: [existing] }).models!;
    expect(models).toHaveLength(4);
    expect(models[3]).toEqual(existing);
  });

  it("writes an Ollama choice with the suggested FIM and embeddings", () => {
    const models = setupLocalConfig(base, {
      provider: "ollama",
      chatModel: "qwen3:8b",
    }).models! as any[];
    expect(models[0]).toMatchObject({
      name: "qwen3:8b",
      provider: "ollama",
      model: "qwen3:8b",
    });
    expect(models[0].apiBase).toBeUndefined();
    expect(models[1].model).toBe("qwen2.5-coder:1.5b-base");
    expect(models[1].name).toBe("Qwen2.5-Coder 1.5B");
    expect(models[2].model).toBe("nomic-embed-text:latest");
  });

  it("uses the FIM and embeddings models named for Ollama", () => {
    const models = setupLocalConfig(base, {
      provider: "ollama",
      chatModel: "llama3.1:8b",
      fimModel: "starcoder2:3b",
      embeddingsModel: "mxbai-embed-large",
    }).models! as any[];
    expect(models.map((m) => m.model)).toEqual([
      "llama3.1:8b",
      "starcoder2:3b",
      "mxbai-embed-large",
    ]);
    expect(models[0].name).toBe("Llama 3.1 8B");
  });

  it("writes an OpenAI-compatible server with its address and only the named models", () => {
    const models = setupLocalConfig(base, {
      provider: "openai",
      chatModel: "my-model",
      chatTitle: "Local Strata",
      apiBase: " http://127.0.0.1:8080/v1/ ",
      fimModel: "my-fim",
    }).models! as any[];
    expect(models).toEqual([
      {
        name: "Local Strata",
        provider: "openai",
        model: "my-model",
        apiBase: "http://127.0.0.1:8080/v1/",
        roles: ["chat", "edit", "apply"],
      },
      {
        name: "my-fim",
        provider: "openai",
        model: "my-fim",
        apiBase: "http://127.0.0.1:8080/v1/",
        roles: ["autocomplete"],
      },
    ]);
  });
});

describe("validation", () => {
  it("rejects empty and spaced model names", () => {
    expect(validateLocalModelName("")).toBeTruthy();
    expect(validateLocalModelName("  ")).toBeTruthy();
    expect(validateLocalModelName("a b")).toBeTruthy();
    expect(validateLocalModelName("qwen3:8b")).toBeUndefined();
  });
  it("accepts only http(s) addresses", () => {
    expect(validateLocalApiBase("")).toBeTruthy();
    expect(validateLocalApiBase("localhost:8080")).toBeTruthy();
    expect(validateLocalApiBase("ftp://x")).toBeTruthy();
    expect(validateLocalApiBase("http://127.0.0.1:8080/v1/")).toBeUndefined();
  });
});
