import type { MessageModes, Tool } from "core";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "core/tools/builtIn";
import { describe, expect, it } from "vitest";
import { getEmptyRootState } from "../../util/test/mockStore";
import { RootState } from "../store";
import { selectActiveTools } from "./selectActiveTools";

const builtIn = (name: string, readonly: boolean): Tool =>
  ({
    type: "function",
    displayTitle: name,
    readonly,
    group: BUILT_IN_GROUP_NAME,
    function: { name, description: name },
    defaultToolPolicy: "allowedWithoutPermission",
  }) as Tool;

const mcp = (
  server: string,
  tool: string,
  readonly: boolean,
  extra: Partial<Tool> = {},
): Tool =>
  ({
    type: "function",
    displayTitle: `${server} ${tool}`,
    readonly,
    group: server,
    originalFunctionName: tool,
    uri: `mcp://${server}/${tool}`,
    function: { name: `${server}_${tool}`, description: tool },
    defaultToolPolicy: "allowedWithoutPermission",
    ...extra,
  }) as Tool;

const tools = [
  builtIn(BuiltInToolNames.ReadFile, true),
  builtIn(BuiltInToolNames.CreateNewFile, false),
  builtIn(BuiltInToolNames.RunTerminalCommand, false),
  // A server that says its own tools only read, which is only a claim
  mcp("evil", "wipe", true),
  mcp("docs", "search", true),
  mcp("wiki", "page", false),
];

function names(
  mode: MessageModes,
  policyExtras: RootState["ui"]["policyExtras"] = {},
): string[] {
  const state = getEmptyRootState();
  const root: RootState = {
    ...state,
    session: { ...state.session, mode },
    ui: { ...state.ui, policyExtras },
    config: { ...state.config, config: { ...state.config.config, tools } },
  };
  return selectActiveTools(root).map((t) => t.function.name);
}

describe("selectActiveTools by role", () => {
  it("Plan mode ignores an MCP server's read-only claim without the user's say", () => {
    expect(names("plan")).toEqual([BuiltInToolNames.ReadFile]);
  });

  it("Plan mode offers the MCP tools the user listed, and tools of a trusted server that claim read-only", () => {
    expect(names("plan", { planMcpTools: ["wiki/page"] }).sort()).toEqual(
      ["read_file", "wiki_page"].sort(),
    );
    expect(names("plan", { trustedMcpServers: ["docs"] })).toEqual([
      BuiltInToolNames.ReadFile,
      "docs_search",
    ]);
    // trusting a server does not make a tool it does not claim read-only
    expect(names("plan", { trustedMcpServers: ["wiki"] })).toEqual([
      BuiltInToolNames.ReadFile,
    ]);
  });

  it("a server the open folder brought is not believed under a listed name", () => {
    const state = getEmptyRootState();
    const root: RootState = {
      ...state,
      session: { ...state.session, mode: "plan" },
      ui: { ...state.ui, policyExtras: { planMcpTools: ["docs/*"] } },
      config: {
        ...state.config,
        config: {
          ...state.config.config,
          tools: [mcp("docs", "search", false, { mcpFromWorkspace: true })],
        },
      },
    };
    expect(selectActiveTools(root)).toEqual([]);
  });

  it("agent mode offers everything, and chat nothing", () => {
    expect(names("agent")).toHaveLength(tools.length);
    expect(names("chat")).toEqual([]);
  });

  it("a background run is unattended: the built-ins, and only the MCP tools listed for it (TR25)", () => {
    expect(names("background")).toHaveLength(3);
    expect(
      names("background", {
        backgroundMcpTools: ["evil", "docs", "wiki"],
      }),
    ).toHaveLength(tools.length);
  });
});
