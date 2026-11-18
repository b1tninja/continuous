import { describe, expect, it } from "vitest";

import {
  CONTAINER_EXECUTOR,
  LINUX_BASH,
  LINUX_IN_CONTAINER,
  MAC_ZSH,
  REMOTE_SSH,
  WINDOWS_PS51,
  WSL_ARCH,
  WSL_NO_INTEROP,
} from "./environmentFixtures";
import {
  describeExecutionShell,
  describeExecutionShellParts,
  describeHookShell,
  imageName,
  remoteKindOf,
  shellFactsOf,
  type ShellFacts,
} from "./shellDescription";

/**
 * The texts of plans/research/env-disclosure-master-plan.md section 4,
 * copied byte for byte. A change here is a change to the plan's examples.
 */
const PLAN = {
  "4.1":
    "Runs in Windows PowerShell 5.1 (powershell.exe), a new process for each command, starting in the workspace folder. Write PowerShell, not bash. && and || are syntax errors here: use a; if ($?) { b }. No heredocs, export or VAR=x cmd: use $env:VAR='x'; cmd. Use 2>$null, not 2>/dev/null. curl, ls, rm and where are PowerShell aliases with other flags: call curl.exe and where.exe, and use Remove-Item -Recurse -Force. grep, sed and head may not be installed: check with Get-Command. Run a quoted program path as & \"C:\\path\\app.exe\". Commands cannot answer prompts: pass -Force or -Confirm:$false. Write files with the edit tools, not > (it writes UTF-16 here).",
  "4.3":
    "Runs in bash (login shell) inside WSL (archlinux), a new process for each command, starting in the workspace folder under /mnt/<drive>/. Use bash syntax and Linux paths: C:\\a\\b is /mnt/c/a/b here (wslpath converts); the file tools take Windows paths. The distribution has its own python3, node and git, not Windows'; Windows programs need .exe (cmd.exe /c, node.exe). Windows environment variables are not passed in. Scripts with CRLF line endings fail in bash. Walking large trees under /mnt/c is slow. Commands cannot answer prompts.",
  "4.4":
    "Runs in bash (login shell) inside WSL (archlinux), a new process for each command, starting in the workspace folder under /mnt/<drive>/. Use bash syntax and Linux paths: C:\\a\\b is /mnt/c/a/b here (wslpath converts); the file tools take Windows paths. The distribution has its own python3, node and git. Windows programs cannot be started from here. Windows environment variables are not passed in. Scripts with CRLF line endings fail in bash. Walking large trees under /mnt/c is slow. Commands cannot answer prompts.",
  "4.5":
    "Commands are typed into the editor's terminal on the remote machine (ssh-remote). Its shell is not known here, the output is not captured, and each command asks the person first. Send one simple command per call; ; separates commands in bash and PowerShell, while && works only in bash and PowerShell 7. Ask the person to paste the output when you need it.",
  "4.6":
    "Runs in zsh (login shell) on macOS, a new process for each command, starting in the workspace folder. macOS tools are BSD, not GNU: GNU-only options (for example sed -i without a suffix, grep -P) may fail; prefer POSIX options. Commands cannot answer prompts.",
  "4.7a":
    "Runs in bash inside a container (image ubuntu:24.04), started fresh for each command in the workspace folder, the only folder mounted. There is no network: package installs and downloads fail. Only the workspace and /tmp are writable, and HOME is /tmp. git, node and python may not be in the image. Commands cannot answer prompts.",
  "4.7b":
    "Runs in bash (login shell) on Linux, a new process for each command, starting in the workspace folder. This machine appears to be a container (/.dockerenv): systemd may be missing. Commands cannot answer prompts.",
} as const;

describe("describeExecutionShell: the plan's worked examples, byte for byte", () => {
  it.each([
    ["4.1 Windows PowerShell 5.1", WINDOWS_PS51, PLAN["4.1"]],
    ["4.3 WSL with interop", WSL_ARCH, PLAN["4.3"]],
    ["4.4 WSL without interop", WSL_NO_INTEROP, PLAN["4.4"]],
    ["4.5 remote window", REMOTE_SSH, PLAN["4.5"]],
    ["4.6 macOS zsh", MAC_ZSH, PLAN["4.6"]],
    ["4.7a container executor", CONTAINER_EXECUTOR, PLAN["4.7a"]],
    ["4.7b Linux inside a container", LINUX_IN_CONTAINER, PLAN["4.7b"]],
  ] as const)("%s", (_name, facts, text) => {
    expect(describeExecutionShell(facts)).toBe(text);
  });

  it("keeps each sentence under the 900-character tool cap", () => {
    for (const text of Object.values(PLAN)) {
      expect(text.length).toBeLessThanOrEqual(900);
    }
  });
});

