import type { ToolDialectSetting } from "@continuedev/config-yaml";
import type { Tool } from "core";
import { generateToolsSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import {
  resolveToolDialectPreset,
  type PromptStyle,
} from "core/util/toolDialectPresets";

/** The call every preview shows: read one file. */
export const SAMPLE_TOOL_NAME = "read_file";
const SAMPLE_ARGS = { filepath: "src/app.ts" };

export interface DialectInfo {
  label: string;
  /** What choosing it does, in one sentence. */
  summary: string;
  /** A reply written in this dialect, calling read_file; absent for auto, native and off. */
  sample?: string;
}

const json = JSON.stringify(SAMPLE_ARGS);
const call = `{"name": "${SAMPLE_TOOL_NAME}", "arguments": ${json}}`;

/**
 * One entry per `toolDialect` value. Typed over the setting, so a value
 * added to TOOL_DIALECT_VALUES does not compile until it has an entry. Each
 * sample is checked against the leak detector in toolPreview.test.ts.
 */
export const DIALECT_INFO: Record<ToolDialectSetting, DialectInfo> = {
  auto: {
    label: "Auto (default)",
    summary:
      "Structured tool calls only. A call written as text is reported, never run.",
  },
  native: {
    label: "Native only",
    summary:
      "The server returns structured calls; never read calls from text for this model.",
  },
  off: {
    label: "Off",
    summary: "Never read calls from text for this model.",
  },
  "qwen-xml": {
    label: "Qwen XML",
    summary: "Qwen3-Coder's markup.",
    sample: `<tool_call>\n<function=${SAMPLE_TOOL_NAME}>\n<parameter=filepath>\nsrc/app.ts\n</parameter>\n</function>\n</tool_call>`,
  },
  pythonic: {
    label: "Python call syntax",
    summary: "Nova and Llama 4 write calls as Python expressions.",
    sample: `[${SAMPLE_TOOL_NAME}(filepath="src/app.ts")]`,
  },
  "llama-json": {
    label: "Llama JSON",
    summary: "Llama 3's bare JSON object with parameters.",
    sample: `{"name": "${SAMPLE_TOOL_NAME}", "parameters": ${json}}`,
  },
  "hermes-json": {
    label: "Hermes JSON",
    summary: "JSON in <tool_call> tags (Hermes, Qwen 2.5).",
    sample: `<tool_call>\n${call}\n</tool_call>`,
  },
  "glm-xml": {
    label: "GLM tags",
    summary: "GLM's argument key and value tags.",
    sample: `<tool_call>${SAMPLE_TOOL_NAME}<arg_key>filepath</arg_key><arg_value>src/app.ts</arg_value></tool_call>`,
  },
  harmony: {
    label: "Harmony",
    summary: "gpt-oss channels addressed to functions.NAME.",
    sample: `<|start|>assistant<|channel|>commentary to=functions.${SAMPLE_TOOL_NAME} <|constrain|>json<|message|>${json}<|call|>`,
  },
  mistral: {
    label: "Mistral",
    summary: "A [TOOL_CALLS] marker followed by JSON.",
    sample: `[TOOL_CALLS] [${call.slice(0, -1)}, "id": "a1b2c3d4e"}]`,
  },
  dsml: {
    label: "DeepSeek DSML",
    summary: "DeepSeek V3.2 and later, full-width bar markup.",
    sample: `<｜DSML｜function_calls>\n<｜DSML｜invoke name="${SAMPLE_TOOL_NAME}">\n<｜DSML｜parameter name="filepath" string="true">src/app.ts</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>`,
  },
  "deepseek-v31": {
    label: "DeepSeek V3.1 tokens",
    summary: "DeepSeek V3 and V3.1 call tokens.",
    sample: `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>${SAMPLE_TOOL_NAME}<｜tool▁sep｜>${json}<｜tool▁call▁end｜><｜tool▁calls▁end｜>`,
  },
  "deepseek-r1": {
    label: "DeepSeek R1 tokens",
    summary: "DeepSeek R1 call tokens with a fenced JSON body.",
    sample: `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>${SAMPLE_TOOL_NAME}\n\`\`\`json\n${json}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`,
  },
  "kimi-tokens": {
    label: "Kimi K2 tokens",
    summary: "Kimi K2 section tokens with functions.NAME:IDX ids.",
    sample: `<|tool_calls_section_begin|><|tool_call_begin|>functions.${SAMPLE_TOOL_NAME}:0<|tool_call_argument_begin|>${json}<|tool_call_end|><|tool_calls_section_end|>`,
  },
  "kimi-xtml": {
    label: "Kimi K3 XTML",
    summary: "Kimi K3's tools, call and argument parts.",
    sample: `<|open|>tools<|sep|><|open|>call tool="${SAMPLE_TOOL_NAME}" index="1"<|sep|><|open|>argument key="filepath" type="string"<|sep|>src/app.ts<|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|>`,
  },
  "minimax-xml": {
    label: "MiniMax XML",
    summary: "MiniMax-M2's <minimax:tool_call> markup.",
    sample: `<minimax:tool_call>\n<invoke name="${SAMPLE_TOOL_NAME}">\n<parameter name="filepath">src/app.ts</parameter>\n</invoke>\n</minimax:tool_call>`,
  },
  "minimax-ns-xml": {
    label: "MiniMax M3 namespaced",
    summary: "MiniMax-M3's namespaced tags.",
    sample: `]<]minimax[>[<tool_call>\n]<]minimax[>[<invoke name="${SAMPLE_TOOL_NAME}">]<]minimax[>[<filepath>src/app.ts]<]minimax[>[</filepath>]<]minimax[>[</invoke>\n]<]minimax[>[</tool_call>`,
  },
  "toolcall-json": {
    label: "<TOOLCALL> JSON",
    summary: "A JSON list in <TOOLCALL> tags (Nemotron).",
    sample: `<TOOLCALL>[${call}]</TOOLCALL>`,
  },
  "granite-tokens": {
    label: "Granite tokens",
    summary: "Granite 3.x <|tool_call|> followed by a JSON list.",
    sample: `<|tool_call|>[${call}]`,
  },
  "lfm-tokens": {
    label: "LFM2 tokens",
    summary: "Liquid LFM2 Python calls between call tokens.",
    sample: `<|tool_call_start|>[${SAMPLE_TOOL_NAME}(filepath="src/app.ts")]<|tool_call_end|>`,
  },
  "hy3-tags": {
    label: "Hy3 tags",
    summary: "Tencent Hy3 opensource tags.",
    sample: `<tool_calls:opensource>\n<tool_call:opensource>${SAMPLE_TOOL_NAME}<tool_sep:opensource>\n<arg_key:opensource>filepath</arg_key:opensource>\n<arg_value:opensource>src/app.ts</arg_value:opensource>\n</tool_call:opensource>\n</tool_calls:opensource>`,
  },
  "solar-tokens": {
    label: "Solar Open tokens",
    summary: "Solar Open's begin, name, args and end tokens.",
    sample: `<|tool_calls|><|tool_call:begin|>a1b2c3d4e5<|tool_call:name|>${SAMPLE_TOOL_NAME}<|tool_call:args|>${json}<|tool_call:end|><|calls|>`,
  },
  "longcat-json": {
    label: "LongCat JSON",
    summary: "JSON in <longcat_tool_call> tags.",
    sample: `<longcat_tool_call>\n${call}\n</longcat_tool_call>`,
  },
  "olmo-function-calls": {
    label: "Olmo 3 calls",
    summary: "Python calls in <function_calls> tags.",
    sample: `<function_calls>${SAMPLE_TOOL_NAME}(filepath="src/app.ts")</function_calls>`,
  },
  "seed-xml": {
    label: "Seed-OSS XML",
    summary: "Seed-OSS <seed:tool_call> markup.",
    sample: `<seed:tool_call>\n<function=${SAMPLE_TOOL_NAME}>\n<parameter=filepath>src/app.ts</parameter>\n</function>\n</seed:tool_call>`,
  },
  "cohere-action": {
    label: "Cohere action",
    summary: "Command A's START_ACTION block.",
    sample: `<|START_ACTION|> [ {"tool_call_id": "0", "tool_name": "${SAMPLE_TOOL_NAME}", "parameters": ${json}} ] <|END_ACTION|>`,
  },
};

/** The tool every preview describes. Only its shape matters. */
export const SAMPLE_TOOL: Tool = {
  type: "function",
  displayTitle: "Read file",
  readonly: true,
  isInstant: true,
  group: "Built-In",
  function: {
    name: SAMPLE_TOOL_NAME,
    description: "Read the contents of a file in the workspace.",
    parameters: {
      type: "object",
      required: ["filepath"],
      properties: {
        filepath: {
          type: "string",
          description: "The path of the file, relative to the workspace.",
        },
      },
    },
  },
};

/** How the tools reach the model: as API tool definitions, or in the system message. */
export type ToolPromptStyle = "native" | "systemMessage";

/** What the model is sent for one tool, as the chat builds it. */
export function toolPromptPreview(style: ToolPromptStyle): string {
  if (style === "native") {
    return JSON.stringify(
      {
        tools: [
          {
            type: "function",
            function: {
              name: SAMPLE_TOOL.function.name,
              description: SAMPLE_TOOL.function.description,
              parameters: SAMPLE_TOOL.function.parameters,
            },
          },
        ],
      },
      null,
      2,
    );
  }
  return generateToolsSystemMessage(
    [SAMPLE_TOOL],
    new SystemMessageToolCodeblocksFramework(),
  );
}

const PROMPT_STYLE_TEXT: Record<PromptStyle, string> = {
  native: "native tool calls",
  codeblock: "tools described in the system message",
  "qwen-xml": "its own Qwen XML form",
  "hermes-json": "its own Hermes JSON form",
  "glm-xml": "its own GLM tag form",
  pythonic: "its own Python call form",
  "llama-json": "its own Llama JSON form",
  "toolcall-json": "its own <TOOLCALL> JSON form",
};

/**
 * What the dialect preset for this model id says about asking for tool calls,
 * and the dialect that recovers its text calls. Data only: nothing sends a
 * family's own form today, so only native and system-message are choices.
 */
export function presetHint(
  model: string,
):
  | { label: string; style: string; evidence: string; recoverWith?: string }
  | undefined {
  const preset = resolveToolDialectPreset(model);
  if (!preset) return undefined;
  return {
    label: preset.label,
    style: PROMPT_STYLE_TEXT[preset.promptStyle.style],
    evidence: preset.promptStyle.evidence,
    recoverWith: preset.recoverWith,
  };
}
