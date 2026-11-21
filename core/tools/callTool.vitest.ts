import { describe, expect, test, vi } from "vitest";

import type { Tool, ToolCall, ToolExtras } from "..";
import { validateMultiEdit } from "../edit/searchAndReplace/multiEditValidation";
import { callTool, encodeMCPToolUri } from "./callTool";
import { multiEditTool } from "./definitions/multiEdit";

const mcpCalls = vi.hoisted(() => [] as unknown[]);
vi.mock("../context/mcp/MCPManagerSingleton", () => ({
  MCPManagerSingleton: {
    getInstance: () => ({
      getConnection: () => ({
        options: {},
        recordToolUse: async () => {},
        client: {
          callTool: async (request: unknown) => {
            mcpCalls.push(request);
            return { content: [{ type: "text", text: "done" }] };
          },
        },
      }),
    }),
  },
}));

const multiEditArgs = vi.hoisted(() => [] as unknown[]);
vi.mock("./implementations/exactEdits", () => ({
  singleFindAndReplaceImpl: async () => [],
  multiEditImpl: async (args: unknown) => {
    multiEditArgs.push(args);
    return [];
  },
}));

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: "call_1",
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

const extras = (tool: Tool) =>
  ({
    tool,
    ide: { getWorkspaceDirs: async () => [] },
  }) as unknown as ToolExtras;

// Some models send an array, boolean or number as a JSON string (upstream 13350)
describe("callTool reads strings as the schema's type", () => {
  const mcpTool: Tool = {
    type: "function",
    displayTitle: "Toggle",
    group: "srv",
    readonly: false,
    uri: encodeMCPToolUri("srv", "toggle"),
    function: {
      name: "toggle",
      parameters: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          count: { type: "integer" },
          label: { type: "string" },
        },
      },
    },
  };

  test('an MCP tool gets a boolean for "true", and its strings as sent', async () => {
    const result = await callTool(
      mcpTool,
      toolCall("toggle", { enabled: "true", count: "3", label: "true" }),
      extras(mcpTool),
    );

    expect(result.errorMessage).toBeUndefined();
    expect(mcpCalls.at(-1)).toEqual({
      name: "toggle",
      arguments: { enabled: true, count: 3, label: "true" },
    });
    expect(result.argRepairs).toEqual([
      {
        kind: "string-to-literal",
        argument: "enabled",
        from: "true",
        to: true,
      },
      { kind: "string-to-literal", argument: "count", from: "3", to: 3 },
    ]);
  });

  test("a call whose arguments already fit records no repair", async () => {
    const result = await callTool(
      mcpTool,
      toolCall("toggle", { enabled: false, label: "10" }),
      extras(mcpTool),
    );

    expect(mcpCalls.at(-1)).toEqual({
      name: "toggle",
      arguments: { enabled: false, label: "10" },
    });
    expect(result.argRepairs).toBeUndefined();
  });

  test("multi_edit runs with edits sent as a JSON string", async () => {
    const edits = [{ old_string: "one", new_string: "two" }];
    const result = await callTool(
      multiEditTool,
      toolCall(multiEditTool.function.name, {
        filepath: "a.txt",
        edits: JSON.stringify(edits),
      }),
      extras(multiEditTool),
    );

    expect(result.errorMessage).toBeUndefined();
    expect(multiEditArgs.at(-1)).toEqual({ filepath: "a.txt", edits });
    expect(validateMultiEdit(multiEditArgs.at(-1)).edits).toEqual(edits);
    expect(result.argRepairs?.map((r) => r.argument)).toEqual(["edits"]);
  });
});
