import { describe, expect, it } from "vitest";

import { runawayActionForLevel } from "./runawayAction";

describe("runawayActionForLevel", () => {
  it("lets a runaway run only at Permissive and IDGAF", () => {
    expect(runawayActionForLevel("permissive")).toBe("keep-running");
    expect(runawayActionForLevel("idgaf")).toBe("keep-running");
  });

  it("stops it at every other level", () => {
    for (const level of ["manual", "cautious", "automatic"]) {
      expect(runawayActionForLevel(level)).toBe("stop");
    }
  });

  it("stops it when the level is missing or not one it knows", () => {
    expect(runawayActionForLevel(undefined)).toBe("stop");
    expect(runawayActionForLevel("loose")).toBe("stop");
    expect(runawayActionForLevel("")).toBe("stop");
  });
});
