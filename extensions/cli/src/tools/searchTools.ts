import type { ChatHistoryItem } from "core/index.js";
import {
  DEFAULT_TOOL_BUDGET_TOKENS,
  activatedFromResults,
  formatSearchResult,
  oneLine,
  resolveToolSearchMode,
  searchIndex,
  searchToolsDescription,
  selectTools,
  type ToolAdapter,
  type ToolSearchMode,
} from "core/tools/toolSearch.js";

import type { Tool } from "./types.js";

/**
 * Tool search for the CLI (plans/tool-overhead.md). Off unless
 * CONTINUE_TOOL_SEARCH=auto. With it on and the MCP tools over the budget,
 * the model gets the tools that fit and `SearchTools` for the rest; a search
 * appends what it found to the list for the following requests.
 */
export const SEARCH_TOOLS_CLI_NAME = "SearchTools";

export const cliToolAdapter: ToolAdapter<Tool> = {
  name: (t) => t.name,
  description: (t) => t.description,
  parameters: (t) => t.parameters,
  isCore: (t) => t.isBuiltIn,
};

/** The tools of the last selection that were left out, for the search to read. */
let lastDeferred: Tool[] = [];

export function resetToolSearchState(): void {
  lastDeferred = [];
}

/**
 * The tools the conversation's searches activated, in the order found, read
 * back out of the search results in the history (as the editor does). Nothing
 * is kept between requests, so a resumed session lists the tools its history
 * already called and a second session in one process starts with none.
 */
export function activatedToolNamesFromHistory(
  history: readonly ChatHistoryItem[],
): string[] {
  const texts: string[] = [];
  for (const item of history) {
    for (const state of item.toolCallStates ?? []) {
      if (state.toolCall.function.name !== SEARCH_TOOLS_CLI_NAME) continue;
      for (const o of state.output ?? []) texts.push(o.content);
    }
  }
  return activatedFromResults(texts);
}

export function makeSearchToolsCliTool(
  deferred: readonly { name: string; line: string }[] = [],
): Tool {
  return {
    name: SEARCH_TOOLS_CLI_NAME,
    displayName: "Search Tools",
    description: searchToolsDescription(deferred),
    readonly: true,
    isBuiltIn: true,
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description:
            "Keywords for what you need, for example 'github pull request'.",
        },
        limit: {
          type: "number",
          description: "Most tools to return. Default 5.",
        },
      },
    },
    run: async (args: { query?: string; limit?: number }) => {
      const query = String(args?.query ?? "");
      const index = lastDeferred.map((t) => ({
        name: t.name,
        line: oneLine(t.description),
      }));
      const matches = searchIndex(index, query, args?.limit ?? 5);
      return formatSearchResult(matches, query);
    },
  };
}

/**
 * The CLI's tool list under tool search. Off (the default): the list as it
 * came, the same array. On: unchanged until the MCP tools pass the budget.
 */
export function applyCliToolSearch(
  tools: Tool[],
  options: {
    mode: "chat" | "plan" | "agent";
    family?: string;
    setting?: ToolSearchMode;
    budgetTokens?: number;
    /** The conversation so far; the activated tools are read from it. */
    history?: readonly ChatHistoryItem[];
  },
): Tool[] {
  const setting = options.setting ?? resolveToolSearchMode();
  if (setting !== "auto") return tools;
  const core = tools.filter((t) => t.isBuiltIn);
  const mcp = tools.filter((t) => !t.isBuiltIn);
  const result = selectTools({
    mode: options.mode,
    family: options.family,
    coreTools: core,
    mcpTools: mcp,
    budgetTokens: options.budgetTokens ?? DEFAULT_TOOL_BUDGET_TOKENS,
    metaTool: makeSearchToolsCliTool,
    adapter: cliToolAdapter,
    activatedNames: activatedToolNamesFromHistory(options.history ?? []),
  });
  if (!result.engaged) {
    lastDeferred = [];
    return tools;
  }
  const byName = new Map(mcp.map((t) => [t.name, t]));
  lastDeferred = result.deferred
    .map((e) => byName.get(e.name))
    .filter((t): t is Tool => !!t);
  // A tool activated earlier is in the list now but a later search must not
  // offer it again, so it is left out of `lastDeferred` already (selectTools
  // removes activated names from `deferred`)
  return result.tools;
}

/** For the static built-in list (display names, permission lookups). */
export const searchToolsMeta: Tool = makeSearchToolsCliTool();
