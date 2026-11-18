import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { evaluateToolPolicyWithRules as evaluateAndRun } from "./evaluate";
import { wouldDecide } from "./idgafView.testutil";
import { DEFAULT_POLICY_LEVELS } from "./policy";
import { runtimeWriteTarget } from "./runtimeWriteTarget";
import { tryLink } from "./testLinks";

// At IDGAF every call runs; these tests read what the guard would have
// decided (wouldDecide), which IDGAF records instead of acting on.
const evaluateToolPolicyWithRules = (
  input: Parameters<typeof evaluateAndRun>[0],
) => wouldDecide(evaluateAndRun(input));

const ASK = "allowedWithPermission" as const;
const RUN = "allowedWithoutPermission" as const;

describe("a write target with a run-time part is found", () => {
  const hits: [ShellKind | undefined, string][] = [
    ["powershell", "Remove-Item $dir\\x"],
    ["powershell", "rm $env:USERPROFILE\\.continuous\\config.yaml"],
    ["powershell", "del *.yaml"],
    ["powershell", "ri -Recurse -Force $p"],
    ["powershell", "Set-Content -Path $f -Value hi"],
    ["powershell", "Set-Content -Pa:$f hi"],
    ["powershell", "Set-Content $f hi"],
    ["powershell", "Out-File -FilePath $env:TEMP\\x"],
    ["powershell", "'hi' | Out-File $f"],
    ["powershell", "Copy-Item a $dest"],
    ["powershell", "cp a $dest"],
    ["powershell", "mv a* b"],
    ["powershell", "Move-Item -Destination $d a"],
    ["powershell", "ren a $n"],
    ["powershell", "icm { 1 }; rm $x"],
    ["powershell", "echo hi > $env:APPDATA\\x"],
    ["powershell", "echo hi >> $f"],
    ["powershell", "echo hi 2> $f"],
    ["powershell", "echo hi *> $f"],
    ["powershell", "New-Item -ItemType File -Path $f"],
    ["powershell", "mkdir $d"],
    ["powershell", "rm $d; $d = 'x'"],
    ["powershell", "$d = 'x'; $d = Get-Location; rm $d"],
    ["powershell", "$d = 'x'; $d += 'y'; rm $d"],
    ["powershell", "$d = 'x'; foreach ($d in $l) { rm $d }"],
    ["powershell", "$d = 'x'; Set-Variable d y; rm $d"],
    ["powershell", "$d = 'x'; $e = 1; rm $d$e"],
    ["powershell", "$p = '~/.continuous/config.yaml'; rm $p"],
    [
      "powershell",
      "Get-ChildItem | ForEach-Object { Remove-Item $_.FullName }",
    ],
    ["powershell", "if ($ok) { rm $x } else { rm y }"],
    ["powershell", "try { del $x } catch { }"],
    ["powershell", "Set-Content (Join-Path $a b) x"],
    ["powershell", "Set-Content (Join-Path a b) x"],
    ["powershell", '$p = "$HOME/x"; rm $p'],
    ["bash", "D=x; D=y; rm $D"],
    ["bash", "D=~/.continuous/config.yaml; rm $D"],
    ["bash", "D=$(pwd); rm $D"],
    ["bash", "rm -rf $DIR"],
    ["bash", "rm -rf ${DIR}/x"],
    ["bash", "rm -rf *.log"],
    ["bash", "rm -rf ?.log"],
    ["bash", "rm -rf `pwd`/x"],
    ["bash", "rm -rf $(pwd)/x"],
    ["bash", "echo hi > $HOME/.continuous/config.yaml"],
    ["bash", "echo hi > ~/.c*/config.yaml"],
    ["bash", "cp a $d"],
    ["bash", "mv a b*"],
    ["bash", "touch $f"],
    ["bash", "mkdir -p $d"],
    ["bash", "sudo rm $x"],
    ["bash", "env A=1 rm $x"],
    ["bash", "echo hi | tee $f"],
    ["bash", "dd if=a of=$f"],
    ["bash", "cd ~/.continuous && rm config.yaml"],
    ["bash", "cd ~ && touch .bashrc"],
    ["bash", "cd $HOME/.continuous; echo x > config.yaml"],
    ["bash", "cd ~/.continuous; sed -i s/a/b/ config.yaml; tee out"],
    ["powershell", "cd ~\\.continuous; Set-Content config.yaml x"],
    [
      "powershell",
      "Set-Location $env:USERPROFILE\\.continuous; rm config.yaml",
    ],
    ["powershell", "sl $HOME; Remove-Item .continuerc.json"],
    ["powershell", "pushd ~; del x"],
    ["cmd", "del %USERPROFILE%\\x"],
    ["cmd", "cd %USERPROFILE%\\.continuous & del config.yaml"],
    [undefined, "rm $x"],
    [undefined, "Remove-Item $x"],
  ];

  it.each(hits)("%s: %j", (shell, command) => {
    expect(runtimeWriteTarget(command, shell)).toBeDefined();
  });
});

