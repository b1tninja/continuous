import { writeFileSync } from "node:fs";

import { countTokens } from "core/llm/countTokens.js";
import {
  biggestDescriptions,
  formatBiggest,
  formatReport,
  measureSet,
  type MeasuredTool,
} from "core/tools/toolOverhead.js";
import { MCP_FIXTURES } from "core/tools/toolOverheadFixtures.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The CLI half of the tool-overhead measurement (plans/tool-overhead.md): the
 * real getAllAvailableTools over fixture MCP tools, per mode. Set
 * TOOL_OVERHEAD_OUT to a file path to write the report there.
 */

const state = vi.hoisted(() => ({
  mode: "agent" as "plan" | "agent",
  mcp: [] as any[],
  history: [] as any[],
}));

vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: { MODEL: "model", MCP: "mcp" },
  serviceContainer: {
    get: vi.fn(async (name: string) =>
      name === "model"
        ? {
            model: {
              provider: "anthropic",
              name: "claude-sonnet-4-5",
              model: "claude-sonnet-4-5",
            },
          }
        : { tools: state.mcp },
    ),
  },
  services: {
    toolPermissions: {
      getCurrentMode: () => state.mode,
      isHeadless: () => false,
    },
    chatHistory: { getHistory: () => state.history },
  },
}));
vi.mock("./searchCode.js", async (orig) => ({
  ...(await orig<any>()),
  checkIfRipgrepIsInstalled: async () => true,
}));

import {
  applyCliToolSearch,
  activatedToolNamesFromHistory,
  resetToolSearchState,
} from "./searchTools.js";

import { getAllAvailableTools } from "./index.js";

const mcpOf = (n: number) =>
  MCP_FIXTURES[n].tools.map((m) => ({
    name: m.name,
    description: m.description,
    inputSchema: m.parameters,
    serverName: "fixture",
  }));

const measured = (tools: any[]): MeasuredTool[] =>
  tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

beforeEach(() => {
  delete process.env.CONTINUE_TOOL_SEARCH;
  resetToolSearchState();
  state.history = [];
});

/** What the history holds after the model called SearchTools and got `out`. */
const searchTurn = (out: string) => ({
  message: { role: "assistant", content: "" },
  contextItems: [],
  toolCallStates: [
    {
      toolCallId: "c1",
      toolCall: {
        id: "c1",
        type: "function",
        function: { name: "SearchTools", arguments: "{}" },
      },
      status: "done",
      parsedArgs: {},
      output: [{ content: out, name: "result", description: "" }],
    },
  ],
});

describe("CLI tool overhead", () => {
  it("measures plan and agent mode with and without MCP tools", async () => {
    const count = (s: string) => countTokens(s);
    const sets = [];
    for (const mode of ["plan", "agent"] as const) {
      state.mode = mode;
      state.mcp = [];
      sets.push(
        measureSet(mode, measured(await getAllAvailableTools(false)), count),
      );
      for (const [i, f] of MCP_FIXTURES.entries()) {
        state.mcp = mcpOf(i);
        sets.push(
          measureSet(
            `${mode} + ${f.label}`,
            measured(await getAllAvailableTools(false)),
            count,
          ),
        );
      }
    }
    const agent = sets.find((s) => s.label === "agent")!;
    expect(agent.count).toBeGreaterThan(5);
    expect(sets.find((s) => s.label === "agent + mcp-60")!.count).toBe(
      agent.count + 60,
    );
    const report = [
      formatReport("CLI (getAllAvailableTools, real built-ins)", sets),
      "### Per-tool tokens, agent mode, built-in tools",
      "",
      agent.rows.map((r) => `${r.name}: ${r.tokens}`).join("; "),
      "",
      "### Biggest descriptions (CLI built-in tools)",
      "",
      formatBiggest(biggestDescriptions([agent], 6)),
    ].join("\n");
    if (process.env.TOOL_OVERHEAD_OUT) {
      writeFileSync(process.env.TOOL_OVERHEAD_OUT, report);
    }
  });
});

