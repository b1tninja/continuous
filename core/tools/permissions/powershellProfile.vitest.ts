import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import { evaluateToolPolicyWithRules, PROFILE_WRITE_REASON } from "./evaluate";
import { DEFAULT_POLICY_LEVELS, type PolicyLevel } from "./policy";
import { normalizeProtectedPath } from "./protected";
import { isConfigPath, isPowerShellProfilePath } from "./protectedPaths";
import { builtinForPreset } from "./safetyDegrees";
import { profileWriteHit } from "./selfProtect";

/**
 * D-012: `protect-config` asks for the class at every level; Automatic
 * refuses only the new PowerShell profile paths (Documents/WindowsPowerShell
 * and Documents/PowerShell, under the home folder or a OneDrive-redirected
 * Documents). IDGAF runs them, recording that Automatic would have refused.
 */
const ASK = "allowedWithPermission" as const;
const ALLOW = "allowedWithoutPermission" as const;
const OFF = "disabled" as const;

const HOME = "C:/Users/dev";
const norm = (p: string) => normalizeProtectedPath(p, HOME, "C:/proj");

const PROFILES = [
  "C:\\Users\\dev\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1",
  "C:\\Users\\dev\\Documents\\WindowsPowerShell\\profile.ps1",
  "C:\\Users\\dev\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1",
  "C:\\Users\\dev\\Documents\\PowerShell\\Microsoft.VSCode_profile.ps1",
  "C:/Users/dev/Documents/WindowsPowerShell/Microsoft.PowerShellISE_profile.ps1",
  // OneDrive-redirected Documents, personal and work
  "C:\\Users\\dev\\OneDrive\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1",
  "C:\\Users\\dev\\OneDrive - Contoso\\Documents\\PowerShell\\profile.ps1",
  "D:\\OneDrive - Contoso\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1",
  // Another account's home, the variables and a WSL path
  "C:/Users/other/Documents/PowerShell/profile.ps1",
  "%USERPROFILE%\\Documents\\WindowsPowerShell\\profile.ps1",
  "$env:USERPROFILE\\OneDrive\\Documents\\PowerShell\\profile.ps1",
  "~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
  "/mnt/c/Users/dev/Documents/WindowsPowerShell/profile.ps1",
  // Case, and Win32 aliases of one file
  "c:\\users\\dev\\documents\\windowspowershell\\MICROSOFT.POWERSHELL_PROFILE.PS1",
  "C:\\Users\\dev\\Documents\\PowerShell\\profile.ps1.",
];

const NOT_PROFILES = [
  "C:\\Users\\dev\\Documents\\notes\\profile.ps1",
  "C:\\Users\\dev\\Documents\\PowerShell\\Modules\\x\\x.psm1",
  "C:\\Users\\dev\\Documents\\PowerShell\\Scripts\\profile.ps1",
  "C:\\Users\\dev\\Documents\\PowerShell\\deploy.ps1",
  "C:\\proj\\Documents\\PowerShell\\profile.ps1",
  "C:\\proj\\scripts\\profile.ps1",
];

describe("the PowerShell profile paths (Windows)", () => {
  it.each(PROFILES)("%s is a profile, and a config path", (p) => {
    expect(isPowerShellProfilePath(norm(p))).toBe(true);
    expect(isConfigPath(norm(p))).toBe(true);
  });

  it.each(NOT_PROFILES)("%s is not a profile", (p) => {
    expect(isPowerShellProfilePath(norm(p))).toBe(false);
  });
});

const fileTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any) => base,
};
const terminalTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
};

const PROFILE =
  "C:\\Users\\dev\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1";
const ONEDRIVE =
  "C:\\Users\\dev\\OneDrive\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1";

const write = (filepath: string, edits: PolicyLevel, builtin = {}) =>
  evaluateToolPolicyWithRules({
    tool: fileTool as any,
    toolName: "create_new_file",
    basePolicy: ALLOW,
    parsedArgs: { filepath, contents: "Import-Module x" },
    permissions: undefined,
    approval: { levels: { ...DEFAULT_POLICY_LEVELS, edits }, builtin },
    home: HOME,
  });

const run = (command: string, tools: PolicyLevel) =>
  evaluateToolPolicyWithRules({
    tool: terminalTool as any,
    toolName: "run_terminal_command",
    basePolicy: ASK,
    parsedArgs: { command },
    permissions: undefined,
    shell: "powershell",
    approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools } },
    home: HOME,
  });

describe("a profile write: refused at Automatic, asked elsewhere", () => {
  it.each([PROFILE, ONEDRIVE])("%s", (p) => {
    const auto = write(p, "automatic");
    expect(auto.policy).toBe(OFF);
    expect(auto.reason).toContain(PROFILE_WRITE_REASON);
    for (const level of ["manual", "cautious", "permissive"] as const) {
      const r = write(p, level);
      expect(r.policy, level).toBe(ASK);
      expect(r.protection, level).toBe("config");
    }
  });

  it("the IDGAF preset has protect-config off, so it just runs", () => {
    const r = write(PROFILE, "permissive", builtinForPreset("idgaf"));
    expect(r.policy).toBe(ALLOW);
    expect(r.protection).toBeUndefined();
  });

  it("Permissive with protect-config left on asks, and refuses only at Automatic", () => {
    const r = write(PROFILE, "permissive");
    expect(r.policy).toBe(ASK);
    expect(r.protection).toBe("config");
    expect(write(PROFILE, "automatic").reason).toContain(PROFILE_WRITE_REASON);
  });

  it("another config file still asks at Automatic and is not refused", () => {
    const r = write("C:\\proj\\.vscode\\tasks.json", "automatic");
    expect(r.policy).toBe(ASK);
    expect(r.protection).toBe("config");
  });

  it("with protect-config off it is not refused", () => {
    const r = write(PROFILE, "automatic", { "protect-config": false });
    expect(r.policy).not.toBe(OFF);
  });

  it("a command that writes $PROFILE or a profile path is refused at Automatic", () => {
    for (const command of [
      'Add-Content -Path $PROFILE -Value "Import-Module x"',
      "Set-Content $PROFILE.CurrentUserAllHosts 'x'",
      `echo x >> "${PROFILE}"`,
      `Copy-Item evil.ps1 "${ONEDRIVE}"`,
    ]) {
      expect(run(command, "automatic").policy, command).toBe(OFF);
      expect(run(command, "cautious").policy, command).toBe(ASK);
    }
  });

  it("a command that only reads the profile is not refused", () => {
    expect(run("Get-Content $PROFILE", "automatic").policy).not.toBe(OFF);
  });

  it("the write scan sees an MCP tool's arguments", () => {
    expect(
      profileWriteHit({
        toolName: "mcp__fs__write",
        parsedArgs: { path: ONEDRIVE, content: "x" },
        mcp: {},
        home: HOME,
      }),
    ).toBeDefined();
    expect(
      profileWriteHit({
        toolName: "mcp__fs__write",
        parsedArgs: { path: ONEDRIVE },
        mcp: { readonly: true },
        home: HOME,
      }),
    ).toBeUndefined();
  });
});
