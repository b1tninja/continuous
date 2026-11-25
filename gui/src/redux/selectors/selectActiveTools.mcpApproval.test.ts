import type { MessageModes, Tool } from "core";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "core/tools/builtIn";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { describe, expect, it } from "vitest";
import { getEmptyRootState } from "../../util/test/mockStore";
import { RootState } from "../store";
import { selectActiveTools } from "./selectActiveTools";

const builtIn = (name: string): Tool =>
  ({
    type: "function",
    displayTitle: name,
    readonly: true,
    group: BUILT_IN_GROUP_NAME,
    function: { name, description: name },
    defaultToolPolicy: "allowedWithoutPermission",
  }) as Tool;

const mcp = (
  server: string,
  tool: string,
  pending?: Tool["mcpPendingApproval"],
): Tool =>
  ({
    type: "function",
    displayTitle: `${server} ${tool}`,
    readonly: false,
    group: server,
    originalFunctionName: tool,
    uri: `mcp://${server}/${tool}`,
    function: { name: `${server}_${tool}`, description: tool },
    defaultToolPolicy: "allowedWithPermission",
    ...(pending ? { mcpPendingApproval: pending } : {}),
  }) as Tool;

function names(
  mode: MessageModes,
  tools: Tool[],
  opts: {
    policyExtras?: RootState["ui"]["policyExtras"];
    /** "Ask before using an MCP tool you have not approved" is off */
    idgaf?: boolean;
  } = {},
): string[] {
  const state = getEmptyRootState();
  const root: RootState = {
    ...state,
    session: { ...state.session, mode },
    ui: {
      ...state.ui,
      policyExtras: {
        ...(opts.policyExtras ?? {}),
        ...(opts.idgaf
          ? {
              builtin: {
                ...(opts.policyExtras?.builtin ?? {}),
                "approve-mcp-tools": false,
              },
            }
          : {}),
      },
      policyLevels: { ...DEFAULT_POLICY_LEVELS },
    },
    config: { ...state.config, config: { ...state.config.config, tools } },
  };
  return selectActiveTools(root).map((t) => t.function.name);
}

const tools = [
  builtIn(BuiltInToolNames.ReadFile),
  mcp("wiki", "search"),
  mcp("wiki", "add", "added"),
  mcp("fresh", "run", "new"),
];

describe("selectActiveTools: MCP tools hidden until approved (TR4)", () => {
  it("Agent mode offers approved MCP tools only", () => {
    expect(names("agent", tools)).toEqual([
      BuiltInToolNames.ReadFile,
      "wiki_search",
    ]);
  });

  it("approval (the pending mark gone after the reload) offers the tool", () => {
    const approved = tools.map((t) =>
      t.function.name === "wiki_add" ? mcp("wiki", "add") : t,
    );
    expect(names("agent", approved)).toContain("wiki_add");
  });

  it("with approve-mcp-tools off, which the IDGAF preset does, they are offered", () => {
    expect(names("agent", tools, { idgaf: true })).toEqual([
      BuiltInToolNames.ReadFile,
      "fresh_run",
      "wiki_add",
      "wiki_search",
    ]);
  });

  it("a background run gets no MCP tool unless background.mcpTools lists it", () => {
    expect(names("background", tools)).toEqual([BuiltInToolNames.ReadFile]);
    expect(
      names("background", tools, {
        policyExtras: { backgroundMcpTools: ["wiki/search", "fresh"] },
      }),
    ).toEqual([BuiltInToolNames.ReadFile, "fresh_run", "wiki_search"]);
  });
});
