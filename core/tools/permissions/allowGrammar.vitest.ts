import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { matchTerminalCommand, parseToolPermissions } from "./rules";

/**
 * An allow rule covers a command only when the shell that runs it reads the
 * same commands the rule matched. Each row below is one line of text that a
 * real shell runs as two commands (checked with `bash -c` and
 * `powershell.exe -Command`, the second command being a harmless `echo`),
 * while the splitter read it as one `echo ...`.
 */
const allow = parseToolPermissions({
  allow: ["runTerminalCommand(echo *)", "runTerminalCommand(git status*)"],
});
const decide = (command: string, shell?: ShellKind) =>
  matchTerminalCommand(allow, command, shell)?.decision ?? "none";

describe("an allow rule does not cover a command its shell reads differently", () => {
  it.each<[string, string, ShellKind]>([
    ["$'...' keeps going past \\'", "echo $'\\'' ; rm x ; \\'", "bash"],
    ["a quote inside a comment", "echo a #'\nrm x #'", "bash"],
    ["a quote inside a comment (zsh)", "echo a #'\nrm x #'", "zsh"],
    ["a comment after a separator", "echo a;#'\nrm x #'", "sh"],
    [
      "a backslash is no escape in PowerShell",
      'echo "a\\" ; Remove-Item x ; "\\"',
      "powershell",
    ],
    ["backslash before a separator", "echo a\\;Remove-Item x", "powershell"],
    [
      "backslash before a single quote",
      "echo \\'x' ; Remove-Item y ; '\\'",
      "powershell",
    ],
    ["backslash before a newline", "echo a\\\nRemove-Item x", "powershell"],
    ["a bare carriage return", "echo a\rRemove-Item x", "powershell"],
    ["a parenthesised command", "echo (Remove-Item x)", "powershell"],
    ["a parenthesised command", "git status (Remove-Item x)", "powershell"],
    ["a comment", "echo a #'\nRemove-Item x #'", "powershell"],
    ["cmd has no single quotes", "echo 'a & del /q x'", "cmd"],
    ["cmd's escape character", 'echo ^" & del /q x ^"', "cmd"],
    ["backslash before a separator", "echo a\\& del /q x", "cmd"],
  ])("%s: %j in %s", (_what, command, shell) => {
    expect(decide(command, shell)).toBe("none");
  });

  it("a bare carriage return is not covered in any shell", () => {
    expect(decide("echo a\rrm x", "bash")).toBe("none");
    expect(decide("echo a\rrm x")).toBe("none");
  });

  it("still covers the plain commands the rules were written for", () => {
    for (const shell of ["bash", "zsh", "sh", "powershell", "cmd"] as const) {
      expect(decide("echo hello", shell)).toBe("allow");
      expect(decide("git status", shell)).toBe("allow");
      expect(decide('echo "hello there"', shell)).toBe("allow");
    }
    expect(decide("echo one; git status --short", "powershell")).toBe("allow");
    expect(decide("echo one && git status --short", "bash")).toBe("allow");
    expect(decide("echo one\r\ngit status", "bash")).toBe("allow");
  });

  it("keeps text that only looks like the above", () => {
    // `$` then a closing quote is not `$'...'`
    expect(decide("echo 'costs 5$' and more", "bash")).toBe("allow");
    expect(decide('echo "costs 5$\'" more', "bash")).toBe("allow");
    // A `#` inside quotes, or with no later line, is not a comment that hides one
    expect(decide('echo "fixes #12"\ngit status', "bash")).toBe("allow");
    expect(decide("echo a #12", "bash")).toBe("allow");
    expect(decide("echo a#b\ngit status", "bash")).toBe("allow");
    // Windows paths keep their backslashes
    expect(decide("echo C:\\Users\\me\\file.txt", "powershell")).toBe("allow");
    expect(decide('echo "C:\\Program Files\\x"', "powershell")).toBe("allow");
  });

  it("in PowerShell every command the shell finds needs a rule", () => {
    expect(decide("echo one; Remove-Item x", "powershell")).toBe("none");
    // A quoted program name is not the program a rule names
    expect(decide('"echo x" y', "cmd")).toBe("none");
  });
});