describe("a write target that is written out, or a command that writes nothing, is not", () => {
  const clean: [ShellKind | undefined, string][] = [
    ["powershell", "Remove-Item build\\out.txt"],
    ["powershell", "rm -Recurse -Force .\\dist"],
    ["powershell", "Set-Content out.txt $text"],
    ["powershell", "Set-Content -Path out.txt -Value $text"],
    ["powershell", 'Set-Content out.txt -Value "$a $b"'],
    ["powershell", "Out-File -FilePath out.txt -Encoding $enc"],
    ["powershell", "'hi' | Out-File out.txt"],
    ["powershell", "Copy-Item a b"],
    ["powershell", "Write-Output $x"],
    ["powershell", "Get-ChildItem $dir"],
    ["powershell", "gci *.ts | Select-Object -First 3"],
    ["powershell", "$x = 1; Write-Output $x"],
    ["powershell", "git add $f"],
    ["powershell", "npm test"],
    ["powershell", "python $script"],
    ["powershell", "echo hi > out.txt"],
    ["powershell", "foreach ($f in $l) { Write-Output $f }"],
    ["powershell", "Get-ChildItem | ForEach-Object { Write-Output $_.Name }"],
    ["powershell", "if ($ok) { rm build } else { Set-Content out.txt $x }"],
    ["powershell", "cmd1 2>&1"],
    ["powershell", "cmd1 > $null"],
    ["powershell", "cd ~\\proj; Get-ChildItem"],
    ["powershell", "Set-Location $env:USERPROFILE; Get-ChildItem"],
    ["powershell", "cd ~; rm C:\\x\\y"],
    ["powershell", "cd ~; rm ~\\x"],
    ["bash", "rm -rf build"],
    ["bash", "rm -rf ./dist /tmp/x"],
    ["bash", "echo $HOME"],
    ["bash", "ls *.log"],
    ["bash", "grep -r $x ."],
    ["bash", "cat $f > out.txt"],
    ["bash", "cd ~ && ls"],
    ["bash", "cd ~/proj && git status"],
    ["bash", "cd /tmp && rm x"],
    ["bash", 'git commit -m "$msg"'],
    ["bash", "dd if=$in of=out.img"],
    ["bash", "command 2>/dev/null"],
    ["bash", "echo hi >/dev/null"],
    ["bash", "echo hi 2>&1"],
    [undefined, "echo hi"],
  ];

  it.each(clean)("%s: %j", (shell, command) => {
    expect(runtimeWriteTarget(command, shell)).toBeUndefined();
  });

  it("names the word in the reason", () => {
    expect(runtimeWriteTarget("rm -rf $DIR/x", "bash")).toContain("$DIR/x");
    expect(runtimeWriteTarget("cd ~/a && rm b", "bash")).toContain("home");
    expect(
      runtimeWriteTarget(`rm ${"a".repeat(200)}*`, "bash")!.length,
    ).toBeLessThan(150);
  });
});

