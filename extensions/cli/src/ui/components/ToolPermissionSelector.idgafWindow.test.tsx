import fs from "fs";
import os from "os";
import path from "path";

import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { PLAN_MODE_HOLD_REASON } from "core/tools/permissions/planMode.js";
import { POLICY_PRESETS } from "core/tools/permissions/policy.js";
import { refusalText } from "core/tools/refusalText.js";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  model: { assistant: undefined as any, authConfig: {} as any },
  mode: "normal" as "normal" | "plan" | "auto",
  loop: undefined as any,
  trail: {
    enabled: true,
    decision: undefined as any,
    answer: undefined as any,
    outcome: undefined as any,
    timerResolved: undefined as any,
  },
}));

vi.mock("../../services/index.js", () => ({
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
vi.mock("core/tools/permissions/audit/global.js", () => ({
  getAuditTrail: () => state.trail,
}));
vi.mock("../../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../session.js")>();
  return { ...actual, getSessionLoop: () => state.loop };
});
vi.mock("../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ columns: 200, rows: 24, isResizing: false }),
}));

import {
  getCountdown,
  resetTurnBudget,
  setCountdownAvailable,
} from "../../permissions/askCountdown.js";
import { toolPermissionManager } from "../../permissions/permissionManager.js";
import {
  getPolicyLevels,
  loadPolicyFile,
  resetPolicyLevels,
  setPolicyLevels,
} from "../../permissions/policyLevels.js";
import { checkToolPermissionApproval } from "../../stream/streamChatResponse.helpers.js";
import { createStreamCallbacks } from "../hooks/useChat.stream.helpers.js";
import type { ActivePermissionRequest } from "../hooks/useChat.types.js";

import { ToolPermissionSelector } from "./ToolPermissionSelector.js";

/**
 * IDGAF is the top level and its heads-up window is 0 unless set
 * (`levels.headsUp.idgaf` in permissions.yaml). With a window, a call that runs
 * only because of IDGAF is shown first, with a countdown and what a lower level
 * would have done. It runs when the window ends; "Don't run" declines it.
 */
const ESC = "\x1b";
const TAB = "\t";

const bash = (command: string): any => ({
  id: "call-1",
  name: "Bash",
  arguments: { command },
  argumentsStr: JSON.stringify({ command }),
  tool: {
    name: "Bash",
    isBuiltIn: true,
    evaluateToolCallPolicy: (base: any, args: any) =>
      evaluateTerminalCommandSecurity(base, args.command),
  },
});

const interactive = {
  policies: [
    { tool: "Bash", permission: "ask" as const },
    { tool: "*", permission: "ask" as const },
  ],
};

let cwd: string;

/** permissions.yaml with the terminal offered in Plan mode and IDGAF's window. */
function policyFile(headsUp?: string) {
  const file = path.join(cwd, "permissions.yaml");
  fs.writeFileSync(
    file,
    [
      "plan:",
      "  allowTerminal: true",
      ...(headsUp ? ["levels:", "  headsUp:", `    ${headsUp}`] : []),
      "",
    ].join("\n"),
  );
  expect(loadPolicyFile(file)).toEqual([]);
  // IDGAF is for the session: it is set here, never read from the file
  setPolicyLevels(POLICY_PRESETS.idgaf.levels);
}

/** Runs the call through the real approval path, with the terminal UI's callbacks. */
function decide(call: any, headless = false) {
  const shown: ActivePermissionRequest[] = [];
  const callbacks = createStreamCallbacks({
    setChatHistory: vi.fn(),
    setActivePermissionRequest: ((r: ActivePermissionRequest | null) => {
      if (r) shown.push(r);
    }) as never,
  });
  const result = checkToolPermissionApproval(
    interactive,
    call,
    callbacks,
    headless,
  );
  return { shown, result };
}

/** The prompt the terminal UI draws for a request, answering through the manager. */
function prompt(request: ActivePermissionRequest) {
  return render(
    <ToolPermissionSelector
      toolName={request.toolName}
      toolArgs={request.toolArgs}
      requestId={request.requestId}
      toolCallPreview={request.toolCallPreview}
      why={request.why}
      onResponse={(id, approved) =>
        approved
          ? toolPermissionManager.approveRequest(id)
          : toolPermissionManager.rejectRequest(id)
      }
    />,
  );
}

