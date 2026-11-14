import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import * as coreRules from "./bedrockFamilyRules";
import * as core from "./bedrockHelpers";

// Loaded at run time from a path held in a variable, not with a static import,
// for the reason given in bedrockOneHourCache.vitest.ts.
const ADAPTER_HELPERS = pathToFileURL(
  resolve(
    __dirname,
    "../../../packages/openai-adapters/src/apis/bedrockHelpers.ts",
  ),
).href;
const ADAPTER_RULES = pathToFileURL(
  resolve(
    __dirname,
    "../../../packages/openai-adapters/src/apis/bedrockFamilyRules.ts",
  ),
).href;
let adapter: typeof core;
let adapterRules: typeof coreRules;

beforeAll(async () => {
  adapter = await import(/* @vite-ignore */ ADAPTER_HELPERS);
  adapterRules = await import(/* @vite-ignore */ ADAPTER_RULES);
});

/**
 * The per-family request rules exist twice: here in core, which the chat
 * window imports, and in the Bedrock adapter, which the CLI uses and which
 * core cannot be imported into. These fail if the two disagree on any case
 * below, so a family added to one has to be added to the other.
 */
const MODELS = [
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-sonnet-4-6",
  "global.anthropic.claude-opus-5-5",
  "us.anthropic.claude-opus-4-8",
  "anthropic.claude-fable-5-2",
  "us.amazon.nova-2-lite-v1:0",
  "us.amazon.nova-2-pro-v1:0",
  "us.amazon.nova-pro-v1:0",
  "amazon.nova-lite-v1:0",
  "amazon.nova-premier-v1:0",
  "qwen.qwen3-32b-v1:0",
  "us.qwen.qwen3-coder-30b-a3b-v1:0",
  "deepseek.v3.2",
  "us.deepseek.r1-v1:0",
  "us.meta.llama3-3-70b-instruct-v1:0",
  "mistral.mistral-large-3-675b-instruct",
  "openai.gpt-oss-120b-1:0",
  "us.moonshotai.kimi-k3",
  "global.moonshotai.kimi-k3.1",
  "moonshotai.kimi-k2.5",
  "moonshot.kimi-k2-thinking",
  "zai.glm-5",
  "minimax.minimax-m2.5",
  "nvidia.nemotron-super-3-120b",
  "us.xai.grok-4.6",
  "",
];
const REASONING = [undefined, false, true] as const;
const BUDGETS = [1024, 4096, 16384];

