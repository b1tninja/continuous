import { describe, expect, it } from "vitest";
import { TOOL_DIALECT_VALUES } from "@continuedev/config-yaml";
import { loadCorpus } from "../llm/toolDialects/corpus/corpus";
import {
  detectToolDialectLeak,
  isLeakedToolCall,
  leakHintText,
  leakNoticeText,
  providerRecoversText,
  stripThinkBlocks,
} from "./toolDialectLeak";

const corpus = new Map(loadCorpus().map((f) => [f.id, f]));
const text = (id: string) => corpus.get(id)!.text;

describe("detectToolDialectLeak", () => {
  it("sees Hermes JSON and GLM markup written as text", () => {
    expect(
      detectToolDialectLeak({ content: text("hermes-canonical") }),
    ).toEqual({ dialect: "hermes-json" });
    expect(detectToolDialectLeak({ content: text("glm47-canonical") })).toEqual(
      { dialect: "glm-xml" },
    );
  });

  it("sees Harmony, Mistral and DeepSeek calls written as text", () => {
    for (const [id, dialect] of [
      ["harmony-commentary-call", "harmony"],
      ["mistral-v3-tool-calls-json", "mistral"],
      ["devstral-args-marker", "mistral"],
      ["deepseek-v32-dsml-canonical", "dsml"],
      ["deepseek-v4-dsml-tool-calls-block", "dsml"],
      ["deepseek-v31-canonical", "deepseek-v31"],
      ["deepseek-r1-canonical", "deepseek-r1"],
    ] as const) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toEqual({
        dialect,
      });
    }
  });

  it("sees the Kimi and MiniMax forms written as text", () => {
    for (const [id, dialect] of [
      ["kimi-k2-canonical", "kimi-tokens"],
      ["kimi-k3-canonical", "kimi-xtml"],
      ["minimax-m2-canonical", "minimax-xml"],
      ["minimax-m3-canonical", "minimax-ns-xml"],
    ] as const) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toEqual({
        dialect,
      });
    }
  });

  it("does not offer recovery for a fenced Kimi K3 or MiniMax M3 example", () => {
    for (const id of [
      "neg-kimi-k3-fenced-example",
      "neg-minimax-m3-fenced-example",
    ]) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toBeUndefined();
    }
  });

  it("sees the Group C forms written as text", () => {
    for (const [id, dialect] of [
      ["granite-canonical", "granite-tokens"],
      ["lfm-canonical", "lfm-tokens"],
      ["hy3-canonical", "hy3-tags"],
      ["solar-canonical", "solar-tokens"],
      ["longcat-canonical", "longcat-json"],
      ["olmo-canonical", "olmo-function-calls"],
      ["seed-canonical", "seed-xml"],
      ["cohere-canonical", "cohere-action"],
    ] as const) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toEqual({
        dialect,
      });
    }
  });

  it("does not offer recovery for a fenced Kimi K3 or MiniMax M3 example", () => {
    for (const id of [
      "neg-kimi-k3-fenced-example",
      "neg-minimax-m3-fenced-example",
    ]) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toBeUndefined();
    }
  });

  it("sees qwen markup written as text", () => {
    expect(
      detectToolDialectLeak({
        content: text("qwen3-coder-30b-bedrock-function-xml-as-text"),
      }),
    ).toEqual({ dialect: "qwen-xml" });
  });

  it("ignores markup inside a code fence or inline code", () => {
    for (const id of [
      "neg-fenced-example-qwen-call",
      "neg-prose-mentions-qwen-tags",
    ]) {
      expect(detectToolDialectLeak({ content: text(id) })).toBeUndefined();
    }
  });

  it("ignores a reply that also has structured calls", () => {
    expect(
      detectToolDialectLeak({
        content: "ok",
        toolCalls: [{ id: "1", name: "read", arguments: "{}" }],
      }),
    ).toBeUndefined();
  });

  it("stays quiet once toolDialect is set, except auto", () => {
    const content = text("qwen3-coder-30b-bedrock-function-xml-as-text");
    expect(detectToolDialectLeak({ content, current: "off" })).toBeUndefined();
    expect(detectToolDialectLeak({ content, current: "auto" })).toBeDefined();
  });

  it("covers Bedrock and the OpenAI-compatible adapter, and words the notice as agreed", () => {
    expect(providerRecoversText("bedrock")).toBe(true);
    expect(providerRecoversText("openai")).toBe(true);
    expect(providerRecoversText("lmstudio")).toBe(true);
    expect(providerRecoversText("anthropic")).toBe(false);
    expect(providerRecoversText(undefined)).toBe(false);
    // Ollama's IDE path is native chat; the CLI goes through the adapter.
    expect(providerRecoversText("ollama")).toBe(false);
    expect(providerRecoversText("ollama", "cli")).toBe(true);
    expect(leakNoticeText("qwen-xml")).toBe(
      "This model typed a tool request as plain text, so it did not run. Let Continuous read that format for this model?",
    );
    expect(leakHintText("m", "qwen-xml")).toContain("toolDialect: qwen-xml");
  });
});

