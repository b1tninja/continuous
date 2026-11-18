import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_OUTPUT_LIMITS, RunawayReason } from "./commandOutputBuffer";
import {
  clearCommandsForTests,
  findCommand,
  finishCommand,
  listCommands,
  recordOutput,
  registerCommand,
  setCommandOutputFolderForTests,
} from "./commandOutputStore";
import {
  readCommandOutputImpl,
  stopCommandImpl,
} from "../tools/implementations/commandOutputTools";

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-output-"));
  setCommandOutputFolderForTests(folder);
  clearCommandsForTests();
});

afterEach(() => {
  clearCommandsForTests();
  fs.rmSync(folder, { recursive: true, force: true });
});

/** Waits for queued file writes to reach the disk. */
const flushed = () => new Promise((r) => setTimeout(r, 50));

describe("the command store", () => {
  it("gives each command a short id, found by it or by its tool call", () => {
    const a = registerCommand({ toolCallId: "call_a", command: "ls" });
    const b = registerCommand({ toolCallId: "call_b", command: "pwd" });
    expect(a.id).toBe("cmd-1");
    expect(b.id).toBe("cmd-2");
    expect(findCommand("cmd-2")).toBe(b);
    expect(findCommand("call_a")).toBe(a);
    expect(findCommand("nope")).toBeUndefined();
  });

  it("writes no file while the output is small", () => {
    const r = registerCommand({ toolCallId: "t", command: "echo hi" });
    recordOutput(r, "hi\n", 3);
    finishCommand(r, 0);
    expect(r.outputPath).toBeUndefined();
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it("past the model's share, writes everything so far and then each chunk", async () => {
    const r = registerCommand({ toolCallId: "t", command: "build" });
    const first = "start\n";
    recordOutput(r, first, first.length);
    const big = "x".repeat(DEFAULT_OUTPUT_LIMITS.modelFailureChars + 10);
    recordOutput(r, big, big.length);
    recordOutput(r, "\nthe end\n", 9);
    finishCommand(r, 0);
    await flushed();
    expect(r.outputPath).toBeDefined();
    expect(fs.readFileSync(r.outputPath!, "utf8")).toBe(
      first + big + "\nthe end\n",
    );
    expect(r.fileBytes).toBe(first.length + big.length + 9);
  });

  it("stops the file at its cap and marks the command as a runaway", async () => {
    const limits = {
      ...DEFAULT_OUTPUT_LIMITS,
      modelFailureChars: 10,
      fileCapBytes: 100,
    };
    const r = registerCommand({ toolCallId: "t", command: "spam", limits });
    for (let i = 0; i < 20; i++) recordOutput(r, "0123456789", 10);
    await flushed();
    expect(r.capture.runaway).toBe(RunawayReason.FileCap);
    expect(r.fileBytes).toBeLessThanOrEqual(100);
    expect(fs.statSync(r.outputPath!).size).toBeLessThanOrEqual(100);
  });

  it("keeps finished commands for a while, then lets the oldest go", () => {
    for (let i = 0; i < 60; i++) {
      const r = registerCommand({ toolCallId: `t${i}`, command: "true" });
      finishCommand(r, 0);
    }
    expect(listCommands().length).toBeLessThanOrEqual(50);
    expect(findCommand("t59")).toBeDefined();
    expect(findCommand("t0")).toBeUndefined();
  });

  it("deletes week-old files when the folder is first used", () => {
    const old = path.join(folder, "old.log");
    fs.writeFileSync(old, "stale");
    const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, weekAgo, weekAgo);
    setCommandOutputFolderForTests(folder);
    const r = registerCommand({ toolCallId: "t", command: "big" });
    const big = "y".repeat(DEFAULT_OUTPUT_LIMITS.modelFailureChars + 1);
    recordOutput(r, big, big.length);
    finishCommand(r, 0);
    expect(fs.existsSync(old)).toBe(false);
  });
});

describe("read_command_output", () => {
  it("returns the last lines of the newest command when no id is given", async () => {
    const r = registerCommand({ toolCallId: "t", command: "make" });
    recordOutput(r, "one\ntwo\nthree\n", 14);
    finishCommand(r, 0);
    const [item] = await readCommandOutputImpl({ lines: 2 }, {} as never);
    expect(item.content).toContain("cmd-1: `make` finished");
    expect(item.content).toMatch(/two\nthree/);
    expect(item.content).not.toMatch(/one\n/);
    expect(item.status).toBe("Finished");
  });

  it("finds lines by pattern, with their numbers, in the full output file", async () => {
    const r = registerCommand({ toolCallId: "t", command: "test" });
    const lines = Array.from({ length: 3000 }, (_, i) =>
      i === 1234 ? "FAIL src/auth.test.ts" : `ok ${i}`,
    ).join("\n");
    recordOutput(r, lines, lines.length);
    finishCommand(r, 1);
    await flushed();
    const [item] = await readCommandOutputImpl(
      { id: "cmd-1", grep: "fail" },
      {} as never,
    );
    expect(item.content).toContain("1235: FAIL src/auth.test.ts");
    expect(item.content).toContain("exited with code 1");
    expect(item.content).toContain(r.outputPath!);
  });

  it("says when nothing matches, and when a pattern is not valid", async () => {
    const r = registerCommand({ toolCallId: "t", command: "ls" });
    recordOutput(r, "a\nb\n", 4);
    finishCommand(r, 0);
    const [none] = await readCommandOutputImpl({ grep: "zzz" }, {} as never);
    expect(none.content).toContain("[no line matches]");
    const [bad] = await readCommandOutputImpl({ grep: "(" }, {} as never);
    expect(bad.status).toBe("Invalid pattern");
  });

  it("names the known ids when the one asked for is not there", async () => {
    registerCommand({ toolCallId: "t", command: "ls" });
    const [item] = await readCommandOutputImpl({ id: "cmd-9" }, {} as never);
    expect(item.status).toBe("Not found");
    expect(item.content).toContain("Known: cmd-1");
  });

  it("caps how many lines it returns", async () => {
    const r = registerCommand({ toolCallId: "t", command: "seq" });
    const many = Array.from({ length: 5000 }, (_, i) => `${i}`).join("\n");
    recordOutput(r, many, many.length);
    finishCommand(r, 0);
    await flushed();
    const [item] = await readCommandOutputImpl({ lines: 100_000 }, {} as never);
    expect(item.content.split("\n").length).toBeLessThanOrEqual(1_002);
  });
});

/** A running command that ends when killed. */
function fakeProcess() {
  const child = new EventEmitter() as EventEmitter & {
    kill: (signal?: string) => boolean;
    killed: boolean;
    pid?: number;
  };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setTimeout(() => child.emit("close", 143), 5);
    return true;
  };
  return child;
}

describe("stop_command", () => {
  it("ends a running command and returns its last lines", async () => {
    const child = fakeProcess();
    const r = registerCommand({
      toolCallId: "t",
      command: "npm run dev",
      process: child as never,
      background: true,
    });
    recordOutput(r, "ready on :3000\n", 15);
    child.on("close", (code: number) => finishCommand(r, code));
    const [item] = await stopCommandImpl({ id: "cmd-1" }, {} as never);
    expect(child.killed).toBe(true);
    expect(item.status).toBe("Stopped");
    expect(item.content).toContain("ready on :3000");
    expect(r.stoppedFor).toBe("stopped");
  });

  it("says so for a command that has already ended", async () => {
    const r = registerCommand({ toolCallId: "t", command: "ls" });
    finishCommand(r, 0);
    const [item] = await stopCommandImpl({ id: "cmd-1" }, {} as never);
    expect(item.status).toBe("Not running");
  });
});
