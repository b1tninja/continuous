import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IDE, ToolExtras } from "../..";
import type { CommandExecutor } from "../../util/commandExecutor";
import { COMMAND_STDIO } from "../../util/commandSpawn";
import {
  setTerminalShellPreference,
  withRealExitCode,
  type ShellKind,
} from "../../util/shell";

/**
 * Phase 0 of the OS sandbox plan: every command the IDE's terminal tool
 * starts goes through `executor.spawn`, with what the old direct
 * `child_process.spawn` was given (the workspace as cwd, the scrubbed
 * environment with colours, no open standard input or the detached
 * background form), and the same results. The executor is replaced here, so
 * these tests read the boundary itself.
 */

const { nodeSpawn, executorBox } = vi.hoisted(() => ({
  nodeSpawn: vi.fn(),
  executorBox: { current: undefined as unknown },
}));

vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, spawn: nodeSpawn },
    spawn: nodeSpawn,
  };
});

vi.mock("../../util/commandExecutor", async (orig) => {
  const actual = await orig<typeof import("../../util/commandExecutor")>();
  return {
    ...actual,
    getCommandExecutor: (
      ...args: Parameters<typeof actual.getCommandExecutor>
    ) =>
      (executorBox.current as CommandExecutor | undefined) ??
      actual.getCommandExecutor(...args),
  };
});

import { fullText } from "../../util/commandOutputBuffer";
import { findCommand } from "../../util/commandOutputStore";
import { refusalText } from "../refusalText";
import { runTerminalCommandImpl } from "./runTerminalCommand";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4321;
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

/** An executor whose spawn records its call and hands back `child`. */
function fakeExecutor(
  child: FakeChild | Error,
  shellKind: ShellKind = "bash",
): {
  executor: CommandExecutor;
  calls: { command: string; options?: SpawnOptions }[];
} {
  const calls: { command: string; options?: SpawnOptions }[] = [];
  const executor: CommandExecutor = {
    kind: "local",
    shell: {
      kind: shellKind,
      executable: shellKind === "powershell" ? "powershell.exe" : "/bin/bash",
      args: (c) => ["-c", c],
      runsProfile: false,
    },
    invocation: (c) => ({ shell: "unused", args: [c] }),
    describe: () => "a fake",
    spawn: async (command, options) => {
      calls.push({ command, options });
      if (child instanceof Error) throw child;
      return child as unknown as ChildProcess;
    },
  };
  return { executor, calls };
}

const workspace = path.resolve("/tmp/executor-workspace");

function extras(overrides: Partial<ToolExtras> = {}): ToolExtras {
  const ide = {
    getIdeInfo: vi.fn().mockResolvedValue({ remoteName: "local" }),
    getWorkspaceDirs: vi
      .fn()
      .mockResolvedValue([pathToFileURL(workspace).href]),
    runCommand: vi.fn(),
  } as unknown as IDE;
  return {
    ide,
    llm: {} as any,
    fetch: vi.fn() as any,
    tool: {} as any,
    config: {} as any,
    onPartialOutput: vi.fn() as any,
    toolCallId: "executor-call",
    ...overrides,
  };
}

/** Lets the asynchronous start finish, so the tool is listening. */
async function started() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  nodeSpawn.mockReset();
  vi.stubEnv("CONTINUE_MISSING_BINARY_CHECK", "off");
  vi.stubEnv("GITHUB_TOKEN", "canary-token");
});

