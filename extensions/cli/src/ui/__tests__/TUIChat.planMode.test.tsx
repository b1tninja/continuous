import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadPolicyFile,
  resetPolicyLevels,
} from "../../permissions/policyLevels.js";
import { services } from "../../services/index.js";
import { getSessionPlanFile, getSessionTaskPlan } from "../../session.js";

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

const DOWN = "\x1b[B";

const planArgs = {
  title: "Add retry",
  plan: "Retry failed fetches with backoff.",
  todos: ["Add a retry helper", "Use it in fetch"],
};

/**
 * Plan mode through the TUI: PresentPlan saves the plan file and asks Build
 * or Keep planning; Build leaves plan mode. Bash is not offered unless plan.allowTerminal opts it in, and then it asks first, as MCP tools do.
 */
describe("TUIChat - plan mode", () => {
  let cwd: string;

  beforeEach(async () => {
    await resetFlowState();
    resetPolicyLevels();
    // PresentPlan writes .continuous/plans under the working directory
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cn-plan-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
  });

  afterEach(async () => {
    await resetFlowState();
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function presentPlan(answerKeys: string[], llm: ScriptedLlm) {
    await registerFlowServices({ llm, mode: "plan" });
    const ui = renderFlow();
    await type(ui.stdin, "plan a retry");
    await type(ui.stdin, ENTER);
    await waitUntil(
      () => (ui.lastFrame() ?? "").includes("Build this plan?"),
      "the Build / Keep planning question",
      ui.lastFrame,
    );
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain(".continuous/plans/add-retry.md");
    expect(frame).toContain("Build");
    expect(frame).toContain("Keep planning");
    for (const key of answerKeys) await type(ui.stdin, key);
    await waitUntil(
      () => llm.requests.length === 2,
      "the request after the answer",
      ui.lastFrame,
    );
    return ui;
  }

  it("PresentPlan saves the plan, and Build leaves plan mode with the to-dos as the task list", async () => {
    const llm = new ScriptedLlm([
      toolTurn("PresentPlan", planArgs),
      textTurn("building now"),
    ]);
    const ui = await presentPlan([ENTER], llm);
    try {
      const offered = llm.requests[0].tools.map((t) => t.function.name);
      expect(offered).toContain("PresentPlan");
      expect(offered).not.toContain("Write");
      expect(offered).not.toContain("Edit");

      const file = path.join(cwd, ".continuous", "plans", "add-retry.md");
      expect(fs.readFileSync(file, "utf-8")).toContain(
        "Retry failed fetches with backoff.",
      );
      expect(getSessionPlanFile()).toMatch(/add-retry\.md$/);
      expect(getSessionTaskPlan()?.items.map((i) => i.text)).toEqual(
        planArgs.todos,
      );

      const result = llm.requests[1].messages.find((m) => m.role === "tool");
      expect(messageText(result!)).toContain("The user approved the plan");
      expect(services.toolPermissions.getCurrentMode()).toBe("normal");
      // The next request is made in normal mode
      const nextTools = llm.requests[1].tools.map((t) => t.function.name);
      expect(nextTools).not.toContain("PresentPlan");
      expect(nextTools).toContain("Write");
      // The plan's checklist goes on being used
      expect(nextTools).toContain("TaskList");

      await waitUntil(
        () => ui.allOutput().includes("building now"),
        "the reply",
        ui.lastFrame,
      );
      const frame = ui.lastFrame() ?? "";
      expect(frame).not.toContain("plan]");
      expect(frame).toContain("0/2 Add a retry helper");
      expect(frame).toContain("plan add-retry.md");
    } finally {
      ui.unmount();
    }
  });

  it("Keep planning stays in plan mode", async () => {
    const llm = new ScriptedLlm([
      toolTurn("PresentPlan", planArgs),
      textTurn("what should change?"),
    ]);
    // Build, Build in a loop, Keep planning
    const ui = await presentPlan([DOWN, DOWN, ENTER], llm);
    try {
      const result = llm.requests[1].messages.find((m) => m.role === "tool");
      expect(messageText(result!)).toContain("The user wants to keep planning");
      expect(services.toolPermissions.getCurrentMode()).toBe("plan");
      expect(llm.requests[1].tools.map((t) => t.function.name)).toContain(
        "PresentPlan",
      );
      await waitUntil(
        () => ui.allOutput().includes("what should change?"),
        "the reply",
        ui.lastFrame,
      );
      expect(ui.lastFrame()).toContain("plan]");
    } finally {
      ui.unmount();
    }
  });

  it("does not offer Bash in plan mode by default", async () => {
    const llm = new ScriptedLlm([textTurn("just reading")]);
    await registerFlowServices({ llm, mode: "plan" });
    const ui = renderFlow();
    try {
      await type(ui.stdin, "look around");
      await type(ui.stdin, ENTER);
      await waitUntil(
        () => ui.allOutput().includes("just reading"),
        "the reply",
        ui.lastFrame,
      );
      const offered = llm.requests[0].tools.map((t) => t.function.name);
      expect(offered).not.toContain("Bash");
      expect(offered).toContain("Read");
    } finally {
      ui.unmount();
    }
  });

  it("asks before Bash in plan mode when plan.allowTerminal opts it in", async () => {
    const policyFile = path.join(cwd, "permissions.yaml");
    fs.writeFileSync(policyFile, "plan:\n  allowTerminal: true\n");
    loadPolicyFile(policyFile);
    const llm = new ScriptedLlm([
      // Not a command that only reads: those run in a plan turn
      toolTurn("Bash", { command: "npm install should-not-run" }),
      textTurn("unreachable"),
    ]);
    await registerFlowServices({ llm, mode: "plan" });
    const ui = renderFlow();
    try {
      await type(ui.stdin, "look around");
      await type(ui.stdin, ENTER);
      await waitUntil(
        () => (ui.lastFrame() ?? "").includes("Would you like to continue?"),
        "the permission prompt for Bash",
        ui.lastFrame,
      );
      expect(ui.lastFrame()).toContain("Bash");
      expect(llm.requests[0].tools.map((t) => t.function.name)).toContain(
        "Bash",
      );

      // "n" refuses and stops the turn
      await type(ui.stdin, "n");
      await waitUntil(
        () => ui.allOutput().includes("Tool canceled"),
        "the refusal",
        ui.lastFrame,
      );
      await tick(200);
      expect(llm.requests).toHaveLength(1);
      expect(ui.allOutput()).not.toContain("should-not-run\n");
    } finally {
      ui.unmount();
    }
  });

  it("hides an MCP tool the user did not list in plan mode, whatever its server claims", async () => {
    const runTool = vi
      .spyOn(services.mcp, "runTool")
      .mockResolvedValue({ content: [{ type: "text", text: "mcp ran" }] });
    const llm = new ScriptedLlm([
      toolTurn("lookup_issue", { id: "42" }),
      textTurn("done"),
    ]);
    await registerFlowServices({
      llm,
      mode: "plan",
      mcpTools: [
        {
          name: "lookup_issue",
          serverName: "docs",
          annotations: { readOnlyHint: true },
          description: "Look up an issue",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      ],
    });
    const ui = renderFlow();
    try {
      await type(ui.stdin, "read issue 42");
      await type(ui.stdin, ENTER);
      await waitUntil(
        () => llm.requests.length === 2,
        "the request after the refused call",
        ui.lastFrame,
      );
      expect(runTool).not.toHaveBeenCalled();
      expect(JSON.stringify(llm.requests[0].tools ?? [])).not.toContain(
        "lookup_issue",
      );
      const result = llm.requests[1].messages.find((m) => m.role === "tool");
      expect(messageText(result!)).toContain("not found");
    } finally {
      ui.unmount();
    }
  });

  it("asks before an MCP tool the user listed for plan mode, and runs it once approved", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mcp-"));
    const file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(
      file,
      ["plan:", "  mcpTools:", "    - docs/*", ""].join(
        String.fromCharCode(10),
      ),
    );
    loadPolicyFile(file);
    fs.rmSync(dir, { recursive: true, force: true });
    const runTool = vi
      .spyOn(services.mcp, "runTool")
      .mockResolvedValue({ content: [{ type: "text", text: "mcp ran" }] });
    const llm = new ScriptedLlm([
      toolTurn("lookup_issue", { id: "42" }),
      textTurn("issue read"),
    ]);
    await registerFlowServices({
      llm,
      mode: "plan",
      mcpTools: [
        {
          name: "lookup_issue",
          serverName: "docs",
          description: "Look up an issue",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      ],
    });
    const ui = renderFlow();
    try {
      await type(ui.stdin, "read issue 42");
      await type(ui.stdin, ENTER);
      await waitUntil(
        () => (ui.lastFrame() ?? "").includes("Would you like to continue?"),
        "the permission prompt for the MCP tool",
        ui.lastFrame,
      );
      expect(ui.lastFrame()).toContain("lookup_issue");
      expect(runTool).not.toHaveBeenCalled();

      await type(ui.stdin, ENTER);
      await waitUntil(
        () => llm.requests.length === 2,
        "the request after the MCP call",
        ui.lastFrame,
      );
      expect(runTool).toHaveBeenCalledWith(
        "lookup_issue",
        { id: "42" },
        "docs",
      );
      const result = llm.requests[1].messages.find((m) => m.role === "tool");
      expect(messageText(result!)).toContain("mcp ran");
    } finally {
      ui.unmount();
    }
  });
});
