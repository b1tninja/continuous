import {
  effectiveRecoverySetting,
  withToolDialect,
  type ToolDialectSetting,
} from "@continuedev/config-yaml";
import { recoverFromText, recoverySetting } from "@continuedev/openai-adapters";
import { describe, expect, it } from "vitest";
import { bedrockSupportsTools } from "../llm/toolSupport.js";
import { TOOL_DIALECT_PRESETS } from "./toolDialectPresetTable.js";
import {
  describePreset,
  presetBedrockTools,
  resolveToolDialectPreset,
  toolDialectHint,
  type NativeOnConverse,
  type TextDialect,
  type ToolsOnBedrock,
} from "./toolDialectPresets.js";

/**
 * Every model of plans/live-tool-call-findings.md, with the id it was sent
 * under, the preset it must resolve to and what that run observed.
 */
const LIVE: [
  id: string,
  preset: string,
  native: NativeOnConverse,
  tools: ToolsOnBedrock,
  text: TextDialect,
][] = [
  [
    "meta.llama3-3-70b-instruct-v1:0",
    "llama-3.3",
    "none",
    "with-recovery",
    "llama-json",
  ],
  [
    "us.meta.llama4-maverick-17b-instruct-v1:0",
    "llama-4",
    "most",
    "yes",
    "pythonic",
  ],
  ["deepseek.v3.2", "deepseek-v3.2", "all", "yes", "dsml"],
  [
    "moonshot.kimi-k2-thinking",
    "kimi-k2-thinking",
    "all",
    "yes",
    "kimi-tokens",
  ],
  ["qwen.qwen3-coder-30b-a3b-v1:0", "qwen3-coder", "most", "yes", "qwen-xml"],
  ["google.gemma-3-27b-it", "gemma-3", "none", "no", "none"],
  ["amazon.nova-pro-v1:0", "nova", "all", "yes", "pythonic"],
  ["amazon.nova-2-lite-v1:0", "nova", "all", "yes", "pythonic"],
  ["zai.glm-4.7", "glm-4.7", "all", "yes", "glm-xml"],
  ["zai.glm-5", "glm-5", "all", "yes", "glm-xml"],
  ["mistral.devstral-2-123b", "mistral", "all", "yes", "mistral"],
  ["mistral.mistral-large-3-675b-instruct", "mistral", "all", "yes", "mistral"],
  ["moonshotai.kimi-k2.5", "kimi-k2", "all", "yes", "kimi-tokens"],
  ["moonshotai.kimi-k3", "kimi-k3", "all", "yes", "kimi-xtml"],
  ["moonshotai.kimi-k3.1", "kimi-k3", "all", "yes", "kimi-xtml"],
  ["minimax.minimax-m2", "minimax-m2", "all", "yes", "minimax-xml"],
  ["minimax.minimax-m2.5", "minimax-m2", "all", "yes", "minimax-xml"],
  ["nvidia.nemotron-super-3-120b", "nemotron-3", "all", "yes", "qwen-xml"],
  ["nvidia.nemotron-nano-3-30b", "nemotron-3", "all", "yes", "qwen-xml"],
  ["qwen.qwen3-32b-v1:0", "qwen3", "all", "yes", "hermes-json"],
  ["qwen.qwen3-coder-next", "qwen3-coder", "most", "yes", "qwen-xml"],
  ["openai.gpt-oss-20b-1:0", "gpt-oss", "all", "yes", "harmony"],
  ["openai.gpt-oss-120b-1:0", "gpt-oss", "all", "yes", "harmony"],
  ["qwen3.8-flash", "qwen3.5-3.8", "all", "yes", "qwen-xml"],
  ["qwen3.6:35b", "qwen3.5-3.8", "all", "yes", "qwen-xml"],
  ["deepseek.r1-v1:0", "deepseek-r1", "none", "no", "deepseek-tokens"],
];