afterEach(() => {
  executorBox.current = undefined;
  setTerminalShellPreference(undefined);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const foregroundOptions = (options?: SpawnOptions) => {
  expect(options?.cwd).toBe(workspace);
  expect(options?.stdio).toEqual(COMMAND_STDIO);
  expect(options?.detached).toBeUndefined();
  const env = options?.env as Record<string, string>;
  // The 2.12.0 scrub, the pager defaults and the colour variables
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.PAGER).toBe("cat");
  expect(env.FORCE_COLOR).toBe("1");
  expect(env.TERM).toBe("xterm-256color");
};

describe("the IDE terminal tool starts commands through the executor", () => {
  it("streaming, waiting: one executor.spawn, output streamed, the exit code named", async () => {
    const child = fakeChild();
    const { executor, calls } = fakeExecutor(child);
    executorBox.current = executor;
    const ex = extras();
    const pending = runTerminalCommandImpl(
      { command: "npm test", waitForCompletion: true },
      ex,
    );
    await started();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("npm test");
    foregroundOptions(calls[0].options);
    child.stdout.emit("data", Buffer.from("1 failed\n"));
    expect(ex.onPartialOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        contextItems: [expect.objectContaining({ content: "1 failed\n" })],
      }),
    );
    child.exitCode = 3;
    child.emit("close", 3);
    const result = await pending;
    expect(result[0].status).toBe("Command failed with exit code 3");
    expect(result[0].content).toBe("1 failed\n");
    expect(nodeSpawn).not.toHaveBeenCalled();
  });

  it("streaming, in the background: resolves at once; its end is kept, not sent into the returned message", async () => {
    const child = fakeChild();
    const { executor, calls } = fakeExecutor(child);
    executorBox.current = executor;
    const ex = extras();
    const result = await runTerminalCommandImpl(
      { command: "npm run dev", waitForCompletion: false },
      ex,
    );
    expect(result[0].status).toBe("Command is running in the background...");
    expect(result[0].content).toMatch(/read_command_output/);
    foregroundOptions(calls[0].options);
    const before = (ex.onPartialOutput as ReturnType<typeof vi.fn>).mock.calls
      .length;
    child.stdout.emit("data", Buffer.from("ready on :3000\n"));
    child.emit("close", 0);
    // The message was already part of the conversation: changing it would
    // break the prompt cache, so nothing more is sent
    expect(
      (ex.onPartialOutput as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(before);
    const record = findCommand(
      (result[0] as { commandOutput?: { id?: string } }).commandOutput!.id!,
    );
    expect(record?.exitCode).toBe(0);
    expect(fullText(record!.capture)).toContain("ready on :3000");
  });

  it("without streaming, waiting: stdout on success, stderr and the code on failure", async () => {
    const ok = fakeChild();
    executorBox.current = fakeExecutor(ok).executor;
    const pendingOk = runTerminalCommandImpl(
      { command: "echo hi", waitForCompletion: true },
      extras({ onPartialOutput: undefined }),
    );
    await started();
    ok.stdout.emit("data", Buffer.from("hi\n"));
    ok.emit("close", 0);
    expect(await pendingOk).toEqual([
      expect.objectContaining({ content: "hi\n", status: "Command completed" }),
    ]);

    const bad = fakeChild();
    const { executor, calls } = fakeExecutor(bad);
    executorBox.current = executor;
    const pendingBad = runTerminalCommandImpl(
      { command: "false", waitForCompletion: true },
      extras({ onPartialOutput: undefined }),
    );
    await started();
    foregroundOptions(calls[0].options);
    bad.stderr.emit("data", Buffer.from("boom"));
    bad.emit("close", 2);
    expect(await pendingBad).toEqual([
      expect.objectContaining({
        content: "boom",
        status: "Command failed with: Command failed with exit code 2",
      }),
    ]);
  });

  it("without streaming, in the background: detached, no streams, unref'd", async () => {
    const child = fakeChild();
    const { executor, calls } = fakeExecutor(child);
    executorBox.current = executor;
    const result = await runTerminalCommandImpl(
      { command: "npm run dev", waitForCompletion: false },
      extras({ onPartialOutput: undefined }),
    );
    expect(result[0].status).toBe("Command is running in the background...");
    const options = calls[0].options!;
    expect(options.cwd).toBe(workspace);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("ignore");
    expect(
      (options.env as Record<string, string>).GITHUB_TOKEN,
    ).toBeUndefined();
    expect(child.unref).toHaveBeenCalled();
  });

  it("asks PowerShell for the real exit code, and leaves bash's command as written", async () => {
    for (const kind of ["powershell", "bash"] as const) {
      const child = fakeChild();
      const { executor, calls } = fakeExecutor(child, kind);
      executorBox.current = executor;
      const pending = runTerminalCommandImpl(
        { command: `node -e "process.exit(3)"`, waitForCompletion: true },
        extras(),
      );
      await started();
      expect(calls[0].command).toBe(
        withRealExitCode(`node -e "process.exit(3)"`, kind, {
          resetFirst: false,
        }),
      );
      if (kind === "bash") {
        expect(calls[0].command).toBe(`node -e "process.exit(3)"`);
      } else {
        expect(calls[0].command).not.toBe(`node -e "process.exit(3)"`);
      }
      child.emit("close", 3);
      await pending;
    }
  });

  it("a shell that cannot start: streaming rejects, non-streaming reports it", async () => {
    const enoent = Object.assign(new Error("spawn /bin/nope ENOENT"), {
      code: "ENOENT",
    });
    executorBox.current = fakeExecutor(enoent).executor;
    await expect(
      runTerminalCommandImpl(
        { command: "ls", waitForCompletion: true },
        extras(),
      ),
    ).rejects.toThrow("ENOENT");
    const result = await runTerminalCommandImpl(
      { command: "ls", waitForCompletion: true },
      extras({ onPartialOutput: undefined }),
    );
    expect(result[0].status).toBe(
      "Command failed with: spawn /bin/nope ENOENT",
    );
  });

  it("an executor that is not available runs nothing", async () => {
    const { executor, calls } = fakeExecutor(fakeChild());
    executorBox.current = { ...executor, unavailable: "WSL is not installed" };
    const result = await runTerminalCommandImpl(
      { command: "ls", waitForCompletion: true },
      extras(),
    );
    expect(result[0].status).toBe("Command not run");
    expect(calls).toHaveLength(0);
  });

  it("a timeout on Windows takes the tree with taskkill /T, and kills the shell itself only when taskkill fails", async () => {
    vi.useFakeTimers();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const killer = new EventEmitter();
      nodeSpawn.mockReturnValue(killer);
      const child = fakeChild();
      executorBox.current = fakeExecutor(child).executor;
      const pending = runTerminalCommandImpl(
        { command: "sleep 999", waitForCompletion: true },
        extras(),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(nodeSpawn).toHaveBeenCalledWith(
        "taskkill",
        ["/pid", "4321", "/T", "/F"],
        expect.objectContaining({ windowsHide: true }),
      );
      // Not before taskkill: it finds the tree through the shell
      expect(child.kill).not.toHaveBeenCalled();
      killer.emit("exit", 1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(nodeSpawn).toHaveBeenCalledTimes(2);
      killer.emit("exit", 1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await pending)[0].status).toBe("Command timed out");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("the container executor mounts the workspace the tool starts in (W28)", () => {
  it("mounts the workspace folder, not the process's own working folder", async () => {
    const actual = await vi.importActual<
      typeof import("../../util/commandExecutor")
    >("../../util/commandExecutor");
    executorBox.current = actual.getCommandExecutor({
      terminalShell: { kind: "container", runtime: "docker" },
      containerStatus: { state: "ready", runtime: "docker" },
    });
    const child = fakeChild();
    nodeSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const pending = runTerminalCommandImpl(
      { command: "ls", waitForCompletion: true },
      extras(),
    );
    await started();
    expect(nodeSpawn).toHaveBeenCalledTimes(1);
    const [program, args, options] = nodeSpawn.mock.calls[0];
    expect(program).toBe("docker");
    const mount = args[args.indexOf("-v") + 1] as string;
    expect(mount.startsWith(`${workspace}:`)).toBe(true);
    expect(process.cwd()).not.toBe(workspace);
    expect(mount.startsWith(`${process.cwd()}:`)).toBe(false);
    expect(options.cwd).toBe(workspace);
    child.emit("close", 0);
    await pending;
  });
});

describe("a remote window with commands set to run somewhere else (PS9)", () => {
  const remote = (remoteName: string) => {
    const ex = extras();
    (ex.ide.getIdeInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      remoteName,
    });
    return ex;
  };

  it("does not type the command into the remote terminal when a container was asked for", async () => {
    setTerminalShellPreference({ kind: "container" });
    const { executor, calls } = fakeExecutor(fakeChild());
    executorBox.current = executor;
    const ex = remote("ssh-remote");
    const result = await runTerminalCommandImpl(
      { command: "npm test", waitForCompletion: true },
      ex,
    );
    expect(result[0].status).toBe("Command not run");
    expect(result[0].content).toBe(
      refusalText.remoteWindowShell({
        remoteName: "ssh-remote",
        preference: "container",
        from: "setting",
      }),
    );
    expect(ex.ide.runCommand).toHaveBeenCalledTimes(0);
    // Nothing was started on this machine either
    expect(calls).toHaveLength(0);
    expect(nodeSpawn).not.toHaveBeenCalled();
  });

  it("refuses for WSL too, and for the choice made in the environment", async () => {
    setTerminalShellPreference({ kind: "wsl", distro: "Ubuntu" });
    const first = remote("dev-container");
    const wsl = await runTerminalCommandImpl({ command: "ls" }, first);
    expect(wsl[0].content).toContain("continuous.terminal.shell is set to wsl");
    expect(first.ide.runCommand).not.toHaveBeenCalled();

    setTerminalShellPreference(undefined);
    vi.stubEnv("CONTINUOUS_TERMINAL_SHELL", "container:podman");
    const second = remote("ssh-remote");
    const env = await runTerminalCommandImpl({ command: "ls" }, second);
    expect(env[0].content).toContain(
      "CONTINUOUS_TERMINAL_SHELL is set to container",
    );
    expect(second.ide.runCommand).not.toHaveBeenCalled();
  });

  it("types the command into the remote terminal as before with the default setting", async () => {
    vi.stubEnv("CONTINUOUS_TERMINAL_SHELL", "");
    const ex = remote("ssh-remote");
    const result = await runTerminalCommandImpl(
      { command: "npm test", waitForCompletion: true },
      ex,
    );
    expect(ex.ide.runCommand).toHaveBeenCalledTimes(1);
    expect(ex.ide.runCommand).toHaveBeenCalledWith("npm test");
    expect(result[0].status).toBe("Command executed");
  });

  it("in a local window the container setting still sends the command to the container executor", async () => {
    setTerminalShellPreference({ kind: "container", runtime: "docker" });
    const actual = await vi.importActual<
      typeof import("../../util/commandExecutor")
    >("../../util/commandExecutor");
    // The executor the setting gives, with the runtime's answer supplied: no
    // container is started, the runtime's program is the mocked spawn
    executorBox.current = actual.getCommandExecutor({
      containerStatus: { state: "ready", runtime: "docker" },
    });
    expect((executorBox.current as CommandExecutor).kind).toBe("container");
    const child = fakeChild();
    nodeSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const ex = extras();
    const pending = runTerminalCommandImpl(
      { command: "ls", waitForCompletion: true },
      ex,
    );
    await started();
    expect(nodeSpawn).toHaveBeenCalledTimes(1);
    expect(nodeSpawn.mock.calls[0][0]).toBe("docker");
    expect(nodeSpawn.mock.calls[0][1].slice(0, 3)).toEqual([
      "run",
      "--rm",
      "-i",
    ]);
    expect(ex.ide.runCommand).not.toHaveBeenCalled();
    child.emit("close", 0);
    expect((await pending)[0].status).not.toBe("Command not run");
  });
});