describe("at IDGAF such a command asks, and nothing loosens it", () => {
  const terminalTool = {
    group: "Built-In",
    evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
      evaluateTerminalCommandSecurity(base, args.command as string),
  };
  const run = (
    command: string,
    shell: ShellKind,
    tools: "idgaf" | "permissive" | "automatic" | "cautious",
    extra: Record<string, unknown> = {},
  ) =>
    evaluateToolPolicyWithRules({
      tool: terminalTool as any,
      toolName: "run_terminal_command",
      basePolicy: ASK,
      parsedArgs: { command },
      permissions: undefined,
      shell,
      approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools } },
      ...extra,
    });

  const cases: [ShellKind, string][] = [
    ["powershell", "Remove-Item $dir\\x"],
    ["powershell", "rm *.yaml"],
    ["powershell", "icm { 1 }; Set-Content $f x"],
    ["bash", "rm -rf $DIR"],
    ["bash", "cd ~/work && rm notes.txt"],
    ["bash", "echo x > $HOME/notes.txt"],
  ];

  it.each(cases)("%s: %j asks at IDGAF, with a reason", (shell, command) => {
    const r = run(command, shell, "idgaf");
    expect(r.policy).toBe(ASK);
    expect(r.source).toBe("floor");
    expect(r.reason).toContain("built when it runs");
  });

  it.each(cases)(
    "%s: %j asks at IDGAF whatever allow rule is written",
    (shell, command) => {
      const r = run(command, shell, "idgaf", {
        permissions: { allow: ["runTerminalCommand(*)"] },
      });
      expect(r.policy).toBe(ASK);
    },
  );

  it.each(cases)(
    "%s: %j is not asked again at a lower level",
    (shell, command) => {
      for (const level of ["permissive", "automatic", "cautious"] as const) {
        const r = run(command, shell, level);
        expect(r.reason ?? "", level).not.toContain("built when it runs");
      }
    },
  );

  it("a floor rule still refuses it, and a refusal is not turned into an ask", () => {
    const r = run("rm $x; git push origin main", "bash", "idgaf", {
      approval: {
        levels: { ...DEFAULT_POLICY_LEVELS, tools: "idgaf" },
        floor: ["runTerminalCommand(git push*)"],
      },
    });
    expect(r.policy).toBe("disabled");
    expect(r.source).toBe("floor");
    expect(r.reason).not.toContain("built when it runs");
  });

  it("a deny rule, which IDGAF reaches past, leaves the command asking rather than running", () => {
    const r = run("rm $x; git push origin main", "bash", "idgaf", {
      permissions: { deny: ["runTerminalCommand(git push*)"] },
    });
    expect(r.policy).toBe(ASK);
  });

  it("a command with a written-out target still runs at IDGAF", () => {
    for (const [shell, command] of [
      ["powershell", "Remove-Item build\\out.txt"],
      ["bash", "rm -rf build"],
      ["powershell", "Set-Content out.txt $text"],
    ] as [ShellKind, string][]) {
      expect(run(command, shell, "idgaf").policy, command).toBe(RUN);
    }
  });

  it("never turns an ask or a refusal into a run", () => {
    for (const [shell, command] of cases) {
      for (const tools of [
        "idgaf",
        "permissive",
        "automatic",
        "cautious",
      ] as const) {
        const without = run(command.replace(/\$|\*/g, "x"), shell, tools);
        const withIt = run(command, shell, tools);
        const rank = {
          disabled: 0,
          allowedWithPermission: 1,
          allowedWithoutPermission: 2,
        };
        expect(
          rank[withIt.policy as keyof typeof rank],
          `${tools} ${command}`,
        ).toBeLessThanOrEqual(rank[without.policy as keyof typeof rank]);
      }
    }
  });
});