describe("bedrockReasoningFields exists in core and in the adapter", () => {
  it.each(MODELS)("agrees on %j", (id) => {
    for (const reasoning of REASONING) {
      for (const budget of BUDGETS) {
        expect(adapter.bedrockReasoningFields(id, reasoning, budget)).toEqual(
          core.bedrockReasoningFields(id, reasoning, budget),
        );
      }
    }
  });

  it("covers Claude, Nova 2, the reasoning_effort models and silence, so it cannot pass emptily", () => {
    const shapes = new Set(
      MODELS.map((id) =>
        Object.keys(
          core.bedrockReasoningFields(id, true, 16384)
            .additionalModelRequestFields,
        ).join(","),
      ),
    );
    expect([...shapes].sort()).toEqual([
      "",
      "reasoningConfig",
      "reasoning_effort",
      "thinking",
      "thinking,output_config",
    ]);
  });

  it("sends Qwen3 and DeepSeek V3.2 none only when reasoning is explicitly off", () => {
    expect(
      core.bedrockReasoningFields("qwen.qwen3-32b-v1:0", false, 1024)
        .additionalModelRequestFields,
    ).toEqual({ reasoning_effort: "none" });
    expect(
      core.bedrockReasoningFields("deepseek.v3.2", undefined, 1024)
        .additionalModelRequestFields,
    ).toEqual({});
  });

  it("turns Nova 2 reasoning on at low when the config says nothing, and off only on an explicit false", () => {
    const nova = "us.amazon.nova-2-lite-v1:0";
    for (const helpers of [core, adapter]) {
      expect(
        helpers.bedrockReasoningFields(nova, undefined, 16384)
          .additionalModelRequestFields,
      ).toEqual({
        reasoningConfig: { type: "enabled", maxReasoningEffort: "low" },
      });
      expect(
        helpers.bedrockReasoningFields(nova, undefined, 16384).omitMaxTokens,
      ).toBe(false);
      expect(
        helpers.bedrockReasoningFields(nova, false, 1024)
          .additionalModelRequestFields,
      ).toEqual({});
      expect(
        helpers.bedrockReasoningFields(nova, true, 4096)
          .additionalModelRequestFields,
      ).toEqual({
        reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" },
      });
    }
    // The other families keep their silence when nothing is said.
    for (const id of [
      "anthropic.claude-haiku-4-5-20251001-v1:0",
      "qwen.qwen3-32b-v1:0",
      "us.amazon.nova-pro-v1:0",
    ]) {
      expect(
        core.bedrockReasoningFields(id, undefined, 1024)
          .additionalModelRequestFields,
      ).toEqual({});
    }
  });

  it("omits maxTokens only for Nova 2 at high effort", () => {
    const nova = "us.amazon.nova-2-lite-v1:0";
    expect(core.bedrockReasoningFields(nova, true, 16384).omitMaxTokens).toBe(
      true,
    );
    expect(core.bedrockReasoningFields(nova, true, 4096).omitMaxTokens).toBe(
      false,
    );
    expect(
      core.bedrockReasoningFields("anthropic.claude-haiku-4-5", true, 16384)
        .omitMaxTokens,
    ).toBe(false);
  });

  it("asks Claude for summarized thinking where it would arrive empty", () => {
    for (const helpers of [core, adapter]) {
      // 4.7 and later hide thinking by default: the request asks to see it
      expect(
        helpers.bedrockReasoningFields(
          "us.anthropic.claude-opus-4-8",
          true,
          4096,
        ).additionalModelRequestFields,
      ).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "medium" },
      });
      // 4.6 shows a summary by default; its request is unchanged
      expect(
        helpers.bedrockReasoningFields(
          "us.anthropic.claude-sonnet-4-6",
          true,
          4096,
        ).additionalModelRequestFields,
      ).toEqual({
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
      });
      // Opus 5.5 thinks with reasoning off, so its thinking is shown too,
      // without an effort
      for (const reasoning of [undefined, false]) {
        expect(
          helpers.bedrockReasoningFields(
            "global.anthropic.claude-opus-5-5",
            reasoning,
            4096,
          ).additionalModelRequestFields,
        ).toEqual({ thinking: { type: "adaptive", display: "summarized" } });
      }
      // Opus 4.8 does not think with reasoning off: nothing is sent
      expect(
        helpers.bedrockReasoningFields(
          "us.anthropic.claude-opus-4-8",
          false,
          4096,
        ).additionalModelRequestFields,
      ).toEqual({});
    }
  });

  it("sends DeepSeek R1 and Nova Pro nothing, which is all they accept", () => {
    for (const id of ["us.deepseek.r1-v1:0", "us.amazon.nova-pro-v1:0"]) {
      expect(
        core.bedrockReasoningFields(id, true, 16384)
          .additionalModelRequestFields,
      ).toEqual({});
    }
  });
});

describe("bedrockSamplingParams exists in core and in the adapter", () => {
  const CASES: Array<[number | undefined, number | undefined, boolean]> = [
    [0.5, 0.9, false],
    [0.5, undefined, false],
    [undefined, 0.9, false],
    [0.5, 0.9, true],
    [undefined, undefined, true],
  ];
  it.each(MODELS)("agrees on %j", (id) => {
    for (const [t, p, r] of CASES) {
      expect(adapter.bedrockSamplingParams(id, t, p, r)).toEqual(
        core.bedrockSamplingParams(id, t, p, r),
      );
    }
  });

  it("keeps Claude to one of the two, and neither with thinking", () => {
    const claude = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    expect(core.bedrockSamplingParams(claude, 0.5, 0.9, false)).toEqual({
      temperature: 0.5,
    });
    expect(core.bedrockSamplingParams(claude, undefined, 0.9, false)).toEqual({
      temperature: undefined,
      topP: 0.9,
    });
    expect(core.bedrockSamplingParams(claude, 0.5, 0.9, true)).toEqual({});
    expect(
      core.bedrockSamplingParams("us.amazon.nova-2-lite-v1:0", 0.5, 0.9, true),
    ).toEqual({ temperature: 0.5, topP: 0.9 });
  });
});

