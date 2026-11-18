import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getTerminalShellPreference,
  isPosixShell,
  parseTerminalShell,
  resolveShell,
  setTerminalShellPreference,
  shellKindOf,
  wslArgs,
} from "./shell";

describe("shellKindOf", () => {
  it.each([
    ["/bin/bash", "bash"],
    ["/usr/local/bin/bash", "bash"],
    ["/bin/zsh", "zsh"],
    ["/bin/sh", "sh"],
    ["/bin/dash", "sh"],
    ["powershell.exe", "powershell"],
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "powershell",
    ],
    ["pwsh", "powershell"],
    ["C:\\Windows\\System32\\cmd.exe", "cmd"],
    ["CMD.EXE", "cmd"],
    ["/usr/bin/fish", "unknown"],
    ["/bin/ksh", "unknown"],
    ["nu", "unknown"],
    ["", "unknown"],
  ])("%s is %s", (executable, kind) => {
    expect(shellKindOf(executable)).toBe(kind);
  });

  it("an undefined executable is unknown", () => {
    expect(shellKindOf(undefined)).toBe("unknown");
  });
});

describe("resolveShell", () => {
  it("is Windows PowerShell on Windows, whatever SHELL says", () => {
    const shell = resolveShell({
      platform: "win32",
      env: { SHELL: "/usr/bin/bash" },
    });
    expect(shell.kind).toBe("powershell");
    expect(shell.executable).toBe("powershell.exe");
    expect(shell.args("ls")).toEqual([
      "-NoLogo",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "ls",
    ]);
    expect(shell.runsProfile).toBe(true);
  });

  it("is the login shell elsewhere, so zsh on a Mac", () => {
    const shell = resolveShell({
      platform: "darwin",
      env: { SHELL: "/bin/zsh" },
    });
    expect(shell.kind).toBe("zsh");
    expect(shell.args("ls")).toEqual(["-l", "-c", "ls"]);
  });

  it("is bash when SHELL is not set", () => {
    const shell = resolveShell({ platform: "linux", env: {} });
    expect(shell.kind).toBe("bash");
    expect(shell.executable).toBe("/bin/bash");
  });

  it("is zsh on a Mac when SHELL is not set, as the tool description says", () => {
    const shell = resolveShell({ platform: "darwin", env: {} });
    expect(shell.kind).toBe("zsh");
    expect(shell.executable).toBe("/bin/zsh");
  });

  it("a shell it does not parse is unknown, and keeps its path", () => {
    const shell = resolveShell({
      platform: "linux",
      env: { SHELL: "/usr/bin/fish" },
    });
    expect(shell.kind).toBe("unknown");
    expect(shell.executable).toBe("/usr/bin/fish");
  });
});

describe("isPosixShell", () => {
  it("is true for bash, zsh and sh, and nothing else", () => {
    expect(["bash", "zsh", "sh"].every((k) => isPosixShell(k as never))).toBe(
      true,
    );
    for (const k of ["powershell", "cmd", "unknown", undefined]) {
      expect(isPosixShell(k as never)).toBe(false);
    }
  });
});

