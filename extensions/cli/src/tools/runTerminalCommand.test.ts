import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { setTerminalShellPreference } from "core/util/shell.js";

import {
  describeShell,
  isRunningInWsl,
  runTerminalCommandTool,
} from "./runTerminalCommand.js";

describe("describeShell", () => {
  it("names Windows PowerShell and its command separator on Windows", () => {
    const text = describeShell("win32", undefined, false);
    expect(text).toContain("Windows PowerShell");
    expect(text).toContain("not &&");
  });

  it("says bash in WSL on a Windows host when commands are sent there", () => {
    setTerminalShellPreference({ kind: "wsl", distro: "Ubuntu" });
    try {
      const text = describeShell("win32", undefined, false);
      expect(text).toContain("bash");
      expect(text).toContain("WSL (Ubuntu)");
      expect(text).not.toContain("PowerShell");
      // Off Windows the preference means nothing
      expect(describeShell("linux", "/bin/bash", false)).toBe(
        "Runs in bash as a login shell on linux.",
      );
    } finally {
      setTerminalShellPreference(undefined);
    }
  });

  it("names the login shell elsewhere", () => {
    expect(describeShell("darwin", "/bin/zsh", false)).toBe(
      "Runs in zsh as a login shell on macOS.",
    );
    expect(describeShell("linux", "/bin/bash", false)).toBe(
      "Runs in bash as a login shell on linux.",
    );
    expect(describeShell("linux", "/usr/bin/fish", true)).toBe(
      "Runs in fish as a login shell on WSL.",
    );
  });

  it("is the second sentence of the tool description", () => {
    expect(runTerminalCommandTool.description).toContain(
      `returns the output. ${describeShell()}`,
    );
  });
});