describe("the other per-family rules agree between the copies", () => {
  it.each(MODELS)("cache point placement and marker leak on %j", (id) => {
    expect(adapter.bedrockCachePointAfterTextOnly(id)).toBe(
      core.bedrockCachePointAfterTextOnly(id),
    );
    expect(adapter.leaksDsmlMarker(id)).toBe(core.leaksDsmlMarker(id));
  });

  it("lets Claude, and only Claude, take a cache point after a toolResult", () => {
    expect(
      core.bedrockCachePointAfterTextOnly("anthropic.claude-sonnet-4-6"),
    ).toBe(false);
    expect(
      core.bedrockCachePointAfterTextOnly("us.amazon.nova-2-lite-v1:0"),
    ).toBe(true);
  });

  it.each([
    "max_tokens",
    "tool_use",
    "end_turn",
    "stop_sequence",
    "content_filtered",
    "guardrail_intervened",
    "something_new",
  ])("maps stop reason %s the same way", (reason) => {
    expect(adapter.bedrockFinishReason(reason)).toBe(
      core.bedrockFinishReason(reason),
    );
  });

  it("maps truncation to length and a tool call to tool_calls", () => {
    expect(core.bedrockFinishReason("max_tokens")).toBe("length");
    expect(core.bedrockFinishReason("tool_use")).toBe("tool_calls");
    expect(core.bedrockFinishReason("end_turn")).toBe("stop");
    expect(core.bedrockFinishReason("stop_sequence")).toBe("stop");
    expect(core.bedrockFinishReason("content_filtered")).toBe("content_filter");
  });

  it("recognises the invalid-identifier refusal and the bare ID to retry with", () => {
    const refusal = new Error(
      "ValidationException: The provided model identifier is invalid.",
    );
    expect(core.isInvalidModelIdentifierError(refusal)).toBe(true);
    expect(adapter.isInvalidModelIdentifierError(refusal)).toBe(true);
    expect(core.isInvalidModelIdentifierError(new Error("throttled"))).toBe(
      false,
    );
    for (const copy of [core, adapter]) {
      expect(
        copy.crossRegionFallbackModelId(
          "qwen.qwen3-32b-v1:0",
          "auto",
          "us-east-1",
        ),
      ).toBe("qwen.qwen3-32b-v1:0");
      // An explicit prefix, an ID that already has one, or no setting: nothing to retry
      expect(
        copy.crossRegionFallbackModelId(
          "qwen.qwen3-32b-v1:0",
          "us",
          "us-east-1",
        ),
      ).toBeUndefined();
      expect(
        copy.crossRegionFallbackModelId(
          "us.qwen.qwen3-32b-v1:0",
          "auto",
          "us-east-1",
        ),
      ).toBeUndefined();
      expect(
        copy.crossRegionFallbackModelId(
          "qwen.qwen3-32b-v1:0",
          undefined,
          "us-east-1",
        ),
      ).toBeUndefined();
    }
  });
});

describe("holdBackDsmlMarker", () => {
  const marker = core.DEEPSEEK_DSML_MARKER;

  it("is the fragment DeepSeek V3.2 leaks, with fullwidth bars", () => {
    expect(marker).toBe("<｜DSML｜function_calls");
    expect(adapter.DEEPSEEK_DSML_MARKER).toBe(marker);
  });

  it("emits plain text and holds nothing", () => {
    expect(core.holdBackDsmlMarker("hello world")).toEqual({
      emit: "hello world",
      hold: "",
    });
  });

  it("holds a tail that could still become the marker", () => {
    expect(core.holdBackDsmlMarker("done <｜DS")).toEqual({
      emit: "done ",
      hold: "<｜DS",
    });
    expect(core.holdBackDsmlMarker("a <")).toEqual({ emit: "a ", hold: "<" });
  });

  it("holds the marker and what follows it", () => {
    expect(core.holdBackDsmlMarker(`I will echo it.${marker}>`)).toEqual({
      emit: "I will echo it.",
      hold: `${marker}>`,
    });
  });

  it("drops a held marker at the end of the block and keeps anything else", () => {
    expect(core.flushDsmlHold(`${marker}>`)).toBe("");
    expect(core.flushDsmlHold("<")).toBe("<");
    for (const text of ["a <", `x${marker}`, "plain", "<｜DS"]) {
      expect(adapter.holdBackDsmlMarker(text)).toEqual(
        core.holdBackDsmlMarker(text),
      );
    }
  });
});

