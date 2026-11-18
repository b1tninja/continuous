import type { ModelConfig } from "@continuedev/config-yaml";
import { REASONING_EFFORT_NOT_APPLIED } from "@continuedev/openai-adapters";
import { describe, expect, it } from "vitest";

import { checkModeModelsForCli } from "./modeModelsCheck.js";

const models = [
  {
    name: "Opus",
    provider: "anthropic",
    model: "claude-opus",
    roles: ["chat"],
  },
  { name: "Nova", provider: "bedrock", model: "nova-pro" },
  { name: "Command", provider: "cohere", model: "command-r", roles: ["chat"] },
  { name: "Judge", provider: "openai", model: "o3-mini", roles: ["reviewer"] },
  { name: "Mini", provider: "openai", model: "gpt-mini", roles: ["chat"] },
] as ModelConfig[];

describe("checkModeModelsForCli (M8)", () => {
  it("is quiet for a config the CLI reads whole", () => {
    expect(
      checkModeModelsForCli(
        {
          plan: { model: "Opus", reasoningEffort: "high" },
          agent: { models: ["Nova", "Mini"], reasoningEffort: "low" },
          loop: { reasoningEffort: "medium" },
          reviewer: { model: "Judge" },
        },
        models,
      ),
    ).toEqual([]);
    expect(checkModeModelsForCli(undefined, models)).toEqual([]);
  });

  it("applies Anthropic's effort since #852: no warning for it", () => {
    expect(
      checkModeModelsForCli(
        { plan: { model: "Opus", reasoningEffort: "high" } },
        models,
      ),
    ).toEqual([]);
  });

  it("names an unknown name and a non-chat name, with the use", () => {
    expect(
      checkModeModelsForCli(
        { plan: { model: "Gone" }, loop: { model: "Judge" } },
        models,
      ),
    ).toEqual([
      'modeModels.plan: no model is named "Gone", so the CLI does not switch models for plan.',
      'modeModels.loop: "Judge" is not a chat model (roles: reviewer), so the CLI does not switch to it for loop.',
    ]);
  });

  it("names an effort the provider's adapter does not send, also through a fallback", () => {
    expect(
      checkModeModelsForCli(
        {
          agent: { model: "Command", reasoningEffort: "high" },
          loop: { reasoningEffort: "low" }, // the agent entry's model
        },
        models,
      ),
    ).toEqual([
      'modeModels.agent: reasoningEffort "high" is not applied to "Command": the CLI\'s cohere adapter sends no reasoning field.',
      'modeModels.loop: reasoningEffort "low" is not applied to "Command": the CLI\'s cohere adapter sends no reasoning field.',
    ]);
  });

  it("says that off and the reviewer's effort are not applied", () => {
    const w = checkModeModelsForCli(
      {
        replan: { model: "Opus", reasoningEffort: "off" },
        reviewer: { model: "Nope", reasoningEffort: "high" },
      },
      models,
    );
    expect(w).toHaveLength(3);
    expect(w[0]).toContain('modeModels.replan: reasoningEffort "off"');
    expect(w[1]).toContain('no model is named "Nope"');
    expect(w[2]).toContain('modeModels.reviewer: reasoningEffort "high"');
  });

  it("reads the providers from the adapters' table, not a list of its own", () => {
    for (const provider of REASONING_EFFORT_NOT_APPLIED) {
      const w = checkModeModelsForCli(
        { plan: { model: "X", reasoningEffort: "high" } },
        [{ name: "X", provider, model: "x" } as ModelConfig],
      );
      expect(w, provider).toHaveLength(1);
    }
  });
});
