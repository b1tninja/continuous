import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { reasoningEffortFromOptions } from "../reasoningEffort";
import { getAnthropicThinkingParams } from "./anthropicThinking";

// Loaded at run time from a path held in a variable, not with a static import,
// for the reason given in bedrockOneHourCache.vitest.ts.
const ADAPTER_HELPERS = pathToFileURL(
  resolve(
    __dirname,
    "../../../packages/openai-adapters/src/apis/bedrockHelpers.ts",
  ),
).href;
const ADAPTER_SWITCH = pathToFileURL(
  resolve(
    __dirname,
    "../../../packages/openai-adapters/src/apis/reasoningSwitch.ts",
  ),
).href;

let claudeThinkingFields: (
  model: string,
  reasoning: boolean | undefined,
  budgetTokens: number,
) => unknown;
let reasoningSwitch: (effort: string | undefined) => {
  reasoning: boolean | undefined;
  budgetTokens: number;
};

beforeAll(async () => {
  ({ claudeThinkingFields } = await import(/* @vite-ignore */ ADAPTER_HELPERS));
  ({ reasoningSwitch } = await import(/* @vite-ignore */ ADAPTER_SWITCH));
});

const MODELS = [
  "claude-3-7-sonnet-20250219",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
  "claude-mythos-5-2",
];

const SETTINGS: { reasoning?: boolean; reasoningBudgetTokens?: number }[] = [
  {},
  { reasoning: false },
  { reasoning: true },
  { reasoning: true, reasoningBudgetTokens: 1024 },
  { reasoning: true, reasoningBudgetTokens: 4096 },
  { reasoning: true, reasoningBudgetTokens: 16384 },
];

/**
 * The adapter's Anthropic path (the CLI, Vertex Claude) gets the IDE's
 * reasoning setting as `reasoning_effort` (reasoningEffortFromOptions) and
 * turns it back into Claude's `thinking` (claudeThinkingFields). The request
 * must match core's own (getAnthropicThinkingParams) wherever the effort
 * carries the setting: on adaptive models always; on budget models when the
 * budget is one of the levels' budgets.
 */
describe("Claude thinking: core and the adapter agree", () => {
  for (const model of MODELS) {
    for (const setting of SETTINGS) {
      it(`${model} ${JSON.stringify(setting)}`, () => {
        const fromCore = getAnthropicThinkingParams({ model, ...setting });
        const { reasoning, budgetTokens } = reasoningSwitch(
          reasoningEffortFromOptions(setting),
        );
        const fromAdapter = claudeThinkingFields(
          model,
          reasoning,
          budgetTokens,
        );
        const budgetModel = (fromCore.thinking as { type?: string })?.type;
        if (
          budgetModel === "enabled" &&
          ![1024, 4096, 16384].includes(setting.reasoningBudgetTokens ?? -1)
        ) {
          // 2048 (the default) is sent as "medium", 4096 tokens
          expect((fromAdapter as any).thinking.type).toBe("enabled");
          return;
        }
        expect(fromAdapter).toEqual(fromCore);
      });
    }
  }
});
