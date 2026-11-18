import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { POLICY_PRESETS } from "core/tools/permissions/policy.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  model: { assistant: undefined as any, authConfig: {} as any },
  mode: "normal" as "normal" | "plan" | "auto",
  engine: undefined as undefined | (() => never),
  trail: {
    enabled: true,
    decision: undefined as any,
    answer: undefined as any,
    outcome: undefined as any,
  },
}));

vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: { MODEL: "model", TOOL_PERMISSIONS: "toolPermissions" },
  serviceContainer: {
    get: vi.fn(async () => state.model),
    getSync: vi.fn(() => ({ value: state.model })),
  },
  services: {
    chatHistory: { getHistory: () => [] },
    toolPermissions: { getCurrentMode: () => state.mode },
  },
}));

vi.mock("../permissions/coreRules.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../permissions/coreRules.js")>();
  return {
    ...actual,
    evaluateWithCoreRules: vi.fn(async (input: any) => {
      if (state.engine) return state.engine();
      return actual.evaluateWithCoreRules(input);
    }),
  };
});

vi.mock("core/tools/permissions/audit/global.js", () => ({
  getAuditTrail: () => state.trail,
}));

import {
  resetPolicyLevels,
  setPolicyLevels,
} from "../permissions/policyLevels.js";

import { checkToolPermissionApproval } from "./streamChatResponse.helpers.js";

const bash = (command: string): any => ({
  id: "call-1",
  name: "Bash",
  arguments: { command },
  argumentsStr: JSON.stringify({ command }),
  tool: {
    evaluateToolCallPolicy: (base: any, args: any) =>
      evaluateTerminalCommandSecurity(base, args.command),
  },
});
const call = (name: string, args: Record<string, unknown> = {}): any => ({
  id: "call-2",
  name,
  arguments: args,
  argumentsStr: JSON.stringify(args),
  tool: {},
});

/** A prompt that must never be shown at IDGAF */
const prompt = () => {
  const onToolPermissionRequest = vi.fn(async () => true);
  return {
    callbacks: { onToolPermissionRequest } as any,
    onToolPermissionRequest,
  };
};

const interactive = {
  policies: [
    { tool: "Bash", permission: "ask" as const },
    { tool: "*", permission: "ask" as const },
  ],
};

beforeEach(() => {
  state.model = { assistant: undefined, authConfig: {} };
  state.mode = "normal";
  state.engine = undefined;
  state.trail = {
    enabled: true,
    decision: vi.fn(),
    answer: vi.fn(),
    outcome: vi.fn(),
  };
  resetPolicyLevels();
  setPolicyLevels(POLICY_PRESETS.idgaf.levels);
});

describe("IDGAF never asks and never refuses a call", () => {
  it("runs a tool core has no name for (Subagent) that the catch-all asks about", async () => {
    const { callbacks, onToolPermissionRequest } = prompt();
    const r = await checkToolPermissionApproval(
      interactive,
      call("Subagent", { prompt: "look" }),
      callbacks,
      false,
    );
    expect(r).toEqual({ approved: true });
    expect(onToolPermissionRequest).not.toHaveBeenCalled();
    expect(state.trail.answer).not.toHaveBeenCalled();
  });

  it("runs a call a Never rule (exclude) refuses, and the trail says it would have", async () => {
    const r = await checkToolPermissionApproval(
      { policies: [{ tool: "Bash", permission: "exclude" }] },
      bash("npm test"),
      {},
      true,
    );
    expect(r).toEqual({ approved: true });
    expect(state.trail.decision.mock.calls[0][0]).toMatchObject({
      policy: "allow",
    });
  });

  it("runs what a guard would refuse or ask about: a secret file, the safety floor, a hidden command", async () => {
    for (const command of ["cat .env", "rm -rf /", "G=rm; $G -rf ~"]) {
      const { callbacks, onToolPermissionRequest } = prompt();
      const r = await checkToolPermissionApproval(
        interactive,
        bash(command),
        callbacks,
        false,
      );
      expect(r, command).toEqual({ approved: true });
      expect(onToolPermissionRequest).not.toHaveBeenCalled();
    }
    expect(state.trail.answer).not.toHaveBeenCalled();
    const reason = state.trail.decision.mock.calls[0][0].reason;
    expect(reason).toContain("would have been");
  });

  it("runs when the rule engine fails, as there is nothing for it to decide", async () => {
    state.engine = () => {
      throw new Error("boom");
    };
    const r = await checkToolPermissionApproval(
      interactive,
      bash("ls"),
      {},
      true,
    );
    expect(r).toEqual({ approved: true });
  });

  it("keeps a structural limit (a subagent cannot start a subagent)", async () => {
    const r = await checkToolPermissionApproval(
      {
        policies: [
          { tool: "Subagent", permission: "exclude", structural: true },
        ],
      },
      call("Subagent"),
      {},
      true,
    );
    expect(r.approved).toBe(false);
  });

  it("below IDGAF the catch-all still asks (headless: refused)", async () => {
    resetPolicyLevels();
    const r = await checkToolPermissionApproval(
      interactive,
      call("Subagent"),
      {},
      true,
    );
    expect(r.approved).toBe(false);
  });
});