describe("terminal shell preference", () => {
  it("parses wsl and wsl:<distro>, and nothing else", () => {
    expect(parseTerminalShell("wsl")).toEqual({ kind: "wsl" });
    expect(parseTerminalShell(" WSL ")).toEqual({ kind: "wsl" });
    expect(parseTerminalShell("wsl:Ubuntu-22.04")).toEqual({
      kind: "wsl",
      distro: "Ubuntu-22.04",
    });
    expect(parseTerminalShell("wsl/archlinux")).toEqual({
      kind: "wsl",
      distro: "archlinux",
    });
    expect(parseTerminalShell("default")).toBeUndefined();
    expect(parseTerminalShell("bash")).toBeUndefined();
    expect(parseTerminalShell(undefined)).toBeUndefined();
  });

  it("runs bash through wsl.exe on Windows when asked", () => {
    const shell = resolveShell({
      platform: "win32",
      terminalShell: { kind: "wsl", distro: "Ubuntu" },
    });
    expect(shell.kind).toBe("bash");
    expect(shell.executable).toBe("wsl.exe");
    const args = shell.args("echo hi");
    expect(args.slice(0, 5)).toEqual(["-d", "Ubuntu", "--", "bash", "-lc"]);
    expect(args[5]).toBe(
      `source <(echo ${Buffer.from("echo hi").toString("base64")} | base64 -d)`,
    );
  });

  it("uses the default distribution when none is named", () => {
    const args = resolveShell({
      platform: "win32",
      terminalShell: { kind: "wsl" },
    }).args("x");
    expect(args.slice(0, 3)).toEqual(["--", "bash", "-lc"]);
  });

  it("sends the command as base64 with nothing for wsl.exe to mangle", () => {
    const command = `cat <<'EOF'
$HOME "x" 'y' ${String.fromCharCode(92)}n
EOF
echo héllo ✓`;
    const arg = wslArgs(command).at(-1)!;
    expect(arg).not.toMatch(/['"$]/);
    expect(arg.includes(String.fromCharCode(92))).toBe(false);
    const encoded = /echo (\S+) \|/.exec(arg)![1];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(command);
  });

  it("reads CONTINUOUS_TERMINAL_SHELL, and an explicit default beats it", () => {
    const env = { CONTINUOUS_TERMINAL_SHELL: "wsl:Debian" };
    expect(resolveShell({ platform: "win32", env }).executable).toBe("wsl.exe");
    expect(
      resolveShell({ platform: "win32", env, terminalShell: "default" }).kind,
    ).toBe("powershell");
  });

  it("the editor's setting beats the environment, and clears with undefined", () => {
    const env = { CONTINUOUS_TERMINAL_SHELL: "wsl:Debian" };
    setTerminalShellPreference({ kind: "wsl", distro: "Ubuntu" });
    try {
      expect(getTerminalShellPreference(env)).toEqual({
        kind: "wsl",
        distro: "Ubuntu",
      });
    } finally {
      setTerminalShellPreference(undefined);
    }
    expect(getTerminalShellPreference(env)).toEqual({
      kind: "wsl",
      distro: "Debian",
    });
  });

  it("the editor settings are machine settings, so a workspace cannot switch the shell", () => {
    const pkgPath = [
      path.resolve(process.cwd(), "extensions/vscode/package.json"),
      path.resolve(process.cwd(), "../extensions/vscode/package.json"),
    ].find((candidate) => existsSync(candidate));
    if (!pkgPath) throw new Error("vscode package.json not found");
    const props = JSON.parse(readFileSync(pkgPath, "utf8")).contributes
      .configuration.properties;
    expect(props["continuous.terminal.shell"].scope).toBe("machine");
    expect(props["continuous.terminal.wslDistro"].scope).toBe("machine");
  });

  it("changes nothing off Windows", () => {
    const shell = resolveShell({
      platform: "linux",
      env: { SHELL: "/bin/zsh" },
      terminalShell: { kind: "wsl" },
    });
    expect(shell.executable).toBe("/bin/zsh");
  });
});

/** wsl.exe is on this machine and has a distribution to run in. */
const hasWsl =
  process.platform === "win32" &&
  spawnSync("wsl.exe", ["--", "true"], { timeout: 20000 }).status === 0;

describe.runIf(hasWsl)("commands in WSL (this machine's distribution)", () => {
  const run = (command: string) => {
    const shell = resolveShell({ terminalShell: { kind: "wsl" } });
    const r = spawnSync(shell.executable, shell.args(command), {
      encoding: "buffer",
      timeout: 30000,
    });
    return { code: r.status, out: r.stdout.toString("utf8") };
  };

  it("keeps quotes, $, heredocs, unicode and exit codes exactly", () => {
    expect(run(`echo "a b" 'c d'`).out).toBe("a b c d\n");
    expect(run(`cat <<'EOF'\n$HOME "x" 'y'\nEOF`).out).toBe(`$HOME "x" 'y'\n`);
    expect(run("echo héllo ✓ 日本").out).toBe("héllo ✓ 日本\n");
    const exit = run("echo a; exit 3");
    expect(exit).toEqual({ code: 3, out: "a\n" });
  });

  it("runs in bash, in the directory the Windows side started in", () => {
    expect(run('echo "$0"').out).toBe("bash\n");
    const shell = resolveShell({ terminalShell: { kind: "wsl" } });
    const r = spawnSync(shell.executable, shell.args("pwd"), {
      cwd: "C:\Windows",
      encoding: "utf8",
      timeout: 30000,
    });
    expect(r.stdout.trim()).toBe("/mnt/c/Windows");
  });
});
