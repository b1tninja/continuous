import { describe, expect, it } from "vitest";
import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import type { ShellKind } from "../../util/shell";
import { evaluateToolPolicyWithRules as evaluateAndRun } from "./evaluate";
import { wouldDecide } from "./idgafView.testutil";
import { DEFAULT_POLICY_LEVELS } from "./policy";

// At IDGAF every call runs; these tests read what the guard would have
// decided (wouldDecide), which IDGAF records instead of acting on.
const evaluateToolPolicyWithRules = (
  input: Parameters<typeof evaluateAndRun>[0],
) => wouldDecide(evaluateAndRun(input));

const ASK = "allowedWithPermission" as const;
const OFF = "disabled" as const;

const terminalTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
};

const run = (
  command: string,
  shell: ShellKind | undefined,
  extra: Record<string, unknown> = {},
) =>
  evaluateToolPolicyWithRules({
    tool: terminalTool as any,
    toolName: "run_terminal_command",
    basePolicy: ASK,
    parsedArgs: { command },
    permissions: undefined,
    shell,
    ...extra,
  });

const at = (tools: "idgaf" | "permissive" | "automatic") => ({
  approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools } },
});

describe("PowerShell commands the floor used to refuse", () => {
  it.each([
    "$env:NAME = 'x'; npm test",
    "$x = Get-Date; Write-Output $x",
    "foreach ($f in $files) { $n = $f.Name; git add $n }",
    "Get-ChildItem | ForEach-Object { $_.Name }",
    "Get-Process | Where-Object { $_.Id -in 1,2 }",
    "$ErrorActionPreference = 'Stop'\nSet-Location $dir\nnpm test",
    "$s = @'\nline $a\n'@\nWrite-Output $s",
    String.raw`& 'C:\tools\tool.exe' $arg`,
  ])("%j is no longer refused and does not ask for the variable", (command) => {
    const r = run(command, "powershell");
    expect(r.policy).not.toBe(OFF);
    expect(r.protection).not.toBe("hidden-command");
  });
});

describe("a variable where the command name is asks", () => {
  const cases: [ShellKind, string][] = [
    ["powershell", "& $exe --version"],
    ["powershell", ". $script"],
    ["powershell", String.raw`& "$dir\tool.exe"`],
    ["bash", "$cmd args"],
    ["bash", "${prog} args"],
    ["bash", '"$@"'],
    ["zsh", "A=1 $cmd"],
  ];

  it.each(cases)("%s: %j asks, not refuses", (shell, command) => {
    expect(run(command, shell)).toMatchObject({
      policy: ASK,
      source: "protected-path",
      protection: "hidden-command",
    });
  });

  it.each(cases)("%s: %j is not loosened by any level", (shell, command) => {
    for (const level of ["idgaf", "permissive", "automatic"] as const) {
      expect(run(command, shell, at(level)).policy, level).toBe(ASK);
    }
  });

  it.each(cases)("%s: %j ignores a blanket allow rule", (shell, command) => {
    expect(
      run(command, shell, {
        permissions: { allow: ["runTerminalCommand(*)"] },
      }),
    ).toMatchObject({ policy: ASK, protection: "hidden-command" });
  });

  it("still lets a deny rule refuse the command it can see", () => {
    const r = run("& $exe; git push origin main", "powershell", {
      permissions: { deny: ["runTerminalCommand(git push*)"] },
    });
    expect(r.policy).toBe(OFF);
    expect(r.source).toBe("deny-rule");
  });

  it("is left alone when the person switched the safety check off", () => {
    const r = run("& $exe", "powershell", {
      approval: {
        levels: DEFAULT_POLICY_LEVELS,
        builtin: { "refuse-dangerous-commands": false },
      },
    });
    expect(r.protection).not.toBe("hidden-command");
  });
});

describe("what the floor still refuses", () => {
  it.each(["bash", "zsh", "sh", "unknown"] as const)(
    "brace expansion and $IFS in %s",
    (shell) => {
      expect(run("{git,push} origin", shell).policy).toBe(OFF);
      expect(run("git${IFS}push", shell).policy).toBe(OFF);
    },
  );

  it("a plainly destructive command in PowerShell", () => {
    expect(run("rm -rf /", "powershell").policy).toBe(OFF);
  });
});