describe("CLI tool search", () => {
  it("off: getAllAvailableTools is the same with the setting unset or off", async () => {
    state.mode = "agent";
    state.mcp = mcpOf(2);
    const a = JSON.stringify(measured(await getAllAvailableTools(false)));
    process.env.CONTINUE_TOOL_SEARCH = "off";
    const b = JSON.stringify(measured(await getAllAvailableTools(false)));
    expect(b).toBe(a);
    expect(a).not.toContain("SearchTools");
  });

  it("auto under the budget changes nothing", async () => {
    state.mode = "agent";
    state.mcp = mcpOf(0);
    const off = JSON.stringify(measured(await getAllAvailableTools(false)));
    process.env.CONTINUE_TOOL_SEARCH = "auto";
    expect(JSON.stringify(measured(await getAllAvailableTools(false)))).toBe(
      off,
    );
  });

  it("auto over the budget defers, a search activates, the next list has the tool at the end", async () => {
    state.mode = "agent";
    state.mcp = mcpOf(2);
    const all = await getAllAvailableTools(false);
    process.env.CONTINUE_TOOL_SEARCH = "auto";
    const first = await getAllAvailableTools(false);
    const names = first.map((t) => t.name);
    expect(names).toContain("SearchTools");
    expect(first.length).toBeLessThan(all.length);
    expect(names).not.toContain("merge_pull_request");
    const search = first.find((t) => t.name === "SearchTools")!;
    const out = await search.run({ query: "merge pull request" });
    expect(out.split("\n")[0]).toMatch(/^activated: .*merge_pull_request/);
    state.history = [searchTurn(out)];
    expect(activatedToolNamesFromHistory(state.history)).toContain(
      "merge_pull_request",
    );
    const second = (await getAllAvailableTools(false)).map((t) => t.name);
    expect(second.at(-1)).toBe(
      activatedToolNamesFromHistory(state.history).at(-1),
    );
    expect(second).toContain("merge_pull_request");
    expect(second.slice(0, names.length)).toEqual(names);
  });

  it("the SearchTools description is the same before and after an activation", async () => {
    state.mode = "agent";
    state.mcp = mcpOf(2);
    process.env.CONTINUE_TOOL_SEARCH = "auto";
    const first = await getAllAvailableTools(false);
    const search = first.find((t) => t.name === "SearchTools")!;
    const out = await search.run({ query: "merge pull request" });
    state.history = [searchTurn(out)];
    const second = await getAllAvailableTools(false);
    expect(second.find((t) => t.name === "SearchTools")!.description).toBe(
      search.description,
    );
    expect(second.length).toBeGreaterThan(first.length);
  });

  it("a resumed session (fresh module state, saved history) lists the same tools as before the resume", async () => {
    state.mode = "agent";
    state.mcp = mcpOf(2);
    process.env.CONTINUE_TOOL_SEARCH = "auto";
    const first = await getAllAvailableTools(false);
    const out = await first
      .find((t) => t.name === "SearchTools")!
      .run({ query: "merge pull request" });
    state.history = [searchTurn(out)];
    const before = (await getAllAvailableTools(false)).map((t) => t.name);
    resetToolSearchState(); // what a new process starts with
    const after = (await getAllAvailableTools(false)).map((t) => t.name);
    expect(after).toEqual(before);
    expect(after).toContain("merge_pull_request");
  });

  it("a new session in the same process starts without the first session's tools", async () => {
    state.mode = "agent";
    state.mcp = mcpOf(2);
    process.env.CONTINUE_TOOL_SEARCH = "auto";
    const first = await getAllAvailableTools(false);
    const out = await first
      .find((t) => t.name === "SearchTools")!
      .run({ query: "merge pull request" });
    state.history = [searchTurn(out)];
    expect((await getAllAvailableTools(false)).map((t) => t.name)).toContain(
      "merge_pull_request",
    );
    state.history = []; // a new session's empty history
    expect(
      (await getAllAvailableTools(false)).map((t) => t.name),
    ).not.toContain("merge_pull_request");
  });

  it("applyCliToolSearch with the setting off returns the same array", () => {
    const tools = [] as any[];
    expect(applyCliToolSearch(tools, { mode: "agent", setting: "off" })).toBe(
      tools,
    );
  });
});
