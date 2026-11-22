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

  it("is the level alone, no wider than Medium, where there is no room", () => {
    expect(modelSettingLabel(model(), undefined, true)).toBe("(med)");
    expect(modelSettingLabel(model(), false, true)).toBe("(off)");
    expect(
      modelSettingLabel(
        model({
          completionOptions: { reasoningBudgetTokens: 16_000 } as never,
        }),
        undefined,
        true,
      ),
    ).toBe("(high)");
    expect(modelSettingLabel(undefined, undefined, true)).toBe("Model");
    for (const reasoning of [undefined, true, false]) {
      expect(
        modelSettingLabel(model(), reasoning, true).length,
      ).toBeLessThanOrEqual("Medium".length);
    }
  });
});
