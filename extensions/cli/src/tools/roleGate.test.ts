import { CLI_TOOL_CLASS, TOOL_CLASSES } from "core/tools/roleTools.js";

import { ALL_BUILT_IN_TOOLS } from "./allBuiltIns.js";
import { cliRoleRefusal, cliToolRef, cliToolRole } from "./roleGate.js";

const mcpTool = (readonly: boolean, mcpServer = "srv") => ({
  name: "search",
  isBuiltIn: false,
  mcpServer,
  readonly,
});

describe("the CLI's role table", () => {
  it("has a row for every built-in tool", () => {
    const names = [
      ...ALL_BUILT_IN_TOOLS.map((t) => t.name),
      "CheckBackgroundJob",
    ];
    for (const name of names) {
      expect(CLI_TOOL_CLASS[name], name).toBeDefined();
      expect(TOOL_CLASSES).toContain(CLI_TOOL_CLASS[name]);
    }
  });

  it("Plan mode is the planner and every other mode is the agent", () => {
    expect(cliToolRole("plan")).toBe("planner");
    expect(cliToolRole("normal")).toBe("agent");
    expect(cliToolRole("auto")).toBe("agent");
  });

  it("refuses an edit and an unlisted MCP tool in Plan mode, with a reason", () => {
    expect(cliRoleRefusal("plan", { name: "Write", isBuiltIn: true })).toMatch(
      /Write tool is not available in Plan mode/,
    );
    expect(cliRoleRefusal("plan", mcpTool(true))).toMatch(/read-only claim/);
  });

  it("refuses Bash in Plan mode by default", () => {
    expect(cliRoleRefusal("plan", { name: "Bash", isBuiltIn: true })).toMatch(
      /Bash tool is not available in Plan mode/,
    );
    expect(
      cliRoleRefusal("normal", { name: "Bash", isBuiltIn: true }),
    ).toBeUndefined();
  });

  it("lets Plan mode read, and the agent do anything", () => {
    expect(
      cliRoleRefusal("plan", { name: "Read", isBuiltIn: true }),
    ).toBeUndefined();
    expect(cliRoleRefusal("normal", mcpTool(false))).toBeUndefined();
    expect(cliRoleRefusal("normal", { name: "Write", isBuiltIn: true })).toBe(
      undefined,
    );
  });

  it("an MCP tool without a server name is still an MCP tool", () => {
    const ref = cliToolRef({ name: "x", isBuiltIn: false });
    expect(ref.mcp?.server).toBe("");
  });
});