/** Failure modes of a negative that is still a call written as text. */
const DECLINED_CALL = new Set([
  "argument-type-mismatch",
  "malformed",
  "truncated",
  "prose-around-call",
  "undeclared-argument",
  "one-bad-call",
  "string-arguments",
  "bad-constrain",
  "bare-object",
  "missing-arguments",
  "wrong-key",
  "partial-refused",
  "trailing-comma",
  "truncated-list",
]);

describe("detectToolDialectLeak never suggests llama-json for Gemma (RQ7)", () => {
  const content = text("gemma3-has-no-tool-section");
  const knownTools = ["get_weather"];

  it("suggests a dialect for another model, and nothing for a Gemma 3 model that writes the same markup", () => {
    const qwen = text("qwen3-coder-canonical");
    const tools = corpus.get("qwen3-coder-canonical")!.tools.map((t) => t.name);
    expect(
      detectToolDialectLeak({ content: qwen, knownTools: tools })?.dialect,
    ).toBe("qwen-xml");
    expect(
      detectToolDialectLeak({
        content: qwen,
        knownTools: tools,
        model: "qwen.qwen3-coder-30b-a3b-v1:0",
      })?.dialect,
    ).toBe("qwen-xml");
    expect(
      detectToolDialectLeak({
        content: qwen,
        knownTools: tools,
        model: "google.gemma-3-27b-it",
      }),
    ).toBeUndefined();
  });

  it.each([
    "google.gemma-3-27b-it",
    "gemma3:27b",
    "gemma-3-27b",
    "google/gemma-4-31B-it",
  ])("makes no suggestion for %s", (model) => {
    expect(
      detectToolDialectLeak({ content, knownTools, model }),
    ).toBeUndefined();
  });
});

