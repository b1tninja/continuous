import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getOllamaShowHint, resetOllamaShowCache } from "./ollamaShowHint.js";
import {
  testOpenAICompatConnection as realTest,
  type TestFetch,
} from "./openaiCompatTest.js";
import {
  hintFromLlamaCppProps,
  hintFromOllamaShow,
} from "./toolDialectMetadata.js";

const measuredDir = mkdtempSync(join(tmpdir(), "measured-"));
/** Tests never write to the real global folder. */
const testOpenAICompatConnection = (
  i: Parameters<typeof realTest>[0],
): ReturnType<typeof realTest> =>
  realTest({ measuredFile: join(measuredDir, "m.json"), ...i });

const dir = join(__dirname, "fixtures");
const load = (sub: string, name: string): unknown =>
  JSON.parse(readFileSync(join(dir, sub, `${name}.json`), "utf8"));

beforeEach(() => resetOllamaShowCache());

// [fixture, model, dialect, serverParses, toolsAdvertised]
const SHOW: [string, string, string | undefined, boolean, boolean][] = [
  ["synthetic-qwen3-coder", "qwen3-coder:30b", "qwen-xml", true, true],
  ["synthetic-qwen3", "qwen3:8b", "hermes-json", true, true],
  ["qwen3.6-27b", "qwen3.6:27b", "qwen-xml", true, true],
  ["synthetic-glm-4.7", "glm-4.7-flash", "glm-xml", true, true],
  ["synthetic-gpt-oss", "gpt-oss:20b", "harmony", true, true],
  ["synthetic-ministral", "ministral-3:8b", "mistral", true, true],
  ["synthetic-functiongemma", "functiongemma", "functiongemma", true, true],
  // a parser that parses calls, into a form we have no dialect for
  ["synthetic-deepseek3", "deepseek-v3.1", undefined, true, true],
  ["synthetic-nemotron-3-nano", "nemotron-3-nano", undefined, true, true],
  // a parser not in the verified table: no claim that the server parses
  ["synthetic-unlisted-parser", "new-model", undefined, false, true],
  ["synthetic-passthrough", "some-model", undefined, false, true],
  ["synthetic-template-hermes", "qwen2.5:7b", "hermes-json", false, true],
  ["synthetic-template-no-tools", "gemma3:4b", undefined, false, false],
];

describe("Ollama /api/show fixtures", () => {
  it.each(SHOW)("%s", (name, model, dialect, serverParses, tools) => {
    const h = hintFromOllamaShow(load("ollama-show", name), model);
    expect(h.signal?.dialect).toBe(dialect);
    expect(h.serverParses ?? false).toBe(serverParses);
    expect(h.toolsAdvertised).toBe(tools);
  });

  it("every fixture file is in the table or is a recorded non-tool body", () => {
    const covered = new Set(SHOW.map((r) => r[0]));
    const rest = readdirSync(join(dir, "ollama-show"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((n) => !covered.has(n));
    expect(rest.sort()).toEqual(["glm-ocr", "qwen3-embedding-8b"]);
  });

  it.each(SHOW)("%s through getOllamaShowHint", async (name, model, _d, sp) => {
    const body = load("ollama-show", name);
    const h = await getOllamaShowHint({
      provider: "ollama",
      model,
      fetchFn: async () => ({ ok: true, json: async () => body }),
    });
    expect(h?.serverParses ?? false).toBe(sp);
  });
});

// [fixture, dialect]
const PROPS: [string, string | undefined][] = [
  ["synthetic-qwen3-coder", "qwen-xml"],
  ["synthetic-hermes", "hermes-json"],
  ["synthetic-gpt-oss", "harmony"],
  ["synthetic-kimi-k2", "kimi-tokens"],
  ["synthetic-deepseek-v32", "dsml"],
  ["synthetic-mistral", "mistral"],
  ["synthetic-glm", "glm-xml"],
  // templates that name no markup the sniff knows
  ["synthetic-llama-3.1", undefined],
  ["synthetic-no-tools", undefined],
];

describe("llama.cpp /props fixtures", () => {
  it.each(PROPS)("%s", (name, dialect) => {
    const h = hintFromLlamaCppProps(load("llamacpp-props", name));
    expect(h.signal?.dialect).toBe(dialect);
    expect(h.serverParses).toBeUndefined();
  });
});

describe("Test connection against the fixtures", () => {
  const route =
    (routes: Record<string, unknown>): TestFetch =>
    async (url, init) => {
      const body = routes[`${init.method} ${url}`];
      if (body === undefined) throw new Error("ECONNREFUSED");
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };
  const prose = { choices: [{ message: { content: "I cannot." } }] };

  it.each(SHOW.filter((r) => r[3]))(
    "Ollama %s: the probe reports serverParses",
    async (name, model) => {
      const r = await testOpenAICompatConnection({
        provider: "ollama",
        model,
        fetchFn: route({
          "GET http://127.0.0.1:11434/v1/models": { data: [{ id: model }] },
          "POST http://127.0.0.1:11434/api/show": load("ollama-show", name),
          "POST http://127.0.0.1:11434/v1/chat/completions": prose,
        }),
      });
      expect(r.ok && r.probe && "serverParses" in r.probe).toBe(true);
    },
  );

  it.each(PROPS.filter((r) => r[1]))(
    "llama.cpp %s: the template line names %s",
    async (name, dialect) => {
      const r = await testOpenAICompatConnection({
        provider: "llama.cpp",
        model: "m",
        fetchFn: route({
          "GET http://127.0.0.1:8080/v1/models": { data: [{ id: "m" }] },
          "GET http://127.0.0.1:8080/props": load("llamacpp-props", name),
          "POST http://127.0.0.1:8080/v1/chat/completions": prose,
        }),
      });
      expect(r.ok && r.template).toContain(`looks like ${dialect}`);
    },
  );

  it("a template that names no markup adds no template line", async () => {
    const r = await testOpenAICompatConnection({
      provider: "llama.cpp",
      model: "m",
      fetchFn: route({
        "GET http://127.0.0.1:8080/v1/models": { data: [{ id: "m" }] },
        "GET http://127.0.0.1:8080/props": load(
          "llamacpp-props",
          "synthetic-no-tools",
        ),
        "POST http://127.0.0.1:8080/v1/chat/completions": prose,
      }),
    });
    expect(r.ok && r.template).toBeUndefined();
  });
});
