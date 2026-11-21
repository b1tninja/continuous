import { describe, expect, it } from "vitest";
import { protectedCommandHit } from "./protectedCall";
import {
  isCurrentDirectoryVariable,
  secretWordLabel,
  variableNames,
} from "./secretCommands";

const HOME = "/home/me";

describe("isCurrentDirectoryVariable", () => {
  it("is PWD, in any letter case", () => {
    for (const name of ["PWD", "pwd", "Pwd"]) {
      expect(isCurrentDirectoryVariable(name), name).toBe(true);
    }
  });

  it("is nothing else: the password-style names keep their meaning", () => {
    for (const name of [
      "DB_PWD",
      "MYSQL_PWD",
      "PWD_FILE",
      "OLDPWD",
      "MY_PWD",
      "PGPASSWORD",
      "GITHUB_TOKEN",
      "",
    ]) {
      expect(isCurrentDirectoryVariable(name), name).toBe(false);
    }
  });
});

describe("secretWordLabel and the current directory", () => {
  it("does not label $PWD or ${PWD} in a path", () => {
    expect(secretWordLabel("$PWD/main.tf", false, true)).toBeUndefined();
    expect(secretWordLabel("${PWD}/x", false, true)).toBeUndefined();
    expect(secretWordLabel("$PWD\\main.tf", false, true)).toBeUndefined();
    expect(secretWordLabel("$pwd.Path", false, true)).toBeUndefined();
  });

  it("does not label a bare PWD printed by a print command", () => {
    expect(secretWordLabel("PWD", false, true, "printenv")).toBeUndefined();
    expect(secretWordLabel("PWD", false, true, "echo")).toBeUndefined();
  });

  it("still labels the password-style names", () => {
    expect(secretWordLabel("$DB_PWD", false, true)).toBe("the variable DB_PWD");
    expect(secretWordLabel("$MYSQL_PWD", false, true)).toBe(
      "the variable MYSQL_PWD",
    );
    expect(secretWordLabel("$GITHUB_TOKEN", false, true)).toBe(
      "the variable GITHUB_TOKEN",
    );
    expect(secretWordLabel("$env:AWS_SECRET_ACCESS_KEY", false, true)).toBe(
      "the variable AWS_SECRET_ACCESS_KEY",
    );
    expect(secretWordLabel("MYSQL_PWD", false, true, "printenv")).toBe(
      "the variable MYSQL_PWD",
    );
  });

  it("skips PWD but still finds a real secret in the same word", () => {
    expect(secretWordLabel("$PWD/$GITHUB_TOKEN", false, true)).toBe(
      "the variable GITHUB_TOKEN",
    );
    expect(variableNames("$PWD/$GITHUB_TOKEN")).toEqual([
      "PWD",
      "GITHUB_TOKEN",
    ]);
  });
});

describe("the command check no longer asks about the current directory", () => {
  it("the call from the usage data: a file read through $PWD in PowerShell", () => {
    expect(
      protectedCommandHit(
        '$m = [IO.File]::ReadAllText("$PWD\\main.tf")',
        HOME,
        [],
        undefined,
        "powershell",
      ),
    ).toBeUndefined();
  });

  it("ordinary uses of the current directory", () => {
    for (const [cmd, shell] of [
      ["echo $PWD", "bash"],
      ['docker run -v "$PWD:/app" node:20 npm test', "bash"],
      ['basename "$PWD"', "bash"],
      ["Get-Content $PWD\\main.tf", "powershell"],
      ["Write-Output $pwd.Path", "powershell"],
    ] as const) {
      expect(
        protectedCommandHit(cmd, HOME, [], undefined, shell),
        cmd,
      ).toBeUndefined();
    }
  });

  it("a password variable still asks, in both shells", () => {
    for (const [cmd, shell] of [
      ["echo $MYSQL_PWD", "bash"],
      ["echo $DB_PWD", "bash"],
      ["echo $GITHUB_TOKEN", "bash"],
      ["Write-Output $env:GITHUB_TOKEN", "powershell"],
    ] as const) {
      expect(
        protectedCommandHit(cmd, HOME, [], undefined, shell)?.kind,
        cmd,
      ).toBe("secret");
    }
  });
});
