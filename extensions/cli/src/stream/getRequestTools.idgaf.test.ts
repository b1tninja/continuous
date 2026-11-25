import { beforeEach, describe, expect, it, vi } from "vitest";

import { setAutoReviewEnabled } from "../permissions/coreRules.js";
import {
  applyPolicyPreset,
  resetPolicyLevels,
} from "../permissions/policyLevels.js";

const tools = vi.hoisted(() => [
  { name: "Read", description: "", parameters: {}, readonly: true },
  { name: "Edit", description: "", parameters: {} },
  { name: "Write", description: "", parameters: {} },
  { name: "Bash", description: "", parameters: {} },
  { name: "Subagent", description: "", parameters: {} },
]);
const state = vi.hoisted(() => ({
  mode: "normal" as "normal" | "plan" | "auto",
  policies: [] as any[],
}));

vi.mock("../tools/index.js", () => ({
  getAllAvailableTools: vi.fn(async () => tools),
  convertToolToChatCompletionTool: (t: any) => ({ function: { name: t.name } }),
}));
vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: { TOOL_PERMISSIONS: "toolPermissions" },
  serviceContainer: {
    get: vi.fn(async () => ({
      permissions: { policies: state.policies },
      currentMode: state.mode,
    })),
  },
  services: {},
}));

import { getRequestTools } from "./handleToolCalls.js";

const names = (r: any[]) => r.map((t) => t.function.name);

/** The headless defaults, with a Never rule on Bash from permissions.yaml */
const headless = [
  { tool: "Bash", permission: "exclude" },
  { tool: "Edit", permission: "ask" },
  { tool: "Write", permission: "ask" },
  { tool: "Read", permission: "allow" },
  { tool: "*", permission: "allow" },
];

beforeEach(() => {
  setAutoReviewEnabled(false);
  resetPolicyLevels();
  state.mode = "normal";
  state.policies = headless;
});

describe("getRequestTools at IDGAF", () => {
  it("control: below IDGAF a headless run is offered ask tools (CO2), never excluded ones", async () => {
    expect(names(await getRequestTools(true))).toEqual([
      "Read",
      "Edit",
      "Write",
      "Subagent",
    ]);
  });

  it("headless: offers the tools that ask and the ones a Never rule excludes", async () => {
    applyPolicyPreset("idgaf");
    expect(names(await getRequestTools(true))).toEqual([
      "Read",
      "Edit",
      "Write",
      "Bash",
      "Subagent",
    ]);
  });

  it("keeps a structural limit (a subagent cannot start a subagent)", async () => {
    applyPolicyPreset("idgaf");
    state.policies = [
      { tool: "Subagent", permission: "exclude", structural: true },
      ...headless,
    ];
    expect(names(await getRequestTools(true))).not.toContain("Subagent");
  });

  it("Plan mode is its own mode: its policies stand at IDGAF", async () => {
    applyPolicyPreset("idgaf");
    state.mode = "plan";
    expect(names(await getRequestTools(true))).toEqual(["Read", "Subagent"]);
  });
});
