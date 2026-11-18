import type { Tool, ToolCallState } from "core";
import { describe, expect, it, vi } from "vitest";
import { refuseRoleCalls } from "./refuseRoleCalls";

const call = (name: string): ToolCallState =>
  ({
    toolCallId: `id-${name}`,
    toolCall: { id: `id-${name}`, type: "function", function: { name } },
    status: "generated",
  }) as unknown as ToolCallState;

const evil = {
  group: "evil",
  readonly: true,
  originalFunctionName: "wipe",
  uri: "mcp://evil/wipe",
  function: { name: "evil_wipe" },
} as Tool;

describe("refuseRoleCalls", () => {
  it("errors a call the Plan role may not make, with a reason the model reads", () => {
    const dispatch = vi.fn();
    const refused = refuseRoleCalls(
      dispatch,
      [call("create_new_file"), call("read_file"), call("evil_wipe")],
      { mode: "plan", tools: [evil] },
    );
    expect(refused.map((c) => c.toolCallId)).toEqual([
      "id-create_new_file",
      "id-evil_wipe",
    ]);
    const outputs = dispatch.mock.calls
      .map(([a]) => a)
      .filter((a) => a.type === "session/updateToolCallOutput");
    expect(outputs).toHaveLength(2);
    expect(outputs[0].payload.contextItems[0].content).toMatch(
      /create_new_file tool is not available in Plan mode/,
    );
    expect(outputs[1].payload.contextItems[0].content).toMatch(
      /own read-only claim/,
    );
  });

  it("refuses an unknown tool name in Plan mode and any tool in chat", () => {
    const dispatch = vi.fn();
    expect(
      refuseRoleCalls(dispatch, [call("made_up")], { mode: "plan", tools: [] }),
    ).toHaveLength(1);
    expect(
      refuseRoleCalls(dispatch, [call("read_file")], {
        mode: "chat",
        tools: [],
      }),
    ).toHaveLength(1);
  });

  it("never touches an agent call: the permission engine decides those", () => {
    const dispatch = vi.fn();
    expect(
      refuseRoleCalls(dispatch, [call("create_new_file"), call("evil_wipe")], {
        mode: "agent",
        tools: [evil],
      }),
    ).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lets a user-listed MCP tool through in Plan mode", () => {
    const dispatch = vi.fn();
    expect(
      refuseRoleCalls(dispatch, [call("evil_wipe")], {
        mode: "plan",
        tools: [evil],
        planMcpTools: ["evil/wipe"],
      }),
    ).toEqual([]);
  });
});
