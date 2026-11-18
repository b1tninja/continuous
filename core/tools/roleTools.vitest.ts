import { describe, expect, it } from "vitest";
import type { IDE, Tool } from "..";
import { BuiltInToolNames } from "./builtIn";
import * as toolDefinitions from "./definitions";
import {
  getBaseToolDefinitions,
  getConfigDependentToolDefinitions,
} from "./index";
import { ideToolRef } from "./roleToolRefs";
import {
  BUILT_IN_TOOL_CLASS,
  CLI_TOOL_CLASS,
  ROLE_CLASSES,
  TOOL_CLASSES,
  TOOL_ROLES,
  classOfTool,
  filterToolsForRole,
  isToolAllowedForRole,
  mcpToolIsUserReadOnly,
  roleClasses,
  roleForMode,
  roleRefusal,
  toolRoleOfMode,
  type PlanMcpTrust,
  type RoleToolRef,
} from "./roleTools";

/** Every tool the IDE can offer, with the experimental and optional ones on. */
export async function allIdeTools(): Promise<Tool[]> {
  const ide = { getIdeInfo: async () => ({ ideType: "vscode" }) } as IDE;
  return [
    ...getBaseToolDefinitions(),
    ...(await getConfigDependentToolDefinitions({
      rules: [],
      enableExperimentalTools: true,
      isRemote: false,
      modelName: "claude-sonnet-4",
      ide,
      toolSearch: "auto",
    })),
    toolDefinitions.recallMaskedResultTool,
    toolDefinitions.editFileTool,
    toolDefinitions.singleFindAndReplaceTool,
  ];
}

const mcp = (
  server: string,
  tool: string,
  readOnlyHint: boolean,
  fromWorkspace = false,
): RoleToolRef => ({
  name: `${server}_${tool}`,
  mcp: {
    server,
    tool,
    readOnlyHint,
    ...(fromWorkspace ? { fromWorkspace } : {}),
  },
});

describe("the role by tool table covers every tool", () => {
  it("has a class for every built-in tool name, and only those", () => {
    expect(Object.keys(BUILT_IN_TOOL_CLASS).sort()).toEqual(
      Object.values(BuiltInToolNames).sort(),
    );
    for (const c of Object.values(BUILT_IN_TOOL_CLASS)) {
      expect(TOOL_CLASSES).toContain(c);
    }
  });

  it("classifies every tool the IDE can offer (none falls to unclassified)", async () => {
    const tools = await allIdeTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const t of tools) {
      expect(classOfTool(ideToolRef(t)), t.function.name).not.toBe(
        "unclassified",
      );
    }
  });

  it("the CLI table only uses known classes", () => {
    for (const c of Object.values(CLI_TOOL_CLASS)) {
      expect(TOOL_CLASSES).toContain(c);
    }
  });

  it("an unknown tool is unclassified, and only agent and background may use it", () => {
    const ref = { name: "made_up_tool" };
    expect(classOfTool(ref)).toBe("unclassified");
    const allowed = TOOL_ROLES.filter((r) => isToolAllowedForRole(r, ref));
    expect(allowed).toEqual(["agent", "background"]);
  });
});

describe("roles", () => {
  it("maps each mode to a role and shares one list between agent and background", () => {
    expect(roleForMode("chat")).toBe("chat");
    expect(roleForMode("agent")).toBe("agent");
    expect(roleForMode("plan")).toBe("planner");
    expect(roleForMode("background")).toBe("background");
    expect(roleForMode(undefined)).toBe("agent");
    expect(ROLE_CLASSES.background).toBe(ROLE_CLASSES.agent);
    expect(toolRoleOfMode("plan")).toBe("planner");
    expect(toolRoleOfMode("worker")).toBeUndefined();
  });

  it("the reviewer and chat have no tools, whatever is offered", async () => {
    const tools = await allIdeTools();
    expect(roleClasses("reviewer")).toEqual([]);
    expect(roleClasses("chat")).toEqual([]);
    for (const role of ["reviewer", "chat"] as const) {
      expect(filterToolsForRole(role, tools, ideToolRef)).toEqual([]);
      expect(
        filterToolsForRole(role, [mcp("docs", "q", true)], (t) => t),
      ).toEqual([]);
    }
  });

  it("the agent and background keep every tool", async () => {
    const tools = await allIdeTools();
    expect(filterToolsForRole("agent", tools, ideToolRef)).toEqual(tools);
    expect(filterToolsForRole("background", tools, ideToolRef)).toEqual(tools);
  });

  it("the planner offers exactly the built-ins marked read-only", async () => {
    const tools = await allIdeTools();
    const offered = new Set(
      filterToolsForRole("planner", tools, ideToolRef).map(
        (t) => t.function.name,
      ),
    );
    for (const t of tools) {
      expect(offered.has(t.function.name), t.function.name).toBe(t.readonly);
    }
    expect(offered.has(BuiltInToolNames.PresentPlan)).toBe(true);
    expect(offered.has(BuiltInToolNames.CreateNewFile)).toBe(false);
    expect(offered.has(BuiltInToolNames.RunTerminalCommand)).toBe(false);
  });

  it("the planner has no terminal by default, on either surface", () => {
    const bash = { name: "Bash" };
    expect(isToolAllowedForRole("planner", bash)).toBe(false);
    expect(
      isToolAllowedForRole("planner", bash, { allowPlanTerminal: false }),
    ).toBe(false);
    expect(roleClasses("planner")).not.toContain("terminal");
  });

  it("plan.allowTerminal restores the terminal for the planner only", () => {
    const opts = { allowPlanTerminal: true };
    expect(isToolAllowedForRole("planner", { name: "Bash" }, opts)).toBe(true);
    expect(
      isToolAllowedForRole("planner", { name: "RunTerminalCommand" }, opts),
    ).toBe(false);
    expect(isToolAllowedForRole("planner", { name: "Write" }, opts)).toBe(
      false,
    );
    expect(isToolAllowedForRole("reviewer", { name: "Bash" }, opts)).toBe(
      false,
    );
    expect(isToolAllowedForRole("chat", { name: "Bash" }, opts)).toBe(false);
  });

  it("the orchestrator (proposed) only delegates and keeps the session", () => {
    expect(
      isToolAllowedForRole("orchestrator", { name: BuiltInToolNames.Subagent }),
    ).toBe(true);
    expect(
      isToolAllowedForRole("orchestrator", {
        name: BuiltInToolNames.ReadFile,
      }),
    ).toBe(false);
  });
});

