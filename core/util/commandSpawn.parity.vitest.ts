import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn,
}));

import { getCommandExecutor } from "./commandExecutor";
import { realExitInvocation, spawnAgentCommand } from "./commandSpawn";

/**
 * `spawnAgentCommand` hands `child_process.spawn` exactly what the terminal
 * tools used to pass it themselves (`realExitInvocation`, then their own
 * options): the same program and arguments for Windows PowerShell, WSL, a
 * login shell and a container, and the caller's options untouched.
 */
afterEach(() => spawn.mockReset());

/** A process that reports it started, as a real one does. */
function startsOk() {
  const child = new EventEmitter();
  spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  return child;
}

const options = {
  cwd: "/work/space",
  env: { PATH: "/usr/bin", PAGER: "cat" },
  stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
};

const executors = {
  "Windows PowerShell": () =>
    getCommandExecutor({
      platform: "win32",
      terminalShell: "default",
      env: {},
    }),
  "WSL on Windows": () =>
    getCommandExecutor({
      platform: "win32",
      terminalShell: { kind: "wsl", distro: "Ubuntu" },
      wslDistros: [{ name: "Ubuntu", isDefault: true }],
    }),
  "bash on Linux": () =>
    getCommandExecutor({
      platform: "linux",
      terminalShell: "default",
      env: { SHELL: "/bin/bash" },
    }),
  "zsh on macOS": () =>
    getCommandExecutor({
      platform: "darwin",
      terminalShell: "default",
      env: { SHELL: "/bin/zsh" },
    }),
  "a docker container": () =>
    getCommandExecutor({
      platform: "linux",
      terminalShell: { kind: "container", runtime: "docker" },
      containerStatus: { state: "ready", runtime: "docker" },
    }),
};

describe("spawnAgentCommand starts what the tools started before", () => {
  it.each(Object.entries(executors))("%s", async (_name, make) => {
    const executor = make();
    const child = startsOk();
    const command = `node -e "process.exit(3)"`;
    await expect(spawnAgentCommand(executor, command, options)).resolves.toBe(
      child,
    );
    const before = realExitInvocation(executor, command, options.cwd);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [program, args, given] = spawn.mock.calls[0];
    expect(program).toBe(before.shell);
    expect(args).toEqual(before.args);
    expect(given).toEqual(options);
  });

  it("chooses powershell.exe on Windows and wsl.exe for WSL, with the exit-code tail only for PowerShell", () => {
    const ps = realExitInvocation(
      executors["Windows PowerShell"](),
      "npm test",
    );
    expect(ps.shell.toLowerCase()).toContain("powershell");
    expect(ps.args.join(" ")).not.toBe(
      executors["Windows PowerShell"]().invocation("npm test").args.join(" "),
    );
    const wsl = executors["WSL on Windows"]();
    expect(realExitInvocation(wsl, "npm test").shell).toBe("wsl.exe");
    expect(realExitInvocation(wsl, "npm test")).toEqual(
      wsl.invocation("npm test"),
    );
  });

  it("rejects with the error that kept the process from starting", async () => {
    const child = new EventEmitter();
    spawn.mockImplementation(() => {
      queueMicrotask(() =>
        child.emit("error", new Error("spawn powershell.exe ENOENT")),
      );
      return child;
    });
    await expect(
      spawnAgentCommand(executors["Windows PowerShell"](), "ls", options),
    ).rejects.toThrow("ENOENT");
  });

  it("a synchronous throw from spawn rejects too", async () => {
    spawn.mockImplementation(() => {
      throw new TypeError("The argument 'args' must not contain null bytes");
    });
    await expect(
      spawnAgentCommand(executors["bash on Linux"](), "ls", options),
    ).rejects.toThrow("null bytes");
  });
});

describe("the container's mount is the folder the command starts in (W28)", () => {
  it("invocation and spawn mount the cwd they are given", async () => {
    const executor = executors["a docker container"]();
    const mountOf = (args: string[]) => args[args.indexOf("-v") + 1];
    expect(mountOf(executor.invocation("ls", "/work/space").args)).toBe(
      "/work/space:/work/space:rw",
    );
    startsOk();
    await executor.spawn("ls", { cwd: "/work/space" });
    expect(mountOf(spawn.mock.calls[0][1])).toBe("/work/space:/work/space:rw");
    // Without a cwd it is still the process's own folder, as before
    expect(mountOf(executor.invocation("ls").args)).toContain(process.cwd());
  });
});