describe("the unmeasured families (plans/model-families-2026-11.md)", () => {
  it("keeps the two copies of the family table identical", () => {
    const flat = (rules: typeof coreRules.FAMILY_RULES) =>
      rules.map((r) => ({ ...r, match: r.match.source + "/" + r.match.flags }));
    expect(flat(adapterRules.FAMILY_RULES)).toEqual(
      flat(coreRules.FAMILY_RULES),
    );
  });

  it("gives every entry a status, a read date and an AWS or vendor source URL", () => {
    for (const r of coreRules.FAMILY_RULES) {
      expect(["unprobed", "probed"], r.id).toContain(r.status);
      expect(r.read, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      for (const url of r.sources) expect(url, r.id).toMatch(/^https:\/\//);
    }
  });

  it("finds the rule for the Bedrock ids on the account, with and without a geography prefix", () => {
    const want: Record<string, string> = {
      "moonshotai.kimi-k3": "kimi-k3",
      "us.moonshotai.kimi-k3": "kimi-k3",
      "global.moonshotai.kimi-k3.1": "kimi-k3",
      "moonshot.kimi-k2-thinking": "kimi-k2-thinking",
      "moonshotai.kimi-k2-thinking": "kimi-k2-thinking",
      "moonshotai.kimi-k2.5": "kimi-k2.5",
      "zai.glm-5": "glm-5",
      "minimax.minimax-m2.5": "minimax-m2.5",
      "nvidia.nemotron-super-3-120b": "nemotron-3-super",
      "us.xai.grok-4.6": "grok-4.6",
      "xai.grok-4.6": "grok-4.6",
      "openai.gpt-oss-120b-1:0": "gpt-oss",
      "openai.gpt-oss-120b": "gpt-oss",
    };
    for (const [id, family] of Object.entries(want)) {
      for (const rules of [coreRules, adapterRules]) {
        expect(rules.familyRuleFor(id)?.id, id).toBe(family);
      }
    }
    expect(coreRules.familyRuleFor("qwen.qwen3-32b-v1:0")).toBeUndefined();
    expect(coreRules.familyRuleFor("moonshotai.kimi-k3-vl")).toBeUndefined();
  });

  it("sends Kimi K3 and K3.1 reasoning_effort only when the config says so, and nothing otherwise", () => {
    for (const helpers of [core, adapter]) {
      for (const id of [
        "us.moonshotai.kimi-k3",
        "global.moonshotai.kimi-k3.1",
      ]) {
        expect(helpers.bedrockReasoningFields(id, undefined, 4096)).toEqual({
          additionalModelRequestFields: {},
          omitMaxTokens: false,
        });
        expect(
          helpers.bedrockReasoningFields(id, false, 4096)
            .additionalModelRequestFields,
        ).toEqual({ reasoning_effort: "none" });
        expect(
          helpers.bedrockReasoningFields(id, true, 1024)
            .additionalModelRequestFields,
        ).toEqual({ reasoning_effort: "low" });
        expect(
          helpers.bedrockReasoningFields(id, true, 16384)
            .additionalModelRequestFields,
        ).toEqual({ reasoning_effort: "high" });
      }
    }
  });

  it("sends nothing to the families with no Converse reasoning switch (documented or measured)", () => {
    const unwired = [
      "moonshotai.kimi-k2.5",
      "moonshot.kimi-k2-thinking",
      "zai.glm-5",
      "minimax.minimax-m2.5",
      "nvidia.nemotron-super-3-120b",
    ];
    for (const id of unwired) {
      for (const reasoning of REASONING) {
        expect(
          core.bedrockReasoningFields(id, reasoning, 4096)
            .additionalModelRequestFields,
          id,
        ).toEqual({});
      }
      expect(
        coreRules.familyRuleFor(id)?.converseReasoning,
        id,
      ).toBeUndefined();
    }
  });

  it("marks an entry probed only with the date and evidence of a run", () => {
    for (const r of coreRules.FAMILY_RULES) {
      if (r.status === "probed") {
        expect(r.probedOn, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.evidence?.length, r.id).toBeGreaterThan(0);
      } else {
        expect(r.probedOn, r.id).toBeUndefined();
      }
    }
  });
});

describe("the families measured live on 2026-11-10", () => {
  const CONFIGS = [
    { temperature: 0.3, topP: 0.9, stopSequences: ["END"], maxTokens: 20 },
    { stopSequences: ["END"] },
    { temperature: 0.7, topP: 0.9 },
    {},
  ];
  it.each(MODELS)("agree between the copies on %j", (id) => {
    for (const config of CONFIGS) {
      expect(adapter.bedrockOmitUnsupportedInference(id, config)).toEqual(
        core.bedrockOmitUnsupportedInference(id, config),
      );
    }
    for (const n of [undefined, 20, 1024, 8192]) {
      expect(adapter.bedrockMinMaxTokens(id, n)).toBe(
        core.bedrockMinMaxTokens(id, n),
      );
    }
  });

  it("marks every measured row probed with the date and evidence, and Kimi K2.5 and Grok still unprobed", () => {
    for (const rules of [coreRules, adapterRules]) {
      for (const id of [
        "kimi-k3",
        "kimi-k2-thinking",
        "glm-5",
        "minimax-m2.5",
        "nemotron-3-super",
        "gpt-oss",
      ]) {
        const row = rules.FAMILY_RULES.find((r) => r.id === id)!;
        expect(row.status).toBe("probed");
        expect(row.probedOn).toBe("2026-11-10");
        expect(row.evidence!.length).toBeGreaterThan(0);
      }
      for (const id of ["kimi-k2.5"]) {
        expect(rules.FAMILY_RULES.find((r) => r.id === id)!.status).toBe(
          "unprobed",
        );
      }
      // Grok 4.6 and 4.7 were measured live on 2026-11-14
      const grok = rules.FAMILY_RULES.find((r) => r.id === "grok-4.6")!;
      expect(grok.status).toBe("probed");
      expect(grok.probedOn).toBe("2026-11-14");
      expect(grok.evidence!.length).toBeGreaterThan(0);
    }
  });

  it("omits what Bedrock refused: Kimi K3 temperature and stopSequences, the rest stopSequences", () => {
    for (const helpers of [core, adapter]) {
      expect(
        helpers.bedrockOmitUnsupportedInference("us.moonshotai.kimi-k3", {
          temperature: 0.3,
          topP: 0.9,
          stopSequences: ["END"],
          maxTokens: 256,
        }),
      ).toEqual({ topP: 0.9, maxTokens: 256 });
      for (const id of [
        "zai.glm-5",
        "nvidia.nemotron-super-3-120b",
        "openai.gpt-oss-120b-1:0",
      ]) {
        expect(
          helpers.bedrockOmitUnsupportedInference(id, {
            temperature: 0.7,
            topP: 0.9,
            stopSequences: ["END"],
          }),
        ).toEqual({ temperature: 0.7, topP: 0.9 });
      }
      for (const id of ["minimax.minimax-m2.5", "us.amazon.nova-2-lite-v1:0"]) {
        expect(
          helpers.bedrockOmitUnsupportedInference(id, {
            temperature: 0.7,
            topP: 0.9,
          }),
        ).toEqual({ temperature: 0.7, topP: 0.9 });
      }
    }
  });

  it("maps gpt-oss reasoning off to low, never none, and low, medium, high from the budget", () => {
    const id = "openai.gpt-oss-120b-1:0";
    for (const helpers of [core, adapter]) {
      const f = (r: boolean | undefined, b: number) =>
        helpers.bedrockReasoningFields(id, r, b).additionalModelRequestFields;
      expect(f(false, 4096)).toEqual({ reasoning_effort: "low" });
      expect(f(true, 1024)).toEqual({ reasoning_effort: "low" });
      expect(f(true, 4096)).toEqual({ reasoning_effort: "medium" });
      expect(f(true, 16384)).toEqual({ reasoning_effort: "high" });
      expect(f(undefined, 4096)).toEqual({});
    }
  });

  it("sends nothing to the families with no working switch", () => {
    for (const id of [
      "zai.glm-5",
      "nvidia.nemotron-super-3-120b",
      "moonshot.kimi-k2-thinking",
      "minimax.minimax-m2.5",
    ]) {
      for (const r of [undefined, false, true] as const) {
        expect(
          core.bedrockReasoningFields(id, r, 4096).additionalModelRequestFields,
        ).toEqual({});
      }
    }
  });

  it("raises a 20-token maxTokens to the floor for the always-reasoning families only", () => {
    for (const id of [
      "us.moonshotai.kimi-k3",
      "global.moonshotai.kimi-k3.1",
      "moonshot.kimi-k2-thinking",
      "minimax.minimax-m2.5",
      "openai.gpt-oss-120b-1:0",
    ]) {
      expect(core.bedrockMinMaxTokens(id, 20)).toBe(1024);
      expect(core.bedrockMinMaxTokens(id, 8192)).toBe(8192);
      expect(core.bedrockMinMaxTokens(id, undefined)).toBeUndefined();
    }
    expect(core.bedrockMinMaxTokens("zai.glm-5", 20)).toBe(20);
    expect(core.bedrockMinMaxTokens("us.amazon.nova-pro-v1:0", 20)).toBe(20);
  });
});