describe("tool dialect presets", () => {
  it.each(LIVE)(
    "%s maps to the preset the run observed",
    (id, preset, native, tools, text) => {
      const p = resolveToolDialectPreset(id);
      expect(p?.id).toBe(preset);
      expect(p?.nativeOnConverse).toBe(native);
      expect(p?.bedrockTools).toBe(tools);
      expect(p?.textDialect).toBe(text);
    },
  );

  it("resolves Ollama, Hugging Face and OpenRouter spellings", () => {
    const id = (name: string) => resolveToolDialectPreset(name)?.id;
    expect(id("qwen3-coder:30b")).toBe("qwen3-coder");
    expect(id("Qwen/Qwen3-Coder-30B-A3B-Instruct")).toBe("qwen3-coder");
    expect(id("nvidia/nemotron-3-super-120b-a12b")).toBe("nemotron-3");
    expect(id("moonshotai/kimi-k2-thinking")).toBe("kimi-k2-thinking");
    expect(id("z-ai/glm-4.6")).toBe("glm-4.5-4.6");
    expect(id("minimax/minimax-m2")).toBe("minimax-m2");
    expect(id("deepseek/deepseek-chat-v3.1")).toBe("deepseek-v3");
    expect(id("openai/gpt-oss-120b")).toBe("gpt-oss");
    expect(id("meta-llama/llama-3.1-70b-instruct")).toBe("llama-3.1-3.2");
  });

  // Ids as catalogs spell them. Qwen3-Next is the Hermes JSON template (read
  // 2026-11-10); Coder and Coder-Next are the qwen-xml ones.
  const QWEN: [string, string][] = [
    // Bedrock
    ["qwen.qwen3-coder-30b-a3b-v1:0", "qwen3-coder"],
    ["qwen.qwen3-coder-480b-a35b-v1:0", "qwen3-coder"],
    ["qwen.qwen3-coder-next", "qwen3-coder"],
    ["qwen.qwen3-next-80b-a3b", "qwen3"],
    ["qwen.qwen3-32b-v1:0", "qwen3"],
    ["qwen.qwen3-235b-a22b-2507-v1:0", "qwen3"],
    ["qwen.qwen3-vl-235b-a22b", "qwen3"],
    // Ollama
    ["qwen3-coder:30b", "qwen3-coder"],
    ["qwen3-coder-next:latest", "qwen3-coder"],
    ["qwen3-next:80b", "qwen3"],
    ["qwen3:8b", "qwen3"],
    ["qwen2.5-coder:7b", "qwen3"],
    // Hugging Face
    ["Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "qwen3-coder"],
    ["Qwen/Qwen3-Coder-Next", "qwen3-coder"],
    ["Qwen/Qwen3-Next-80B-A3B-Instruct", "qwen3"],
    ["Qwen/Qwen3-Next-80B-A3B-Thinking", "qwen3"],
    ["Qwen/Qwen3-30B-A3B", "qwen3"],
    // OpenRouter
    ["qwen/qwen3-coder", "qwen3-coder"],
    ["qwen/qwen3-coder:free", "qwen3-coder"],
    ["qwen/qwen3-coder-flash", "qwen3-coder"],
    ["qwen/qwen3-next-80b-a3b-instruct", "qwen3"],
    ["qwen/qwen3-235b-a22b-2507", "qwen3"],
  ];
  it.each(QWEN)("%s resolves to %s", (id, preset) => {
    expect(resolveToolDialectPreset(id)?.id).toBe(preset);
  });

  // Qwen3.5, 3.6 and 3.8 templates write the Qwen3-Coder XML (read 2026-11-10).
  const QWEN35: [string, string][] = [
    // Bedrock-style, Ollama tags, Hugging Face repos, OpenRouter slugs
    ["qwen3.8-flash", "qwen3.5-3.8"],
    ["qwen3.6:35b", "qwen3.5-3.8"],
    ["qwen3.5:27b", "qwen3.5-3.8"],
    ["qwen3.5:9b-q4_K_M", "qwen3.5-3.8"],
    ["Qwen/Qwen3.5-27B", "qwen3.5-3.8"],
    ["Qwen/Qwen3.6-35B-A3B", "qwen3.5-3.8"],
    ["Qwen/Qwen3.8-27B", "qwen3.5-3.8"],
    ["qwen/qwen3.5-397b-a17b", "qwen3.5-3.8"],
    ["qwen/qwen3.6-plus", "qwen3.5-3.8"],
    ["qwen/qwen3.8-flash", "qwen3.5-3.8"],
    // Not them: Qwen3 is Hermes JSON, and Qwen3-8B must not read as 3.8
    ["qwen3:8b", "qwen3"],
    ["qwen3:30b-a3b", "qwen3"],
    ["qwen.qwen3-235b-a22b-2507-v1:0", "qwen3"],
    ["qwen3-vl:8b", "qwen3"],
    ["Qwen/Qwen3-Next-80B-A3B-Instruct", "qwen3"],
  ];
  it.each(QWEN35)("%s resolves to %s", (id, preset) => {
    expect(resolveToolDialectPreset(id)?.id).toBe(preset);
  });

  it("gives Qwen3.5 and later the Coder XML and the qwen3_coder parser, not Hermes JSON", () => {
    for (const id of ["qwen3.6:35b", "Qwen/Qwen3.5-27B", "qwen3.8-flash"]) {
      const p = resolveToolDialectPreset(id);
      expect(p?.textDialect, id).toBe("qwen-xml");
      expect(p?.recoverWith, id).toBe("qwen-xml");
      expect(p?.serverParser, id).toMatchObject({
        vllm: "qwen3_coder",
        basis: "model-card",
      });
    }
  });

  // Rows added from the 2026-11-10 template reads. A form no TextDialect value
  // names is `none`, with the form written in promptStyle.evidence.
  const FAMILIES: [string, string, TextDialect][] = [
    // Kimi K3 (XTML) and MiniMax M3 (namespaced invoke) are not K2 and M2
    ["moonshotai.kimi-k3", "kimi-k3", "kimi-xtml"],
    ["moonshotai/Kimi-K3", "kimi-k3", "kimi-xtml"],
    ["moonshotai/kimi-k3.1", "kimi-k3", "kimi-xtml"],
    ["moonshotai/kimi-k2.5", "kimi-k2", "kimi-tokens"],
    ["MiniMaxAI/MiniMax-M3", "minimax-m3", "minimax-ns-xml"],
    ["minimax/minimax-m3", "minimax-m3", "minimax-ns-xml"],
    ["minimax.minimax-m2.5", "minimax-m2", "minimax-xml"],
    ["minimax/minimax-m2.7", "minimax-m2", "minimax-xml"],
    // GLM-5 is sourced
    ["zai-org/GLM-5", "glm-5", "glm-xml"],
    ["z-ai/glm-5.1", "glm-5", "glm-xml"],
    // DeepSeek V4 writes the tool_calls block, V3.2 function_calls
    ["deepseek-ai/DeepSeek-V4-Flash", "deepseek-v4", "dsml"],
    ["deepseek/deepseek-v4-pro", "deepseek-v4", "dsml"],
    ["deepseek.v3.2", "deepseek-v3.2", "dsml"],
    ["deepseek-ai/DeepSeek-V3.2", "deepseek-v3.2", "dsml"],
    // IBM Granite 4.2 is the Coder XML, 4.0 is Hermes JSON
    ["ibm-granite/granite-4.2-8b", "granite-4.2", "qwen-xml"],
    ["ibm-granite/granite-4.0-h-small", "granite-4", "hermes-json"],
    ["granite4:tiny-h", "granite-4", "hermes-json"],
    ["granite4.2:8b", "granite-4.2", "qwen-xml"],
    // Xiaomi MiMo
    ["XiaomiMiMo/MiMo-V2.5", "mimo-v2", "qwen-xml"],
    ["xiaomi/mimo-v2.6-flash", "mimo-v2", "qwen-xml"],
    ["XiaomiMiMo/MiMo-7B-RL", "mimo", "hermes-json"],
    // StepFun
    ["stepfun-ai/Step-3.5-Flash", "step-3.5-3.7", "qwen-xml"],
    ["stepfun/step-3.7-flash", "step-3.5-3.7", "qwen-xml"],
    // Liquid LFM
    ["LiquidAI/LFM2.5-24B-A2B", "liquid-lfm", "lfm-tokens"],
    ["liquid/lfm-2.5-2.6b:free", "liquid-lfm", "lfm-tokens"],
    ["lfm2:8b", "liquid-lfm", "lfm-tokens"],
    // Tencent Hy3
    ["tencent/Hy3", "hy3", "hy3-tags"],
    ["tencent/hy3-preview", "hy3", "hy3-tags"],
    // Group C families
    ["ibm-granite/granite-3.3-8b-instruct", "granite-3", "granite-tokens"],
    ["granite3.3:8b", "granite-3", "granite-tokens"],
    ["upstage/Solar-Open-100B", "solar-open", "solar-tokens"],
    ["meituan-longcat/LongCat-Flash-Chat", "longcat-flash", "longcat-json"],
    ["allenai/Olmo-3-7B-Instruct", "olmo-3", "olmo-function-calls"],
    ["ByteDance-Seed/Seed-OSS-36B-Instruct", "seed-oss", "seed-xml"],
    [
      "CohereLabs/command-a-reasoning-08-2025",
      "cohere-command",
      "cohere-action",
    ],
    ["cohere.command-r7b-12-2024", "cohere-command", "cohere-action"],
  ];
  it.each(FAMILIES)(
    "%s resolves to %s with text dialect %s",
    (id, row, text) => {
      const p = resolveToolDialectPreset(id);
      expect(p?.id).toBe(row);
      expect(p?.textDialect).toBe(text);
    },
  );

  it("does not recover a form no parser exists for, and says so", () => {
    for (const id of ["gemma-4"]) {
      const p = TOOL_DIALECT_PRESETS.find((r) => r.id === id);
      expect(p?.recoverWith, id).toBeUndefined();
    }
  });

  it("recovers R1 and V3-0324 with the fenced-layout parser, and V3.1 with its own", () => {
    for (const [id, row, dialect] of [
      ["deepseek.r1-v1:0", "deepseek-r1", "deepseek-r1"],
      ["deepseek-ai/DeepSeek-R1-0528", "deepseek-r1", "deepseek-r1"],
      ["deepseek-ai/DeepSeek-V3-0324", "deepseek-v3-0324", "deepseek-r1"],
      ["deepseek/deepseek-chat-v3-0324", "deepseek-v3-0324", "deepseek-r1"],
      ["deepseek-ai/DeepSeek-V3.1", "deepseek-v3", "deepseek-v31"],
    ] as const) {
      const p = resolveToolDialectPreset(id);
      expect(p?.id, id).toBe(row);
      expect(p?.recoverWith, id).toBe(dialect);
    }
  });

  it("records GLM-5 as sourced, with the glm47 parser from its card", () => {
    const p = resolveToolDialectPreset("zai.glm-5");
    expect(p?.serverParser).toMatchObject({
      vllm: "glm47",
      basis: "model-card",
    });
    expect(p?.promptStyle.evidence).not.toMatch(/assumed/i);
    expect(p?.unverified?.join(" ") ?? "").not.toMatch(/assumed/i);
  });

  it("leaves Mistral and DeepSeek V3.2 undecided upstream and says why", () => {
    const mistral = resolveToolDialectPreset("mistral.devstral-2-123b");
    expect(mistral?.unverified?.join(" ")).toMatch(/mistral-common/);
    const ds = resolveToolDialectPreset("deepseek.v3.2");
    expect(ds?.unverified?.join(" ")).toMatch(/no Jinja template/);
  });

  it("recovers gpt-oss, Mistral and DeepSeek with the parsers built for their forms", () => {
    for (const [id, dialect] of [
      ["openai.gpt-oss-120b-1:0", "harmony"],
      ["mistral.devstral-2-123b", "mistral"],
      ["deepseek.v3.2", "dsml"],
      ["deepseek-v4-flash", "dsml"],
      ["deepseek-v3.1", "deepseek-v31"],
    ]) {
      expect(resolveToolDialectPreset(id)?.recoverWith, id).toBe(dialect);
    }
  });

  it("gives Qwen3-Next the Hermes JSON dialect, not Qwen3-Coder's", () => {
    const p = resolveToolDialectPreset("qwen.qwen3-next-80b-a3b");
    expect(p?.textDialect).toBe("hermes-json");
    expect(p?.recoverWith).toBe("hermes-json");
  });

  it("marks only rows the live run measured as proved", () => {
    for (const p of TOOL_DIALECT_PRESETS) {
      expect(p.toolsEvidence === "proved", p.id).toBe(!!p.measured);
      if (p.bedrockTools === "unmeasured") {
        expect(p.toolsEvidence, p.id).toBe("unmeasured");
      } else {
        expect(p.toolsEvidence, p.id).not.toBe("unmeasured");
      }
    }
    const inferred = TOOL_DIALECT_PRESETS.filter(
      (p) => p.toolsEvidence === "inferred",
    ).map((p) => p.id);
    expect(inferred.sort()).toEqual([
      "claude",
      "deepseek-v3",
      "glm-4.5-4.6",
      "llama-3.1-3.2",
      "minimax-m3",
    ]);
  });

  it("only gives thinkingInText to rows that name thinkingTags", () => {
    for (const p of TOOL_DIALECT_PRESETS) {
      if (p.thinkingInText) expect(p.thinkingTags, p.id).toBeDefined();
    }
    expect(
      TOOL_DIALECT_PRESETS.filter((p) => p.thinkingInText).map((p) => p.id),
    ).toEqual(["kimi-k2-thinking", "nova"]);
  });

  it("marks Nemotron-H as a prompted path and Nano v2 as toolcall-json", () => {
    const h = resolveToolDialectPreset("nvidia/Nemotron-H-47B-Reasoning-128K");
    expect(h?.textDialect).toBe("none");
    expect(h?.promptStyle.evidence).toMatch(/prompted path, not parser/);
    expect(
      resolveToolDialectPreset("nvidia/Nemotron-H-4B-Instruct-128K")?.id,
    ).toBe("nemotron-h");
    const v2 = resolveToolDialectPreset("nvidia/NVIDIA-Nemotron-Nano-12B-v2");
    expect(v2?.textDialect).toBe("toolcall-json");
  });

  it("tells the Nemotron generations apart", () => {
    const id = (name: string) => resolveToolDialectPreset(name)?.id;
    expect(id("nvidia/Llama-3_3-Nemotron-Super-49B-v1_5")).toBe(
      "llama-nemotron",
    );
    expect(id("nvidia/NVIDIA-Nemotron-Nano-9B-v2")).toBe("nemotron-nano-v2");
    expect(id("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16")).toBe("nemotron-3");
    expect(id("nvidia/Nemotron-H-8B-Reasoning-128K")).toBe("nemotron-h");
  });

  it("does not match unrelated names", () => {
    expect(resolveToolDialectPreset("innovator-7b")).toBeUndefined();
    expect(resolveToolDialectPreset("mimosa-7b")).toBeUndefined();
    expect(resolveToolDialectPreset("stepper-3b")).toBeUndefined();
    expect(resolveToolDialectPreset("granite-2b")).toBeUndefined();
    expect(
      resolveToolDialectPreset("cohere.command-r-plus-v1:0"),
    ).toBeUndefined();
    expect(resolveToolDialectPreset("command-a")?.id).toBe("cohere-command");
    expect(resolveToolDialectPreset("")).toBeUndefined();
    expect(resolveToolDialectPreset(undefined)).toBeUndefined();
  });

  it("keeps ids unique and every row sourced and dated", () => {
    const ids = TOOL_DIALECT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of TOOL_DIALECT_PRESETS) {
      expect(p.source.length, p.id).toBeGreaterThan(0);
      expect(p.readOn, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.match.length, p.id).toBeGreaterThan(0);
      if (p.serverParser?.basis === "registered-only") {
        expect(p.serverParser.note, p.id).toBeTruthy();
      }
    }
  });

  it("gives every row a prompt style with its evidence", () => {
    for (const p of TOOL_DIALECT_PRESETS) {
      const { style, evidence } = p.promptStyle;
      expect(evidence.length, p.id).toBeGreaterThan(10);
      // A family's own form must be the form its template writes.
      if (style !== "native" && style !== "codeblock") {
        expect(style, p.id).toBe(p.textDialect);
      }
      // Codeblock rows are a fallback nobody has measured: they must say so.
      if (style === "codeblock") expect(evidence, p.id).toMatch(/untested/i);
    }
    expect(
      resolveToolDialectPreset("google.gemma-3-27b-it")?.promptStyle.style,
    ).toBe("codeblock");
    expect(
      resolveToolDialectPreset("meta.llama3-3-70b-instruct-v1:0")?.promptStyle
        .style,
    ).toBe("llama-json");
  });

  it("only offers a recovery dialect that code exists for", () => {
    const built = [
      "qwen-xml",
      "pythonic",
      "llama-json",
      "hermes-json",
      "glm-xml",
      "harmony",
      "mistral",
      "dsml",
      "deepseek-v31",
      "deepseek-r1",
      "toolcall-json",
      "kimi-tokens",
      "kimi-xtml",
      "minimax-xml",
      "minimax-ns-xml",
      "granite-tokens",
      "lfm-tokens",
      "hy3-tags",
      "solar-tokens",
      "longcat-json",
      "olmo-function-calls",
      "seed-xml",
      "cohere-action",
    ];
    for (const p of TOOL_DIALECT_PRESETS) {
      if (p.recoverWith) expect(built, p.id).toContain(p.recoverWith);
    }
    for (const id of ["nemotron-h", "nemotron-nano-v2", "llama-nemotron"]) {
      expect(
        TOOL_DIALECT_PRESETS.find((p) => p.id === id)?.recoverWith,
        id,
      ).toBeUndefined();
    }
  });

  it("records Nemotron 3 as the Qwen3-Coder markup with the qwen3_coder parser", () => {
    const p = resolveToolDialectPreset("nvidia.nemotron-super-3-120b");
    expect(p?.textDialect).toBe("qwen-xml");
    expect(p?.recoverWith).toBe("qwen-xml");
    expect(p?.serverParser).toMatchObject({
      vllm: "qwen3_coder",
      basis: "model-card",
    });
  });
});

