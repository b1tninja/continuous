import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getCommandExecutor } from "./commandExecutor";
import {
  COMMAND_STDIO,
  commandEnvironment,
  realExitInvocation,
} from "./commandSpawn";
import { withRealExitCode } from "./shell";
import { setTerminalEnvironmentSettings } from "./terminalEnvironment";

/** Runs to the end and reports what the command printed and how long it took. */
function finish(
  child: ChildProcess,
): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, out, err, ms: Date.now() - started }),
    );
  });
}

describe("a command cannot wait for an answer", () => {
  it("gives a command no open standard input", () => {
    expect(COMMAND_STDIO).toEqual(["ignore", "pipe", "pipe"]);
  });

  // Real shells: before, each of these waited until the tool's timeout
  it.runIf(process.platform === "win32")(
    "Read-Host fails at once in Windows PowerShell",
    async () => {
      const child = await getCommandExecutor({
        terminalShell: "default",
      }).spawn("Read-Host 'name'", { windowsHide: true });
      expect(child.stdin).toBeNull();
      const result = await finish(child);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/NonInteractive/);
      expect(result.ms).toBeLessThan(20_000);
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "a cmdlet missing a mandatory parameter fails instead of asking for it",
    async () => {
      // Get-Content with no -Path asks "Path[0]:" in an interactive session
      const result = await finish(
        await getCommandExecutor({ terminalShell: "default" }).spawn(
          "Get-Content",
          { windowsHide: true },
        ),
      );
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/Path/);
      expect(result.ms).toBeLessThan(20_000);
    },
    30_000,
  );

  it.runIf(process.platform !== "win32")(
    "read in sh sees end of file at once",
    async () => {
      const child = await getCommandExecutor({
        terminalShell: "default",
        env: { SHELL: "/bin/sh" },
      }).spawn("read x; echo got=$x");
      expect(child.stdin).toBeNull();
      const result = await finish(child);
      expect(result.out).toContain("got=");
      expect(result.ms).toBeLessThan(20_000);
    },
    30_000,
  );
});

describe("the exit code is the program's own", () => {
  const powershell = getCommandExecutor({
    platform: "win32",
    terminalShell: "default",
  });

  it("asks PowerShell for the real code and keeps the command on line 1", () => {
    const { shell, args } = realExitInvocation(powershell, "npm test");
    expect(shell).toBe("powershell.exe");
    const text = args[args.length - 1];
    // Line 1 is the command, so "At line:1 char:5" in an error is unchanged
    expect(text.split("\n")[0]).toBe("npm test");
    expect(text).toContain("exit $LASTEXITCODE");
    expect(text).not.toContain("$global:LASTEXITCODE = $null");
    // Loop checks keep the reset: their verdict is the number itself
    expect(withRealExitCode("npm test", "powershell").split("\n")[0]).toBe(
      "$global:LASTEXITCODE = $null",
    );
  });

  it("leaves a command for bash, WSL or a container as written", () => {
    const bash = getCommandExecutor({
      platform: "linux",
      terminalShell: "default",
      env: { SHELL: "/bin/bash" },
    });
    expect(realExitInvocation(bash, "npm test").args).toEqual([
      "-l",
      "-c",
      "npm test",
    ]);
    const wsl = getCommandExecutor({
      platform: "win32",
      terminalShell: { kind: "wsl" },
      wslDistros: [],
    });
    expect(realExitInvocation(wsl, "npm test")).toEqual(
      wsl.invocation("npm test"),
    );
  });

  // Real shells, with a tiny script that exits 3
  const exit3 = `node -e "process.exit(3)"`;
  const run = (command: string, wrapped: boolean) => {
    const executor = getCommandExecutor({
      terminalShell: "default",
      ...(process.platform === "win32" ? {} : { env: { SHELL: "/bin/sh" } }),
    });
    const { shell, args } = wrapped
      ? realExitInvocation(executor, command)
      : executor.invocation(command);
    return finish(
      spawn(shell, args, { stdio: COMMAND_STDIO, windowsHide: true }),
    );
  };

  it("a program that exits 3 is reported as 3", async () => {
    const result = await run(exit3, true);
    expect(result.code).toBe(3);
    if (process.platform === "win32") {
      // What PowerShell says without the tail: 1, for any failure
      expect((await run(exit3, false)).code).toBe(1);
    }
  }, 60_000);

  it("changes nothing else: output, success, a failing cmdlet, the last statement decides", async () => {
    const ok = `node -e "console.log('out'); console.error('err')"`;
    const [plain, wrapped] = [await run(ok, false), await run(ok, true)];
    expect(wrapped.code).toBe(0);
    expect(wrapped.out).toBe(plain.out);
    expect(wrapped.err).toBe(plain.err);
    // As in every shell, `a; b` is b's result
    expect((await run(`${exit3}; echo hi`, true)).code).toBe(0);
    if (process.platform === "win32") {
      const missing = "Get-Item .\\no-such-file-for-this-test";
      const [a, b] = [await run(missing, false), await run(missing, true)];
      expect(b.code).toBe(1);
      // The same error text, "At line:1" included
      expect(b.err).toBe(a.err);
      expect(b.err).toMatch(/line:1 /);
    }
  }, 120_000);
});

describe("commandEnvironment", () => {
  it("adds the passEnv names to WSLENV only when the command runs in WSL", () => {
    setTerminalEnvironmentSettings({ passEnv: ["MY_TOKEN"] });
    try {
      const base = { MY_TOKEN: "v", PATH: "x" };
      expect(
        commandEnvironment(base, { platform: "win32", wsl: true }).WSLENV,
      ).toBe("MY_TOKEN/u");
      expect(
        commandEnvironment(base, { platform: "win32", wsl: false }).WSLENV,
      ).toBeUndefined();
      // Not Windows: never WSL's way in
      expect(commandEnvironment(base, { platform: "linux" }).WSLENV).toBe(
        undefined,
      );
    } finally {
      setTerminalEnvironmentSettings(undefined);
    }
  });
});