describe("runTerminalCommandTool", () => {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";

  describe("commands that leave a background process", () => {
    // The shell exits right away but `sleep` keeps the output pipe open; the
    // tool used to wait for the pipe to close, i.e. for the timeout.
    it.skipIf(process.platform === "win32")(
      "returns when the shell exits, without waiting for the background child",
      async () => {
        const started = Date.now();
        const result = await runTerminalCommandTool.run({
          command: "sleep 30 & echo started",
        });
        expect(result).toContain("started");
        expect(Date.now() - started).toBeLessThan(10_000);
      },
      20_000,
    );
  });

  describe("pagers", () => {
    it("gives a command a pager that prints and ends", async () => {
      const result = await runTerminalCommandTool.run({
        command: `node -e "console.log('P=' + process.env.PAGER + ' G=' + process.env.GIT_PAGER)"`,
      });
      expect(result).toContain("P=cat G=cat");
    }, 30_000);
  });

  describe("exit codes", () => {
    // Windows PowerShell used to report 1 for any failing native program
    it("names the code the program chose", async () => {
      await expect(
        runTerminalCommandTool.run({
          command: `node -e "console.error('failed'); process.exit(3)"`,
        }),
      ).rejects.toMatch(/^Error \(exit code 3\): failed/);
    }, 30_000);
  });

  describe("commands that ask a question", () => {
    // Standard input used to stay open, so these waited for the timeout
    it.runIf(process.platform === "win32")(
      "Read-Host fails at once with PowerShell's NonInteractive error",
      async () => {
        const started = Date.now();
        await expect(
          runTerminalCommandTool.run({ command: "Read-Host 'name'" }),
        ).rejects.toMatch(/NonInteractive/);
        expect(Date.now() - started).toBeLessThan(20_000);
      },
      30_000,
    );

    it.skipIf(process.platform === "win32")(
      "read sees end of file at once",
      async () => {
        const started = Date.now();
        const result = await runTerminalCommandTool.run({
          command: "read x; echo got=$x",
        });
        expect(result).toContain("got=");
        expect(Date.now() - started).toBeLessThan(20_000);
      },
      30_000,
    );
  });

  describe("basic platform-specific terminal execution", () => {
    it.skipIf(process.platform === "win32" || !fs.existsSync("/bin/bash"))(
      "does not source a shell startup file named after the process started",
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-bash-tool-"));
        const marker = path.join(dir, "marker");
        const script = path.join(dir, "setup.sh");
        fs.writeFileSync(script, `echo ran > '${marker}'\n`);
        const previousBash = process.env.BASH_ENV;
        const previousShell = process.env.SHELL;
        process.env.BASH_ENV = script;
        process.env.SHELL = "/bin/bash";
        try {
          const result = await runTerminalCommandTool.run({
            command: "echo done",
          });
          expect(result).toContain("done");
          expect(fs.existsSync(marker)).toBe(false);
        } finally {
          if (previousBash === undefined) delete process.env.BASH_ENV;
          else process.env.BASH_ENV = previousBash;
          if (previousShell === undefined) delete process.env.SHELL;
          else process.env.SHELL = previousShell;
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it("should execute a simple echo command", async () => {
      let command: string;
      let expectedOutput: string;

      if (isWindows) {
        command = 'Write-Output "hello world"';
        expectedOutput = "hello world";
      } else {
        command = 'echo "hello world"';
        expectedOutput = "hello world";
      }

      const result = await runTerminalCommandTool.run({ command });
      expect(result.trim()).toBe(expectedOutput);
    });

    it("should get current directory", async () => {
      let command: string;

      if (isWindows) {
        command = "Get-Location | Select-Object -ExpandProperty Path";
      } else {
        command = "pwd";
      }

      const result = await runTerminalCommandTool.run({ command });

      if (isWindows) {
        // Windows paths like C:\path\to\dir
        expect(result.trim()).toMatch(/^[A-Za-z]:\\.*/);
      } else {
        // Unix paths like /path/to/dir
        expect(result.trim()).toMatch(/^\/.*$/);
      }
    });

    it("should list directory contents", async () => {
      let command: string;

      if (isWindows) {
        command = "Get-ChildItem | Select-Object -ExpandProperty Name";
      } else {
        command = "ls";
      }

      const result = await runTerminalCommandTool.run({ command });
      // Should return some directory content (not empty)
      expect(result.length).toBeGreaterThan(0);
    });

    it("should handle command that produces version info", async () => {
      // Node.js should be available on all platforms in CI
      const command = "node --version";
      const result = await runTerminalCommandTool.run({ command });

      // Should contain version number (starts with v)
      expect(result.trim()).toMatch(/^v\d+\.\d+\.\d+/);
    });
  });

  describe("basic error handling", () => {
    it("should handle non-existent commands", async () => {
      const command = "definitely-not-a-real-command-xyz123";
      // The shell's own error path: the missing-program check would stop the
      // command before it runs, so it is switched off here.
      const before = process.env.CONTINUE_MISSING_BINARY_CHECK;
      process.env.CONTINUE_MISSING_BINARY_CHECK = "off";
      try {
        await expect(runTerminalCommandTool.run({ command })).rejects.toMatch(
          /Error \(exit code|Command timed out|not found|not recognized/,
        );
      } finally {
        if (before === undefined) {
          delete process.env.CONTINUE_MISSING_BINARY_CHECK;
        } else {
          process.env.CONTINUE_MISSING_BINARY_CHECK = before;
        }
      }
    });

    it("does not run a command whose program is not installed", async () => {
      const result = await runTerminalCommandTool.run({
        command: "nonexistentcommandxyz123",
      });
      expect(result).toContain("Command not run");
      expect(result).toContain("nonexistentcommandxyz123");
      expect(result).toContain("was not run");
    });
  });

  describe("platform-specific features", () => {
    if (isWindows) {
      it("should work with Windows commands", async () => {
        const result = await runTerminalCommandTool.run({
          command: "Write-Output $env:OS",
        });
        expect(result.trim()).toBe("Windows_NT");
      });
    }

    if (isMac) {
      it("should work with macOS commands", async () => {
        const result = await runTerminalCommandTool.run({
          command: "uname -s",
        });
        expect(result.trim()).toBe("Darwin");
      });
    }

    if (isLinux) {
      it("should work with Linux commands", async () => {
        const result = await runTerminalCommandTool.run({
          command: "uname -s",
        });
        expect(result.trim()).toBe("Linux");
      });
    }
  });

  describe("WSL detection", () => {
    it("should cache the WSL detection result", () => {
      const firstResult = isRunningInWsl();
      const secondResult = isRunningInWsl();
      expect(firstResult).toBe(secondResult);
    });

    if (!isLinux) {
      it("should return false on non-Linux platforms", () => {
        expect(isRunningInWsl()).toBe(false);
      });
    }
  });
});
