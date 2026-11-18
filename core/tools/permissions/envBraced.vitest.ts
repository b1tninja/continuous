import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import { hasUnsafeShellConstruct } from "./command";
import { envAssignmentHit, envAssignments } from "./envAssignments";
import { evaluateToolPolicyWithRules as evaluateAndRun } from "./evaluate";
import { wouldDecide } from "./idgafView.testutil";

// At IDGAF every call runs; these tests read what the guard would have
// decided (wouldDecide), which IDGAF records instead of acting on.
const evaluateToolPolicyWithRules = (
  input: Parameters<typeof evaluateAndRun>[0],
) => wouldDecide(evaluateAndRun(input));

/**
 * ROADMAP P13: PowerShell's braced variable `${env:NAME}` / `${name}` is a
 * variable reference, not a bash parameter expansion. The `:` or `-` inside
 * made `hasUnsafeShellConstruct` refuse it, which asked at every level.
 */
const ASK = "allowedWithPermission" as const;
const RUN = "allowedWithoutPermission" as const;

const terminalTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
};

function run(command: string, level?: "idgaf") {
  return evaluateToolPolicyWithRules({
    tool: terminalTool as any,
    toolName: "run_terminal_command",
    basePolicy: RUN,
    parsedArgs: { command },
    permissions: undefined,
    shell: "powershell",
    ...(level
      ? { approval: { levels: { context: level, tools: level, edits: level } } }
      : {}),
  } as any);
}

describe("braced PowerShell variables", () => {
  it.each([
    "${env:FOO} = 'x'",
    "${env:FOO}='x'; Get-Date",
    "${env:FOO} += 'x'",
    "echo ${env:FOO}",
    "${my-var} = 1; Get-Date",
    "echo ${env:FOO bar}",
  ])("%s is not an unsafe construct in PowerShell", (c) => {
    expect(hasUnsafeShellConstruct(c, "powershell")).toBe(false);
  });

  it.each([
    "${env:A}$(calc)",
    "${env:A}`calc`",
    "${function:x} = { calc }",
    "${variable:x} = 1",
    "${env:A:-b}",
    "echo ${x@P}",
    "${x@P}",
    "${a$(calc)}",
    "${env:$(calc)}",
  ])("%s is still unsafe in PowerShell", (c) => {
    expect(hasUnsafeShellConstruct(c, "powershell")).toBe(true);
  });

  it("bash and an unknown shell keep the strict reading", () => {
    for (const shell of ["bash", undefined] as const) {
      expect(hasUnsafeShellConstruct("${env:FOO}", shell)).toBe(true);
      expect(hasUnsafeShellConstruct("${my-var}", shell)).toBe(true);
    }
  });

  it("${env:FOO}='x'; Get-Date is read as an env assignment", () => {
    expect(envAssignments("${env:FOO}='x'; Get-Date", "powershell")).toEqual([
      { name: "FOO", value: "'x'", how: "powershell" },
    ]);
    expect(
      envAssignmentHit("${env:FOO}='x'; Get-Date", "powershell"),
    ).toBeUndefined();
    expect(
      envAssignmentHit("${env:PATH}='C:/x'; Get-Date", "powershell")?.severity,
    ).toBe("dangerous");
    expect(
      envAssignmentHit("${env:HTTPS_PROXY}='http://h'; Get-Date", "powershell")
        ?.severity,
    ).toBe("sensitive");
  });

  it("a harmless name runs, a policy name asks, at IDGAF", () => {
    expect(run("${env:FOO}='x'; Get-Date", "idgaf").policy).toBe(RUN);
    expect(run("${env:CI}='1'; Get-Date", "idgaf").policy).toBe(RUN);
    expect(run("${env:PATH}='C:/x'; Get-Date", "idgaf").policy).toBe(ASK);
    expect(
      run("${env:NODE_OPTIONS}='--require x'; Get-Date", "idgaf").policy,
    ).toBe(ASK);
  });

  it.each([
    "${env:A}$(calc)",
    "& ${env:X}",
    "${env:FOO}='$(calc)'; Get-Date",
    '${env:A}="$(calc)"',
  ])("%s asks at IDGAF", (c) => {
    expect(run(c, "idgaf").policy).toBe(ASK);
  });
});
