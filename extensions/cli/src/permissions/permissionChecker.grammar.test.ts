import { describe, expect, it } from "vitest";

import { allowCoversCommand } from "./permissionChecker.js";

/**
 * A prefix allow such as `Bash(echo *)` covers a command only when the shell
 * that runs it reads the same commands the pattern matched. Each hidden row is
 * one segment to a POSIX-style splitter and two commands to the named shell
 * (checked with `bash -c` and `powershell.exe -Command`).
 */
describe("a prefix allow and the shell that runs the command", () => {
  it.each([
    ["echo $'\\'' ; rm x ; \\'", "bash"],
    ["echo a #'\nrm x #'", "bash"],
    ["echo a\rrm x", "bash"],
    ['echo "a\\" ; Remove-Item x ; "\\"', "powershell"],
    ["echo a\\;Remove-Item x", "powershell"],
    ["echo \\'x' ; Remove-Item y ; '\\'", "powershell"],
    ["echo (Remove-Item x)", "powershell"],
    ["echo a\rRemove-Item x", "powershell"],
    ["echo “ ' ” ; Remove-Item x ; “ ' ”", "powershell"],
    ["echo 'a & del /q x'", "cmd"],
  ] as const)("does not cover %j in %s", (command, shell) => {
    expect(allowCoversCommand("echo *", command, shell)).toBe(false);
  });

  it.each(["bash", "zsh", "sh", "powershell", "cmd"] as const)(
    "still covers a plain command in %s",
    (shell) => {
      expect(allowCoversCommand("echo *", "echo hello", shell)).toBe(true);
      expect(allowCoversCommand("echo *", 'echo "hello there"', shell)).toBe(
        true,
      );
      expect(allowCoversCommand("git status*", "git status", shell)).toBe(true);
    },
  );

  it("covers a compound line only when every command matches", () => {
    expect(allowCoversCommand("echo *", "echo a; echo b", "powershell")).toBe(
      true,
    );
    expect(
      allowCoversCommand("echo *", "echo a; Remove-Item b", "powershell"),
    ).toBe(false);
    expect(allowCoversCommand("echo *", "echo a && echo b", "bash")).toBe(true);
  });
});
