import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// _streamChat reads the body through streamResponse; one finished reply.
vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@continuedev/fetch")>()),
  streamResponse: async function* () {
    yield '{"message":{"role":"assistant","content":"ok"},"done":true}\n';
  },
}));

import type { LLMOptions, ModelDescription } from "../index.js";
import { resetLearned } from "../llm/learnedLimits.js";
import Ollama from "../llm/llms/Ollama.js";
import { llmToSerializedModelDescription } from "./load.js";
import { reloadConfigWhenLearned } from "./reloadConfigWhenLearned.js";

/** An Ollama whose server loaded the model with `window` tokens. */
function createOllama(options: Partial<LLMOptions>, window: number) {
  const ollama = new Ollama({ model: "llama3.1:8b", ...options });
  const paths: string[] = [];
  (ollama as any).fetch = async (url: URL) => {
    paths.push(url.pathname);
    const json =
      url.pathname === "/api/ps"
        ? { models: [{ name: "llama3.1:8b", context_length: window }] }
        : {};
    return { status: 200, ok: true, json: async () => json };
  };
  return { ollama, paths };
}

async function chat(ollama: Ollama): Promise<void> {
  for await (const _ of (ollama as any)._streamChat(
    [{ role: "user", content: "hi" }],
    new AbortController().signal,
    { model: "llama3.1:8b", stream: true },
  )) {
    // drain
  }
}

/**
 * The part of a config reload that matters here: the model is built again
 * from the same options and serialized for the GUI, which replaces the
 * description it holds with the one it is sent.
 */
function fakeConfig(options: Partial<LLMOptions>, window: number) {
  const state = {
    ...createOllama(options, window),
    held: undefined as ModelDescription | undefined,
    reasons: [] as string[],
  };
  state.held = llmToSerializedModelDescription(state.ollama);
  const configHandler = {
    reloadConfig: async (reason: string) => {
      state.reasons.push(reason);
      Object.assign(state, createOllama(options, window));
      state.held = llmToSerializedModelDescription(state.ollama);
    },
  };
  return { state, configHandler };
}

describe("the window an Ollama server loaded reaches the GUI", () => {
  let stop: () => void = () => {};
  beforeEach(resetLearned);
  afterEach(() => stop());

  test("after the first request the held description has the window and its source", async () => {
    const { state, configHandler } = fakeConfig({}, 4096);
    stop = reloadConfigWhenLearned(configHandler);
    // Before a request the row has the published window, which is not the
    // one a laptop's server loads the model with
    expect(state.held).toMatchObject({
      contextLength: 131072,
      contextLengthSource: "published",
    });

    await chat(state.ollama);

    expect(state.reasons).toEqual(["Context window learned"]);
    expect(state.held).toMatchObject({
      contextLength: 4096,
      contextLengthSource: "provider",
    });
  });

  test("the model built by that reload asks again and does not reload again", async () => {
    const { state, configHandler } = fakeConfig({}, 4096);
    stop = reloadConfigWhenLearned(configHandler);
    await chat(state.ollama);
    await chat(state.ollama);
    expect(state.paths).toContain("/api/ps");
    expect(state.reasons).toHaveLength(1);
  });

  test("a window the server changed is shown after the next request", async () => {
    const first = fakeConfig({}, 4096);
    stop = reloadConfigWhenLearned(first.configHandler);
    await chat(first.state.ollama);
    stop();

    // The same model, now loaded with a larger window
    const { state, configHandler } = fakeConfig({}, 8192);
    stop = reloadConfigWhenLearned(configHandler);
    expect(state.held?.contextLength).toBe(4096);
    await chat(state.ollama);
    expect(state.held).toMatchObject({
      contextLength: 8192,
      contextLengthSource: "provider",
    });
  });

  test("a context length the person set is kept and nothing reloads", async () => {
    const { state, configHandler } = fakeConfig({ contextLength: 16384 }, 4096);
    stop = reloadConfigWhenLearned(configHandler);
    await chat(state.ollama);
    expect(state.reasons).toEqual([]);
    expect(state.held).toMatchObject({
      contextLength: 16384,
      contextLengthSource: "config",
    });
  });

  test("a reload that fails does not fail the request", async () => {
    const { ollama } = createOllama({}, 4096);
    stop = reloadConfigWhenLearned({
      reloadConfig: async () => {
        throw new Error("no profile");
      },
    });
    await expect(chat(ollama)).resolves.toBeUndefined();
    expect(ollama.contextLength).toBe(4096);
  });
});
