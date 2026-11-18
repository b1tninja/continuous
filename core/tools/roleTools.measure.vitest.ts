import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IDE, Tool } from "..";
import { countTokens } from "../llm/countTokens";
import { BuiltInToolNames } from "./builtIn";
import {
  getBaseToolDefinitions,
  getConfigDependentToolDefinitions,
} from "./index";
import { ideToolRef } from "./roleToolRefs";
import {
  filterToolsForRole,
  roleClasses,
  TOOL_ROLES,
  type ToolRole,
} from "./roleTools";
import { serializeMeasured } from "./toolOverhead";

/**
 * Tokens of the tool list each role is offered (plans/ROADMAP.md, TR1): the
 * IDE's default built-in list (no experimental tools, no tool search), after
 * the mode gating the selector applies (task list, Loop tools and present_plan
 * are offered only where a mode asks for them). Set ROLE_TOOLS_OUT to a file
 * path to write the table.
 */
const ide = { getIdeInfo: async () => ({ ideType: "vscode" }) } as IDE;

const GATED = new Set<string>([
  BuiltInToolNames.TaskList,
  BuiltInToolNames.HoldQuestion,
  BuiltInToolNames.FinishItem,
  BuiltInToolNames.RemindMe,
  BuiltInToolNames.PresentPlan,
]);

function offeredFor(role: ToolRole, all: Tool[]): Tool[] {
  const modeTools = all.filter(
    (t) =>
      !GATED.has(t.function.name) ||
      (role === "planner" && t.function.name === BuiltInToolNames.PresentPlan),
  );
  return filterToolsForRole(role, modeTools, ideToolRef);
}

describe("tokens per role tool list", () => {
  it("measures each role and shows which roles share a list", async () => {
    const all = [
      ...getBaseToolDefinitions(),
      ...(await getConfigDependentToolDefinitions({
        rules: [],
        enableExperimentalTools: false,
        isRemote: false,
        modelName: "claude-sonnet-4-5",
        ide,
      })),
    ];
    const rows = TOOL_ROLES.map((role) => {
      const tools = offeredFor(role, all);
      const tokens = tools.reduce(
        (n, t) =>
          n +
          countTokens(
            serializeMeasured({
              name: t.function.name,
              description: t.function.description ?? "",
              parameters: t.function.parameters,
            }),
          ),
        0,
      );
      return {
        role,
        count: tools.length,
        tokens,
        key: tools.map((t) => t.function.name).join(","),
      };
    });
    const lines = [
      "| role | classes | tools | tokens | list shared with |",
      "| --- | --- | --- | --- | --- |",
      ...rows.map((r) => {
        const same = rows
          .filter((o) => o.role !== r.role && o.key === r.key)
          .map((o) => o.role)
          .join(", ");
        return `| ${r.role} | ${roleClasses(r.role).length} | ${r.count} | ${r.tokens} | ${same || "-"} |`;
      }),
    ];
    const report = lines.join("\n");
    console.log(report);
    if (process.env.ROLE_TOOLS_OUT)
      writeFileSync(process.env.ROLE_TOOLS_OUT, report);

    const by = Object.fromEntries(rows.map((r) => [r.role, r]));
    expect(by.reviewer.count).toBe(0);
    expect(by.chat.tokens).toBe(0);
    expect(by.agent.key).toBe(by.background.key);
    expect(by.planner.tokens).toBeGreaterThan(0);
    expect(by.planner.tokens).toBeLessThan(by.agent.tokens);
  });
});
