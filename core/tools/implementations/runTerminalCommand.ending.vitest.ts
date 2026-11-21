import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDE, ToolExtras } from "../..";
import {
  clearCommandsForTests,
  findCommand,
  setCommandOutputFolderForTests,
} from "../../util/commandOutputStore";
import { terminalEndOf } from "../permissions/audit/terminalEnd";
import { runTerminalCommandImpl } from "./runTerminalCommand";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", () => ({
  default: { spawn: mockSpawn },
  spawn: mockSpawn,
}));

const ESC = "\u001b";

/**
 * How a terminal command ends (its exit code, the signal that ended it, the
 * time limit), and what colour does: the model reads the output without
 * terminal escape sequences, the screen keeps them in commandOutput.display.
 */
describe("runTerminalCommand: how it ends, and colour", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let child: any;
  let folder: string;
  let onPartialOutput: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-ending-"));
    setCommandOutputFolderForTests(folder);
    clearCommandsForTests();

    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    // A signal ends the process with no exit code, as a real one does
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killed = true;
      setTimeout(() => {
        child.signalCode = signal ?? "SIGTERM";
        child.emit("close", null);
      }, 50);
      return true;
    });
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    onPartialOutput = vi.fn();
  });

  afterEach(() => {
    clearCommandsForTests();
    fs.rmSync(folder, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const extras = (): ToolExtras => {
    const ide = {
      getIdeInfo: vi.fn().mockResolvedValue({ remoteName: "local" }),
      getWorkspaceDirs: vi
        .fn()
        .mockResolvedValue(["file:///tmp/test-workspace"]),
    } as unknown as IDE;
    return {
      ide,
      llm: {} as never,
      fetch: vi.fn() as never,
      tool: {} as never,
      config: {} as never,
      onPartialOutput: onPartialOutput as never,
      toolCallId: "call-1",
    };
  };

  /** Runs a command to its end; `finish` acts on the fake child once it is running. */
  async function run(
    finish: () => void | Promise<void>,
    args: Record<string, unknown> = {},
  ) {
    const promise = runTerminalCommandImpl(
      { command: "x", waitForCompletion: true, ...args },
      extras(),
    );
    await vi.advanceTimersByTimeAsync(0);
    await finish();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.runAllTimersAsync();
    return promise;
  }

  const recordOf = (result: Awaited<ReturnType<typeof run>>) =>
    findCommand(result[0].commandOutput!.id!)!;

  describe("how it ends", () => {
    it("a clean exit: code 0, no signal, no time-out", async () => {
      const result = await run(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
      const record = recordOf(result);
      expect(record.exitCode).toBe(0);
      expect(record.signal).toBeUndefined();
      expect(record.timedOut).toBeUndefined();
      expect(terminalEndOf(result)).toEqual({ exit: 0 });
    });

    it("a non-zero exit: the code is recorded, with no signal", async () => {
      const result = await run(() => {
        child.stdout.emit("data", Buffer.from("boom\n"));
        child.exitCode = 3;
        child.emit("close", 3);
      });
      expect(result[0].status).toContain("exit code 3");
      expect(terminalEndOf(result)).toEqual({ exit: 3, error: "boom" });
    });

    it("a command that hits the time limit records SIGTERM and timedOut, and no exit code", async () => {
      const result = await run(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(result[0].status).toBe("Command timed out");
      const record = recordOf(result);
      expect(record.timedOut).toBe(true);
      expect(record.signal).toBe("SIGTERM");
      expect(record.exitCode).toBeNull();
      expect(terminalEndOf(result)).toEqual({
        signal: "SIGTERM",
        timedOut: true,
        error: "timed out",
      });
    });

    it("a command ended by a signal that is not the time limit is not timed out", async () => {
      const result = await run(() => {
        child.signalCode = "SIGKILL";
        child.emit("close", null);
      });
      const record = recordOf(result);
      expect(record.signal).toBe("SIGKILL");
      expect(record.timedOut).toBeUndefined();
      const end = terminalEndOf(result);
      expect(end?.signal).toBe("SIGKILL");
      expect(end?.timedOut).toBeUndefined();
      expect("exit" in (end ?? {})).toBe(false);
    });

    it("the time limit is not applied to a background command", async () => {
      const result = await runTerminalCommandImpl(
        { command: "x", waitForCompletion: false },
        extras(),
      );
      expect(result[0].status).toContain("background");
      child.exitCode = 0;
      child.emit("close", 0);
      await vi.runAllTimersAsync();
      expect(
        findCommand(result[0].commandOutput!.id!)?.timedOut,
      ).toBeUndefined();
    });
  });

  describe("colour", () => {
    const coloured = `${ESC}[31mFAIL${ESC}[0m src/a.test.ts\n${ESC}[32mPASS${ESC}[0m src/b.test.ts\n`;

    it("the model's text has no escape sequences, and the screen's copy keeps them", async () => {
      const result = await run(() => {
        child.stdout.emit("data", Buffer.from(coloured));
        child.exitCode = 0;
        child.emit("close", 0);
      });
      expect(result[0].content).toBe(
        "FAIL src/a.test.ts\nPASS src/b.test.ts\n",
      );
      expect(result[0].content).not.toContain(ESC);
      expect(result[0].commandOutput?.display).toBe(coloured);
    });

    it("a failed command is stripped too, and keeps its colour for the screen", async () => {
      const result = await run(() => {
        child.stderr.emit(
          "data",
          Buffer.from(`${ESC}[31mError:${ESC}[0m nope\n`),
        );
        child.exitCode = 1;
        child.emit("close", 1);
      });
      expect(result[0].content).toBe("Error: nope\n");
      expect(result[0].commandOutput?.display).toContain(`${ESC}[31m`);
      // the audit's error label is the clean last line
      expect(terminalEndOf(result)?.error).toBe("Error: nope");
    });

    it("output with no colour has no display copy: nothing is stored twice", async () => {
      const result = await run(() => {
        child.stdout.emit("data", Buffer.from("plain output\n"));
        child.exitCode = 0;
        child.emit("close", 0);
      });
      expect(result[0].content).toBe("plain output\n");
      expect(result[0].commandOutput).not.toHaveProperty("display");
    });

    it("the live view keeps colour for the screen while the saved text stays plain", async () => {
      const promise = runTerminalCommandImpl(
        { command: "x", waitForCompletion: true },
        extras(),
      );
      await vi.advanceTimersByTimeAsync(0);
      child.stdout.emit("data", Buffer.from(`${ESC}[33mworking${ESC}[0m\n`));
      await vi.advanceTimersByTimeAsync(2_000);
      const live = onPartialOutput.mock.calls
        .map((c) => c[0]?.contextItems?.[0])
        .filter(Boolean);
      expect(live.length).toBeGreaterThan(0);
      const last = live[live.length - 1];
      // what is saved with the session and read by the model: no escapes
      expect(last.content).not.toContain(ESC);
      expect(last.content).toContain("working");
      // what the chat draws: the colours
      expect(last.commandOutput.display).toContain(`${ESC}[33m`);
      child.exitCode = 0;
      child.emit("close", 0);
      await vi.runAllTimersAsync();
      const done = await promise;
      expect(done[0].content).toBe("working\n");
    });

    it("a sequence split across two chunks is still removed", async () => {
      const result = await run(() => {
        child.stdout.emit("data", Buffer.from(`before ${ESC}[3`));
        child.stdout.emit("data", Buffer.from(`1mred${ESC}[0m after\n`));
        child.exitCode = 0;
        child.emit("close", 0);
      });
      expect(result[0].content).toBe("before red after\n");
    });

    it("the saved file keeps the raw output", async () => {
      const result = await run(() => {
        child.stdout.emit("data", Buffer.from(coloured));
        child.exitCode = 0;
        child.emit("close", 0);
      });
      const file = recordOf(result).outputPath;
      if (file) {
        // written when the output is large; a small one stays in memory
        expect(fs.readFileSync(file, "utf8")).toContain(ESC);
      }
    });
  });
});
