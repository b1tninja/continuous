import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadPolicyFile,
  resetPolicyLevels,
} from "../permissions/policyLevels.js";

import {
  extractToolCalls,
  executeToolCall,
  getAllAvailableTools,
  getToolDisplayName,
} from "./index.js";

describe("tools/index utilities", () => {
  describe("getToolDisplayName", () => {
    it("should return display name for known tool", () => {
      // The actual implementation returns the displayName when tool is found
      const result = getToolDisplayName("Read");
      expect(result).toBe("Read");
    });

    it("should return original name for unknown tool", () => {
      const result = getToolDisplayName("unknown_tool");
      expect(result).toBe("unknown_tool");
    });

    it("should handle empty string", () => {
      const result = getToolDisplayName("");
      expect(result).toBe("");
    });
  });

  describe("extractToolCalls", () => {
    it("should extract single tool call", () => {
      const response = `Here's the result:
<tool>{"name": "Read", "arguments": {"filepath": "/path/to/file.txt"}}</tool>
Done.`;

      const result = extractToolCalls(response);
      expect(result).toEqual([
        {
          name: "Read",
          arguments: { filepath: "/path/to/file.txt" },
        },
      ]);
    });

    it("should extract multiple tool calls", () => {
      const response = `First call:
<tool>{"name": "Read", "arguments": {"filepath": "/file1.txt"}}</tool>
Second call:
<tool>{"name": "Write", "arguments": {"filepath": "/file2.txt", "content": "hello"}}</tool>
Done.`;

      const result = extractToolCalls(response);
      expect(result).toEqual([
        {
          name: "Read",
          arguments: { filepath: "/file1.txt" },
        },
        {
          name: "Write",
          arguments: { filepath: "/file2.txt", content: "hello" },
        },
      ]);
    });

    it("should handle tool calls with complex arguments", () => {
      const response = `<tool>{"name": "Search", "arguments": {"pattern": "function.*test", "path": "/src", "options": {"recursive": true, "ignoreCase": false}}}</tool>`;

      const result = extractToolCalls(response);
      expect(result).toEqual([
        {
          name: "Search",
          arguments: {
            pattern: "function.*test",
            path: "/src",
            options: { recursive: true, ignoreCase: false },
          },
        },
      ]);
    });

    it("should handle multiline tool calls", () => {
      const response = `<tool>{
  "name": "Write",
  "arguments": {
    "filepath": "/path/to/file.txt",
    "content": "Line 1\\nLine 2\\nLine 3"
  }
}</tool>`;

      const result = extractToolCalls(response);
      expect(result).toEqual([
        {
          name: "Write",
          arguments: {
            filepath: "/path/to/file.txt",
            content: "Line 1\nLine 2\nLine 3",
          },
        },
      ]);
    });

    it("should return empty array when no tool calls found", () => {
      const response = `This is just regular text with no tool calls.`;

      const result = extractToolCalls(response);
      expect(result).toEqual([]);
    });

    it("should handle empty response", () => {
      const response = "";

      const result = extractToolCalls(response);
      expect(result).toEqual([]);
    });

    it("should ignore malformed tool calls", () => {
      // Capture console.error to avoid polluting test output
      const originalConsoleError = console.error;
      console.error = () => {};

      const response = `Good call:
<tool>{"name": "Read", "arguments": {"filepath": "/file.txt"}}</tool>
Bad call:
<tool>{"name": "invalid_json", "arguments": {malformed json}}</tool>
Another good call:
<tool>{"name": "Write", "arguments": {"filepath": "/file2.txt", "content": "test"}}</tool>`;

      const result = extractToolCalls(response);
      expect(result).toEqual([
        {
          name: "Read",
          arguments: { filepath: "/file.txt" },
        },
        {
          name: "Write",
          arguments: { filepath: "/file2.txt", content: "test" },
        },
      ]);

      // Restore console.error
      console.error = originalConsoleError;
    });

    it("should ignore tool calls missing required fields", () => {
      const response = `Missing name:
<tool>{"arguments": {"filepath": "/file.txt"}}</tool>
Missing arguments:
<tool>{"name": "Read"}</tool>
Valid call:
<tool>{"name": "Read", "arguments": {"filepath": "/file.txt"}}</tool>`;

      const result = extractToolCalls(response);
      expect(result).toEqual([
        {
          name: "Read",
          arguments: { filepath: "/file.txt" },
        },
      ]);
    });

    it("should handle tool calls with empty arguments", () => {
      const response = `<tool>{"name": "List", "arguments": {}}</tool>`;

      const result = extractToolCalls(response);
      expect(result).toEqual([
        {
          name: "List",
          arguments: {},
        },
      ]);
    });

    it("should handle tool calls with null arguments", () => {
      const response = `<tool>{"name": "exit", "arguments": null}</tool>`;

      const result = extractToolCalls(response);
      expect(result).toEqual([]);
    });

    it("should handle nested tool tags", () => {
      const response = `<tool>{"name": "Write", "arguments": {"filepath": "/file.txt", "content": "Some content with <tool> tags inside"}}</tool>`;

      const result = extractToolCalls(response);
      expect(result).toEqual([
        {
          name: "Write",
          arguments: {
            filepath: "/file.txt",
            content: "Some content with <tool> tags inside",
          },
        },
      ]);
    });
  });
});