const flat = (frame: string | undefined) =>
  (frame ?? "").replace(/[\s│]+/g, " ");

beforeEach(() => {
  state.model = { assistant: undefined, authConfig: {} };
  state.mode = "plan";
  state.loop = undefined;
  state.trail = {
    enabled: true,
    decision: vi.fn(),
    answer: vi.fn(),
    outcome: vi.fn(),
    timerResolved: vi.fn(),
  };
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cn-idgaf-window-"));
  // git is vouched as read-only only in a repository whose config runs nothing
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.writeFileSync(
    path.join(cwd, ".git", "config"),
    "[core]\n\tbare = false\n",
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(cwd, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_SYSTEM", path.join(cwd, "no-system-config"));
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  resetPolicyLevels();
  resetTurnBudget();
  setCountdownAvailable(true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setCountdownAvailable(false);
  resetPolicyLevels();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("IDGAF's heads-up window at 0, the default", () => {
  it("in Plan mode a command that changes things runs at once, with no prompt", async () => {
    policyFile();
    const { shown, result } = decide(bash("mkdir x"));
    expect(await result).toEqual({ approved: true });
    expect(shown).toEqual([]);
    expect(state.trail.decision.mock.calls[0][0]).toMatchObject({
      policy: "allow",
      wouldHave: { policy: "ask", source: "plan-mode" },
    });
    expect(state.trail.timerResolved).not.toHaveBeenCalled();
  });

  it("a window set for another level changes nothing at IDGAF", async () => {
    policyFile("permissive: 5");
    const { shown, result } = decide(bash("mkdir x"));
    expect(await result).toEqual({ approved: true });
    expect(shown).toEqual([]);
  });
});

describe("IDGAF with a heads-up window of 5 s", () => {
  it("shows the call with a countdown and Plan mode's reason, and runs it when the window ends", async () => {
    policyFile("idgaf: 5");
    const { shown, result } = decide(bash("mkdir x"));
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    const id = shown[0].requestId;
    expect(getCountdown(id)).toMatchObject({
      secondsLeft: 5,
      seconds: 5,
      proposed: "allow",
    });

    const ui = prompt(shown[0]);
    const frame = flat(ui.lastFrame());
    expect(frame).toContain(
      "Runs in 5 s unless you answer. Press w to keep waiting.",
    );
    expect(frame).toContain(
      `Below IDGAF this call would have been asked: ${PLAN_MODE_HOLD_REASON}`,
    );
    expect(frame).toContain("Run now");
    expect(frame).toContain("Don't run (the agent goes on without it)");
    expect(frame).not.toContain("always allow");
    expect(frame).not.toContain("Would you like to continue?");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(flat(ui.lastFrame())).toContain("Runs in 2 s unless you answer.");
    expect(toolPermissionManager.getPendingRequestIds()).toContain(id);
    ui.unmount();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toEqual({ approved: true });
    expect(getCountdown(id)).toBeUndefined();
    // The trail: the policy allowed it past Plan mode, and nobody answered
    expect(state.trail.decision.mock.calls[0][0]).toMatchObject({
      policy: "allow",
      level: "idgaf",
      wouldHave: { policy: "ask", source: "plan-mode" },
    });
    expect(state.trail.timerResolved).toHaveBeenCalledWith(
      "call-1",
      { outcome: "default-applied", final: "allow" },
      { proposed: "allow", seconds: 5 },
    );
    expect(state.trail.answer).not.toHaveBeenCalled();
  });

  it("Don't run declines that one call: nothing runs, and the level stays", async () => {
    policyFile("idgaf: 5");
    const { shown, result } = decide(bash("mkdir x"));
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    const ui = prompt(shown[0]);
    await vi.advanceTimersByTimeAsync(1_000);
    ui.stdin.write(ESC);
    await vi.advanceTimersByTimeAsync(100);
    ui.unmount();

    const r = await result;
    expect(r).toEqual({
      approved: false,
      denialReason: "timer",
      denialMessage: refusalText.declined("Bash"),
    });
    expect(state.trail.timerResolved).toHaveBeenCalledWith(
      "call-1",
      { outcome: "overridden", final: "refuse" },
      { proposed: "allow", seconds: 5 },
    );
    expect(getPolicyLevels().tools).toBe("idgaf");
    // The window that would have run it ended with the answer
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toolPermissionManager.getPendingRequestIds()).toEqual([]);
  });

  it("Run now runs it without waiting, as the person's choice", async () => {
    policyFile("idgaf: 5");
    const { shown, result } = decide(bash("mkdir x"));
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    const ui = prompt(shown[0]);
    await vi.advanceTimersByTimeAsync(1_000);
    ui.stdin.write(TAB);
    await vi.advanceTimersByTimeAsync(100);
    ui.unmount();
    expect(await result).toEqual({ approved: true });
    expect(state.trail.timerResolved).toHaveBeenCalledWith(
      "call-1",
      { outcome: "confirmed", final: "allow" },
      { proposed: "allow", seconds: 5 },
    );
  });

  it("w stops the countdown: the call waits, and the reason stays on the prompt", async () => {
    policyFile("idgaf: 5");
    const { shown, result } = decide(bash("mkdir x"));
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    const ui = prompt(shown[0]);
    await vi.advanceTimersByTimeAsync(1_000);
    ui.stdin.write("w");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toolPermissionManager.getPendingRequestIds()).toHaveLength(1);
    const frame = flat(ui.lastFrame());
    expect(frame).not.toContain("unless you answer");
    expect(frame).toContain("Below IDGAF this call would have been asked");
    ui.stdin.write(ESC);
    await vi.advanceTimersByTimeAsync(100);
    ui.unmount();
    expect((await result).approved).toBe(false);
    expect(state.trail.answer).toHaveBeenCalledWith("call-1", false, "person");
  });

  it("a command that only reads would run below IDGAF too: it is not delayed", async () => {
    policyFile("idgaf: 5");
    const { shown, result } = decide(bash("git log -n 1"));
    expect(await result).toEqual({ approved: true });
    expect(shown).toEqual([]);
  });

  it("outside Plan mode, a command nothing would have stopped is not delayed", async () => {
    policyFile("idgaf: 5");
    state.mode = "normal";
    const { shown, result } = decide(bash("mkdir x"));
    expect(await result).toEqual({ approved: true });
    expect(shown).toEqual([]);
  });

  it("outside Plan mode, a call a rule would have asked about or refused gets the window", async () => {
    policyFile("idgaf: 10");
    state.mode = "normal";
    state.model.assistant = {
      toolPermissions: {
        ask: ["runTerminalCommand(git push*)"],
        deny: ["runTerminalCommand(terraform destroy*)"],
      },
    };
    for (const [command, was] of [
      ["git push origin main", "asked"],
      ["terraform destroy", "refused"],
    ]) {
      const { shown, result } = decide(bash(command));
      await vi.waitFor(() => expect(shown).toHaveLength(1));
      const ui = prompt(shown[0]);
      const frame = flat(ui.lastFrame());
      expect(frame).toContain("Runs in 10 s unless you answer.");
      expect(frame).toContain(`Below IDGAF this call would have been ${was}: `);
      ui.unmount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result, command).toEqual({ approved: true });
    }
  });
});

describe("nobody to show it to: no window", () => {
  it("a headless run (cn -p) runs it at once", async () => {
    policyFile("idgaf: 5");
    const { shown, result } = decide(bash("mkdir x"), true);
    expect(await result).toEqual({ approved: true });
    expect(shown).toEqual([]);
    expect(state.trail.timerResolved).not.toHaveBeenCalled();
  });

  it("a process with no terminal UI (cn serve) runs it at once", async () => {
    policyFile("idgaf: 5");
    setCountdownAvailable(false);
    const { shown, result } = decide(bash("mkdir x"));
    expect(await result).toEqual({ approved: true });
    expect(shown).toEqual([]);
  });

  it("a Loop step runs it at once", async () => {
    policyFile("idgaf: 5");
    state.loop = { current: { kind: "item", id: "run" } };
    const { shown, result } = decide(bash("mkdir x"));
    expect(await result).toEqual({ approved: true });
    expect(shown).toEqual([]);
  });
});
