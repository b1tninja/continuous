import { describe, expect, it } from "vitest";

import { evaluateToolPolicyWithRules } from "./evaluate";
import { parsePermissions } from "./names";
import { DEFAULT_POLICY_LEVELS, type PolicyLevel } from "./policy";

const LEVELS: PolicyLevel[] = [
  "manual",
  "cautious",
  "automatic",
  "permissive",
  "idgaf",
];

const tool = (changed: boolean) =>
  ({
    group: "docs",
    uri: "mcp://docs-id/search",
    originalFunctionName: "search",
    readonly: false,
    ...(changed && {
      mcpDefinitionChange: {
        kind: "changed" as const,
        summary: "search (description 40 to 200 characters)",
      },
    }),
  }) as never;

function run(
  level: PolicyLevel,
  changed: boolean,
  basePolicy: "allowedWithPermission" | "allowedWithoutPermission",
  permissions?: Parameters<
    typeof evaluateToolPolicyWithRules
  >[0]["permissions"],
) {
  return evaluateToolPolicyWithRules({
    tool: tool(changed),
    toolName: "docs_search",
    basePolicy,
    parsedArgs: { q: "x" },
    permissions,
    approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools: level } },
  } as never);
}

describe("an MCP tool whose definition changed since approval", () => {
  it.each(LEVELS.filter((l) => l !== "idgaf"))(
    "asks at %s, even when the tool would run without asking",
    (level) => {
      for (const base of [
        "allowedWithPermission",
        "allowedWithoutPermission",
      ] as const) {
        const r = run(level, true, base);
        expect(r.policy).toBe("allowedWithPermission");
        expect(r.source).toBe("protected-path");
        expect(r.protection).toBe("mcp-definition-changed");
        expect(r.reason).toContain("definition changed");
        expect(r.reason).toContain("description 40 to 200 characters");
      }
    },
  );

  it("is still passed by IDGAF, the owner's explicit choice", () => {
    expect(run("idgaf", true, "allowedWithPermission").policy).toBe(
      "allowedWithoutPermission",
    );
  });

  it("is not loosened by an allow rule", () => {
    const rules = { allow: ["docs_search"] } as never;
    const r = run("permissive", true, "allowedWithPermission", rules);
    expect(r.policy).toBe("allowedWithPermission");
    expect(r.protection).toBe("mcp-definition-changed");
  });

  it("leaves an unchanged tool as before", () => {
    expect(run("permissive", false, "allowedWithPermission").policy).toBe(
      "allowedWithoutPermission",
    );
    expect(run("cautious", false, "allowedWithoutPermission").policy).toBe(
      "allowedWithoutPermission",
    );
  });

  it("does not turn a disabled tool back on", () => {
    expect(run("cautious", true, "allowedWithPermission").policy).not.toBe(
      "disabled",
    );
    const r = evaluateToolPolicyWithRules({
      tool: tool(true),
      toolName: "docs_search",
      basePolicy: "disabled",
      parsedArgs: {},
      permissions: undefined,
    } as never);
    expect(r.policy).toBe("disabled");
  });

  it("a changed launch definition asks at every level but IDGAF and says so", () => {
    const launchTool = {
      group: "docs",
      uri: "mcp://docs-id/search",
      originalFunctionName: "search",
      readonly: false,
      mcpDefinitionChange: {
        kind: "launch" as const,
        summary: "launch definition changed: arguments",
      },
    } as never;
    for (const level of LEVELS) {
      const r = evaluateToolPolicyWithRules({
        tool: launchTool,
        toolName: "docs_search",
        basePolicy: "allowedWithoutPermission",
        parsedArgs: {},
        permissions: undefined,
        approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools: level } },
      } as never);
      if (level === "idgaf") {
        expect(r.policy).toBe("allowedWithoutPermission");
      } else {
        expect(r.policy).toBe("allowedWithPermission");
        expect(r.reason).toContain("started differently");
      }
    }
  });
});

void parsePermissions;