describe("a variable worked out from known pieces is read, not asked about", () => {
  const ps = "C:/work/proj";
  const inside: [ShellKind, string, string][] = [
    ["powershell", ps, "$d = 'build'; Remove-Item $d"],
    [
      "powershell",
      ps,
      "$f = Join-Path $PWD 'out.txt'; Set-Content -Path $f -Value x",
    ],
    ["powershell", ps, "$f = (Join-Path $PWD 'out.txt'); Set-Content $f x"],
    ["powershell", ps, "$f = Join-Path 'out' 'a.txt'; Set-Content $f x"],
    [
      "powershell",
      ps,
      "$f = Join-Path -Path 'out' -ChildPath 'a.txt'; Set-Content $f x",
    ],
    ["powershell", ps, '$f = "$PWD/out.txt"; Set-Content $f x'],
    ["powershell", ps, "$d = 'a'; $f = Join-Path $d 'b.txt'; Set-Content $f x"],
    ["powershell", ps, "$f = 'C:\work\proj\out.txt'; Set-Content $f x"],
    ["bash", "/work/proj", "D=build; rm -rf $D"],
  ];
  const asks: [ShellKind, string, string][] = [
    [
      "powershell",
      ps,
      "$f = Join-Path $env:TEMP 'x.ps1'; Set-Content -Path $f -Value x",
    ],
    ["powershell", ps, "$f = Join-Path $env:TMP 'x.ps1'; Set-Content $f x"],
    ["powershell", ps, "$f = Join-Path $env:USERPROFILE 'x'; Remove-Item $f"],
    ["powershell", ps, "$f = 'C:/other/x'; Remove-Item $f"],
    ["powershell", ps, "$f = '../x'; Remove-Item $f"],
    ["powershell", ps, "$f = Join-Path $PWD '../x'; Remove-Item $f"],
    ["powershell", ps, "$f = Get-Location; Remove-Item $f"],
    ["powershell", ps, "$f = Join-Path $unknown 'x'; Remove-Item $f"],
    ["powershell", ps, "$f = Join-Path $PSScriptRoot 'x'; Remove-Item $f"],
    ["powershell", ps, "$f = Join-Path $PWD 'a' 'b' 'c'; Remove-Item $f"],
    ["powershell", ps, "$f = Join-Path $PWD (Get-Date); Remove-Item $f"],
    ["powershell", ps, "$f = Join-Path $PWD 'x'; $f = 'y'; Remove-Item $f"],
    [
      "powershell",
      ps,
      "$f = Join-Path $PWD '.continuous/config.yaml'; Remove-Item $f",
    ],
    ["powershell", "", "$f = Join-Path $PWD 'x'; Remove-Item $f"],
    ["bash", "/work/proj", "D=/etc; rm -rf $D"],
  ];

  it.each(inside)("%s %s: %j", (shell, cwd, command) => {
    expect(
      runtimeWriteTarget(command, shell, cwd || undefined),
    ).toBeUndefined();
  });

  it.each(asks)("%s %s: %j asks", (shell, cwd, command) => {
    expect(runtimeWriteTarget(command, shell, cwd || undefined)).toBeDefined();
  });

  it("says why", () => {
    expect(
      runtimeWriteTarget(
        "$f = 'C:/other/x'; Set-Content $f x",
        "powershell",
        ps,
      ),
    ).toContain("outside the workspace");
    expect(
      runtimeWriteTarget(
        "$f = Join-Path $PWD '.continuous/config.yaml'; Remove-Item $f",
        "powershell",
        ps,
      ),
    ).toContain("policy file");
  });
});

