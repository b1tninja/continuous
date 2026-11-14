/**
 * Per-family request rules for the models the benchmark has not measured yet
 * (plans/model-families-2026-11.md; roadmap rows I2 and I4). Data only: what a
 * vendor or AWS page says, with its URL and the date it was read. Nothing here
 * was probed against Bedrock; every entry is `unprobed` until a run of
 * `bench/probe.mjs` (probes in bench/probes/families.yaml) says otherwise, and
 * the entry changes to `probed` with the run's date in the same commit.
 *
 * Measured entries say `probed` with the date and the evidence file (live
 * Bedrock Converse calls, 2026-11-10, account torgate, us-east-1). Code reads
 * three things from a row: `converseReasoning` (`bedrockReasoningFields`),
 * `unsupportedInference` (`bedrockOmitUnsupportedInference`) and
 * `minMaxTokens` (`bedrockMinMaxTokens`). The rest is the table the probes
 * are checked against and the CLI's model picker can show.
 *
 * Two copies, this one and packages/openai-adapters/src/apis/bedrockFamilyRules.ts
 * (core cannot import that package; see `bedrockSupportsOneHourCache`).
 * bedrockReasoningFields.vitest.ts fails if they disagree.
 */

export type FamilyStatus = "unprobed" | "probed";

/** `inferenceConfig` fields a family's Converse endpoint refuses. */
export type InferenceField = "temperature" | "topP" | "stopSequences";

/** How a Converse request switches reasoning for a family. */
export interface ConverseReasoningRule {
  /** The key put in `additionalModelRequestFields`. */
  field: string;
  /** Values the vendor documents, weakest first. */
  values: string[];
  /** The value that turns reasoning off, when there is one. */
  off?: string;
  /** What the model does when the field is absent. */
  defaultWhenAbsent: string;
}

export interface FamilyRule {
  id: string;
  /** Matches the Bedrock model id with or without a geography prefix. */
  match: RegExp;
  status: FamilyStatus;
  /** Date the sources were read, YYYY-MM-DD. */
  read: string;
  /** Date of the live run behind a `probed` entry, YYYY-MM-DD. */
  probedOn?: string;
  /** Evidence file names (`<family>/<case>.out.json` or `.err.txt`) of that run. */
  evidence?: string[];
  /**
   * `inferenceConfig` fields Bedrock answered with "This model doesn't support
   * the <field> field". Request builders leave them out.
   */
  unsupportedInference?: InferenceField[];
  /**
   * Floor for `maxTokens` on a family that reasons whether or not asked to:
   * a 20-token budget was spent entirely on reasoning and returned no text.
   */
  minMaxTokens?: number;
  /** Vendor and AWS pages the entry rests on. */
  sources: string[];
  /** Converse field wired into the request builder; absent means none is. */
  converseReasoning?: ConverseReasoningRule;
  /**
   * Fields the vendor documents for its own API or a serving stack, to try in
   * the probe. Not sent by any code.
   */
  candidateReasoningFields: string[];
  /** Tool-choice values the sources claim or a probe confirmed; `unknown` when neither. */
  toolChoice: "auto-any-tool" | "unknown" | "disputed";
  /** Sampling constraints the sources state, plain words. */
  sampling: string;
  /** The tool-call dialect id from core/util/toolDialectDetect.ts. */
  dialect: string;
  /** Limits from the AWS card: context tokens and max output tokens. */
  contextLength?: number;
  maxOutputTokens?: number;
  /** One line per known quirk. */
  quirks: string[];
}

const AWS = "https://docs.aws.amazon.com/bedrock/latest/userguide";

