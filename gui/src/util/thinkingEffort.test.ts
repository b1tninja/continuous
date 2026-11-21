import { describe, expect, it } from "vitest";
import { applyThinkingEffort, parseThinkingEffort } from "./thinkingEffort";

describe("applyThinkingEffort", () => {
  it("writes only reasoningEffort when the mode already has a model", () => {
    const { update, modeModels } = applyThinkingEffort(
      { agent: { title: "Claude Opus", titles: ["Claude Opus"] } },
      "agent",
      "low",
      "Claude Opus",
    );
    expect(update).toEqual({ agent: { reasoningEffort: "low" } });
    expect(modeModels?.agent).toEqual({
      title: "Claude Opus",
      titles: ["Claude Opus"],
      reasoningEffort: "low",
    });
  });

  it("names the selected model when the mode has no entry to hang the effort on", () => {
    const { update, modeModels } = applyThinkingEffort(
      undefined,
      "plan",
      "high",
      "Claude Opus",
    );
    expect(update).toEqual({
      plan: { model: "Claude Opus", reasoningEffort: "high" },
    });
    expect(modeModels?.plan).toEqual({
      title: "Claude Opus",
      reasoningEffort: "high",
    });
  });

  it("clears the effort with null and leaves the model", () => {
    const { update, modeModels } = applyThinkingEffort(
      { agent: { title: "Claude Opus", reasoningEffort: "high" } },
      "agent",
      undefined,
      "Claude Opus",
    );
    expect(update).toEqual({ agent: { reasoningEffort: null } });
    expect(modeModels?.agent).toEqual({ title: "Claude Opus" });
  });

  it("rejects values outside the existing effort set", () => {
    expect(parseThinkingEffort("max")).toBeUndefined();
    expect(parseThinkingEffort("low")).toBe("low");
    expect(parseThinkingEffort("")).toBeUndefined();
  });
});