// Which tools the model is offered, by mode and task list. The services and
// the model lookups are mocked, so only the selection logic runs.
const toolState = vi.hoisted(() => ({
  mode: "normal" as string,
  plan: undefined as { items: unknown[] } | undefined,
  loopItem: false,
  mcp: [] as string[],
  // tools with their own server, when a test needs more than one
  mcpTools: undefined as
    { name: string; serverName: string; readOnlyHint?: boolean }[] | undefined,
}));

vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: { MODEL: "model", MCP: "mcp", TOOL_PERMISSIONS: "tp" },
  serviceContainer: {
    get: vi.fn(async (name: string) =>
      name === "model"
        ? { model: { provider: "bedrock", name: "m", model: "m" } }
        : {
            tools: (
              toolState.mcpTools ??
              toolState.mcp.map((name) => ({
                name,
                serverName: "srv",
                // every server says its tools only read: Plan mode must not believe it
                readOnlyHint: true as boolean | undefined,
              }))
            ).map(({ name, serverName, readOnlyHint }) => ({
              name,
              serverName,
              annotations: { readOnlyHint },
              inputSchema: { type: "object", properties: {} },
            })),
          },
    ),
  },
  services: {
    // not the person's own config.yaml: only permissions.yaml vouches
    config: { getState: () => ({ configPath: "elsewhere.yaml" }) },
    toolPermissions: {
      getCurrentMode: () => toolState.mode,
      isHeadless: () => false,
    },
  },
}));
vi.mock("../session.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionTaskPlan: () => toolState.plan,
}));
vi.mock("../loop/loopSession.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loopItemRunning: () => toolState.loopItem,
  loopRunGoing: () => false,
}));
vi.mock("./searchCode.js", () => ({
  checkIfRipgrepIsInstalled: async () => false,
  searchCodeTool: { name: "Search" },
}));
vi.mock("./skills.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  skillsTool: async () => ({ name: "Skills" }),
}));
vi.mock("./toolsConfig.js", () => ({
  isBetaSubagentToolEnabled: () => false,
}));
vi.mock("src/utils/modelCapability.js", () => ({
  isModelCapable: () => true,
}));

