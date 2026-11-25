import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import {
  builtinForPreset,
  noChecksOn,
} from "core/tools/permissions/safetyDegrees.js";
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

import {
  approvalExtras,
  resetPolicyLevels,
} from "../permissions/policyLevels.js";

import { workerOptions } from "./loopWave.js";
import { applyLoopWorkerPolicy } from "./loopWorker.js";

afterEach(() => {
  resetPolicyLevels();
  state.mode = "normal";
});

describe("a loop worker gets the levels in force", () => {
  it("an --auto parent's worker runs the IDGAF preset, as its parent does: Permissive, no check on", () => {
    state.mode = "auto";
    const policy = workerOptions().policy;
    expect(policy?.levels?.tools).toBe("permissive");
    expect(policy?.levels?.edits).toBe("permissive");
    expect(policy?.levels?.context).toBe("permissive");
    // the levels alone do not say it: the checks are sent with them
    expect(noChecksOn(policy?.builtin)).toBe(true);
  });

  it("a worker started by an older parent, with no checks sent, keeps its own", () => {
    // nothing sent: the worker's checks stay what loading the file left them
    applyLoopWorkerPolicy({ levels: DEFAULT_POLICY_LEVELS });
    expect(noChecksOn(approvalExtras("normal").builtin)).toBe(false);
  });

  it("a worker applies the checks its parent sent", () => {
    applyLoopWorkerPolicy({
      levels: DEFAULT_POLICY_LEVELS,
      builtin: builtinForPreset("idgaf"),
    });
    expect(noChecksOn(approvalExtras("normal").builtin)).toBe(true);
  });

  it("a normal parent's worker gets the levels as set, and no checks off", () => {
    const policy = workerOptions().policy;
    expect(policy?.levels).toEqual(DEFAULT_POLICY_LEVELS);
    expect(noChecksOn(policy?.builtin)).toBe(false);
  });
});