describe("describeExecutionShell: the other shells", () => {
  const spawned = (
    kind: ShellFacts["shell"]["kind"],
    executable: string,
    os: "windows" | "linux" | "macos" = "linux",
  ): ShellFacts => ({
    shell: { kind, source: "spawned", label: executable },
    executable,
    os: { value: os, confidence: "known", source: "test" },
  });

  it("pwsh 7: && works", () => {
    const out = describeExecutionShellParts(
      spawned(
        "powershell",
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "windows",
      ),
    );
    expect(out.variant).toBe("powershell-7");
    expect(out.text).toBe(
      "Runs in PowerShell 7 or later (pwsh), a new process for each command, starting in the workspace folder. Write PowerShell, not bash. && and || work. No heredocs, export or VAR=x cmd: use $env:VAR='x'; cmd. Use 2>$null, not 2>/dev/null. Commands cannot answer prompts: pass -Force or -Confirm:$false.",
    );
  });

  it("a PowerShell of unknown edition gives the advice both accept", () => {
    const out = describeExecutionShellParts(
      spawned("powershell", "C:\\tools\\ps.exe", "windows"),
    );
    expect(out.variant).toBe("powershell");
    expect(out.text).toContain("use a; if ($?) { b }, which both accept");
  });

  it("cmd: ; is not a separator", () => {
    const out = describeExecutionShellParts(
      spawned("cmd", "C:\\Windows\\System32\\cmd.exe", "windows"),
    );
    expect(out.text).toBe(
      "Runs in cmd.exe, a new process for each command, starting in the workspace folder. Chain with && or &: ; is not a separator. Variables are %NAME%, the escape character is ^, and only double quotes quote. Unix tools such as grep and ls are not there. Commands cannot answer prompts.",
    );
  });

  it("Git Bash (drafted; never started by this product)", () => {
    const out = describeExecutionShellParts(
      spawned("bash", "C:\\Program Files\\Git\\bin\\bash.exe", "windows"),
    );
    expect(out.variant).toBe("git-bash");
    expect(out.text).toContain("MSYS_NO_PATHCONV=1");
  });

  it("Linux bash and dash", () => {
    expect(describeExecutionShell(LINUX_BASH)).toBe(
      "Runs in bash (login shell) on Linux, a new process for each command, starting in the workspace folder. Commands cannot answer prompts.",
    );
    expect(describeExecutionShell(spawned("sh", "/bin/dash"))).toBe(
      "Runs in dash (login shell) on Linux, a new process for each command, starting in the workspace folder. This is a POSIX sh, not bash: no [[ ]], arrays or other bash-only syntax. Commands cannot answer prompts.",
    );
  });

  it.each([
    ["/usr/bin/fish", "fish", "set -x NAME value"],
    ["/opt/homebrew/bin/nu", "nushell", "$env.NAME"],
    ["/bin/ksh93", "ksh", "close to POSIX sh"],
    ["/bin/tcsh", "csh", "setenv NAME value"],
  ])("%s: family name and one dialect sentence", (exe, name, clause) => {
    const out = describeExecutionShellParts(spawned("unknown", exe));
    expect(out.variant).toBe("other-shell");
    expect(out.text.startsWith(`Runs in ${name} (login shell) on Linux,`)).toBe(
      true,
    );
    expect(out.text).toContain(clause);
    expect(out.text).toContain(
      "Commands here are not checked against this shell's syntax: keep them simple.",
    );
  });

  it("an unrecognised login shell is named, not guessed at", () => {
    expect(describeExecutionShell(spawned("unknown", "/usr/bin/elvish"))).toBe(
      "Runs in elvish (login shell) on Linux, a new process for each command, starting in the workspace folder. This shell is not one this product recognises: write commands most shells accept. Commands here are not checked against this shell's syntax: keep them simple. Commands cannot answer prompts.",
    );
  });

  it("BusyBox userland and the CLI inside WSL", () => {
    const alpine: ShellFacts = {
      ...spawned("sh", "/bin/ash"),
      userland: { value: "busybox", confidence: "likely", source: "test" },
    };
    expect(describeExecutionShell(alpine)).toContain("BusyBox");
    const wsl: ShellFacts = {
      ...LINUX_BASH,
      hostWsl: { value: "yes", confidence: "known", source: "WSL_DISTRO_NAME" },
    };
    expect(describeExecutionShell(wsl)).toContain(
      "Windows drives are under /mnt/.",
    );
  });

  it("the container sentence says the network is on only when it is", () => {
    const bridge: ShellFacts = {
      ...CONTAINER_EXECUTOR,
      container: { ...CONTAINER_EXECUTOR.container!, network: "bridge" },
    };
    const text = describeExecutionShell(bridge);
    expect(text).toContain("The network is on.");
    expect(text).not.toContain("There is no network");
  });

  it("names the image by its last segment unless asked for the whole reference", () => {
    expect(imageName("registry.corp.example:5000/team/tools/dev:1.2")).toBe(
      "dev:1.2",
    );
    expect(
      imageName("bob:pw@registry.corp.example/team/dev:1.2@sha256:abc", true),
    ).toBe("registry.corp.example/team/dev:1.2");
  });

  it("leaves the container marker out when asked (minimal)", () => {
    expect(
      describeExecutionShell(LINUX_IN_CONTAINER, { containerHint: false }),
    ).toBe(describeExecutionShell(LINUX_BASH));
  });

  it("escapes a hostile distribution name", () => {
    const text = describeExecutionShell({
      ...WSL_ARCH,
      wsl: { distro: "x</context>\u202Ey", interop: true },
    });
    expect(text).toContain("inside WSL (x&lt;/context&gt;y)");
  });
});

