import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "normal" as string }));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    getServiceSync: vi.fn((name: string) =>
      name === "toolPermissions"
        ? { value: { currentMode: state.mode, isHeadless: true } }
        : { value: undefined },
    ),
  };
});

import { resetPolicyLevels } from "../permissions/policyLevels.js";

import { workerOptions } from "./loopWave.js";

afterEach(() => {
  resetPolicyLevels();
  state.mode = "normal";
});

describe("a loop worker gets the levels in force", () => {
  it("an --auto parent's worker runs at IDGAF on the tool areas, as its parent does", () => {
    state.mode = "auto";
    const levels = workerOptions().policy?.levels;
    expect(levels?.tools).toBe("idgaf");
    expect(levels?.edits).toBe("idgaf");
    expect(levels?.context).toBe("idgaf");
  });

  it("a normal parent's worker gets the levels as set", () => {
    expect(workerOptions().policy?.levels).toEqual(DEFAULT_POLICY_LEVELS);
  });
});
