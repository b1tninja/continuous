import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearCommandsForTests,
  finishCommand,
  recordOutput,
  registerCommand,
  setCommandOutputFolderForTests,
  waitForEnd,
} from "./commandOutputStore";
import {
  clampWaitSeconds,
  MAX_WAIT_SECONDS,
  readCommandOutputImpl,
} from "../tools/implementations/commandOutputTools";
import { readCommandOutputTool } from "../tools/definitions/commandOutput";

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-wait-"));
  setCommandOutputFolderForTests(folder);
  clearCommandsForTests();
});

afterEach(() => {
  clearCommandsForTests();
  fs.rmSync(folder, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (out: Awaited<ReturnType<typeof readCommandOutputImpl>>) =>
  out.map((i) => i.content).join("\n");

describe("waitForEnd", () => {
  it("resolves true at once for a command that has ended", async () => {
    const r = registerCommand({ toolCallId: "t1", command: "x" });
    finishCommand(r, 0);
    const started = Date.now();
    expect(await waitForEnd(r, 5_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("resolves true as soon as the command ends, not when the time is up", async () => {
    const r = registerCommand({ toolCallId: "t2", command: "x" });
    const started = Date.now();
    const waiting = waitForEnd(r, 10_000);
    setTimeout(() => finishCommand(r, 0), 60);
    expect(await waiting).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("resolves false when the time runs out first", async () => {
    const r = registerCommand({ toolCallId: "t3", command: "x" });
    const started = Date.now();
    expect(await waitForEnd(r, 80)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(r.endedAt).toBeUndefined();
  });

  it("does not wait at all for zero, negative or invalid times", async () => {
    const r = registerCommand({ toolCallId: "t4", command: "x" });
    for (const ms of [0, -5, Number.NaN]) {
      const started = Date.now();
      expect(await waitForEnd(r, ms), String(ms)).toBe(false);
      expect(Date.now() - started).toBeLessThan(200);
    }
  });

  it("answers every waiter when the command ends", async () => {
    const r = registerCommand({ toolCallId: "t5", command: "x" });
    const all = Promise.all([
      waitForEnd(r, 5_000),
      waitForEnd(r, 5_000),
      waitForEnd(r, 5_000),
    ]);
    setTimeout(() => finishCommand(r, 1), 30);
    expect(await all).toEqual([true, true, true]);
  });

  it("a waiter that timed out is not woken later, and does not block the others", async () => {
    const r = registerCommand({ toolCallId: "t6", command: "x" });
    const short = waitForEnd(r, 40);
    const long = waitForEnd(r, 5_000);
    expect(await short).toBe(false);
    finishCommand(r, 0);
    expect(await long).toBe(true);
    // ending again must not throw or wake anything stale
    finishCommand(r, 0);
  });

  it("a command that ends twice keeps its first end time", async () => {
    const r = registerCommand({ toolCallId: "t7", command: "x" });
    finishCommand(r, 0, 1000);
    finishCommand(r, 3, 2000);
    expect(r.endedAt).toBe(1000);
    expect(await waitForEnd(r, 10)).toBe(true);
  });
});

describe("clampWaitSeconds", () => {
  it("is zero for anything that is not a positive number", () => {
    for (const v of [
      undefined,
      null,
      0,
      -1,
      "abc",
      NaN,
      Infinity,
      {},
      [],
      true,
      "",
    ]) {
      expect(clampWaitSeconds(v), String(v)).toBe(0);
    }
  });

  it("is a whole number of seconds, at most the maximum", () => {
    expect(clampWaitSeconds(1)).toBe(1);
    expect(clampWaitSeconds(2.9)).toBe(2);
    expect(clampWaitSeconds("5")).toBe(5);
    expect(clampWaitSeconds(MAX_WAIT_SECONDS)).toBe(MAX_WAIT_SECONDS);
    expect(clampWaitSeconds(MAX_WAIT_SECONDS + 1)).toBe(MAX_WAIT_SECONDS);
    expect(clampWaitSeconds(100_000)).toBe(MAX_WAIT_SECONDS);
  });

  it("the maximum stays below the 2 minute foreground limit", () => {
    expect(MAX_WAIT_SECONDS).toBeLessThan(120);
  });
});

describe("read_command_output with waitSeconds", () => {
  it("returns the whole output of a command that ends during the wait", async () => {
    const r = registerCommand({
      toolCallId: "w1",
      command: "x",
      background: true,
    });
    recordOutput(r, "first line\n", 11);
    setTimeout(() => {
      recordOutput(r, "last line\n", 10);
      finishCommand(r, 0);
    }, 80);
    const out = await readCommandOutputImpl(
      { id: r.id, waitSeconds: 10 },
      {} as never,
    );
    const body = text(out);
    expect(body).toContain("the command ended");
    expect(body).toContain("last line");
    expect(out[0].name ?? "").toBeDefined();
  });

  it("says the command is still running when the wait ran out", async () => {
    const r = registerCommand({
      toolCallId: "w2",
      command: "x",
      background: true,
    });
    recordOutput(r, "working\n", 8);
    // 1 s is the shortest wait the tool allows; the command never ends
    const out = await readCommandOutputImpl(
      { id: r.id, waitSeconds: 1 },
      {} as never,
    );
    const body = text(out);
    expect(body).toContain("waited 1 s: the command is still running");
    expect(body).toContain("working");
  });

  it("without waitSeconds it reads at once, as before", async () => {
    const r = registerCommand({
      toolCallId: "w3",
      command: "x",
      background: true,
    });
    recordOutput(r, "now\n", 4);
    const started = Date.now();
    const out = await readCommandOutputImpl({ id: r.id }, {} as never);
    expect(Date.now() - started).toBeLessThan(500);
    expect(text(out)).not.toContain("waited");
    expect(text(out)).toContain("now");
  });

  it("a finished command is read at once even with a wait", async () => {
    const r = registerCommand({ toolCallId: "w4", command: "x" });
    recordOutput(r, "done\n", 5);
    finishCommand(r, 0);
    const started = Date.now();
    const out = await readCommandOutputImpl(
      { id: r.id, waitSeconds: 30 },
      {} as never,
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(text(out)).not.toContain("waited");
  });

  it("an unknown id is reported without waiting", async () => {
    const started = Date.now();
    const out = await readCommandOutputImpl(
      { id: "cmd-999", waitSeconds: 30 },
      {} as never,
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(text(out)).toMatch(/cmd-999|no command/i);
  });
});

describe("the waitSeconds parameter in the tool definition", () => {
  const params = readCommandOutputTool.function.parameters as {
    properties: Record<string, { type: string; description: string }>;
  };

  it("is appended after the existing parameters, so older cached prefixes stay prefixes", () => {
    expect(Object.keys(params.properties)).toEqual([
      "id",
      "grep",
      "lines",
      "waitSeconds",
    ]);
  });

  it("is a number, capped at the same maximum the implementation uses", () => {
    expect(params.properties.waitSeconds.type).toBe("number");
    expect(params.properties.waitSeconds.description).toContain(
      `${MAX_WAIT_SECONDS}`,
    );
  });

  it("the tool description tells the agent to pass it instead of sleeping", () => {
    expect(readCommandOutputTool.function.description).toMatch(
      /waitSeconds instead of running a sleep/,
    );
  });
});

void sleep;
