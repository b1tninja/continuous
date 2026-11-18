import type { ChildProcess, SpawnOptions } from "child_process";
import { EventEmitter } from "events";

import type { CommandExecutor } from "core/util/commandExecutor.js";
import { COMMAND_STDIO } from "core/util/commandSpawn.js";
import { withRealExitCode, type ShellKind } from "core/util/shell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 0 of the OS sandbox plan: the CLI's Bash tool and its background jobs
 * start commands through `executor.spawn`, with what the old direct
 * `child_process.spawn` was given (the scrubbed environment, no open standard
 * input, the process's own cwd), and give the same results.
 */

const { nodeSpawn, executorBox } = vi.hoisted(() => ({
  nodeSpawn: vi.fn(),
  executorBox: { current: undefined as unknown },
}));

vi.mock("child_process", async (orig) => {
  const actual = await orig<typeof import("child_process")>();
  return { ...actual, spawn: nodeSpawn };
});

vi.mock("core/util/commandExecutor.js", async (orig) => {
  const actual = await orig<typeof import("core/util/commandExecutor.js")>();
  return {
    ...actual,
    getCommandExecutor: (
      ...args: Parameters<typeof actual.getCommandExecutor>
    ) =>
      (executorBox.current as CommandExecutor | undefined) ??
      actual.getCommandExecutor(...args),
  };
});

import {
  BackgroundJobService,
  backgroundJobService,
} from "../services/BackgroundJobService.js";
import { backgroundSignalManager } from "../util/backgroundSignalManager.js";

import {
  runCommandInBackground,
  runTerminalCommandTool,
} from "./runTerminalCommand.js";

type FakeChild = EventEmitter & {
  stdout: EventEmitter & { setEncoding: () => void; resume: () => void };
  stderr: EventEmitter & { setEncoding: () => void; resume: () => void };
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const stream = () =>
    Object.assign(new EventEmitter(), {
      setEncoding: () => {},
      resume: () => {},
    });
  const child = new EventEmitter() as FakeChild;
  child.stdout = stream();
  child.stderr = stream();
  child.kill = vi.fn(() => true);
  return child;
}

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
      args: (c: string) => ["-c", c],
      runsProfile: false,
    },
    invocation: (c: string) => ({ shell: "unused", args: [c] }),
    describe: () => "a fake",
    spawn: async (command, options) => {
      calls.push({ command, options });
      if (child instanceof Error) throw child;
      return child as unknown as ChildProcess;
    },
  };
  return { executor, calls };
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
  vi.unstubAllEnvs();
  vi.useRealTimers();
  backgroundJobService.killAllJobs();
});

const commandOptions = (options?: SpawnOptions) => {
  expect(options?.stdio).toEqual(COMMAND_STDIO);
  // The command starts where cn does, as before
  expect(options?.cwd).toBeUndefined();
  const env = options?.env as Record<string, string>;
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.PAGER).toBe("cat");
};