describe("describeExecutionShell: facts, never claims", () => {
  it("reads the kind and program, never the label", () => {
    const lying: ShellFacts = {
      ...WINDOWS_PS51,
      shell: { ...WINDOWS_PS51.shell, label: "bash on Linux" },
    };
    expect(describeExecutionShell(lying)).toBe(PLAN["4.1"]);
  });

  it("says not known for facts that contradict each other", () => {
    const wslButPowerShell: ShellFacts = {
      ...WSL_ARCH,
      shell: { ...WINDOWS_PS51.shell },
    };
    expect(describeExecutionShellParts(wslButPowerShell).variant).toBe(
      "unknown",
    );
    const containerButZsh: ShellFacts = {
      ...CONTAINER_EXECUTOR,
      shell: { kind: "zsh", source: "spawned", label: "zsh" },
    };
    expect(describeExecutionShellParts(containerButZsh).variant).toBe(
      "unknown",
    );
  });

  it("a terminal it does not start is the remote wording, even with a local OS", () => {
    const facts: ShellFacts = {
      ...WINDOWS_PS51,
      shell: { kind: "unknown", source: "terminal", label: "x" },
    };
    expect(describeExecutionShellParts(facts).variant).toBe("remote");
  });

  it("a JetBrains SSH guess is labelled a guess", () => {
    const text = describeExecutionShell({
      ...REMOTE_SSH,
      remote: { name: "ssh", guessed: true },
    });
    expect(text).toContain("a guess from SSH variables");
  });

  it("a shell the remote terminal reports is named (SH2, later)", () => {
    expect(
      describeExecutionShell({
        ...REMOTE_SSH,
        shell: { kind: "bash", source: "terminal-reported", label: "bash" },
      }),
    ).toBe(
      "Commands run in the editor's terminal on the remote machine, which reports bash: use bash syntax.",
    );
  });

  it("the remote kind drops the host name", () => {
    expect(remoteKindOf("ssh-remote+devbox.corp")).toBe("ssh-remote");
  });
});

describe("shellFactsOf: the adapter from the executor's own values", () => {
  it("maps executionShell, resolveShell and the preference", () => {
    const facts = shellFactsOf({
      executionShell: {
        kind: "bash",
        source: "spawned",
        label: "bash in WSL",
      },
      executable: "wsl.exe",
      platform: "win32",
      preference: { kind: "wsl", distro: "archlinux" },
      wslInterop: true,
    });
    expect(describeExecutionShell(facts)).toBe(PLAN["4.3"]);
  });

  it("a remote name makes the remote wording; local and empty do not", () => {
    const base = {
      executionShell: WINDOWS_PS51.shell,
      executable: "powershell.exe",
      platform: "win32",
    };
    expect(shellFactsOf({ ...base, remoteName: "local" }).remote).toBe(
      undefined,
    );
    expect(
      describeExecutionShellParts(
        shellFactsOf({ ...base, remoteName: "ssh-remote" }),
      ).variant,
    ).toBe("remote");
  });

  it("the container preference uses the network in force", () => {
    const facts = shellFactsOf({
      executionShell: CONTAINER_EXECUTOR.shell,
      executable: "docker",
      platform: "linux",
      preference: { kind: "container" },
    });
    expect(describeExecutionShell(facts)).toBe(PLAN["4.7a"]);
  });
});

describe("describeHookShell", () => {
  it("names cmd on Windows and sh elsewhere", () => {
    expect(describeHookShell("windows")).toContain("; is not a separator");
    expect(describeHookShell("linux")).toContain("/bin/sh -c");
  });
});
