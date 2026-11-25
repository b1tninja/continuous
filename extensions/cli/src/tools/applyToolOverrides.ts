import type { ToolOverrideConfig } from "@continuedev/config-yaml";
import type { ChatCompletionFunctionTool } from "openai/resources.mjs";

/**
 * Applies tool prompt overrides from YAML config to CLI tools.
 * Supports description changes and disabling tools.
 */
export function applyChatCompletionToolOverrides(
  tools: ChatCompletionFunctionTool[],
  overrides: Record<string, ToolOverrideConfig> | undefined,
): ChatCompletionFunctionTool[] {
  if (!overrides) {
    return tools;
  }

  return tools
    .filter((tool) => !overrides[tool.function.name]?.disabled)
    .map((tool) => {
      const override = overrides[tool.function.name];
      if (!override?.description) {
        return tool;
      }
      return {
        ...tool,
        function: {
          ...tool.function,
          description: override.description,
        },
      };
    });
}
