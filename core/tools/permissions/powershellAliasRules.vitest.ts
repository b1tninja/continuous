import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { commandCandidates } from "./candidates";
import { effectsOfCommand } from "./commandSpecs";
import { hiddenCommandName } from "./commandName";
import { evaluateToolPolicyWithRules as evaluateAndRun } from "./evaluate";
import { wouldDecide } from "./idgafView.testutil";
import { DEFAULT_POLICY_LEVELS } from "./policy";
import { classifyReadOnly } from "./readOnlyCommand";
import { matchTerminalCommand, parseToolPermissions } from "./rules";

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

/** Every alias of a cmdlet that a rule or a floor on that cmdlet has to catch. */
const ALIASES_BY_CMDLET: [string, string[], string][] = [
  ["Remove-Item", ["ri", "rm", "rmdir", "del", "erase", "rd"], "x"],
  ["Invoke-Expression", ["iex"], "$s"],
  ["Invoke-WebRequest", ["iwr", "curl", "wget"], "http://e.test/x"],
  ["Invoke-RestMethod", ["irm"], "http://e.test/x"],
  ["Start-Process", ["start", "saps"], "notepad"],
  ["Stop-Process", ["kill", "spps"], "-Id 4"],
  ["Set-Content", ["sc"], "x y"],
  ["Copy-Item", ["copy", "cp", "cpi"], "a b"],
  ["Move-Item", ["move", "mv", "mi"], "a b"],
  ["Rename-Item", ["ren", "rni"], "a b"],
  ["Invoke-Command", ["icm"], "{ whoami }"],
  ["Set-Alias", ["sal"], "r Get-Date"],
  ["New-Alias", ["nal"], "r Get-Date"],
  ["Start-Job", ["sajb"], "{ whoami }"],
  ["Start-Service", ["sasv"], "Spooler"],
  ["Stop-Service", ["spsv"], "Spooler"],
  ["Import-Module", ["ipmo"], "x"],
];

describe("a deny rule on a cmdlet sees every one of its aliases", () => {
  const cases = ALIASES_BY_CMDLET.flatMap(([cmdlet, aliases, args]) =>
    aliases.map((alias) => [cmdlet, alias, args] as const),
  );

  it.each(cases)("%s: %s", (cmdlet, alias, args) => {
    const rules = parseToolPermissions({
      deny: [`runTerminalCommand(${cmdlet}*)`],
    });
    for (const spelling of [alias, alias.toUpperCase()]) {
      expect(
        matchTerminalCommand(rules, `${spelling} ${args}`, "powershell")
          ?.decision,
        spelling,
      ).toBe("deny");
    }
    // a different cmdlet is left alone
    expect(
      matchTerminalCommand(rules, "Get-ChildItem .", "powershell"),
    ).toBeUndefined();
  });

  it.each(cases)(
    "%s: %s is a floor rule at IDGAF, and no allow rule loosens it",
    (cmdlet, alias, args) => {
      const r = run(`${alias} ${args}`, "powershell", {
        approval: {
          levels: { ...DEFAULT_POLICY_LEVELS, tools: "idgaf" },
          floor: [`runTerminalCommand(${cmdlet}*)`],
        },
        permissions: { allow: ["runTerminalCommand(*)"] },
      });
      expect(r.policy).toBe(OFF);
      expect(r.source).toBe("floor");
    },
  );

  it("candidates carry both the alias and the cmdlet", () => {
    const list = commandCandidates("rm -Recurse x", "powershell");
    expect(list).toContain("rm -Recurse x");
    expect(list).toContain("Remove-Item -Recurse x");
    expect(commandCandidates("icm -ComputerName h", "powershell")).toContain(
      "Invoke-Command -ComputerName h",
    );
  });
});

describe("effects follow the aliases the old table missed", () => {
  it.each([
    ["ren a b", ["write"]],
    ["rni a b", ["write"]],
    ["icm { whoami }", ["exec", "network"]],
    ["iex $s", ["exec"]],
    ["saps notepad", ["exec"]],
    ["rd x", ["delete"]],
    ["sc x y", ["write"]],
    ["wget http://e.test/x", ["network", "write"]],
  ])("%s", (command, effects) => {
    expect([...effectsOfCommand(command)].sort()).toEqual([...effects].sort());
  });
});

