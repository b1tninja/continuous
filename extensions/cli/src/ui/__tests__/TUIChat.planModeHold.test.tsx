import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadPolicyFile,
  resetPolicyLevels,
} from "../../permissions/policyLevels.js";
import { CONFIRM_ARM_MS } from "../hooks/useInterruptConfirm.js";

import {
  ENTER,
  messageText,
  registerFlowServices,
  renderFlow,
  resetFlowState,
  ScriptedLlm,
  textTurn,
  tick,
  toolTurn,
  type,
  waitUntil,
} from "./TUIChat.flowHarness.js";

/**
 * Plan mode's hold is the engine's (core's planModeVerdict), as in the IDE:
 * with the terminal opted back in (`plan.allowTerminal`) and Tool use at
 * Permissive, a command that changes things still asks, and a command that
 * only reads runs.
 */
describe("TUIChat - plan mode holds what a level would run", () => {
  let cwd: string;

  beforeEach(async () => {
    await resetFlowState();
    resetPolicyLevels();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cn-plan-hold-"));
    // git is vouched as read-only only in a repository whose config runs
    // nothing, so the test has one of its own and no machine-wide git config
    fs.mkdirSync(path.join(cwd, ".git"));
    fs.writeFileSync(
      path.join(cwd, ".git", "config"),
      "[core]\n\tbare = false\n",
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(cwd, "no-global-config"));
    vi.stubEnv("GIT_CONFIG_SYSTEM", path.join(cwd, "no-system-config"));
    vi.stubEnv("GIT_CONFIG_COUNT", "0");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    const policyFile = path.join(cwd, "permissions.yaml");
    fs.writeFileSync(
      policyFile,
      [
        "levels:",
        "  context: permissive",
        "  tools: permissive",
        "plan:",
        "  allowTerminal: true",
        "",
      ].join("\n"),
    );
    expect(loadPolicyFile(policyFile)).toEqual([]);
  });

  afterEach(async () => {
    await resetFlowState();
    resetPolicyLevels();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // `touch` is a Unix tool, so on Windows the shell check asks about it as
  // well and its warning is the reason shown; `mkdir` exists in every shell,
  // so there Plan mode is the only thing asking
  it.each([
    ["touch x", process.platform !== "win32"],
    ["mkdir x", true],
  ])("asks before `%s`", async (command, planModeIsWhy) => {
    const llm = new ScriptedLlm([
      toolTurn("Bash", { command }),
      textTurn("unreachable"),
    ]);
    await registerFlowServices({ llm, mode: "plan" });
    const ui = renderFlow();
    try {
      await type(ui.stdin, "make a file");
      await type(ui.stdin, ENTER);
      await waitUntil(
        () => (ui.lastFrame() ?? "").includes("Would you like to continue?"),
        `the permission prompt for ${command}`,
        ui.lastFrame,
      );
      if (planModeIsWhy) {
        const frame = (ui.lastFrame() ?? "").replace(/[\s│]+/g, " ");
        expect(frame).toContain(
          "Why: Plan mode asks before anything that changes files or state.",
        );
        expect(frame).toContain(
          "From: Plan mode, the mode this session is in (plan-mode)",
        );
      }
      expect(fs.existsSync(path.join(cwd, "x"))).toBe(false);

      // "n" refuses and stops the turn, after the stop question
      await type(ui.stdin, "n");
      await tick(CONFIRM_ARM_MS);
      await type(ui.stdin, ENTER);
      await waitUntil(
        () => ui.allOutput().includes("Tool canceled"),
        "the refusal",
        ui.lastFrame,
      );
      await tick(200);
      expect(llm.requests).toHaveLength(1);
      expect(fs.existsSync(path.join(cwd, "x"))).toBe(false);
    } finally {
      ui.unmount();
    }
  });

  it("runs `git log` without asking", async () => {
    const llm = new ScriptedLlm([
      // One commit: the command runs in the real working folder
      toolTurn("Bash", { command: "git log -n 1" }),
      textTurn("history read"),
    ]);
    await registerFlowServices({ llm, mode: "plan" });
    const ui = renderFlow();
    try {
      await type(ui.stdin, "what changed lately");
      await type(ui.stdin, ENTER);
      await waitUntil(
        () => llm.requests.length === 2,
        "the request after git log ran",
        ui.lastFrame,
      );
      expect(ui.allOutput()).not.toContain("Would you like to continue?");
      // The command's own result came back: it was run, not refused
      const result = llm.requests[1].messages.find((m) => m.role === "tool");
      expect(result).toBeDefined();
      expect(messageText(result!)).not.toMatch(/declined|blocked|Plan mode/i);
    } finally {
      ui.unmount();
    }
  });
});