describe("Plan mode and MCP tools", () => {
  const claim = mcp("evil", "wipe", true);

  it("ignores a server's own read-only claim without the user's say", () => {
    expect(classOfTool(claim)).toBe("mcp-other");
    expect(isToolAllowedForRole("planner", claim)).toBe(false);
    expect(isToolAllowedForRole("planner", claim, { trust: {} })).toBe(false);
    expect(roleRefusal("planner", claim)).toMatch(/not available in Plan mode/);
    expect(roleRefusal("planner", claim)).toMatch(/own read-only claim/);
    expect(isToolAllowedForRole("planner", mcp("evil", "x", false))).toBe(
      false,
    );
  });

  it("allows a tool the user listed, whatever the server claims", () => {
    const trust: PlanMcpTrust = { tools: ["docs/search", "wiki/*", "notes"] };
    const ok = (server: string, tool: string, hint: boolean) =>
      isToolAllowedForRole("planner", mcp(server, tool, hint), { trust });
    expect(ok("docs", "search", false)).toBe(true);
    expect(ok("docs", "delete", true)).toBe(false);
    expect(ok("wiki", "any", false)).toBe(true);
    expect(ok("notes", "any", false)).toBe(true);
    expect(
      roleRefusal("planner", mcp("docs", "search", false), { trust }),
    ).toBeUndefined();
  });

  it("believes the hint only for a server the user marked trusted", () => {
    const trust: PlanMcpTrust = { trustedServers: ["docs"] };
    const ok = (server: string, hint: boolean) =>
      isToolAllowedForRole("planner", mcp(server, "q", hint), { trust });
    expect(ok("docs", true)).toBe(true);
    expect(ok("docs", false)).toBe(false);
    expect(ok("other", true)).toBe(false);
  });

  it("a server the open folder brought never counts, even under a listed name", () => {
    const trust: PlanMcpTrust = { trustedServers: ["docs"], tools: ["docs/q"] };
    const ref = mcp("docs", "q", true, true);
    expect(mcpToolIsUserReadOnly(ref.mcp!, trust)).toBe(false);
    expect(isToolAllowedForRole("planner", ref, { trust })).toBe(false);
  });

  it("the agent may use any approved MCP tool: the table only restricts", () => {
    expect(isToolAllowedForRole("agent", claim)).toBe(true);
    // An unattended run only the ones the person listed (TR25)
    expect(isToolAllowedForRole("background", claim)).toBe(false);
    expect(
      isToolAllowedForRole("background", claim, {
        unattendedMcpTools: [claim.mcp!.server],
      }),
    ).toBe(true);
  });

  it("the list filter drops an MCP tool the user did not list, and keeps the rest", () => {
    const tools = [
      { name: "read_file" },
      mcp("docs", "search", true),
      mcp("evil", "wipe", true),
    ];
    const offered = filterToolsForRole("planner", tools, (t) => t, {
      trust: { tools: ["docs/search"] },
    });
    expect(offered.map((t) => t.name)).toEqual(["read_file", "docs_search"]);
  });
});

describe("refusal at execution", () => {
  it("refuses a hidden tool with a clear message and names the role", () => {
    const msg = roleRefusal("planner", {
      name: BuiltInToolNames.CreateNewFile,
    });
    expect(msg).toMatch(/create_new_file tool is not available in Plan mode/);
    expect(msg).toMatch(/was not run/);
    expect(
      roleRefusal("reviewer", { name: BuiltInToolNames.ReadFile }),
    ).toMatch(/not available in the reviewer/);
  });

  it("allows a tool the role may use", () => {
    expect(
      roleRefusal("planner", { name: BuiltInToolNames.ReadFile }),
    ).toBeUndefined();
  });
});