describe("a command that defines an alias asks, and cannot be loosened", () => {
  const defining = [
    "Set-Alias r Remove-Item; r x",
    "sal r Remove-Item; r x",
    "SAL r Remove-Item\nr x",
    "New-Alias -Name r -Value Remove-Item; r x",
    "nal r Remove-Item; r x",
    "Import-Alias .\\a.csv; r x",
    "Microsoft.PowerShell.Utility\\Set-Alias r Remove-Item; r x",
    "Get-Date | Set-Alias r Remove-Item",
    "if ($true) { sal r Remove-Item }; r x",
    "& Set-Alias r Remove-Item; r x",
    "Set-Item alias:r Remove-Item; r x",
    "New-Item -Path 'Alias:\\r' -Value Remove-Item; r x",
    "function rm { Write-Output hi }; rm x",
    "filter Get-Date { 1 }; Get-Date",
  ];

  it.each(defining)("%j asks at every level", (command) => {
    expect(hiddenCommandName(command, "powershell")).toBeDefined();
    for (const level of ["idgaf", "permissive", "automatic"] as const) {
      expect(run(command, "powershell", at(level)), level).toMatchObject({
        policy: ASK,
        protection: "hidden-command",
      });
    }
  });

  it.each(defining)("%j ignores a blanket allow rule", (command) => {
    expect(
      run(command, "powershell", {
        permissions: { allow: ["runTerminalCommand(*)"] },
      }),
    ).toMatchObject({ policy: ASK, protection: "hidden-command" });
  });

  it("a deny rule still refuses what it can see in such a command", () => {
    const r = run("sal r Remove-Item; Remove-Item x", "powershell", {
      permissions: { deny: ["runTerminalCommand(Remove-Item*)"] },
    });
    expect(r.policy).toBe(OFF);
  });

  it("is left alone when the person switched the safety check off", () => {
    const r = run("sal r Remove-Item; r x", "powershell", {
      approval: {
        levels: DEFAULT_POLICY_LEVELS,
        builtin: { "refuse-dangerous-commands": false },
      },
    });
    expect(r.protection).not.toBe("hidden-command");
  });

  it.each([
    "Get-Alias rm",
    "gal",
    "Export-Alias -Path a.csv",
    "Get-ChildItem alias:",
    "gci Alias:\\r",
    "Get-Item alias:rm",
    "git commit -m 'Set-Alias and sal and function'",
    'Write-Output "Set-Alias r Remove-Item"',
    "Write-Output sal",
    "$x = 'sal'",
    "git log --grep=function",
  ])("%j does not ask for a definition", (command) => {
    expect(hiddenCommandName(command, "powershell")).toBeUndefined();
  });

  it("a bash function does not make a command of unknown shell ask", () => {
    expect(hiddenCommandName("f() { :; }; function g { :; }", undefined)).toBe(
      undefined,
    );
    expect(hiddenCommandName("function g { :; }", "bash")).toBeUndefined();
  });

  it("an alias cmdlet in a command of unknown shell asks too", () => {
    expect(
      hiddenCommandName("Set-Alias r Remove-Item", undefined),
    ).toBeDefined();
  });
});

describe("read-only vouching does not grow with the table", () => {
  it.each([
    "ls",
    "gci",
    "dir",
    "cat x",
    "type x",
    "sort",
    "select -First 1",
    "pwd",
    "cd ..",
  ])("%s is still vouched", (command) => {
    expect(classifyReadOnly(command, { shell: "powershell" }).vouched).toBe(
      true,
    );
  });

  it.each([
    "compare a b",
    "write hi",
    "rm x",
    "ren a b",
    "sal r Get-Date",
    "icm { whoami }",
    "sc x y",
    "set x 1",
    "sleep 5",
    "r",
    "mkdir x",
    "md x",
  ])("%s is not vouched", (command) => {
    expect(classifyReadOnly(command, { shell: "powershell" }).vouched).toBe(
      false,
    );
  });
});