describe("isLeakedToolCall", () => {
  const tools = (id: string) => corpus.get(id)!.tools.map((t) => t.name);
  const leak = (id: string, extra?: { toolCalls?: never }) =>
    isLeakedToolCall({
      content: text(id),
      knownTools: tools(id),
      ...extra,
    });

  it("counts the shapes that models write as text", () => {
    for (const id of [
      "qwen3-coder-30b-bedrock-function-xml-as-text",
      "qwen3-coder-canonical",
      "hermes-canonical",
      "glm47-canonical",
      "llama33-bedrock-json-text-single",
      "nova-python-call-syntax",
      "deepseek-v32-dsml-canonical",
      "mistral-v3-tool-calls-json",
      "devstral-args-marker",
      "harmony-commentary-call",
      "deepseek-v31-canonical",
      "deepseek-r1-canonical",
      "llama3-python-tag-builtin",
      "granite-canonical",
      "lfm-canonical",
      "hy3-canonical",
      "solar-canonical",
      "longcat-canonical",
      "olmo-canonical",
      "seed-canonical",
      "cohere-canonical",
      "toolcall-json-canonical",
      "toolcall-json-array-two-calls",
      "toolcall-json-think-then-call",
      "llama4-pythonic-canonical",
    ]) {
      expect(leak(id), id).toBe(true);
    }
  });

  it("does not count negatives, fenced examples or inline mentions", () => {
    for (const f of corpus.values()) {
      if (!f.id.startsWith("neg-")) continue;
      // Recovery leaves a malformed or refused call as text, but it is still
      // a call written as text, so the nudge applies (next test).
      if (DECLINED_CALL.has(f.failureMode)) continue;
      expect(leak(f.id), f.id).toBe(false);
    }
  });

  it("counts a refused call (wrong argument type, truncated, bare object, wrong key): recovery declines it, the nudge does not", () => {
    for (const f of corpus.values()) {
      if (!f.id.startsWith("neg-") || !DECLINED_CALL.has(f.failureMode)) {
        continue;
      }
      expect(leak(f.id), f.id).toBe(true);
    }
  });

  it("a call written only inside a think block is not a leaked call", () => {
    const id = "qwen3-coder-call-inside-think-vllm-39056";
    expect(leak(id)).toBe(false);
  });

  it("a call after a think block, or after a prefilled opener, is still a leak", () => {
    const call = text("qwen3-coder-canonical");
    const knownTools = tools("qwen3-coder-canonical");
    for (const content of [
      `<think>
plan
</think>
${call}`,
      `plan
</think>
${call}`,
      `<think>
plan
</think>
<think>more</think>${call}`,
    ]) {
      expect(isLeakedToolCall({ content, knownTools }), content).toBe(true);
    }
    // a think block left open swallows the rest of the reply
    expect(
      isLeakedToolCall({
        content: `<think>
plan
${call}`,
        knownTools,
      }),
    ).toBe(false);
  });

  it("stripThinkBlocks is linear on a reply of 1 MiB", () => {
    const big = "<think>x</think>".repeat(65536);
    const t0 = Date.now();
    expect(stripThinkBlocks(big)).toBe("");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("counts a Llama 4 list that was cut off or ends in a trailing comma, and not a quoted one (Q24c)", () => {
    const id = "llama4-pythonic-canonical";
    const full = text(id);
    const shapes = [
      full.slice(0, full.length - 14),
      full.replace(/\)\]$/, "),]"),
      full.replace(/\)\]$/, ", )]"),
      `[${full.slice(1, full.indexOf("), ") + 3)}`,
    ];
    for (const content of shapes) {
      expect(
        isLeakedToolCall({ content, knownTools: tools(id) }),
        content,
      ).toBe(true);
    }
    for (const content of [
      "Use [1, 2, 3] as the list.",
      `Example: \`${full}\``,
      `\`\`\`
${full.slice(0, 20)}
\`\`\``,
      `[unknown_tool(a=1),`,
    ]) {
      expect(
        isLeakedToolCall({ content, knownTools: tools(id) }),
        content,
      ).toBe(false);
    }
  });

  it("does not count a quoted TOOLCALL block (fenced, inline, or naming no offered tool)", () => {
    const id = "toolcall-json-canonical";
    const call = text(id);
    for (const content of [
      `Reply with:

\`\`\`
${call}
\`\`\``,
      `The marker is \`${call}\`.`,
      "The <TOOLCALL> marker wraps a JSON list.",
    ]) {
      expect(
        isLeakedToolCall({ content, knownTools: tools(id) }),
        content,
      ).toBe(false);
    }
  });

  it("counts a call that recovery declined because prose came before or after it (Q28): the turn must not end silently", () => {
    const declined = [...corpus.values()].filter((f) =>
      f.provenance.note.includes("Declined by owner rule"),
    );
    expect(declined.length).toBeGreaterThan(5);
    // Every declined shape is counted for Kimi, DeepSeek V3.1 and Harmony too
    // (the table test below); these are the Qwen and Mistral ones.
    const counted = declined.filter((f) => leak(f.id));
    for (const id of [
      "qwen3-coder-prose-then-call",
      "qwen3-coder-prose-after-call",
      "qwen3-coder-two-calls-with-prose-between",
      "qwen3-coder-missing-open-tag-ollama-16686",
      "qwen3-coder-30b-bedrock-function-xml-as-text",
      "mistral-v3-parallel-and-prose",
    ]) {
      expect(
        counted.map((f) => f.id),
        id,
      ).toContain(id);
    }
  });

  it("counts a declined call of the Kimi, DeepSeek and Harmony shapes, whose tool name follows `functions.` or a separator", () => {
    const declined: [string, (t: string) => string][] = [
      // truncated, undeclared argument, prose around: recovery refuses each.
      ["kimi-k2-canonical", (t) => t.slice(0, t.length - 12)],
      ["kimi-k2-canonical", (t) => `Reading it. ${t}`],
      ["harmony-commentary-call", (t) => t.slice(0, t.length - 8)],
      ["harmony-commentary-call", (t) => `${t} Done.`],
      ["deepseek-v32-dsml-canonical", (t) => `Sure.\n\n${t}`],
      ["deepseek-v32-dsml-canonical", (t) => t.slice(0, t.length - 20)],
      ["deepseek-v31-canonical", (t) => `Sure. ${t}`],
      ["deepseek-v31-canonical", (t) => t.slice(0, t.length - 30)],
      ["deepseek-r1-canonical", (t) => `Sure. ${t}`],
      ["deepseek-r1-canonical", (t) => t.slice(0, t.length - 30)],
    ];
    for (const [id, make] of declined) {
      const content = make(text(id));
      expect(
        isLeakedToolCall({ content, knownTools: tools(id) }),
        `${id}: ${content}`,
      ).toBe(true);
    }
  });

  it("needs a tool that was actually offered", () => {
    expect(
      isLeakedToolCall({
        content: text("qwen3-coder-30b-bedrock-function-xml-as-text"),
        knownTools: ["something_else"],
      }),
    ).toBe(false);
    expect(
      isLeakedToolCall({
        content: text("qwen3-coder-30b-bedrock-function-xml-as-text"),
      }),
    ).toBe(false);
  });

  it("does not count a reply that also made a structured call", () => {
    expect(
      isLeakedToolCall({
        content: text("qwen3-coder-canonical"),
        knownTools: tools("qwen3-coder-canonical"),
        toolCalls: [{ name: "read", arguments: "{}" }],
      }),
    ).toBe(false);
  });

  it("does not count plain prose", () => {
    expect(
      isLeakedToolCall({
        content: "Let me read the file next.",
        knownTools: ["read"],
      }),
    ).toBe(false);
  });
});