export const FAMILY_RULES: FamilyRule[] = [
  {
    id: "kimi-k3",
    match: /(^|\.)moonshotai\.kimi-k3(\.1)?$/i,
    status: "probed",
    read: "2026-11-10",
    probedOn: "2026-11-10",
    evidence: [
      "kimi-k3/sampling-temperature.err.txt",
      "kimi-k3/sampling-both.err.txt",
      "kimi-k3/stop-sequences.err.txt",
      "kimi-k3/reasoning-variant.effort-{none,low,medium,max,minimal}.out.json",
      "kimi-k3/replay-reasoning.out.json",
      "kimi-k3/tool-{auto,any,named}.out.json",
    ],
    unsupportedInference: ["temperature", "stopSequences"],
    minMaxTokens: 1024,

    sources: [
      `${AWS}/model-card-moonshot-ai-kimi-k3.html`,
      `${AWS}/model-card-moonshot-ai-kimi-k3-1-highspeed.html`,
      "https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model",
    ],
    // AWS: Converse accepts reasoning_effort in additionalModelRequestFields
    // but does not validate it for this model. Unset means max.
    converseReasoning: {
      field: "reasoning_effort",
      values: ["low", "medium", "high", "xhigh", "max"],
      off: "none",
      defaultWhenAbsent: "max",
    },
    candidateReasoningFields: ["reasoning_effort"],
    toolChoice: "auto-any-tool",
    sampling:
      "temperature (alone or with topP) and stopSequences are refused on Converse (measured 2026-11-10); topP alone not tried",
    dialect: "kimi-tokens",
    contextLength: 1_000_000,
    quirks: [
      "Converse fails (InternalServerException) when reasoning content from earlier turns is replayed; AWS recommends Responses or Chat Completions",
      "output burns 10x of the token quota",
      "Moonshot's page lists low, high and max; AWS adds none, medium and xhigh",
      "MEASURED 2026-11-10: temperature (alone or with topP) and stopSequences are refused with 'This model doesn't support the <field> field'; topP alone was not tried",
      "MEASURED: Converse accepted reasoning_effort none, low, medium, max and minimal (AWS says minimal is unsupported and Converse does not validate), but reasoning length did not track the value (44 to 118 chars); no evidence the switch does anything",
      "MEASURED: a replayed reasoning block was accepted, where the AWS card says Converse fails with InternalServerException",
      "MEASURED: toolChoice auto, any and a named tool all work",
      "MEASURED: a 20-token maxTokens was spent entirely on reasoning and returned no text (also K3.1)",
    ],
  },
  {
    id: "kimi-k2-thinking",
    match: /(^|\.)moonshot(ai)?\.kimi-k2-thinking$/i,
    status: "probed",
    read: "2026-11-10",
    probedOn: "2026-11-10",
    evidence: [
      "kimi-k2-thinking/reasoning-variant.thinking-disabled.out.json",
      "kimi-k2-thinking/replay-reasoning.out.json",
      "kimi-k2-thinking/tool-{auto,any,named}.out.json",
    ],
    minMaxTokens: 1024,

    sources: [`${AWS}/model-card-moonshot-ai-kimi-k2-thinking.html`],
    candidateReasoningFields: [],
    toolChoice: "auto-any-tool",
    sampling: "no page found",
    dialect: "kimi-tokens",
    contextLength: 256_000,
    maxOutputTokens: 16_384,
    quirks: [
      "always reasons; there is no switch",
      "bedrock-runtime id is moonshot.kimi-k2-thinking, Mantle id is moonshotai.kimi-k2-thinking",
      "Legacy, end of life 2027-03-30",
      "MEASURED 2026-11-10: a thinking {type: disabled} field is accepted and ignored, the model still reasons",
      "MEASURED: replaying a reasoning block is accepted but the model then writes a literal <think>...</think> block into its text",
      "MEASURED: toolChoice auto, any and a named tool all work; sampling and stopSequences were not probed",
      "MEASURED: a 20-token maxTokens returned no visible text",
    ],
  },
  {
    id: "kimi-k2.5",
    match: /(^|\.)moonshotai\.kimi-k2\.5$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [
      `${AWS}/model-card-moonshot-ai-kimi-k2-5.html`,
      "https://huggingface.co/moonshotai/Kimi-K2.5",
    ],
    // Moonshot API: thinking {type: disabled}; vLLM and SGLang:
    // chat_template_kwargs {thinking: false}. No Bedrock field is documented.
    candidateReasoningFields: [
      "thinking",
      "chat_template_kwargs.thinking",
      "reasoning_effort",
    ],
    toolChoice: "unknown",
    sampling: "temperature 1.0 thinking, 0.6 instant, top_p 0.95 (vendor card)",
    dialect: "kimi-tokens",
    contextLength: 256_000,
    maxOutputTokens: 16_384,
    quirks: ["replay the full assistant message with reasoning_content"],
  },
  {
    id: "glm-5",
    match: /(^|\.)zai\.glm-5$/i,
    status: "probed",
    read: "2026-11-10",
    probedOn: "2026-11-10",
    evidence: [
      "glm5/reasoning-variant.thinking-disabled.out.json",
      "glm5/reasoning-variant.template-enable-thinking-false.out.json",
      "glm5/sampling-both.out.json",
      "glm5/stop-sequences.err.txt",
      "glm5/tool-{auto,any,named}.out.json",
    ],
    unsupportedInference: ["stopSequences"],

    sources: [
      `${AWS}/model-card-zai-glm-5.html`,
      "https://docs.z.ai/guides/capabilities/thinking-mode",
      "https://huggingface.co/zai-org/GLM-5",
    ],
    candidateReasoningFields: [
      "thinking",
      "chat_template_kwargs.enable_thinking",
    ],
    toolChoice: "auto-any-tool",
    sampling:
      "1.0 / 0.95 for reasoning, 0.7 / 0.95 for SWE-bench (vendor card)",
    dialect: "glm-xml",
    contextLength: 200_000,
    maxOutputTokens: 128_000,
    quirks: [
      "thinking is on by default; vendor API takes thinking.type enabled or disabled",
      "clear_thinking false keeps prior reasoning and needs it returned in order",
      "MEASURED 2026-11-10: enable_thinking and thinking {type: disabled} are accepted but no reasoning block is ever returned, so there is nothing to switch; nothing is sent",
      "MEASURED: temperature with topP accepted; stopSequences refused",
      "MEASURED: toolChoice auto, any and a named tool all work",
    ],
  },
  {
    id: "minimax-m2.5",
    match: /(^|\.)minimax\.minimax-m2\.5$/i,
    status: "probed",
    read: "2026-11-10",
    probedOn: "2026-11-10",
    evidence: [
      "minimax-m25/reasoning-variant.reasoning-split.out.json",
      "minimax-m25/reasoning-variant.thinking-disabled.out.json",
      "minimax-m25/sampling-both.out.json",
      "minimax-m25/tool-{auto,any,named}.out.json",
    ],
    minMaxTokens: 1024,

    sources: [
      `${AWS}/model-card-minimax-minimax-m2-5.html`,
      "https://huggingface.co/MiniMaxAI/MiniMax-M2.5",
      "https://platform.minimax.io/docs/api-reference/text-openai-api",
    ],
    candidateReasoningFields: ["reasoning_split", "thinking"],
    toolChoice: "auto-any-tool",
    sampling:
      "recommended temperature 1.0, top_p 0.95, top_k 40; the vendor API ignores temperature, top_p and penalties",
    dialect: "minimax-xml",
    contextLength: 196_000,
    maxOutputTokens: 8_192,
    quirks: [
      "thinking tokens count toward the limit; a small limit gives finish_reason length with empty content",
      "thinking stays in <think> tags in content unless reasoning_split is true",
      "Mantle listed it but did not answer in a March 2026 third-party test; AWS lists it on Mantle now",
      "MEASURED 2026-11-10: reasoning_split is accepted and the reasoning came back shorter; thinking {type: disabled} is accepted but it still reasons; neither is sent",
      "MEASURED: temperature with topP accepted; stopSequences was not probed",
      "MEASURED: toolChoice auto, any and a named tool all work; a 20-token maxTokens returned no visible text",
    ],
  },
  {
    id: "nemotron-3-super",
    match: /(^|\.)nvidia\.nemotron-super-3-120b$/i,
    status: "probed",
    read: "2026-11-10",
    probedOn: "2026-11-10",
    evidence: [
      "nemotron3-super/reasoning-variant.effort-{none,low}.out.json",
      "nemotron3-super/reasoning-variant.template-{enable-thinking-false,low-effort}.out.json",
      "nemotron3-super/sampling-both.out.json",
      "nemotron3-super/stop-sequences.err.txt",
      "nemotron3-super/tool-{auto,any,named}.out.json",
    ],
    unsupportedInference: ["stopSequences"],

    sources: [
      `${AWS}/model-card-nvidia-nemotron-super-3-120b.html`,
      "https://docs.vllm.ai/en/stable/api/vllm/parser/nemotron_v3/",
    ],
    // AWS: effort none, low, medium, high, with no field named.
    candidateReasoningFields: [
      "reasoning_effort",
      "chat_template_kwargs.enable_thinking",
      "chat_template_kwargs.low_effort",
      "reasoning_budget",
    ],
    toolChoice: "auto-any-tool",
    sampling: "no page found",
    dialect: "qwen-xml",
    contextLength: 256_000,
    maxOutputTokens: 32_768,
    quirks: [
      "vLLM serves tools with the qwen3_coder parser",
      "force_nonempty_content is advised for coding agents by Cloudflare (unverified)",
      "MEASURED 2026-11-10: every reasoning variant is accepted and none returns a reasoning block, so nothing is sent",
      "MEASURED: temperature with topP accepted; stopSequences refused",
      "MEASURED: toolChoice auto and a named tool add a stray newline text block next to the toolUse",
    ],
  },
  {
    id: "grok-4.6",
    match: /(^|\.)xai\.grok-4\.[67]$/i,
    status: "unprobed",
    read: "2026-11-10",
    sources: [
      `${AWS}/model-card-xai-grok-4-6.html`,
      "https://docs.x.ai/docs/guides/reasoning",
    ],
    // Responses: reasoning {effort}; Chat Completions: reasoning_effort.
    candidateReasoningFields: ["reasoning_effort", "reasoning.effort"],
    toolChoice: "unknown",
    sampling:
      "presencePenalty, frequencyPenalty and stop return an error on xAI's reasoning models",
    dialect: "native-structured",
    contextLength: 500_000,
    quirks: [
      "reasoning cannot be turned off; effort low, medium, high, xhigh",
      "on bedrock-runtime only us.xai.grok-4.6 and global.xai.grok-4.6 answer; xai.grok-4.6 is the Mantle id with path /openai/v1",
      "Chat Completions does not return reasoning tokens",
    ],
  },
  {
    id: "gpt-oss",
    match: /(^|\.)openai\.gpt-oss-(120b|20b)(-1:0)?$/i,
    status: "probed",
    read: "2026-11-10",
    probedOn: "2026-11-10",
    evidence: [
      "gpt-oss-120b/reasoning-variant.effort-{low,high}.out.json",
      "gpt-oss-120b/reasoning-variant.effort-none.err.txt",
      "gpt-oss-120b/sampling-both.out.json",
      "gpt-oss-120b/stop-sequences.err.txt",
      "gpt-oss-120b/tool-{auto,any,named}.out.json",
    ],
    unsupportedInference: ["stopSequences"],
    minMaxTokens: 1024,

    sources: [
      `${AWS}/model-card-openai-gpt-oss-120b.html`,
      "https://huggingface.co/openai/gpt-oss-120b",
    ],
    // The Hugging Face card sets effort in the system prompt ("Reasoning:
    // high"); no Bedrock field is documented.
    converseReasoning: {
      field: "reasoning_effort",
      values: ["low", "medium", "high"],
      // `none` is refused by the model, so "reasoning off" is the weakest.
      off: "low",
      defaultWhenAbsent: "medium",
    },
    candidateReasoningFields: ["reasoning_effort"],
    toolChoice: "auto-any-tool",
    sampling: "no page found",
    dialect: "harmony",
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    quirks: [
      "refuses stopSequences on Converse (handled by isStopSequencesUnsupportedError)",
      "reasoning is on by default; low, medium, high",
      "a small max_tokens can leave content null",
      "MEASURED 2026-11-10 (120b): reasoning_effort low and high are accepted and visibly change the reasoning; none is refused by the model (\"Harmony does not support reasoning_effort='none'\"), so off maps to low",
      "MEASURED: temperature with topP accepted; stopSequences refused",
      "MEASURED: a 20-token maxTokens returned no visible text; 20b was not probed beyond the availability call",
    ],
  },
  {
    // OpenAI's closed GPT models on Bedrock: GPT-5.6 Sol, Terra and Luna, GPT-6
    // Sol and Luna, GPT-6.1 Sol, by their regional or global profile. GPT OSS
    // (above) and Daybreak Blue (Mantle only) are not matched here.
    id: "gpt-closed",
    match: /(^|\.)openai\.gpt-(?:5\.[5-9]|6(?:\.\d+)?)-(?:sol|terra|luna)$/i,
    status: "probed",
    read: "2026-11-14",
    probedOn: "2026-11-14",
    evidence: [
      "live-runtime 2026-11-14: us.openai.gpt-6-luna, gpt-6.1-sol, gpt-5.6-terra",
    ],
    unsupportedInference: ["stopSequences"],
    // Sol and Terra spent a 60-token budget on reasoning and made no call
    minMaxTokens: 1024,
    sources: [`${AWS}/bedrock-mantle.html`],
    // No Converse field: reasoning_effort is refused ("Unknown parameter:
    // 'reasoning_effort'"). The Responses API takes reasoning.effort.
    candidateReasoningFields: ["reasoning.effort"],
    toolChoice: "unknown",
    sampling: "stopSequences refused on Converse",
    dialect: "native-structured",
    contextLength: 1_050_000,
    maxOutputTokens: 128_000,
    quirks: [
      "MEASURED 2026-11-14: stopSequences refused ('This model doesn't support the stopSequences field')",
      "MEASURED: reasoning_effort in additionalModelRequestFields refused ('Unknown parameter: reasoning_effort'); reasoning cannot be set on Converse",
      "MEASURED: Terra and Sol may open with a reasoningContent block, so tool calls start at contentBlockIndex 1 or later",
      "MEASURED: parallel tool calls stream as separate blocks with valid JSON; ids look like call_<hex>",
      "MEASURED: a 60-token cap ended at max_tokens with the arguments cut short (Luna) or with only reasoning (Sol, Terra)",
    ],
  },
];

/** The rule for a Bedrock model id, or undefined. */
export function familyRuleFor(modelId: string): FamilyRule | undefined {
  return FAMILY_RULES.find((r) => r.match.test(modelId));
}

/**
 * The `inferenceConfig` fields to leave out for a Bedrock model id, from the
 * family's `unsupportedInference`. Empty for a family not in the table.
 */
export function unsupportedInferenceFor(modelId: string): InferenceField[] {
  return familyRuleFor(modelId)?.unsupportedInference ?? [];
}

/** The `maxTokens` floor for a family that always reasons, or undefined. */
export function minMaxTokensFor(modelId: string): number | undefined {
  return familyRuleFor(modelId)?.minMaxTokens;
}
