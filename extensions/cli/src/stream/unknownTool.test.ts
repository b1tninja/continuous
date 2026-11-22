import { TOOL_NAME_PAIRS } from "core/tools/unknownTool.js";
import { describe, expect, it, vi } from "vitest";

import { ALL_BUILT_IN_TOOLS } from "../tools/allBuiltIns.js";
import type { ToolCall } from "../tools/types.js";

import { preprocessStreamedToolCalls } from "./streamChatResponse.helpers.js";

// The tools on offer: the built-in ones, with no model or MCP service to ask
vi.mock("../tools/index.js", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const { ALL_BUILT_IN_TOOLS: tools } = await import("../tools/allBuiltIns.js");
  return { ...actual, getAllAvailableTools: vi.fn(async () => [...tools]) };
});

function call(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: "call_1",
    name,
    arguments: args,
    argumentsStr: JSON.stringify(args),
    startNotified: false,
  };
}

describe("a call to a name that is not a tool", () => {
  it("lists the tools on offer", async () => {
    const onToolError = vi.fn();
    const { preprocessedCalls, errorChatEntries } =
      await preprocessStreamedToolCalls(true, [call("open_file", { p: 1 })], {
        onToolError,
      } as never);
    expect(preprocessedCalls).toEqual([]);
    expect(errorChatEntries).toHaveLength(1);
    const text = String(errorChatEntries[0].content);
    expect(text).toMatch(
      /^There is no tool named open_file\. The tools available are: /,
    );
    // Names only, the real ones
    expect(text).toMatch(/\bRead\b/);
    expect(text).toMatch(/\bBash\b/);
    expect(text).not.toMatch(/not found/);
    expect(onToolError).toHaveBeenCalledWith(text, "open_file", "call_1");
  });

  it("runs the IDE's read_file as Read, under Read's own name", async () => {
    const { preprocessedCalls, errorChatEntries } =
      await preprocessStreamedToolCalls(true, [
        call("read_file", { filepath: "package.json" }),
      ]);
    expect(errorChatEntries).toEqual([]);
    expect(preprocessedCalls).toHaveLength(1);
    // The permission check and the run key on these
    expect(preprocessedCalls[0].name).toBe("Read");
    expect(preprocessedCalls[0].tool.name).toBe("Read");
    expect(preprocessedCalls[0].arguments).toEqual({
      filepath: "package.json",
    });
    expect(preprocessedCalls[0].id).toBe("call_1");
  });

  it("renames the IDE's parameter names to the CLI's", async () => {
    const { preprocessedCalls } = await preprocessStreamedToolCalls(true, [
      call("ls", { dirPath: "src" }),
    ]);
    expect(preprocessedCalls[0]?.name).toBe("List");
    expect(preprocessedCalls[0]?.arguments).toEqual({ dirpath: "src" });
  });

  it("gives the list when an argument has no counterpart", async () => {
    const { preprocessedCalls, errorChatEntries } =
      await preprocessStreamedToolCalls(true, [
        call("run_terminal_command", {
          command: "npm run dev",
          waitForCompletion: false,
        }),
      ]);
    expect(preprocessedCalls).toEqual([]);
    expect(String(errorChatEntries[0].content)).toMatch(
      /^There is no tool named run_terminal_command\. The tools available are: /,
    );
  });
});

describe("TOOL_NAME_PAIRS against the CLI's own tools", () => {
  it.each(TOOL_NAME_PAIRS.map((p) => [p.cli, p] as const))(
    "%s exists and has every mapped parameter",
    (_name, pair) => {
      const tool = ALL_BUILT_IN_TOOLS.find((t) => t.name === pair.cli);
      expect(tool, `${pair.cli} is not a tool`).toBeDefined();
      const properties = Object.keys(tool!.parameters.properties ?? {});
      for (const cliParam of Object.keys(pair.params)) {
        expect(properties, `${pair.cli}.${cliParam}`).toContain(cliParam);
      }
      // A required parameter with no counterpart could never be sent
      for (const required of tool!.parameters.required ?? []) {
        expect(Object.keys(pair.params)).toContain(required);
      }
    },
  );
});
