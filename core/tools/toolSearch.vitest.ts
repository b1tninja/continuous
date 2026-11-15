import { describe, expect, it } from "vitest";
import { Tool } from "..";
import { BUILT_IN_GROUP_NAME } from "./builtIn";
import { makeSearchToolsTool } from "./definitions/searchTools";
import {
  activatedFromResults,
  DEFAULT_TOOL_BUDGET_TOKENS,
  effectiveBudget,
  formatSearchResult,
  parseActivated,
  resolveToolSearchMode,
  searchIndex,
  selectTools,
} from "./toolSearch";
import { coreToolAdapter } from "./toolSearchAdapter";
import { biggestDescriptions, charsOver4, measureSet } from "./toolOverhead";
import { ALL_FIXTURE_TOOLS, MCP_FIXTURES } from "./toolOverheadFixtures";

function tool(name: string, group: string, description = name): Tool {
  return {
    type: "function",
    displayTitle: name,
    readonly: false,
    group,
    function: { name, description, parameters: { type: "object" } },
  };
}

const core = ["read_file", "edit"].map((n) => tool(n, BUILT_IN_GROUP_NAME));
const fromFixture = (n: number) =>
  MCP_FIXTURES[n].tools.map((m) => ({
    ...tool(m.name, "srv", m.description),
    function: {
      name: m.name,
      description: m.description,
      parameters: m.parameters as Record<string, any>,
    },
  }));

function run(
  mcp: Tool[],
  extra: Partial<Parameters<typeof selectTools<Tool>>[0]> = {},
) {
  return selectTools<Tool>({
    mode: "agent",
    coreTools: core,
    mcpTools: mcp,
    budgetTokens: DEFAULT_TOOL_BUDGET_TOKENS,
    metaTool: makeSearchToolsTool,
    adapter: coreToolAdapter,
    ...extra,
  });
}

describe("selectTools", () => {
  it("under the budget: core tools then MCP tools by name, nothing deferred", () => {
    const mcp = fromFixture(0);
    const r = run([...mcp].reverse());
    expect(r.engaged).toBe(false);
    expect(r.deferred).toEqual([]);
    expect(r.tools.map((t) => t.function.name)).toEqual([
      "read_file",
      "edit",
      ...mcp.map((t) => t.function.name).sort(),
    ]);
  });

  it("is independent of the order the servers connected in", () => {
    const mcp = fromFixture(2);
    const a = run(mcp).tools.map((t) => t.function.name);
    const b = run([...mcp].reverse()).tools.map((t) => t.function.name);
    expect(b).toEqual(a);
  });

  it("over the budget: core first, a name-ordered prefix of MCP tools, then the meta-tool", () => {
    const mcp = fromFixture(2);
    const r = run(mcp);
    expect(r.engaged).toBe(true);
    const names = r.tools.map((t) => t.function.name);
    expect(names.slice(0, 2)).toEqual(["read_file", "edit"]);
    expect(names.at(-1)).toBe("search_tools");
    const kept = names.slice(2, -1);
    const sorted = mcp.map((t) => t.function.name).sort();
    expect(kept).toEqual(sorted.slice(0, kept.length));
    expect(kept.length + r.deferred.length).toBe(mcp.length);
    expect(r.deferred.map((d) => d.name)).toEqual(sorted.slice(kept.length));
    const total = r.tools.reduce(
      (n, t) => n + charsOver4(JSON.stringify(t.function)),
      0,
    );
    expect(total).toBeLessThan(
      core.length * 100 + DEFAULT_TOOL_BUDGET_TOKENS + 200,
    );
  });

  it("an activation appends and never reorders what was there", () => {
    const mcp = fromFixture(2);
    const before = run(mcp);
    const target = before.deferred[3].name;
    const after = run(mcp, { activatedNames: [target] });
    const b = before.tools.map((t) => t.function.name);
    const a = after.tools.map((t) => t.function.name);
    // everything up to and including the meta-tool keeps its place
    expect(a.slice(0, b.length - 1)).toEqual(b.slice(0, -1));
    expect(a.at(-1)).toBe(target);
    expect(after.deferred.map((d) => d.name)).not.toContain(target);
  });

  it("activations keep the order the model found them in", () => {
    const mcp = fromFixture(2);
    const d = run(mcp).deferred;
    const r = run(mcp, { activatedNames: [d[5].name, d[1].name, d[5].name] });
    expect(r.tools.slice(-2).map((t) => t.function.name)).toEqual([
      d[5].name,
      d[1].name,
    ]);
  });

  it("the meta-tool description is identical before and after an activation", () => {
    const mcp = fromFixture(2);
    const before = run(mcp);
    const after = run(mcp, { activatedNames: [before.deferred[3].name] });
    const text = (r: typeof before) =>
      r.tools.find((t) => t.function.name === "search_tools")!.function
        .description;
    expect(text(after)).toBe(text(before));
    // the search index still leaves out what is already in the list
    expect(after.deferred.map((d) => d.name)).not.toContain(
      before.deferred[3].name,
    );
  });

  it("chat mode offers nothing", () => {
    expect(run(fromFixture(2), { mode: "chat" }).tools).toEqual([]);
  });

  it("a small-model family gets half the budget", () => {
    expect(effectiveBudget(4000, "qwen3-coder-30b")).toBe(2000);
    expect(effectiveBudget(4000, "claude-sonnet-4-5")).toBe(4000);
    // mcp-20 is under 4000 tokens but over half of it
    const mcp = fromFixture(1);
    expect(run(mcp, { family: "claude-sonnet-4-5" }).engaged).toBe(false);
    expect(run(mcp, { family: "qwen3-coder-30b" }).engaged).toBe(true);
  });

  it("the meta-tool lists deferred names and stays small", () => {
    const r = run(fromFixture(2));
    const meta = r.tools.at(-1)!;
    for (const d of r.deferred) {
      expect(meta.function.description).toContain(d.name);
    }
    expect(charsOver4(JSON.stringify(meta.function))).toBeLessThan(
      DEFAULT_TOOL_BUDGET_TOKENS / 4,
    );
  });
});

