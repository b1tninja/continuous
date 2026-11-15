import { describe, expect, it } from "vitest";
import {
  CONTEXT_HIGH_FRACTION,
  CONTEXT_WARN_FRACTION,
  contextLevel,
} from "./contextLevel";

describe("contextLevel", () => {
  it("steps at the documented thresholds", () => {
    expect(contextLevel(0)).toBe("ok");
    expect(contextLevel(CONTEXT_WARN_FRACTION - 0.01)).toBe("ok");
    expect(contextLevel(CONTEXT_WARN_FRACTION)).toBe("warn");
    expect(contextLevel(CONTEXT_HIGH_FRACTION - 0.01)).toBe("warn");
    expect(contextLevel(CONTEXT_HIGH_FRACTION)).toBe("high");
  });

  it("is high once messages are being left out, and at least warn when large", () => {
    expect(contextLevel(0.1, { pruned: true })).toBe("high");
    expect(contextLevel(0.1, { large: true })).toBe("warn");
    expect(contextLevel(0.9, { large: true })).toBe("high");
  });
});
