import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../../services/index.js";

import {
  ENTER,
  ESC,
  messageText,
  registerFlowServices,
  renderFlow,
  resetFlowState,
  ScriptedLlm,
  textTurn,
  toolTurn,
  type,
  waitUntil,
} from "./TUIChat.flowHarness.js";

const lookupIssue = {
  name: "lookup_issue",
  description: "Look up an issue",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
};

/*
 * Esc on a permission prompt denies that one call: the model gets the denied
 * result and the turn goes on. No single key ends the turn.
 */
describe("TUIChat - Esc on a permission prompt", () => {
  let runTool: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetFlowState();
    runTool = vi.spyOn(services.mcp, "runTool").mockResolvedValue({
      content: [{ type: "text", text: "issue 7: fixed" }],
    });
  });

  afterEach(async () => {
    await resetFlowState();
    vi.restoreAllMocks();
  });

  it("denies the call and the turn goes on", async () => {
    const llm = new ScriptedLlm([
      toolTurn("lookup_issue", { id: "7" }),
      textTurn("I could not look it up."),
    ]);
    await registerFlowServices({ llm, mcpTools: [lookupIssue] });
    const ui = renderFlow();
    try {
      await type(ui.stdin, "is issue 7 fixed?");
      await type(ui.stdin, ENTER);
      await waitUntil(
        () => (ui.lastFrame() ?? "").includes("Would you like to continue?"),
        "the permission prompt",
        ui.lastFrame,
      );
      await type(ui.stdin, ESC);

      await waitUntil(
        () => llm.requests.length === 2,
        "the turn to go on with the denied result",
        ui.lastFrame,
      );
      expect(runTool).not.toHaveBeenCalled();
      const toolResult = llm.requests[1].messages.find(
        (m) => m.role === "tool",
      );
      expect(toolResult).toBeDefined();
      expect(messageText(toolResult!)).not.toContain("issue 7: fixed");
      await waitUntil(
        () => ui.allOutput().includes("I could not look it up."),
        "the reply after the denial",
        ui.lastFrame,
      );
      expect(ui.allOutput()).not.toContain("Tool canceled");
    } finally {
      ui.unmount();
    }
  });
});