describe("toolDialectHint", () => {
  it("reads the preset for auto and for no setting", () => {
    expect(toolDialectHint("zai.glm-4.7").dialect).toBe("glm-xml");
    expect(toolDialectHint("zai.glm-4.7", "auto")).toMatchObject({
      dialect: "glm-xml",
      from: "preset",
    });
    expect(toolDialectHint("unknown-model")).toEqual({
      dialect: "auto",
      from: "none",
    });
  });

  it("lets an explicit setting win", () => {
    expect(toolDialectHint("zai.glm-4.7", "off")).toMatchObject({
      dialect: "off",
      from: "setting",
    });
  });

  it("describes a preset in one line", () => {
    const p = resolveToolDialectPreset("qwen3-coder");
    expect(p && describePreset(p)).toBe(
      "Known format for this model family: qwen-xml (tools written as text)",
    );
    const glm = resolveToolDialectPreset("zai.glm-4.7");
    expect(glm && describePreset(glm)).toBe(
      "Known format for this model family: glm-xml (tools written as text)",
    );
    const none = resolveToolDialectPreset("gemma-3-27b");
    expect(none && describePreset(none)).toBe(
      "Known format for this model family: none (native tools only)",
    );
  });
});

describe("Bedrock tool support from the presets", () => {
  it.each([
    "moonshotai.kimi-k3",
    "moonshot.kimi-k2-thinking",
    "moonshotai.kimi-k2.5",
    "zai.glm-4.7",
    "zai.glm-5",
    "minimax.minimax-m2.5",
    "nvidia.nemotron-super-3-120b",
    "mistral.devstral-2-123b",
  ])("turns tools on for %s", (id) => {
    expect(bedrockSupportsTools(id)).toBe(true);
  });

  it("keeps the earlier answers", () => {
    expect(
      bedrockSupportsTools("anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).toBe(true);
    expect(bedrockSupportsTools("anthropic.claude-instant-v1")).toBe(false);
    expect(bedrockSupportsTools("deepseek.r1-v1:0")).toBe(false);
    expect(bedrockSupportsTools("us.deepseek.r1-v1:0")).toBe(false);
    expect(bedrockSupportsTools("google.gemma-3-27b-it")).toBe(false);
    expect(bedrockSupportsTools("meta.llama4-maverick-17b-instruct-v1:0")).toBe(
      true,
    );
    expect(bedrockSupportsTools("amazon.nova-pro-v1:0")).toBe(true);
    expect(bedrockSupportsTools("something.unknown-model")).toBe(false);
  });

  it("offers Llama 3.x tools only with llama-json recovery", () => {
    const id = "meta.llama3-3-70b-instruct-v1:0";
    const none = {};
    expect(bedrockSupportsTools(id, undefined, undefined, none)).toBe(false);
    expect(bedrockSupportsTools(id, "auto", undefined, none)).toBe(false);
    expect(bedrockSupportsTools(id, "off", undefined, none)).toBe(false);
    expect(bedrockSupportsTools(id, "llama-json", undefined, none)).toBe(true);
    expect(presetBedrockTools(id, "qwen-xml", undefined, none)).toBe(false);
  });

  describe("tool enabling follows the recovery switch (config field and environment variable)", () => {
    const llama33 = "meta.llama3-3-70b-instruct-v1:0";
    const llama31 = "us.meta.llama3-1-70b-instruct-v1:0";
    const ENV = "CONTINUE_RECOVER_TEXT_TOOL_CALLS";
    const FIELD = "x_continue_recover_text_tool_calls";

    it("turns tools on when only the environment variable asks for llama-json", () => {
      for (const id of [llama33, llama31]) {
        expect(
          bedrockSupportsTools(id, undefined, undefined, {
            [ENV]: "llama-json",
          }),
        ).toBe(true);
        expect(
          bedrockSupportsTools(id, undefined, undefined, {
            [ENV]: "force:llama-json",
          }),
        ).toBe(true);
        expect(
          bedrockSupportsTools(id, undefined, undefined, {
            [ENV]: "qwen-xml,llama-json",
          }),
        ).toBe(true);
      }
    });

    it("lets the environment variable win over the config field", () => {
      // The variable names another dialect: llama-json is not asked for.
      expect(
        bedrockSupportsTools(llama33, "llama-json", undefined, {
          [ENV]: "qwen-xml",
        }),
      ).toBe(false);
      // The config turns recovery off, the variable turns it on.
      expect(
        bedrockSupportsTools(llama33, "off", undefined, {
          [ENV]: "llama-json",
        }),
      ).toBe(true);
      // An empty variable is not set.
      expect(
        bedrockSupportsTools(llama33, "llama-json", undefined, { [ENV]: "" }),
      ).toBe(true);
    });

    it("reads the extra body field recovery reads", () => {
      expect(
        bedrockSupportsTools(llama33, undefined, { [FIELD]: "llama-json" }, {}),
      ).toBe(true);
      expect(
        bedrockSupportsTools(llama33, undefined, { [FIELD]: "pythonic" }, {}),
      ).toBe(false);
    });

    it("changes nothing for families that are not with-recovery", () => {
      const env = { [ENV]: "llama-json" };
      expect(
        bedrockSupportsTools(
          "google.gemma-3-27b-it",
          undefined,
          undefined,
          env,
        ),
      ).toBe(false);
      expect(
        bedrockSupportsTools("amazon.nova-pro-v1:0", "off", undefined, env),
      ).toBe(true);
      expect(
        bedrockSupportsTools("deepseek.r1-v1:0", undefined, undefined, env),
      ).toBe(false);
    });

    it("asks the same question the recovery stage answers", () => {
      const cases: [
        ToolDialectSetting | undefined,
        Record<string, unknown> | undefined,
        Record<string, string | undefined>,
      ][] = [
        [undefined, undefined, {}],
        ["llama-json", undefined, {}],
        ["native", undefined, {}],
        ["off", { a: 1 }, { [ENV]: "llama-json" }],
        ["llama-json", undefined, { [ENV]: "qwen-xml" }],
        [undefined, { [FIELD]: "force:llama-json" }, {}],
        ["qwen-xml", { [FIELD]: "force:llama-json" }, {}],
        [undefined, undefined, { [ENV]: "pythonic,llama-json" }],
        ["llama-json", undefined, { [ENV]: "" }],
      ];
      for (const [toolDialect, extra, env] of cases) {
        const body = withToolDialect(extra, toolDialect, env);
        // The stage is wrapped by the counter, so ask what it does with a
        // llama-json call rather than for its class.
        const { calls } = recoverFromText(
          llama33,
          '{"type": "function", "name": "t", "parameters": {}}',
          [{ name: "t", parameters: { type: "object", properties: {} } }],
          body,
          env,
        );
        expect(calls.length === 1).toBe(
          bedrockSupportsTools(llama33, toolDialect, extra, env),
        );
        expect(effectiveRecoverySetting(toolDialect, extra, env)).toBe(
          recoverySetting(body, env),
        );
      }
    });
  });
});

describe("Gemma presets never carry llama-json (RQ7)", () => {
  it.each([
    "google.gemma-3-27b-it",
    "gemma3:27b",
    "gemma-3n-e4b",
    "google/gemma-4-31B-it",
  ])("%s resolves to no llama-json dialect or recovery", (id) => {
    const p = resolveToolDialectPreset(id);
    expect(p?.textDialect).not.toBe("llama-json");
    expect(p?.recoverWith).not.toBe("llama-json");
    expect(p?.promptStyle.style).not.toBe("llama-json");
    expect(toolDialectHint(id).dialect).not.toBe("llama-json");
    expect(presetBedrockTools(id, "llama-json")).not.toBe(true);
  });

  it("no preset that matches a Gemma id is a Llama row", () => {
    for (const p of TOOL_DIALECT_PRESETS) {
      if (p.match.some((re) => re.test("gemma-3-27b-it"))) {
        expect(p.id).toMatch(/^gemma/);
      }
    }
  });
});
