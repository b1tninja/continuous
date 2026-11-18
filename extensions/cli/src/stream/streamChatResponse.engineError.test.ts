import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  model: { assistant: undefined as any, authConfig: {} as any },
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
  services: { chatHistory: { getHistory: () => [] } },
}));

// The engine itself, replaced by one that throws: what a bug in a rule
// matcher, a parser or a settings read would look like to the CLI.
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

import { toolPermissionManager } from "../permissions/permissionManager.js";
import { resetPolicyLevels } from "../permissions/policyLevels.js";

import {
  checkToolPermissionApproval,
  ENGINE_ERROR_REASON,
} from "./streamChatResponse.helpers.js";

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

/** The headless list defaults: Bash and every unlisted tool allowed. */
const headlessDefaults = {
  policies: [
    { tool: "Bash", permission: "allow" as const },
    { tool: "*", permission: "allow" as const },
  ],
};

const throwingEngine = () => {
  throw new Error("boom: the rule engine failed");
};

beforeEach(() => {
  state.model = { assistant: undefined, authConfig: {} };
  state.engine = undefined;
  state.trail = {
    enabled: true,
    decision: vi.fn(),
    answer: vi.fn(),
    outcome: vi.fn(),
  };
  resetPolicyLevels();
});

describe("the rule engine throws at the default levels, with no rules written", () => {
  it("control: the same call is allowed while the engine works", async () => {
    expect(
      await checkToolPermissionApproval(headlessDefaults, bash("ls"), {}, true),
    ).toEqual({ approved: true });
  });

  it("headless: the call is refused with a reason, never left to the list's allow", async () => {
    state.engine = throwingEngine;
    const r = await checkToolPermissionApproval(
      headlessDefaults,
      bash("cat .env"),
      {},
      true,
    );
    expect(r.approved).toBe(false);
    expect(r.denialReason).toBe("policy");
    expect(r.denialMessage).toContain(ENGINE_ERROR_REASON);
    expect(r.denialMessage).toMatch(/headless/i);
  });

  it("headless: the refusal is in the audit trail as the system's, with the reason", async () => {
    state.engine = throwingEngine;
    await checkToolPermissionApproval(headlessDefaults, bash("ls"), {}, true);
    expect(state.trail.decision).toHaveBeenCalledTimes(1);
    expect(state.trail.decision.mock.calls[0][0]).toMatchObject({
      callId: "call-1",
      tool: "Bash",
      policy: "deny",
      by: "system",
      reason: ENGINE_ERROR_REASON,
    });
    expect(state.trail.answer).not.toHaveBeenCalled();
  });

  it("interactive: the person is asked, and their answer decides", async () => {
    state.engine = throwingEngine;
    const shown: string[] = [];
    const callbacks = {
      onToolPermissionRequest: vi.fn((_n: string, _a: any, requestId: string) =>
        shown.push(requestId),
      ),
    };

    const approved = checkToolPermissionApproval(
      headlessDefaults,
      bash("ls"),
      callbacks,
      false,
    );
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    toolPermissionManager.approveRequest(shown[0]);
    expect(await approved).toEqual({ approved: true });
    expect(state.trail.decision.mock.calls[0][0]).toMatchObject({
      policy: "ask",
      by: "system",
      reason: ENGINE_ERROR_REASON,
    });
    expect(state.trail.answer).toHaveBeenCalledWith("call-1", true, "person");

    const rejected = checkToolPermissionApproval(
      headlessDefaults,
      bash("ls"),
      callbacks,
      false,
    );
    await vi.waitFor(() => expect(shown).toHaveLength(2));
    toolPermissionManager.rejectRequest(shown[1]);
    expect(await rejected).toEqual({ approved: false, denialReason: "user" });
  });

  it("interactive with no way to ask (a subagent, a worker): refused", async () => {
    state.engine = throwingEngine;
    expect(
      await checkToolPermissionApproval(
        headlessDefaults,
        bash("ls"),
        {},
        false,
      ),
    ).toEqual({ approved: false, denialReason: "user" });
  });

  it("a PreToolUse hook's allow does not stand in for the failed check", async () => {
    state.engine = throwingEngine;
    const r = await checkToolPermissionApproval(
      { policies: [{ tool: "*", permission: "ask" as const }] },
      bash("ls"),
      {},
      true,
      "allow",
    );
    expect(r).toMatchObject({ approved: false, denialReason: "policy" });
  });

  it("the CLI's own exclude still refuses without consulting the engine", async () => {
    state.engine = throwingEngine;
    const r = await checkToolPermissionApproval(
      { policies: [{ tool: "Bash", permission: "exclude" as const }] },
      bash("ls"),
      {},
      true,
    );
    expect(r).toMatchObject({ approved: false, denialReason: "policy" });
  });
});
