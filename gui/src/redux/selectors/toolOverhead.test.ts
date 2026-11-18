import type { Tool } from "core";
import { countTokens } from "core/llm/countTokens";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import {
  getBaseToolDefinitions,
  getConfigDependentToolDefinitions,
} from "core/tools";
import {
  biggestDescriptions,
  formatBiggest,
  formatReport,
  measureSet,
  MeasuredTool,
} from "core/tools/toolOverhead";
import { MCP_FIXTURES } from "core/tools/toolOverheadFixtures";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyToolSearch } from "../util/applyToolSearch";
import { selectActiveTools } from "./selectActiveTools";

/**
 * The IDE half of the tool-overhead measurement (plans/tool-overhead.md). It
 * builds the real built-in tool list (base plus config-dependent, as the
 * config loader does) and runs it through the real selector for each mode.
 * Set TOOL_OVERHEAD_OUT to a file path to write the report there.
 */

const ide = { getIdeInfo: async () => ({ ideType: "vscode" }) } as any;

async function configTools(toolSearch?: "auto"): Promise<Tool[]> {
  return [
    ...getBaseToolDefinitions(),
    ...(await getConfigDependentToolDefinitions({
      rules: [],
      enableExperimentalTools: false,
      isRemote: false,
      modelName: "claude-sonnet-4-5",
      ide,
      toolSearch,
    })),
  ];
}

function asTools(mcp: MeasuredTool[]): Tool[] {
  return mcp.map(
    (m) =>
      ({
        type: "function",
        displayTitle: m.name,
        readonly: false,
        group: "fixture-server",
        function: {
          name: m.name,
          description: m.description,
          parameters: m.parameters,
        },
      }) as Tool,
  );
}

type Mode = "chat" | "plan" | "agent";

function active(
  mode: Mode,
  tools: Tool[],
  loopItem = false,
  hasTaskList = false,
): Tool[] {
  return selectActiveTools.resultFunc(
    mode,
    tools,
    {},
    {},
    loopItem,
    hasTaskList,
    undefined,
    undefined,
    undefined,
    false,
  );
}

const measured = (tools: Tool[]): MeasuredTool[] =>
  tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters,
  }));

describe("IDE tool overhead", () => {
  it("measures every mode with and without MCP tools, and writes the report", async () => {
    const base = await configTools();
    const count = (s: string) => countTokens(s);
    const sets = [];
    const scenarios: [string, Mode, boolean, boolean][] = [
      ["chat", "chat", false, false],
      ["plan", "plan", false, false],
      ["agent", "agent", false, false],
      ["agent + task list", "agent", false, true],
      ["loop item", "agent", true, false],
    ];
    for (const [label, mode, loop, list] of scenarios) {
      sets.push(
        measureSet(label, measured(active(mode, base, loop, list)), count),
      );
      for (const f of MCP_FIXTURES) {
        const withMcp = [...base, ...asTools(f.tools)];
        sets.push(
          measureSet(
            `${label} + ${f.label}`,
            measured(active(mode, withMcp, loop, list)),
            count,
          ),
        );
      }
    }
    const agent = sets.find((s) => s.label === "agent")!;
    const agent60 = sets.find((s) => s.label === "agent + mcp-60")!;
    expect(agent.count).toBeGreaterThan(5);
    expect(sets.find((s) => s.label === "chat")!.count).toBe(0);
    expect(agent60.tokens).toBeGreaterThan(agent.tokens);

    const report = [
      formatReport(
        "IDE (gui selectActiveTools over the real core definitions)",
        sets,
      ),
      "### Per-tool tokens, agent mode, built-in tools",
      "",
      agent.rows.map((r) => `${r.name}: ${r.tokens}`).join("; "),
      "",
      "### Biggest descriptions (built-in and fixture tools)",
      "",
      formatBiggest(biggestDescriptions([agent60], 12)),
    ].join("\n");
    if (process.env.TOOL_OVERHEAD_OUT) {
      writeFileSync(process.env.TOOL_OVERHEAD_OUT, report);
    }
  });

  it("toolSearch off is byte-identical to the selector's own list", async () => {
    const tools = [...(await configTools()), ...asTools(MCP_FIXTURES[2].tools)];
    for (const mode of ["chat", "plan", "agent"] as Mode[]) {
      const before = active(mode, tools);
      for (const setting of [undefined, "off"] as const) {
        const after = applyToolSearch(before, {
          setting,
          mode,
          history: [],
        });
        expect(after).toBe(before);
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      }
    }
  });

  it("toolSearch auto stays equal to today's list under the budget, and engages above it", async () => {
    const small = [
      ...(await configTools("auto")),
      ...asTools(MCP_FIXTURES[0].tools),
    ];
    const plain = [...(await configTools()), ...asTools(MCP_FIXTURES[0].tools)];
    const under = applyToolSearch(active("agent", small), {
      setting: "auto",
      mode: "agent",
      history: [],
    });
    expect(JSON.stringify(under)).toBe(JSON.stringify(active("agent", plain)));

    const big = [
      ...(await configTools("auto")),
      ...asTools(MCP_FIXTURES[2].tools),
    ];
    const over = applyToolSearch(active("agent", big), {
      setting: "auto",
      mode: "agent",
      history: [],
    });
    const names = over.map((t) => t.function.name);
    expect(names).toContain("search_tools");
    expect(over.length).toBeLessThan(active("agent", big).length);
    expect(
      over.filter((t) => t.group !== BUILT_IN_GROUP_NAME).length,
    ).toBeLessThan(MCP_FIXTURES[2].tools.length);
  });
});