describe("the CLI Bash tool starts commands through the executor", () => {
  it("one executor.spawn; output and success as before", async () => {
    const child = fakeChild();
    const { executor, calls } = fakeExecutor(child);
    executorBox.current = executor;
    const pending = runTerminalCommandTool.run({ command: "echo hi" });
    await started();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("echo hi");
    commandOptions(calls[0].options);
    child.stdout.emit("data", Buffer.from("hi\n"));
    child.emit("close", 0);
    await expect(pending).resolves.toBe("hi\n");
    expect(nodeSpawn).not.toHaveBeenCalled();
  });

  it("a failure with stderr rejects with the program's own code", async () => {
    const child = fakeChild();
    executorBox.current = fakeExecutor(child).executor;
    const pending = runTerminalCommandTool.run({ command: "npm test" });
    await started();
    child.stderr.emit("data", Buffer.from("boom"));
    child.emit("close", 3);
    await expect(pending).rejects.toBe("Error (exit code 3): boom");
  });

  it("asks PowerShell for the real exit code, and leaves bash's command as written", async () => {
    for (const kind of ["powershell", "bash"] as const) {
      const child = fakeChild();
      const { executor, calls } = fakeExecutor(child, kind);
      executorBox.current = executor;
      const command = `node -e "process.exit(3)"`;
      const pending = runTerminalCommandTool.run({ command });
      await started();
      expect(calls[0].command).toBe(
        withRealExitCode(command, kind, { resetFirst: false }),
      );
      expect(calls[0].command === command).toBe(kind === "bash");
      child.emit("close", 0);
      await pending;
    }
  });

  it("a shell that cannot start is reported as its error event was", async () => {
    executorBox.current = fakeExecutor(
      new Error("spawn /bin/nope ENOENT"),
    ).executor;
    await expect(runTerminalCommandTool.run({ command: "ls" })).rejects.toBe(
      "Error: spawn /bin/nope ENOENT",
    );
  });

  it("an executor that is not available runs nothing", async () => {
    const { executor, calls } = fakeExecutor(fakeChild());
    executorBox.current = { ...executor, unavailable: "WSL is not installed" };
    await expect(runTerminalCommandTool.run({ command: "ls" })).resolves.toBe(
      "WSL is not installed",
    );
    expect(calls).toHaveLength(0);
  });

  it("a command silent past its timeout is killed and the timeout named", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    executorBox.current = fakeExecutor(child).executor;
    const pending = runTerminalCommandTool.run({
      command: "sleep 99",
      timeout: 2,
    });
    await started();
    child.stdout.emit("data", Buffer.from("tick\n"));
    // Output restarts the clock
    await vi.advanceTimersByTimeAsync(1_500);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(child.kill).toHaveBeenCalled();
    await expect(pending).resolves.toContain(
      "[Command timed out after 2 seconds of no output]",
    );
  });

  it("moving a running command to the background hands its process to a job", async () => {
    const child = fakeChild();
    executorBox.current = fakeExecutor(child).executor;
    const pending = runTerminalCommandTool.run({ command: "npm run dev" });
    await started();
    child.stdout.emit("data", Buffer.from("listening\n"));
    backgroundSignalManager.signalBackground();
    const text = await pending;
    const id = /Job ID: (\S+)/.exec(text)![1];
    const job = backgroundJobService.getJob(id)!;
    expect(job.status).toBe("running");
    expect(job.output).toBe("listening\n");
    child.stdout.emit("data", "more\n");
    child.emit("close", 0);
    expect(job.output).toBe("listening\nmore\n");
    expect(job.status).toBe("completed");
  });
});

describe("background jobs start through the executor", () => {
  it("runs the job's command with the scrubbed environment and records its life", async () => {
    const child = fakeChild();
    const { executor, calls } = fakeExecutor(child);
    executorBox.current = executor;
    const service = new BackgroundJobService();
    const job = service.createJob("npm run watch")!;
    expect(job.status).toBe("pending");
    expect(await service.startJob(job.id)).toBe(child);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("npm run watch");
    commandOptions(calls[0].options);
    expect(job.status).toBe("running");
    child.stdout.emit("data", "built\n");
    child.stderr.emit("data", "warn\n");
    child.emit("close", 2);
    expect(job).toMatchObject({
      status: "failed",
      exitCode: 2,
      output: "built\nwarn\n",
    });
    expect(nodeSpawn).not.toHaveBeenCalled();
  });

  it("completes on 0, cancels with a kill, and fails when the shell cannot start", async () => {
    const service = new BackgroundJobService();
    const ok = fakeChild();
    executorBox.current = fakeExecutor(ok).executor;
    const a = service.createJob("true")!;
    await service.startJob(a.id);
    ok.emit("close", 0);
    expect(a).toMatchObject({ status: "completed", exitCode: 0 });

    const long = fakeChild();
    executorBox.current = fakeExecutor(long).executor;
    const b = service.createJob("sleep 99")!;
    await service.startJob(b.id);
    expect(service.cancelJob(b.id)).toBe(true);
    expect(long.kill).toHaveBeenCalled();
    long.emit("close", null);
    expect(b.status).toBe("cancelled");

    executorBox.current = fakeExecutor(
      new Error("spawn /bin/nope ENOENT"),
    ).executor;
    const c = service.createJob("ls")!;
    expect(await service.startJob(c.id)).toBeNull();
    expect(c).toMatchObject({
      status: "failed",
      error: "spawn /bin/nope ENOENT",
    });
  });

  it("runCommandInBackground starts a job through the executor", async () => {
    const child = fakeChild();
    const { executor, calls } = fakeExecutor(child, "powershell");
    executorBox.current = executor;
    const started = await runCommandInBackground("npm run dev");
    expect(started.success).toBe(true);
    expect(calls[0].command).toBe(
      withRealExitCode("npm run dev", "powershell", { resetFirst: false }),
    );
    expect(backgroundJobService.getJob(started.jobId!)?.status).toBe("running");
  });
});