describe("the user's own temp folder is a safe root, when it is certain", () => {
  let base = "";
  let temp = "";
  let env: Record<string, string>;
  const ps = "C:/work/proj";
  const where = () => ({ env, platform: "win32" });
  const run = (command: string, cwd: string | undefined = ps, w = where()) =>
    runtimeWriteTarget(command, "powershell", cwd, w);

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "rwt-")).replace(/\\/g, "/");
    temp = `${base}/AppData/Local/Temp`;
    fs.mkdirSync(temp, { recursive: true });
    fs.mkdirSync(`${base}/Other`, { recursive: true });
    env = {
      LOCALAPPDATA: `${base}/AppData/Local`,
      TEMP: temp.replace(/\//g, "\\"),
      TMP: temp,
    };
  });
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it.each([
    "$f = Join-Path $env:TEMP 'x.ps1'; Set-Content -Path $f -Value x",
    "$f = Join-Path $env:TMP 'x.ps1'; Set-Content -Path $f -Value x",
    "$f = Join-Path $env:TEMP 'sub' 'x.ps1'; Set-Content $f x",
    "$f = Join-Path $env:TEMP 'a/../b.ps1'; Set-Content $f x",
    '$f = "$env:TEMP/x.ps1"; Set-Content $f x',
    'Set-Content "$env:TEMP/x.ps1" x',
    "Remove-Item $env:TEMP/x.ps1",
    "echo hi > $env:TMP/log.txt",
  ])("%s runs", (command) => {
    expect(run(command)).toBeUndefined();
  });

  it("needs no workspace to be known", () => {
    expect(
      run("$f = Join-Path $env:TEMP 'x.ps1'; Set-Content $f x", undefined),
    ).toBeUndefined();
  });

  it.each([
    "$f = Join-Path $env:TEMP '../x'; Set-Content $f x",
    "$f = Join-Path $env:TEMP '..\\x'; Set-Content $f x",
    "$f = Join-Path $env:TEMP 'a/../../x'; Set-Content $f x",
    "Set-Content $env:TEMP/../x y",
    "$f = Join-Path $env:LOCALAPPDATA 'x'; Set-Content $f x",
    "$f = Join-Path $env:USERPROFILE 'x'; Set-Content $f x",
    "$f = Join-Path $env:TEMP $unknown; Set-Content $f x",
    "$f = Join-Path $env:TEMP 'x'; $f = 'y'; Set-Content $f x",
  ])("%s asks", (command) => {
    expect(run(command)).toBeDefined();
  });

  it("asks when $env:TEMP cannot be proven to be %LOCALAPPDATA%/Temp", () => {
    const cmd = "$f = Join-Path $env:TEMP 'x.ps1'; Set-Content $f x";
    expect(
      run(cmd, ps, { env: { ...env, TEMP: "D:/temp" }, platform: "win32" }),
    ).toBeDefined();
    expect(
      run(cmd, ps, {
        env: { ...env, TEMP: undefined as never },
        platform: "win32",
      }),
    ).toBeDefined();
    expect(
      run(cmd, ps, {
        env: { ...env, LOCALAPPDATA: undefined as never },
        platform: "win32",
      }),
    ).toBeDefined();
    expect(
      run(cmd, ps, {
        env: { ...env, LOCALAPPDATA: `${base}/Other` },
        platform: "win32",
      }),
    ).toBeDefined();
    expect(run(cmd, ps, { env, platform: "linux" })).toBeDefined();
    expect(run(cmd, ps, { env: {}, platform: "win32" })).toBeDefined();
  });

  it("proves each variable on its own", () => {
    const only = { ...env, TMP: "D:/elsewhere" };
    expect(
      run("Set-Content $env:TEMP/x y", ps, { env: only, platform: "win32" }),
    ).toBeUndefined();
    expect(
      run("Set-Content $env:TMP/x y", ps, { env: only, platform: "win32" }),
    ).toBeDefined();
  });

  it("asks for a link or junction inside the temp folder that points elsewhere", (ctx) => {
    const made = tryLink(`${base}/Other`, `${temp}/lnk`);
    if (!made.ok) return ctx.skip(made.reason);
    expect(run("Set-Content $env:TEMP/lnk/x y")).toBeDefined();
    expect(run("Set-Content $env:TEMP/lnk y")).toBeDefined();
    expect(run("Set-Content $env:TEMP/plain/x y")).toBeUndefined();
  });

  it("a locked policy path still asks, wherever it is", () => {
    fs.mkdirSync(`${temp}/proj/.continuous`, { recursive: true });
    expect(
      runtimeWriteTarget(
        "$f = Join-Path $env:TEMP 'proj/.continuous/config.yaml'; Set-Content $f x",
        "powershell",
        `${temp}/proj`,
        where(),
      ),
    ).toBeDefined();
  });

  it("is not used for another shell", () => {
    expect(
      runtimeWriteTarget("Set-Content $env:TEMP/x y", "bash", ps, where()),
    ).toBeDefined();
  });
});

describe("the word read does not hide an assignment, the read builtin does", () => {
  it("prose that says read is not the builtin", () => {
    expect(
      runtimeWriteTarget(
        "# read the file, then write it\n$d = 'out'; Set-Content $d x",
        "powershell",
        "C:/work/proj",
      ),
    ).toBeUndefined();
  });

  it("read, mapfile and readarray at the start of a statement still hide it", () => {
    for (const hide of ["read D", "mapfile D", "readarray D"]) {
      expect(
        runtimeWriteTarget(`D=build; ${hide}; rm $D`, "bash", "/work/proj"),
      ).toBeDefined();
    }
  });
});
