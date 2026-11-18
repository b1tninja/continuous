import { EventEmitter } from "events";

import {
  setTerminalEnvironmentSettings,
  withPagerDefaults,
} from "core/util/terminalEnvironment.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  spawn,
}));

import { mcpStdioEnv, shellChildEnv } from "./childEnv.js";
import { runTerminalCommandTool } from "./tools/runTerminalCommand.js";

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 1;
  return child;
}

afterEach(() => {
  setTerminalEnvironmentSettings(undefined);
  vi.unstubAllEnvs();
  spawn.mockReset();
});

async function runAndGetEnv(): Promise<Record<string, string>> {
  const child = fakeChild();
  // A real process reports that it started; the executor waits for that
  // before the tool listens for output and exit (executor.spawn)
  spawn.mockImplementation(() => {
    setImmediate(() => child.emit("spawn"));
    return child;
  });
  const p = runTerminalCommandTool.run({ command: "echo hi" } as any);
  await vi.waitFor(() =>
    expect(child.listenerCount("close")).toBeGreaterThan(0),
  );
  child.emit("close", 0);
  await p;
  return spawn.mock.calls[0][2].env;
}

describe("terminal tool environment", () => {
  it("does not pass the host's secrets, keeps PATH and HOME", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", "/home/me");
    const env = await runAndGetEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBe("/home/me");
  });

  it("passEnv lets a named variable through", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp");
    setTerminalEnvironmentSettings({ passEnv: ["GITHUB_TOKEN"] });
    expect((await runAndGetEnv()).GITHUB_TOKEN).toBe("ghp");
  });

  it("inherit gives the same environment as before the change, plus the pager defaults", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    setTerminalEnvironmentSettings({ environment: "inherit" });
    // PAGER, GIT_PAGER, MANPAGER and LESS are filled in only where the host
    // does not set them; everything else is the host's environment as is
    expect(await runAndGetEnv()).toEqual(
      withPagerDefaults(shellChildEnv() as Record<string, string>),
    );
  });

  it("the tool description carries the static notice", () => {
    expect(runTerminalCommandTool.description).toContain("terminal.passEnv");
  });
});

describe("stdio MCP environment", () => {
  it("scrubs the host's variables but keeps the server's own env block", () => {
    const env = mcpStdioEnv(
      { OPENAI_API_KEY: "from-config" },
      { PATH: "/usr/bin", OPENAI_API_KEY: "host", GITHUB_TOKEN: "ghp" },
      { PATH: "/usr/bin" },
    );
    expect(env.OPENAI_API_KEY).toBe("from-config");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});