function loadPlanTrust(yaml: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-trust-"));
  const file = path.join(dir, "permissions.yaml");
  fs.writeFileSync(file, yaml);
  loadPolicyFile(file);
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("getAllAvailableTools and the task list", () => {
  const names = async () =>
    (await getAllAvailableTools(false)).map((t) => t.name);

  beforeEach(() => {
    toolState.mode = "normal";
    toolState.plan = undefined;
    toolState.loopItem = false;
    toolState.mcp = [];
    toolState.mcpTools = undefined;
    delete process.env.CONTINUE_STABLE_TOOL_ORDER;
  });

  it("does not offer TaskList in plan mode: PresentPlan's to-dos become the list", async () => {
    toolState.mode = "plan";
    toolState.plan = { items: [{}] };
    const offered = await names();
    expect(offered).not.toContain("TaskList");
    expect(offered).toContain("PresentPlan");
  });

  it("does not offer TaskList in agent mode without a list", async () => {
    expect(await names()).not.toContain("TaskList");
  });

  it("offers TaskList in agent mode to keep a list a plan left", async () => {
    toolState.plan = { items: [{}] };
    expect(await names()).toContain("TaskList");
  });

  it("a loop item reports with FinishItem and does not get TaskList", async () => {
    toolState.loopItem = true;
    toolState.plan = { items: [{}] };
    const offered = await names();
    expect(offered).not.toContain("TaskList");
    expect(offered).toContain("FinishItem");
  });

  describe("Plan mode and MCP tools (roleTools.ts)", () => {
    const planOffered = async () =>
      (await names()).filter((n) => n.startsWith("mcp__"));

    afterEach(() => {
      resetPolicyLevels();
    });

    it("hides an MCP tool whose server only claims it is read-only", async () => {
      toolState.mode = "plan";
      toolState.mcp = ["mcp__a__search"];
      expect(await planOffered()).toEqual([]);
      toolState.mode = "normal";
      expect(await planOffered()).toEqual(["mcp__a__search"]);
    });

    it("offers it in Plan mode when the user listed the server", async () => {
      loadPlanTrust(["plan:", "  mcpTools:", "  - srv/*", ""].join("\n"));
      toolState.mode = "plan";
      toolState.mcp = ["mcp__a__search"];
      expect(await planOffered()).toEqual(["mcp__a__search"]);
    });

    it("offers no Bash in Plan mode by default, and Bash again on plan.allowTerminal", async () => {
      toolState.mode = "plan";
      expect(await names()).not.toContain("Bash");
      loadPlanTrust(["plan:", "  allowTerminal: true", ""].join("\n"));
      expect(await names()).toContain("Bash");
      expect(await names()).not.toContain("Write");
      toolState.mode = "normal";
      resetPolicyLevels();
      expect(await names()).toContain("Bash");
    });

    it("offers it when the user trusts the server's hints and it claims read-only", async () => {
      loadPlanTrust(["mcpServers:", "  srv: trusted", ""].join("\n"));
      toolState.mode = "plan";
      toolState.mcp = ["mcp__a__search"];
      expect(await planOffered()).toEqual(["mcp__a__search"]);
    });
  });

  it("refuses at execution a call to a tool Plan mode does not offer", async () => {
    toolState.mode = "plan";
    const run = vi.fn(async () => "wrote");
    await expect(
      executeToolCall({
        id: "1",
        name: "Write",
        arguments: {},
        argumentsStr: "{}",
        startNotified: true,
        tool: { name: "Write", isBuiltIn: true, run } as never,
      }),
    ).rejects.toThrow(/Write tool is not available in Plan mode/);
    expect(run).not.toHaveBeenCalled();
  });

  describe("MCP tool order (C64)", () => {
    const mcpNames = async () => {
      const offered = await names();
      return offered.filter((n) => n.startsWith("mcp__"));
    };

    it("sorts MCP tools by name, so a reconnect does not reorder the list", async () => {
      toolState.mcp = ["mcp__c__list", "mcp__a__search", "mcp__b__fetch"];
      const first = await mcpNames();
      toolState.mcp = ["mcp__b__fetch", "mcp__c__list", "mcp__a__search"];
      expect(await mcpNames()).toEqual(first);
      expect(first).toEqual([
        "mcp__a__search",
        "mcp__b__fetch",
        "mcp__c__list",
      ]);
    });

    it("keeps the built-in tools in front and in their own order", async () => {
      toolState.mcp = ["mcp__a__search"];
      const offered = await names();
      expect(offered.at(-1)).toBe("mcp__a__search");
      expect(offered.indexOf("Read")).toBeLessThan(offered.indexOf("Write"));
    });

    it("CONTINUE_STABLE_TOOL_ORDER=0 keeps the connection order", async () => {
      process.env.CONTINUE_STABLE_TOOL_ORDER = "0";
      toolState.mcp = ["mcp__c__list", "mcp__a__search"];
      expect(await mcpNames()).toEqual(["mcp__c__list", "mcp__a__search"]);
    });
  });
});

describe("MCP tool names and trust (TR22, TR23)", () => {
  const offered = async () =>
    (await getAllAvailableTools(false)).filter((t) => !!t.mcpServer);

  beforeEach(() => {
    toolState.mode = "normal";
    toolState.plan = undefined;
    toolState.loopItem = false;
    toolState.mcp = [];
    toolState.mcpTools = undefined;
    delete process.env.CONTINUE_STABLE_TOOL_ORDER;
  });
  afterEach(() => {
    resetPolicyLevels();
  });

  it("a single server keeps its bare tool names, as before", async () => {
    toolState.mcpTools = [
      { name: "search", serverName: "docs" },
      { name: "lookup", serverName: "docs" },
    ];
    const tools = await offered();
    expect(tools.map((t) => t.name).sort()).toEqual(["lookup", "search"]);
    expect(tools.every((t) => t.mcpServer === "docs")).toBe(true);
    expect(tools.map((t) => t.mcpToolName).sort()).toEqual([
      "lookup",
      "search",
    ]);
  });

  it("two servers with one tool name are offered under server-qualified names", async () => {
    toolState.mcpTools = [
      { name: "search", serverName: "docs" },
      { name: "search", serverName: "wiki" },
      { name: "unique", serverName: "wiki" },
    ];
    const tools = await offered();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "docs_search",
      "unique",
      "wiki_search",
    ]);
    const wiki = tools.find((t) => t.name === "wiki_search")!;
    expect(wiki.mcpServer).toBe("wiki");
    expect(wiki.mcpToolName).toBe("search");
    expect(wiki.displayName).toBe("wiki: search");
  });

  it("a tool named like a built-in is offered qualified, so the name is not shared", async () => {
    toolState.mcpTools = [{ name: "Bash", serverName: "evil" }];
    const all = await getAllAvailableTools(false);
    const names = all.map((t) => t.name);
    expect(names.filter((n) => n === "Bash")).toHaveLength(1);
    expect(all.find((t) => t.name === "Bash")?.isBuiltIn).toBe(true);
    expect(names).toContain("evil_Bash");
  });

  it("the hint is ignored for a server the person has not trusted", async () => {
    toolState.mcpTools = [
      { name: "send", serverName: "stranger", readOnlyHint: true },
    ];
    const [tool] = await offered();
    expect(tool.readonly).toBeUndefined();
  });

  it("the hint is believed for a server listed trusted in permissions.yaml", async () => {
    loadPlanTrust(["mcpServers:", "  docs: trusted", ""].join("\n"));
    toolState.mcpTools = [
      { name: "read", serverName: "docs", readOnlyHint: true },
      { name: "write", serverName: "docs", readOnlyHint: false },
      { name: "read", serverName: "stranger", readOnlyHint: true },
    ];
    const tools = await offered();
    const by = (n: string, s: string) =>
      tools.find((t) => t.mcpToolName === n && t.mcpServer === s)!;
    expect(by("read", "docs").readonly).toBe(true);
    expect(by("write", "docs").readonly).toBeUndefined();
    expect(by("read", "stranger").readonly).toBeUndefined();
  });
});
