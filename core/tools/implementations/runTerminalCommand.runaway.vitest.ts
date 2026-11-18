import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDE, ToolExtras } from "../..";
import { clearCommandsForTests } from "../../util/commandOutputStore";
import { runTerminalCommandImpl, VIEW_UPDATE_MS } from "./runTerminalCommand";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({
  default: { spawn: mockSpawn },
  spawn: mockSpawn,
}));

/**
 * A command whose output looks like a runaway (plans/research/
 * runaway-command-output.md): a flood or a loop is stopped, unless the Tools
 * level lets it run; the chat gets a throttled window, never the whole output.
 */
describe("runTerminalCommand: runaway output", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let child: any;
  let onPartialOutput: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    clearCommandsForTests();
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.destroy = vi.fn();
    child.stderr.destroy = vi.fn();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killed = true;
      setTimeout(() => {
        child.exitCode = 143;
        child.signalCode = signal ?? null;
        child.emit("close", 143);
      }, 10);
      return true;
    });
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    onPartialOutput = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearCommandsForTests();
  });

  const extras = (overrides: Partial<ToolExtras> = {}): ToolExtras =>
    ({
      ide: {
        getIdeInfo: vi.fn().mockResolvedValue({ remoteName: "local" }),
        getWorkspaceDirs: vi
          .fn()
          .mockResolvedValue(["file:///tmp/test-workspace"]),
      } as unknown as IDE,
      llm: {} as never,
      fetch: vi.fn() as never,
      tool: {} as never,
      config: {} as never,
      onPartialOutput: onPartialOutput as never,
      toolCallId: "call-runaway",
      ...overrides,
    }) as ToolExtras;

  const emit = (text: string) => child.stdout.emit("data", Buffer.from(text));

  it("stops a command that prints the same line over and over, and says why", async () => {
    const pending = runTerminalCommandImpl(
      { command: "node retry.js", waitForCompletion: true },
      extras(),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 1_200; i++) emit("connection refused, retrying\n");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    const [item] = await pending;
    expect(item.status).toBe(
      "Command stopped: its output looked like a runaway",
    );
    expect(item.content).toMatch(/^\[Stopped by Continuous: .*same line/);
    // The repeated line is shown once with a count, not 1,000 times
    expect(item.content).toMatch(/repeated \d+ more times/);
    expect(item.content.length).toBeLessThan(12_000);
  });

  it("lets it run at Permissive or IDGAF (keep-running)", async () => {
    const pending = runTerminalCommandImpl(
      { command: "node retry.js", waitForCompletion: true },
      extras({ runawayAction: "keep-running" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 1_200; i++) emit("connection refused, retrying\n");
    expect(child.kill).not.toHaveBeenCalled();
    child.exitCode = 0;
    child.emit("close", 0);
    const [item] = await pending;
    expect(item.status).toBe("Command completed");
  });

  it("stops a flood: more than the total a command may print", async () => {
    const pending = runTerminalCommandImpl(
      { command: "cat /dev/urandom", waitForCompletion: true },
      extras(),
    );
    await vi.advanceTimersByTimeAsync(0);
    // 100 MB in 1 MiB chunks of varied lines, all within one second
    const chunk = Buffer.alloc(1024 * 1024, "abcdefghij\n");
    for (let i = 0; i < 100 && !child.killed; i++) {
      child.stdout.emit("data", chunk);
    }
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    const [item] = await pending;
    expect(item.content).toMatch(/Stopped by Continuous: the command printed/);
    expect(item.content.length).toBeLessThan(40_000);
  }, 30_000);

  it("sends the chat at most one window per interval, never the whole output", async () => {
    const pending = runTerminalCommandImpl(
      { command: "npm test", waitForCompletion: true },
      extras(),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 2_000; i++) emit(`test ${i} passed\n`);
    // One leading update, the rest coalesced behind the throttle
    expect(onPartialOutput.mock.calls.length).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(VIEW_UPDATE_MS);
    const last = onPartialOutput.mock.calls.at(-1)![0].contextItems[0];
    expect(last.content).toContain("test 1999 passed");
    expect(last.content).not.toContain("test 0 passed\n");
    expect(last.commandOutput.lines).toBe(2_000);
    child.exitCode = 0;
    child.emit("close", 0);
    await pending;
  });

  it("gives the model a cut with a note when the output is long", async () => {
    const pending = runTerminalCommandImpl(
      { command: "npm run build", waitForCompletion: true },
      extras(),
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5_000; i++) emit(`compiled module ${i}\n`);
    child.exitCode = 0;
    child.emit("close", 0);
    const [item] = await pending;
    expect(item.status).toBe("Command completed");
    expect(item.content).toMatch(/^\[Output cut: /);
    expect(item.content).toContain("compiled module 0");
    expect(item.content).toContain("compiled module 4999");
    expect(item.content.length).toBeLessThanOrEqual(31_000);
  });
});
