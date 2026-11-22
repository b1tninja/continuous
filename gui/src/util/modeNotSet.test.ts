import type { ModelDescription } from "core";
import { describe, expect, it } from "vitest";
import { modelSettingLabel } from "./modeNotSet";

const model = (extra: Partial<ModelDescription> = {}) =>
  ({
    title: "Claude",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    underlyingProviderName: "anthropic",
    ...extra,
  }) as ModelDescription;

describe("modelSettingLabel", () => {
  it("names the level the model's own setting sends", () => {
    expect(modelSettingLabel(model(), undefined)).toBe(
      "Model setting (medium)",
    );
    expect(
      modelSettingLabel(
        model({ completionOptions: { reasoningBudgetTokens: 512 } as never }),
        undefined,
      ),
    ).toBe("Model setting (low)");
  });

  it("says off when the model, or the session, turned reasoning off", () => {
    expect(
      modelSettingLabel(
        model({ completionOptions: { reasoning: false } as never }),
        undefined,
      ),
    ).toBe("Model setting (off)");
    expect(modelSettingLabel(model(), false)).toBe("Model setting (off)");
    expect(modelSettingLabel(model({ model: "gpt-4" }), undefined)).toBe(
      "Model setting (off)",
    );
  });

  it("has no level for Ollama, which takes no budget", () => {
    expect(
      modelSettingLabel(
        model({ underlyingProviderName: "ollama", provider: "ollama" }),
        true,
      ),
    ).toBe("Model setting (on)");
  });

  it("keeps the level and drops a word where there is no room", () => {
    expect(modelSettingLabel(model(), undefined, true)).toBe("Model (medium)");
    expect(modelSettingLabel(undefined, undefined, true)).toBe("Model");
  });
});
