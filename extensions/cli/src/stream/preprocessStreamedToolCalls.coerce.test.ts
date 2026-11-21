import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tool, ToolCall } from "../tools/types.js";

const offered = vi.hoisted(() => ({ tools: [] as unknown[] }));
vi.mock("../tools/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/index.js")>()),
  getAllAvailableTools: async () => offered.tools,
}));

function call(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${name}`,
    name,
    arguments: args,
    argumentsStr: JSON.stringify(args),
    startNotified: false,
  };
}

// Some models send an array, boolean or number as a JSON string (upstream 13350)
describe("preprocessStreamedToolCalls reads strings as the schema's type", () => {
  let dir: string;
  let preprocessStreamedToolCalls: typeof import("./streamChatResponse.helpers.js").preprocessStreamedToolCalls;
  let convertMcpToolToContinueTool: typeof import("../tools/index.js").convertMcpToolToContinueTool;
  let multiEditTool: Tool;
  let markFileAsRead: typeof import("../tools/readFile.js").markFileAsRead;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-coerce-"));
    // The test setup has already loaded these with the real tool list
    vi.resetModules();
    ({ preprocessStreamedToolCalls } =
      await import("./streamChatResponse.helpers.js"));
    ({ convertMcpToolToContinueTool } = await import("../tools/index.js"));
    ({ multiEditTool } = await import("../tools/multiEdit.js"));
    ({ markFileAsRead } = await import("../tools/readFile.js"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs a MultiEdit whose edits arrived as a JSON string", async () => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "one two\n");
    markFileAsRead(file);
    offered.tools = [multiEditTool];
    const edits = [{ old_string: "one", new_string: "three" }];

    const { preprocessedCalls, errorChatEntries } =
      await preprocessStreamedToolCalls(true, [
        call("MultiEdit", { file_path: file, edits: JSON.stringify(edits) }),
      ]);

    expect(errorChatEntries).toEqual([]);
    expect(preprocessedCalls[0].arguments.edits).toEqual(edits);
    expect(preprocessedCalls[0].argRepairs).toEqual([
      {
        kind: "string-to-literal",
        argument: "edits",
        from: JSON.stringify(edits),
        to: edits,
      },
    ]);

    await multiEditTool.run(preprocessedCalls[0].preprocessResult?.args);
    expect(fs.readFileSync(file, "utf-8")).toBe("three two\n");
  });

  it('gives an MCP tool a boolean for "true" and leaves its strings alone', async () => {
    const run = vi.fn(async () => "ok");
    const tool: Tool = {
      ...convertMcpToolToContinueTool({
        name: "toggle",
        serverName: "srv",
        inputSchema: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            label: { type: "string" },
          },
          required: ["enabled"],
        },
      }),
      run,
    };
    offered.tools = [tool];

    const { preprocessedCalls, errorChatEntries } =
      await preprocessStreamedToolCalls(true, [
        call("toggle", { enabled: "true", label: "true" }),
      ]);

    expect(errorChatEntries).toEqual([]);
    const [preprocessed] = preprocessedCalls;
    expect(preprocessed.arguments).toEqual({ enabled: true, label: "true" });
    expect(preprocessed.argRepairs?.map((r) => r.argument)).toEqual([
      "enabled",
    ]);

    await preprocessed.tool.run(preprocessed.arguments);
    expect(run).toHaveBeenCalledWith({ enabled: true, label: "true" });
  });

  it("records nothing when the arguments already fit", async () => {
    const tool: Tool = {
      ...convertMcpToolToContinueTool({
        name: "toggle",
        inputSchema: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
        },
      }),
      run: async () => "ok",
    };
    offered.tools = [tool];

    const { preprocessedCalls } = await preprocessStreamedToolCalls(true, [
      call("toggle", { enabled: false }),
    ]);

    expect(preprocessedCalls[0].arguments).toEqual({ enabled: false });
    expect(preprocessedCalls[0].argRepairs).toBeUndefined();
  });
});
