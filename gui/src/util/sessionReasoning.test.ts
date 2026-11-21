import { describe, expect, it } from "vitest";
import { sessionReasoningAfterConfig } from "./sessionReasoning";

const base = {
  supportsReasoning: true,
  reasoningDisabledOnModel: false,
  storedToggle: undefined,
  modeEffort: undefined,
} as const;

describe("sessionReasoningAfterConfig", () => {
  it("lets a stored bulb choice win over the mode effort", () => {
    expect(
      sessionReasoningAfterConfig({
        ...base,
        storedToggle: false,
        modeEffort: "high",
      }),
    ).toBe(false);
    expect(
      sessionReasoningAfterConfig({
        ...base,
        storedToggle: true,
        modeEffort: "off",
      }),
    ).toBe(true);
  });

  it("leaves the flag unset so a mode effort is what the request sends", () => {
    expect(
      sessionReasoningAfterConfig({ ...base, modeEffort: "medium" }),
    ).toBeUndefined();
    expect(
      sessionReasoningAfterConfig({ ...base, modeEffort: "off" }),
    ).toBeUndefined();
  });

  it("turns reasoning on for a thinking model when nothing else is set", () => {
    expect(sessionReasoningAfterConfig(base)).toBe(true);
  });

  it("stays off for a model that does not think", () => {
    expect(
      sessionReasoningAfterConfig({ ...base, supportsReasoning: false }),
    ).toBe(false);
    expect(
      sessionReasoningAfterConfig({
        ...base,
        reasoningDisabledOnModel: true,
        storedToggle: true,
      }),
    ).toBe(false);
  });
});