describe("isLeakedToolCall covers every dialect the recovery parsers know (H21)", () => {
  const tools = (id: string) => corpus.get(id)!.tools.map((t) => t.name);
  // Llama JSON shapes the classifier still reads as prose (a bare list of
  // strings, calls joined by semicolons): recorded, not nudged.
  const KNOWN_GAP = new Set(["llama33-bedrock-json-array-of-strings"]);
  const markup = TOOL_DIALECT_VALUES.filter(
    (v) => v !== "auto" && v !== "native" && v !== "off",
  );

  it.each(markup)(
    "%s: every must-pass positive fixture is a leaked call, bare or with prose around it",
    (dialect) => {
      const fixtures = [...corpus.values()].filter(
        (f) =>
          f.dialect === dialect &&
          f.kind === "positive" &&
          f.policy === "must" &&
          !KNOWN_GAP.has(f.id),
      );
      expect(fixtures.length, `no fixture for ${dialect}`).toBeGreaterThan(0);
      for (const f of fixtures) {
        const knownTools = tools(f.id);
        expect(isLeakedToolCall({ content: f.text, knownTools }), f.id).toBe(
          true,
        );
        // recovery is strict (whole reply); the nudge is not, for the marker
        // dialects. A bare list or object is a call only as the whole reply.
        if (dialect === "pythonic" || dialect === "llama-json") continue;
        expect(
          isLeakedToolCall({ content: `Sure. ${f.text}`, knownTools }),
          `${f.id} with prose before`,
        ).toBe(true);
      }
    },
  );

  it.each(markup)(
    "%s: the same call in a code fence, in inline code or explained is not a leak",
    (dialect) => {
      const f = [...corpus.values()].find(
        (x) =>
          x.dialect === dialect && x.kind === "positive" && x.policy === "must",
      )!;
      const knownTools = tools(f.id);
      const inline = f.text.includes("`")
        ? []
        : [
            "The model writes `" +
              f.text.replaceAll(String.fromCharCode(10), " ") +
              "` when it calls a tool.",
          ];
      for (const content of [
        ...inline,
        `Here is the format:

\`\`\`
${f.text}
\`\`\`

It is what the model writes.`,
      ]) {
        expect(isLeakedToolCall({ content, knownTools }), content).toBe(false);
      }
    },
  );

  it("counts the Harmony call whose recipient sits in the role section", () => {
    const id = "harmony-template-form-recipient-in-role";
    expect(isLeakedToolCall({ content: text(id), knownTools: tools(id) })).toBe(
      true,
    );
  });

  it("does not count prose that names the Kimi, DeepSeek or Harmony tokens, or a tool call that names no offered tool", () => {
    const known = ["get_weather"];
    for (const content of [
      "Kimi K2 wraps calls in <|tool_calls_section_begin|> and ends them with <|tool_calls_section_end|>; see get_weather.",
      "DeepSeek V3.1 uses the <｜tool▁calls▁begin｜> token before get_weather.",
      "Harmony routes a call with to=functions.get_weather after the commentary channel.",
      "The <|call|> token ends a Harmony call to get_weather.",
      text("kimi-k2-canonical").replace("get_weather", "not_offered"),
      text("harmony-commentary-call").replace("get_weather", "not_offered"),
    ]) {
      expect(isLeakedToolCall({ content, knownTools: known }), content).toBe(
        false,
      );
    }
  });
});
