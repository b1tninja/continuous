import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn,
}));

import { getCommandExecutor } from "./commandExecutor";
import { setTerminalShellPreference } from "./shell";
import { setTerminalEnvironmentSettings } from "./terminalEnvironment";

// A process that never reports back: these tests read the spawn arguments only
beforeEach(() => {
  spawn.mockImplementation(() => new EventEmitter());
});

afterEach(() => {
  setTerminalEnvironmentSettings(undefined);
  vi.unstubAllEnvs();
  spawn.mockReset();
});

describe("command executor environment", () => {
  it("does not hand the host's secrets to a local command", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    vi.stubEnv("PATH", "/usr/bin");
    void getCommandExecutor({ platform: "linux", env: {} }).spawn("ls");
    const env = spawn.mock.calls[0][2].env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("inherit passes the host's environment on", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    setTerminalEnvironmentSettings({ environment: "inherit" });
    void getCommandExecutor({ platform: "linux", env: {} }).spawn("ls");
    expect(spawn.mock.calls[0][2].env.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("a caller's own env is not touched", () => {
    void getCommandExecutor({ platform: "linux", env: {} }).spawn("ls", {
      env: { CANARY_TOKEN: "c" },
    });
    expect(spawn.mock.calls[0][2].env).toEqual({ CANARY_TOKEN: "c" });
  });

  it("gives a command pagers that print and end, unless passEnv names one", () => {
    vi.stubEnv("PAGER", "less");
    vi.stubEnv("GIT_PAGER", "delta");
    setTerminalEnvironmentSettings({ passEnv: ["GIT_PAGER"] });
    void getCommandExecutor({ platform: "linux", env: {} }).spawn("git log");
    const env = spawn.mock.calls[0][2].env;
    expect(env.PAGER).toBe("cat");
    expect(env.MANPAGER).toBe("cat");
    expect(env.GIT_PAGER).toBe("delta");
  });

  it("leaves no standard input open unless the caller sets stdio", () => {
    const local = getCommandExecutor({ platform: "linux", env: {} });
    void local.spawn("ls");
    expect(spawn.mock.calls[0][2].stdio).toEqual(["ignore", "pipe", "pipe"]);
    void local.spawn("ls", { stdio: "pipe" });
    expect(spawn.mock.calls[1][2].stdio).toBe("pipe");
    void getCommandExecutor({
      platform: "linux",
      terminalShell: { kind: "container", runtime: "docker" },
      containerStatus: { runtime: "docker" } as never,
    }).spawn("ls");
    expect(spawn.mock.calls[2][2].stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("WSL gets the passEnv names in WSLENV, and not a withheld name", () => {
    vi.stubEnv("WSLENV", "FOO/p");
    vi.stubEnv("PASSED_TOKEN", "p");
    vi.stubEnv("WITHHELD_TOKEN", "w");
    setTerminalEnvironmentSettings({ passEnv: ["PASSED_TOKEN"] });
    setTerminalShellPreference({ kind: "wsl" });
    try {
      void getCommandExecutor({
        platform: "win32",
        terminalShell: { kind: "wsl" },
        wslDistros: [{ name: "Ubuntu", state: "Running", version: 2 } as never],
      }).spawn("ls");
    } finally {
      setTerminalShellPreference(undefined);
    }
    const env = spawn.mock.calls[0][2].env;
    if (process.platform === "win32") {
      expect(env.WSLENV).toBe("FOO/p:PASSED_TOKEN/u");
    }
    expect(env.WITHHELD_TOKEN).toBeUndefined();
    expect(env.WSLENV ?? "").not.toContain("WITHHELD_TOKEN");
  });

  it("the host's shell does not get a WSLENV it did not have", () => {
    vi.stubEnv("PASSED_TOKEN", "p");
    setTerminalEnvironmentSettings({ passEnv: ["PASSED_TOKEN"] });
    void getCommandExecutor({ platform: "linux", env: {} }).spawn("ls");
    expect(spawn.mock.calls[0][2].env.WSLENV).toBeUndefined();
  });

  it("WSL keeps WSLENV and the basics in allowlist mode", () => {
    vi.stubEnv("WSLENV", "FOO/p");
    vi.stubEnv("GITHUB_TOKEN", "ghp");
    vi.stubEnv("SystemRoot", "C:\Windows");
    setTerminalEnvironmentSettings({ environment: "allowlist" });
    void getCommandExecutor({
      platform: "win32",
      terminalShell: { kind: "wsl" },
      wslDistros: [{ name: "Ubuntu", state: "Running", version: 2 } as never],
    }).spawn("ls");
    const env = spawn.mock.calls[0][2].env;
    expect(env.WSLENV).toBe("FOO/p");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});
