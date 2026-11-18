import {
  TOOL_DIALECT_VALUES,
  type ToolDialectSetting,
} from "@continuedev/config-yaml";
import { classifyToolReply } from "core/util/toolDialectDetect";
import { recoverableDialect } from "core/util/toolDialectLeak";
import { describe, expect, it } from "vitest";
import {
  DIALECT_INFO,
  presetHint,
  SAMPLE_TOOL_NAME,
  toolPromptPreview,
} from "./toolPreview";

const NO_MARKUP: ToolDialectSetting[] = ["auto", "native", "off"];

describe("DIALECT_INFO", () => {
  it("describes every supported dialect, and nothing else", () => {
    expect(Object.keys(DIALECT_INFO).sort()).toEqual(
      [...TOOL_DIALECT_VALUES].sort(),
    );
    for (const v of TOOL_DIALECT_VALUES) {
      expect(DIALECT_INFO[v].label, v).toBeTruthy();
      expect(DIALECT_INFO[v].summary, v).toBeTruthy();
    }
  });

  it.each(TOOL_DIALECT_VALUES.filter((v) => !NO_MARKUP.includes(v)))(
    "the %s sample is what the classifier reads as that dialect",
    (dialect) => {
      const sample = DIALECT_INFO[dialect].sample;
      expect(sample).toContain(SAMPLE_TOOL_NAME);
      const read = classifyToolReply({
        content: sample,
        knownTools: [SAMPLE_TOOL_NAME],
      });
      expect(recoverableDialect(read.dialect)).toBe(dialect);
    },
  );

  it("shows no sample for the settings that name no markup", () => {
    for (const v of NO_MARKUP) expect(DIALECT_INFO[v].sample).toBeUndefined();
  });
});

describe("toolPromptPreview", () => {
  it("shows the API tool definition for native tool calls", () => {
    const text = toolPromptPreview("native");
    const parsed = JSON.parse(text);
    expect(parsed.tools[0].function.name).toBe(SAMPLE_TOOL_NAME);
    expect(parsed.tools[0].function.parameters.required).toEqual(["filepath"]);
  });

  it("shows the system-message text the chat adds for prompted tools", () => {
    const text = toolPromptPreview("systemMessage");
    expect(text).toContain("<tool_use_instructions>");
    expect(text).toContain(`TOOL_NAME: ${SAMPLE_TOOL_NAME}`);
    expect(text).toContain("```tool");
  });
});

describe("presetHint", () => {
  it("reads the family's prompt style from the preset table", () => {
    const hint = presetHint("qwen.qwen3-coder-30b-a3b-v1:0");
    expect(hint?.style).toBeTruthy();
    expect(hint?.evidence).toBeTruthy();
  });

  it("is undefined for an unknown model", () => {
    expect(presetHint("totally-unknown-model")).toBeUndefined();
  });
});
