import { describe, expect, it } from "vitest";

import type { ShellKind } from "../../util/shell";
import type { ApprovalSettings } from "./approval";
import { evaluateToolPolicyWithRules } from "./evaluate";
import { DEFAULT_POLICY_LEVELS } from "./policy";
import { builtinForPreset } from "./safetyDegrees";

const ASK = "allowedWithPermission" as const;
const ALLOW = "allowedWithoutPermission" as const;
const OFF = "disabled" as const;

const IDGAF: ApprovalSettings = {
  levels: {
    ...DEFAULT_POLICY_LEVELS,
    context: "idgaf",
    tools: "idgaf",
    edits: "idgaf",
  },
  // The IDGAF preset leaves no safety check on
  builtin: builtinForPreset("idgaf"),
};

const run = (
  command: string,
  shell: ShellKind,
  basePolicy: typeof ASK | typeof ALLOW = ALLOW,
  approval?: ApprovalSettings,
) =>
  evaluateToolPolicyWithRules({
    tool: { group: "Built-In" } as never,
    toolName: "run_terminal_command",
    basePolicy,
    parsedArgs: { command },
    permissions: undefined,
    shell,
    ...(approval ? { approval } : {}),
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

  it("refuses && at IDGAF, because Windows PowerShell 5.1 cannot parse it", () => {
    const r = run("echo A && echo B", "powershell", ALLOW, IDGAF);
    expect(r.policy).toBe(OFF);
    expect(r.source).toBe("shell-hint");
    expect(r.reason).toContain("The command was not run");
    expect(r.reason).toContain("Windows PowerShell 5.1");
    expect(r.reason).toContain("Instead:");
    expect(r.reason).toContain("Fix it and call again");
  });

  it("asks for rm -rf and rm -r below IDGAF, and does not call them a shell hint", () => {
    for (const command of ["rm -rf src", "rm -r -fo C:/src"]) {
      const r = run(command, "powershell");
      expect(r.policy, command).toBe(ASK);
      expect(r.source, command).not.toBe("shell-hint");
    }
  });

  it("runs rm -rf under the IDGAF preset, which has no check on", () => {
    const r = run("rm -rf src", "powershell", ALLOW, IDGAF);
    expect(r.policy).toBe(ALLOW);
    expect(r.source).not.toBe("shell-hint");
  });

  it("refuses an unclosed quote before anyone is asked, including at IDGAF", () => {
    for (const approval of [undefined, IDGAF]) {
      const r = run('echo "hello', "powershell", ALLOW, approval);
      expect(r.policy).toBe(OFF);
      expect(r.source).toBe("shell-hint");
      expect(r.reason).toContain("never closed");
      expect(r.reason).toContain("Instead:");
      expect(r.reason).toContain("Windows PowerShell");
    }
  });

  it("leaves && alone under bash, and raises nothing when the shell is unknown", () => {
    expect(run("echo A && echo B", "bash").policy).toBe(ALLOW);
    expect(run("echo A && echo B", "unknown")).toEqual({
      policy: ALLOW,
      displayValue: "echo A && echo B",
    });
  });
});
