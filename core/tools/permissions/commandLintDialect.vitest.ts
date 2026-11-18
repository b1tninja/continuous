import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { lintCommand } from "./commandLint";

const codes = (command: string, shell: ShellKind) =>
  lintCommand(command, shell).map((f) => f.code);

describe("lint: text written for another shell", () => {
  it.each([
    ["ls -la src | grep foo", "CL042"],
    ["rm -rf build && mkdir -p build", "CL042"],
    ["sudo apt-get install -y jq", "CL042"],
    ["dir /b && echo %USERPROFILE%", "CL043"],
    ["if exist build rmdir /s /q build", "CL043"],
  ])("PowerShell: %s", (command, code) => {
    expect(codes(command, "powershell")).toContain(code);
  });

  it("gives the PowerShell for the bash it saw", () => {
    const f = lintCommand("ls -la; rm -rf build", "powershell").find(
      (x) => x.code === "CL042",
    );
    expect(f?.advice).toContain("Get-ChildItem");
    expect(f?.advice).toContain("Remove-Item");
    const g = lintCommand("echo %PATH%", "powershell").find(
      (x) => x.code === "CL043",
    );
    expect(g?.advice).toContain("$env:NAME");
  });

  it.each([
    ["Get-ChildItem | Where-Object { $_.Length -gt 1kb }", "CL004"],
    ["Write-Host $env:PATH", "CL004"],
    ["$x = 1; if ($x -eq 1) { Write-Output ok }", "CL044"],
  ])("bash: %s", (command, code) => {
    expect(codes(command, "bash")).toContain(code);
    expect(codes(command, "zsh")).toContain(code);
  });

  it("cmd gets PowerShell text flagged", () => {
    expect(
      codes("Get-ChildItem -Recurse | Where-Object { $_ }", "cmd"),
    ).toContain("CL045");
  });

  it("says nothing for text in the right dialect", () => {
    expect(
      codes("Get-ChildItem -Force | Select-Object Name", "powershell"),
    ).toEqual([]);
    expect(codes("$env:FOO = 'x'; node app.js", "powershell")).toEqual([]);
    expect(codes("ls -la 2>/dev/null && echo done", "bash")).toEqual([]);
    expect(codes("setopt extendedglob; echo *(.)", "zsh")).toEqual([]);
    expect(codes("dir /b && echo %USERPROFILE%", "cmd")).toEqual([]);
  });

  it("says nothing for text that tells nothing", () => {
    for (const shell of ["powershell", "bash", "cmd"] as ShellKind[]) {
      expect(codes("git status", shell)).toEqual([]);
      expect(codes("npm test", shell)).toEqual([]);
    }
  });

  it("does not repeat a shell-hint parse error as CL040 or CL041", () => {
    expect(codes("cd src && npm test", "powershell")).not.toContain("CL040");
    const devNull = codes("ls -la 2>/dev/null", "powershell");
    expect(devNull).not.toContain("CL041");
    expect(devNull).toContain("CL042");
  });

  it("does not take && inside a string for a chain", () => {
    expect(codes("git commit -m 'a && b'", "powershell")).toEqual([]);
  });

  it("does not repeat what a specific finding already says", () => {
    const c = codes("export A=1\nls -la", "powershell");
    expect(c).toContain("CL002");
    expect(c).not.toContain("CL042");
  });
});