describe("search index", () => {
  const index = ALL_FIXTURE_TOOLS.map((t) => ({
    name: t.name,
    line: t.description.split(".")[0],
  }));

  it("finds by name word, by prefix and by description word", () => {
    expect(searchIndex(index, "screenshot")[0].name).toBe(
      "browser_take_screenshot",
    );
    expect(
      searchIndex(index, "pull request review").map((e) => e.name),
    ).toContain("create_pull_request_review");
    expect(searchIndex(index, "sql")[0].name).toBe("query");
    expect(searchIndex(index, "rename")[0].name).toBe("move_file");
  });

  it("is deterministic and respects the limit", () => {
    const a = searchIndex(index, "file", 3);
    expect(a).toHaveLength(3);
    expect(searchIndex(index, "file", 3)).toEqual(a);
  });

  it("returns nothing for an empty or unmatched query", () => {
    expect(searchIndex(index, "")).toEqual([]);
    expect(searchIndex(index, "zzzzqq")).toEqual([]);
  });

  it("the result is an ordinary text whose first line round-trips", () => {
    const matches = searchIndex(index, "screenshot", 2);
    const text = formatSearchResult(matches, "screenshot");
    expect(parseActivated(text)).toEqual(matches.map((m) => m.name));
    expect(text).toContain("next message");
    expect(parseActivated(formatSearchResult([], "x"))).toEqual([]);
    expect(
      activatedFromResults([
        text,
        formatSearchResult(matches.slice(0, 1), "y"),
      ]),
    ).toEqual(matches.map((m) => m.name));
  });
});

describe("setting", () => {
  it("is off unless it says auto", () => {
    expect(resolveToolSearchMode(undefined, {})).toBe("off");
    expect(resolveToolSearchMode("off", { CONTINUE_TOOL_SEARCH: "auto" })).toBe(
      "off",
    );
    expect(resolveToolSearchMode("auto", {})).toBe("auto");
    expect(
      resolveToolSearchMode(undefined, { CONTINUE_TOOL_SEARCH: "auto" }),
    ).toBe("auto");
    expect(resolveToolSearchMode("on", {})).toBe("off");
  });
});

describe("measurement helpers", () => {
  it("counts per tool and ranks the biggest descriptions", () => {
    const m = measureSet("mcp-20", MCP_FIXTURES[1].tools, charsOver4);
    expect(m.count).toBe(20);
    expect(m.tokens).toBe(m.rows.reduce((n, r) => n + r.tokens, 0));
    const top = biggestDescriptions([m], 3);
    expect(top[0].descriptionTokens).toBeGreaterThanOrEqual(
      top[1].descriptionTokens,
    );
  });

  it("the fixtures have 5, 20 and 60 tools with unique names", () => {
    expect(MCP_FIXTURES.map((f) => f.tools.length)).toEqual([5, 20, 60]);
    const names = ALL_FIXTURE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
