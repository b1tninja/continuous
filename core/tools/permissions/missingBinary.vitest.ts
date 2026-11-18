import { beforeEach, describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import {
  alternativesFor,
  installHint,
  missingBinaryMessage,
  missingBinaryProblem,
} from "./missingBinary";
import {
  missingBinaryGate,
  onPath,
  resetMissingBinaryCache,
} from "./missingBinaryGate";
import type { CommandExecutor } from "../../util/commandExecutor";

/** Only these programs exist */
const PRESENT = new Set([
  "git",
  "node",
  "npm",
  "python3",
  "grep",
  "apt-get",
  // the tools that wrap or install other programs are there; the wrapped one is not
  "sh",
  "bash",
  "pip",
  "apt",
  "brew",
  "cargo",
  "go",
  "curl",
  "wget",
  "npx",
  "bunx",
  "pnpm",
  "uv",
  "poetry",
  "docker",
  "ssh",
  "xargs",
  "sudo",
  "env",
]);
const has = (name: string) => PRESENT.has(name);
const problem = (command: string, shell: ShellKind = "bash") =>
  missingBinaryProblem(command, { shell, hasProgram: has, cwd: "/w" })?.program;

describe("missingBinaryProblem: certain failures", () => {
  const cases: [string, string, ShellKind?][] = [
    ["a plain command", "rg foo", "bash"],
    ["with arguments", "rg -n foo src", "bash"],
    ["second segment of &&", "git status && rg foo", "bash"],
    ["after ;", "git status; rg foo", "bash"],
    ["in a pipe", "git log | rg foo", "bash"],
    ["first of a chain wins", "fd x && rg y", "bash"],
    ["through sudo", "sudo rg foo", "bash"],
    ["through sudo with an option value", "sudo -u bob rg foo", "bash"],
    ["through env", "env FOO=1 rg foo", "bash"],
    ["through time", "time rg foo", "bash"],
    ["through nohup", "nohup rg foo", "bash"],
    ["zsh", "rg foo", "zsh"],
    ["sh", "rg foo", "sh"],
    ["python on a machine with python3 only", "python script.py", "bash"],
    ["powershell", "rg foo", "powershell"],
    ["powershell after ;", "git status; rg foo", "powershell"],
    ["cmd", "rg foo", "cmd"],
    ["a wrapper that is itself missing", "npx2 rg", "bash"],
    ["a program that follows a harmless echo", "echo hi && rg foo", "bash"],
    ["a missing wrapper is itself the program", "yarn x", "bash"],
  ];
  for (const [name, command, shell] of cases) {
    it(name, () => {
      const p = problem(command, shell);
      expect(p).toBeDefined();
    });
  }

  it("names the missing program", () => {
    expect(problem("git status && rg foo")).toBe("rg");
    expect(problem("sudo -u bob rg foo")).toBe("rg");
    expect(problem("env FOO=1 python x.py")).toBe("python");
  });
});

describe("missingBinaryProblem: must not fire", () => {
  const cases: [string, string, ShellKind?][] = [
    ["every program present", "git status && node -v | grep v"],
    ["empty-ish", "git"],
    ["a path", "./rg foo"],
    ["an absolute path", "/usr/local/bin/rg foo"],
    ["a home path", "~/bin/rg foo"],
    ["a windows path", "C:\\tools\\rg.exe foo", "powershell"],
    ["a relative script", "scripts/run.sh", "bash"],
    ["builtin cd then present", "cd src && git status"],
    ["echo", "echo hello"],
    ["export of a plain variable", "export FOO=1 && git status"],
    ["test builtin", "test -f x && git status"],
    ["type guard", "type rg && rg foo"],
    ["which guard", "which rg && rg foo"],
    ["command -v guard", "command -v rg && rg foo"],
    ["command -v or fallback", "command -v rg || grep foo"],
    [
      "version probe with fallback",
      "rg --version 2>/dev/null || grep --version",
    ],
    ["fallback after the missing program", "rg foo || grep foo"],
    ["fallback before", "git status || rg foo"],
    ["or-true", "rg foo || true"],
    ["export PATH then program", "export PATH=/opt/bin && rg foo"],
    ["source then program", "source env.sh && rg foo"],
    ["dot then program", ". ./env.sh && rg foo"],
    ["eval then program", "eval something && rg foo"],
    ["alias then program", "alias rg=grep && rg foo"],
    ["function keyword then program", "function rg && rg foo"],
    ["cd then relative name", "cd tools && rg foo"],
    ["pushd then name", "pushd tools && rg foo"],
    ["npm i -g then program", "npm i -g ripgrep-bin && rg foo"],
    ["npm install -g then program", "npm install -g tool && tool run"],
    ["pip install then program", "pip install tool && tool run"],
    ["apt install then program", "apt install ripgrep && rg foo"],
    ["sudo apt install then program", "sudo apt install ripgrep && rg foo"],
    ["brew install then program", "brew install ripgrep && rg foo"],
    ["cargo install then program", "cargo install ripgrep && rg foo"],
    ["go install then program", "go install x/y@latest && y run"],
    ["curl piped to sh then program", "curl -fsSL https://x.sh | sh && rg foo"],
    [
      "wget piped to bash then program",
      "wget -qO- https://x.sh | bash; rg foo",
    ],
    ["npx", "npx rg foo"],
    ["npm run", "npm run rg"],
    ["bunx", "bunx rg foo"],
    ["pnpm exec", "pnpm exec rg foo"],
    ["uv run", "uv run rg foo"],
    ["poetry run", "poetry run rg foo"],
    ["docker run", "docker run alpine rg foo"],
    ["ssh", "ssh host rg foo"],
    ["xargs", "git ls-files | xargs rg foo"],
    ["find -exec", "git ls-files | xargs -n1 rg foo"],
    ["if keyword body", "if git status; then rg foo; fi"],
    ["for loop body", "for f in a; do rg $f; done"],
    ["not understood: variable", "rg $HOME"],
    ["not understood: substitution", "echo $(rg foo)"],
    ["not understood: assignment prefix", "PATH=/x rg foo"],
    ["not understood: newline", "git status\nrg foo"],
    ["not understood: redirect", "rg foo > out.txt"],
    ["not understood: heredoc", "rg foo <<EOF\nx\nEOF"],
    ["not understood: background", "rg foo &"],
    ["not understood: group", "(rg foo)"],
    ["glob name", "r* foo"],
    ["unknown shell", "rg foo", "unknown"],
    ["powershell cmdlet", "Get-ChildItem", "powershell"],
    ["powershell custom verb-noun", "Invoke-Thing -x", "powershell"],
    ["powershell alias ls", "ls", "powershell"],
    ["powershell alias cat", "cat x.txt", "powershell"],
    ["powershell alias gci", "gci -Recurse", "powershell"],
    ["powershell sls", "sls foo x.txt", "powershell"],
    [
      "powershell Set-Alias then name",
      "Set-Alias rg grep; rg foo",
      "powershell",
    ],
    [
      "powershell Import-Module then name",
      "Import-Module x; rg foo",
      "powershell",
    ],
    ["powershell Get-Command guard", "Get-Command rg; rg foo", "powershell"],
    ["powershell invoke-expression", "iex x; rg foo", "powershell"],
    ["cmd builtin dir", "dir", "cmd"],
    ["cmd echo", "echo hi", "cmd"],
    ["cmd where guard", "where rg && rg foo", "cmd"],
    ["zsh builtin", "whence rg", "zsh"],
    ["zsh print", "print hello", "zsh"],
    ["bash type -p", "type -p rg && rg x"],
    ["bash hash guard", "hash rg && rg x"],
    ["env alone", "env"],
    ["sudo alone", "sudo"],
    ["bash -c runs anything", "bash -c 'rg foo'"],
    ["sh then program (script may define)", "sh setup.sh && rg foo"],
  ];
  for (const [name, command, shell] of cases) {
    it(name, () => {
      expect(problem(command, shell)).toBeUndefined();
    });
  }

  it("does not doubt a program that is there", () => {
    expect(problem("git status && node -v && npm test")).toBeUndefined();
  });
});

describe("alternatives and hints", () => {
  const ctx = (shell: ShellKind) => ({ shell, hasProgram: has });

  it("offers python3 for python when it is there", () => {
    expect(alternativesFor("python", ctx("bash"))).toEqual(["python3"]);
  });

  it("filters alternatives by presence", () => {
    expect(alternativesFor("rg", ctx("bash"))).toEqual(["grep -rn"]);
    expect(alternativesFor("fd", ctx("bash"))).toEqual([]);
  });

  it("offers PowerShell builtins without a lookup", () => {
    expect(alternativesFor("grep", ctx("powershell"))).toContain(
      "Select-String",
    );
    expect(alternativesFor("rg", ctx("powershell"))).toEqual(["Select-String"]);
  });

  it("offers cmd builtins in cmd only", () => {
    expect(alternativesFor("ls", ctx("cmd"))).toEqual(["dir"]);
    expect(alternativesFor("ls", ctx("bash"))).toEqual([]);
  });

  it("never offers more than three", () => {
    const all = { shell: "powershell" as const, hasProgram: () => true };
    expect(alternativesFor("grep", all).length).toBeLessThanOrEqual(3);
  });

  it("hints by platform", () => {
    expect(installHint("rg", "win32", has)).toBe(
      "winget install BurntSushi.ripgrep.MSVC",
    );
    expect(installHint("rg", "darwin", has)).toBe("brew install ripgrep");
    expect(installHint("rg", "linux", has)).toBe("sudo apt install ripgrep");
    expect(installHint("fd", "linux", has)).toBe("sudo apt install fd-find");
    expect(installHint("rg", "linux", (n) => n === "dnf")).toBe(
      "sudo dnf install ripgrep",
    );
    expect(installHint("rg", "linux", (n) => n === "pacman")).toBe(
      "sudo pacman -S ripgrep",
    );
  });

  it("gives no hint for what it does not know, or a manager that is not there", () => {
    expect(installHint("frobnicate", "linux", has)).toBeUndefined();
    expect(installHint("rg", "linux", () => false)).toBeUndefined();
    expect(installHint("make", "win32", has)).toBeUndefined();
  });

  it("writes the message", () => {
    const text = missingBinaryMessage(
      { program: "python", segment: 0 },
      {
        shell: "bash",
        hasProgram: has,
        where: "bash on this machine",
        platform: "linux",
      },
    );
    expect(text).toContain("`python` was not found");
    expect(text).toContain("bash on this machine");
    expect(text).toContain("python3");
    expect(text).toContain("sudo apt install python3");
    expect(text).toContain("The command was not run");
  });
});

describe("onPath", () => {
  it("finds a file on a posix PATH", () => {
    const isFile = (f: string) => f.split("\\").join("/").endsWith("/bin/git");
    expect(
      onPath("git", { platform: "linux", env: { PATH: "/usr:/bin" }, isFile }),
    ).toBe(true);
    expect(
      onPath("rg", { platform: "linux", env: { PATH: "/usr:/bin" }, isFile }),
    ).toBe(false);
  });

  it("applies PATHEXT on Windows", () => {
    const seen: string[] = [];
    onPath("rg", {
      platform: "win32",
      env: { Path: "C:\\tools", PATHEXT: ".EXE;.CMD" },
      isFile: (f) => {
        seen.push(f);
        return false;
      },
    });
    expect(seen.some((f) => f.endsWith("rg.EXE"))).toBe(true);
    expect(seen.some((f) => f.endsWith("rg.CMD"))).toBe(true);
  });
});

describe("missingBinaryGate", () => {
  beforeEach(() => resetMissingBinaryCache());

  const executor = (
    kind: CommandExecutor["kind"],
    shell: ShellKind,
  ): CommandExecutor => ({
    kind,
    shell: { kind: shell, executable: "x", args: () => [], runsProfile: false },
    invocation: () => ({ shell: "x", args: [] }),
    spawn: () => Promise.reject(new Error("not used")),
    describe: () => "bash on this machine",
  });

  it("stops a command whose program is on neither the PATH nor the shell", () => {
    const text = missingBinaryGate("rg foo", executor("local", "bash"), {
      onPath: () => false,
      probe: () => false,
      platform: "linux",
    });
    expect(text).toContain("`rg` was not found");
  });

  it("lets a program that the shell knows run (a profile function)", () => {
    expect(
      missingBinaryGate("nvm use 20", executor("local", "bash"), {
        onPath: () => false,
        probe: () => true,
      }),
    ).toBeUndefined();
  });

  it("lets a command run when the probe cannot say", () => {
    expect(
      missingBinaryGate("rg foo", executor("local", "bash"), {
        onPath: () => false,
        probe: () => undefined,
      }),
    ).toBeUndefined();
  });

  it("lets a program on the PATH run without asking the shell", () => {
    let asked = 0;
    expect(
      missingBinaryGate("rg foo", executor("local", "bash"), {
        onPath: () => true,
        probe: () => {
          asked++;
          return false;
        },
      }),
    ).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("does not use the host PATH for WSL", () => {
    let asked = 0;
    const text = missingBinaryGate("rg foo", executor("wsl", "bash"), {
      onPath: () => true,
      probe: () => {
        asked++;
        return false;
      },
      platform: "win32",
    });
    expect(asked).toBeGreaterThan(0);
    expect(text).toContain("`rg` was not found");
  });

  it("never probes a container", () => {
    expect(
      missingBinaryGate("rg foo", executor("container", "bash"), {
        onPath: () => false,
        probe: () => false,
      }),
    ).toBeUndefined();
  });

  it("keeps an answer for a minute", () => {
    let asked = 0;
    let t = 1000;
    const opts = {
      onPath: () => false,
      probe: () => {
        asked++;
        return false;
      },
      now: () => t,
      platform: "linux" as const,
    };
    missingBinaryGate("rg foo", executor("local", "bash"), opts);
    missingBinaryGate("rg bar", executor("local", "bash"), opts);
    expect(asked).toBe(1 + asked - 1); // the alternatives may be asked once each
    const first = asked;
    missingBinaryGate("rg baz", executor("local", "bash"), opts);
    expect(asked).toBe(first);
    t += 61_000;
    missingBinaryGate("rg baz", executor("local", "bash"), opts);
    expect(asked).toBeGreaterThan(first);
  });

  it("is off with CONTINUE_MISSING_BINARY_CHECK=off", () => {
    expect(
      missingBinaryGate("rg foo", executor("local", "bash"), {
        env: { CONTINUE_MISSING_BINARY_CHECK: "off" },
        onPath: () => false,
        probe: () => false,
      }),
    ).toBeUndefined();
  });
});
