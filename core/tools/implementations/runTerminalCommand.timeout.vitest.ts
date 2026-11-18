import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDE, ToolExtras } from "../..";
import { runTerminalCommandImpl } from "./runTerminalCommand";

// Hoist mock function so it can be referenced in vi.mock factory
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  default: {
    spawn: mockSpawn,
  },
  spawn: mockSpawn,
}));

describe("runTerminalCommand timeout functionality", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockChildProc: any;
  let mockGetIdeInfo: ReturnType<typeof vi.fn>;
  let mockGetWorkspaceDirs: ReturnType<typeof vi.fn>;
  let mockOnPartialOutput: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setTimeoutSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clearTimeoutSpy: any;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.clearAllTimers();
    vi.useFakeTimers();

    // Spy on setTimeout and clearTimeout
    setTimeoutSpy = vi.spyOn(global, "setTimeout");
    clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    // Create mock child process with EventEmitter behavior
    mockChildProc = new EventEmitter();
    mockChildProc.stdout = new EventEmitter();
    mockChildProc.stderr = new EventEmitter();
    // Use exitCode/signalCode to track process state (matches Node.js ChildProcess API)
    mockChildProc.exitCode = null;
    mockChildProc.signalCode = null;
    mockChildProc.killed = false;
    mockChildProc.kill = vi.fn((signal?: NodeJS.Signals) => {
      mockChildProc.killed = true;
      setTimeout(() => {
        mockChildProc.exitCode = signal === "SIGKILL" ? 137 : 143;
        mockChildProc.signalCode = signal ?? null;
        mockChildProc.emit("close", mockChildProc.exitCode);
      }, 100);
      return true;
    });

    // Reports that it started, as a real process does: the executor waits for it
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => mockChildProc.emit("spawn"));
      return mockChildProc;
    });

    mockGetIdeInfo = vi.fn().mockResolvedValue({ remoteName: "local" });
    mockGetWorkspaceDirs = vi
      .fn()
      .mockResolvedValue(["file:///tmp/test-workspace"]);
    mockOnPartialOutput = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const createMockExtras = (
    overrides: Partial<ToolExtras> = {},
  ): ToolExtras => {
    const mockIde = {
      getIdeInfo: mockGetIdeInfo,
      getWorkspaceDirs: mockGetWorkspaceDirs,
      getIdeSettings: vi.fn(),
      getDiff: vi.fn(),
      readFile: vi.fn(),
      readRangeInFile: vi.fn(),
      isTelemetryEnabled: vi.fn(),
      getProblems: vi.fn(),
      subprocess: vi.fn(),
      getWorkspaceConfigs: vi.fn(),
      showToast: vi.fn(),
      listWorkspaceContents: vi.fn(),
      getTerminalContents: vi.fn(),
      listFolders: vi.fn(),
      getSessionId: vi.fn(),
      runCommand: vi.fn(),
      showLines: vi.fn(),
      saveFile: vi.fn(),
      getBranch: vi.fn(),
      showDiff: vi.fn(),
      getOpenFiles: vi.fn(),
      showVirtualFile: vi.fn(),
      openFile: vi.fn(),
      getRepo: vi.fn(),
      pathSep: vi.fn(),
      fileExists: vi.fn(),
    } as unknown as IDE;

    return {
      ide: mockIde,
      llm: {} as any,
      fetch: vi.fn() as any,
      tool: {} as any,
      config: {} as any,
      onPartialOutput: mockOnPartialOutput as any,
      toolCallId: "test-tool-call-id",
      ...overrides,
    };
  };

  it("should set up timeout when waitForCompletion is true", async () => {
    const extras = createMockExtras();
    const args = { command: "echo test", waitForCompletion: true };
    const resultPromise = runTerminalCommandImpl(args, extras);
    await vi.runOnlyPendingTimersAsync();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
    mockChildProc.exitCode = 0;
    mockChildProc.emit("close", 0);
    await resultPromise;
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("should NOT set up timeout when waitForCompletion is false", async () => {
    const extras = createMockExtras();
    const args = { command: "sleep 10", waitForCompletion: false };
    const result = await runTerminalCommandImpl(args, extras);
    const timeoutCalls = setTimeoutSpy.mock.calls.filter(
      (call: any[]) => call[1] === 120_000,
    );
    expect(timeoutCalls.length).toBe(0);
    expect(result[0].status).toContain("background");
  });

  it("should kill process when timeout fires (streaming)", async () => {
    const extras = createMockExtras();
    const args = { command: "sleep 300", waitForCompletion: true };
    const resultPromise = runTerminalCommandImpl(args, extras);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockChildProc.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result[0].content).toContain(
      "[Timeout: process killed after 2 minutes]",
    );
  });

  it("should clear timeout on normal process exit", async () => {
    const extras = createMockExtras();
    const args = { command: "echo quick", waitForCompletion: true };
    const resultPromise = runTerminalCommandImpl(args, extras);
    // Flush async setup (getIdeInfo, getWorkspaceDirs) without advancing timer time
    await vi.advanceTimersByTimeAsync(0);
    mockChildProc.stdout.emit("data", Buffer.from("quick\n"));
    mockChildProc.exitCode = 0;
    mockChildProc.emit("close", 0);
    await resultPromise;
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(mockChildProc.kill).not.toHaveBeenCalled();
  });

  it("should clear SIGKILL timeout when process exits between SIGTERM and SIGKILL grace period", async () => {
    const extras = createMockExtras();
    const args = { command: "sleep 300", waitForCompletion: true };
    const resultPromise = runTerminalCommandImpl(args, extras);

    // Let initial setup complete
    await vi.runOnlyPendingTimersAsync();

    // Advance to trigger main timeout (120s) — SIGTERM sent, SIGKILL timer started
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockChildProc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mockChildProc.kill).toHaveBeenCalledTimes(1);

    // Process exits gracefully after 2 seconds (before 5s grace period)
    await vi.advanceTimersByTimeAsync(2_000);
    mockChildProc.exitCode = 143;
    mockChildProc.signalCode = "SIGTERM";
    mockChildProc.emit("close", 143); // SIGTERM exit code

    // Wait for promise to resolve
    await resultPromise;

    // Advance past the SIGKILL grace period (3 more seconds)
    await vi.advanceTimersByTimeAsync(3_000);

    // Verify SIGKILL was NOT called (timer was cleared)
    expect(mockChildProc.kill).toHaveBeenCalledTimes(1); // Only SIGTERM
    expect(mockChildProc.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  describe("a child that keeps the pipes open", () => {
    /** A shell that dies on kill while something it started holds its pipes. */
    const pipesStayOpen = () => {
      mockChildProc.kill = vi.fn((signal?: NodeJS.Signals) => {
        mockChildProc.killed = true;
        mockChildProc.exitCode = null;
        mockChildProc.signalCode = null;
        return signal ? true : true;
      });
      mockChildProc.stdout.destroy = vi.fn();
      mockChildProc.stderr.destroy = vi.fn();
    };

    it("finishes the call as timed out instead of staying running (streaming)", async () => {
      pipesStayOpen();
      const extras = createMockExtras();
      let settled = false;
      const resultPromise = runTerminalCommandImpl(
        { command: "pytest | tail -45", waitForCompletion: true },
        extras,
      ).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockChildProc.kill).toHaveBeenCalledWith("SIGTERM");
      // Killed, but no close event ever comes
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockChildProc.kill).toHaveBeenCalledWith("SIGKILL");
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await resultPromise;
      expect(settled).toBe(true);
      expect(result[0].status).toBe("Command timed out");
      expect(result[0].content).toContain(
        "[Timeout: process killed after 2 minutes]",
      );
      // The streams were let go, so nothing keeps listening to the child
      expect(mockChildProc.stdout.destroy).toHaveBeenCalled();
      expect(mockChildProc.stderr.destroy).toHaveBeenCalled();
    });

    it("a late close after the forced finish changes nothing", async () => {
      pipesStayOpen();
      const resultPromise = runTerminalCommandImpl(
        { command: "pytest", waitForCompletion: true },
        createMockExtras(),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(128_000);
      const result = await resultPromise;
      mockChildProc.emit("close", 143);
      expect(result[0].status).toBe("Command timed out");
    });

    it("finishes a timed-out call without streaming too, naming the timeout", async () => {
      pipesStayOpen();
      const finished = runTerminalCommandImpl(
        { command: "pytest", waitForCompletion: true },
        createMockExtras({ onPartialOutput: undefined }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(128_000);
      const result = await finished;
      expect(result[0].content).toContain("[Timeout:");
    });

    it("finishes shortly after the shell exits even if the pipes never close", async () => {
      const resultPromise = runTerminalCommandImpl(
        { command: "start-server", waitForCompletion: true },
        createMockExtras(),
      );
      await vi.advanceTimersByTimeAsync(0);
      mockChildProc.stdout.destroy = vi.fn();
      mockChildProc.stderr.destroy = vi.fn();
      mockChildProc.stdout.emit("data", Buffer.from("listening\n"));
      mockChildProc.exitCode = 0;
      mockChildProc.emit("exit", 0);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await resultPromise;
      expect(result[0].content).toContain("listening");
      expect(result[0].status).toBe("Command completed");
    });

    it("a normal close right after exit does not wait for the grace period", async () => {
      const resultPromise = runTerminalCommandImpl(
        { command: "echo hi", waitForCompletion: true },
        createMockExtras(),
      );
      await vi.advanceTimersByTimeAsync(0);
      mockChildProc.stdout.emit("data", Buffer.from("hi\n"));
      mockChildProc.exitCode = 0;
      mockChildProc.emit("exit", 0);
      mockChildProc.emit("close", 0);
      const result = await resultPromise;
      expect(result[0].content).toContain("hi");
    });
  });
});
