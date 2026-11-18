import { describe, expect, it } from "vitest";

import { evaluateToolPolicyWithRules } from "./evaluate";
import type { ShellKind } from "../../util/shell";

const ASK = "allowedWithPermission" as const;
const ALLOW = "allowedWithoutPermission" as const;
const OFF = "disabled" as const;

const run = (
  command: string,
  shell: ShellKind,
  basePolicy: typeof ASK | typeof ALLOW = ALLOW,
) =>
  evaluateToolPolicyWithRules({
    tool: { group: "Built-In" } as never,
    toolName: "run_terminal_command",
    basePolicy,
    parsedArgs: { command },
    permissions: undefined,
    shell,
  });

describe("detectShellHints on the terminal command path", () => {
  it("refuses && under Windows PowerShell 5.1 before anyone is asked", () => {
    const r = run("echo A && echo B", "powershell");
    expect(r.policy).toBe(OFF);
    expect(r.source).toBe("shell-hint");
    expect(r.reason).toContain("The command was not run");
    expect(r.reason).toContain("Windows PowerShell 5.1");
    expect(r.reason).toContain("&&");
  });

  it("asks and names the warning when the command only looks like another shell", () => {
    const r = run("source .venv/bin/activate", "powershell");
    expect(r.policy).toBe(ASK);
    expect(r.source).toBe("shell-hint");
    expect(r.reason).toContain("This looks like bash");
    expect(r.reason).toContain("Windows PowerShell 5.1");
  });

  it("leaves && alone under bash, and raises nothing when the shell is unknown", () => {
    expect(run("echo A && echo B", "bash").policy).toBe(ALLOW);
    expect(run("echo A && echo B", "unknown")).toEqual({
      policy: ALLOW,
      displayValue: "echo A && echo B",
    });
  });
});
