import { describe, expect, it } from "vitest";

import {
  describeModelInUse,
  effortOfModel,
  type ModelInUse,
  modelInUseLabel,
  modelInUseOf,
  ModelNoteGate,
} from "./modelInUse.js";

const opus = {
  name: "Opus",
  provider: "anthropic",
  model: "claude-opus",
  requestOptions: { extraBodyProperties: { reasoning_effort: "high" } },
} as any;

describe("the model in use (M7)", () => {
  it("reads the effort the requests carry, a use's or a catalog variant's", () => {
    expect(effortOfModel(opus)).toBe("high");
    expect(effortOfModel({ provider: "openai", model: "m" } as any)).toBe(
      undefined,
    );
    expect(effortOfModel(null)).toBeUndefined();
  });

  it("labels it `<name> (<effort>)`, the name alone without an effort", () => {
    const info = modelInUseOf(opus, "use", { use: "plan" });
    expect(info).toEqual({
      name: "Opus",
      model: "claude-opus",
      provider: "anthropic",
      effort: "high",
      reason: "use",
      use: "plan",
    });
    expect(modelInUseLabel(info)).toBe("Opus (high)");
    expect(modelInUseLabel({ name: "GPT-4" })).toBe("GPT-4");
  });

  it("says why in the transcript line, with the fallback reason", () => {
    const base = { name: "Nova", model: "nova", provider: "bedrock" };
    expect(describeModelInUse({ ...base, reason: "use", use: "plan" })).toBe(
      "Model: Nova, for Plan (modeModels)",
    );
    expect(
      describeModelInUse({
        ...base,
        reason: "use",
        use: "loop",
        fallbackReason: 'model "X" is not configured; using Nova',
      }),
    ).toBe(
      'Model: Nova, for Loop item (modeModels); model "X" is not configured; using Nova',
    );
    expect(describeModelInUse({ ...base, effort: "low", reason: "item" })).toBe(
      "Model: Nova (low), the Loop item's own model",
    );
    expect(
      describeModelInUse({ ...base, reason: "subagent", agent: "Helper" }),
    ).toBe("Model: Nova, subagent Helper");
  });

  it("writes one transcript line per change, none for /model or a subagent", () => {
    const start: ModelInUse = {
      name: "GPT-4",
      model: "gpt-4",
      provider: "openai",
      reason: "start",
    };
    const gate = new ModelNoteGate(start);
    expect(gate.next({ ...start, reason: "use", use: "agent" })).toBe(
      undefined,
    );
    const plan = modelInUseOf(opus, "use", { use: "plan" });
    expect(gate.next(plan)).toBe("Model: Opus (high), for Plan (modeModels)");
    expect(gate.next({ ...plan, use: "replan" })).toBeUndefined();
    expect(gate.next({ ...plan, effort: "low", use: "loop" })).toContain(
      "Opus (low)",
    );
    expect(gate.next({ ...start, reason: "manual" })).toBeUndefined();
    // the manual pick is what is shown now: switching to it again is no change
    expect(gate.next({ ...start, reason: "use", use: "agent" })).toBe(
      undefined,
    );
    expect(
      gate.next({ ...plan, reason: "subagent", agent: "Helper" }),
    ).toBeUndefined();
  });
});
