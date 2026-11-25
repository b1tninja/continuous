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
    context: "permissive",
    tools: "permissive",
    edits: "permissive",
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

// The shell check runs only when its switch is on
const SWITCH_ON: ApprovalSettings = {
  levels: { ...IDGAF.levels, tools: "permissive" },
  builtin: { "check-shell-commands": true },
};

describe("detectShellHints on the terminal command path", () => {
  it("refuses && under Windows PowerShell 5.1 once the switch is on, before anyone is asked", () => {
    const r = run("echo A && echo B", "powershell", ALLOW, SWITCH_ON);
    expect(r.policy).toBe(OFF);
    expect(r.source).toBe("shell-hint");
    expect(r.reason).toContain("The command was not run");
    expect(r.reason).toContain("Windows PowerShell 5.1");
    expect(r.reason).toContain("&&");
  });

  it("asks and names the warning when the command only looks like another shell", () => {
    const r = run("source .venv/bin/activate", "powershell", ALLOW, SWITCH_ON);
    expect(r.policy).toBe(ASK);
    expect(r.source).toBe("shell-hint");
    expect(r.reason).toContain("This looks like bash");
    expect(r.reason).toContain("Windows PowerShell 5.1");
  });

  it("refuses && at IDGAF only when the person keeps the shell check on", () => {
    // The IDGAF preset switches the check off, so the command runs as written
    const off = run("echo A && echo B", "powershell", ALLOW, IDGAF);
    expect(off.source).not.toBe("shell-hint");
    // A switch the file names as on stays on at IDGAF
    const kept: ApprovalSettings = {
      ...IDGAF,
      builtin: { ...IDGAF.builtin, "check-shell-commands": true },
    };
    const r = run("echo A && echo B", "powershell", ALLOW, kept);
    expect(r.policy).toBe(OFF);
    expect(r.source).toBe("shell-hint");
    expect(r.reason).toContain("The command was not run");
    expect(r.reason).toContain("Windows PowerShell 5.1");
    expect(r.reason).toContain("Instead:");
    expect(r.reason).toContain("Fix it and call again");
  });

  it("runs && as written once the Check shell commands switch is off", () => {
    const off: ApprovalSettings = {
      levels: { ...IDGAF.levels, tools: "automatic" },
      builtin: { "check-shell-commands": false },
    };
    const r = run("echo A && echo B", "powershell", ALLOW, off);
    expect(r.source).not.toBe("shell-hint");
    expect(r.policy).not.toBe(OFF);
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

  it("refuses an unclosed quote before anyone is asked, unless the switch is off", () => {
    const r = run('echo "hello', "powershell", ALLOW, SWITCH_ON);
    expect(r.policy).toBe(OFF);
    expect(r.source).toBe("shell-hint");
    expect(r.reason).toContain("never closed");
    expect(r.reason).toContain("Instead:");
    expect(r.reason).toContain("Windows PowerShell");
    const atIdgaf = run('echo "hello', "powershell", ALLOW, IDGAF);
    expect(atIdgaf.source).not.toBe("shell-hint");
  });

  it("leaves && alone under bash, and raises nothing when the shell is unknown", () => {
    expect(run("echo A && echo B", "bash").policy).toBe(ALLOW);
    expect(run("echo A && echo B", "unknown")).toEqual({
      policy: ALLOW,
      displayValue: "echo A && echo B",
    });
  });
});
