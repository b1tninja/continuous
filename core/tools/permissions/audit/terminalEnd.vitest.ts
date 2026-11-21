import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearCommandsForTests,
  finishCommand,
  registerCommand,
  setCommandOutputFolderForTests,
} from "../../../util/commandOutputStore";
import { terminalEndOf } from "./terminalEnd";

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-end-"));
  setCommandOutputFolderForTests(folder);
  clearCommandsForTests();
});

afterEach(() => {
  clearCommandsForTests();
  fs.rmSync(folder, { recursive: true, force: true });
});

const item = (id: string | undefined, content = "") => ({
  name: "Terminal",
  description: "Terminal command output",
  content,
  ...(id
    ? { commandOutput: { id, bytes: 0, lines: 0, bytesPerSecond: 0 } }
    : {}),
});

describe("terminalEndOf", () => {
  it("records exit 0 for a command that succeeded, with no error text", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, 0);
    expect(terminalEndOf([item(r.id, "all good")])).toEqual({ exit: 0 });
  });

  it("records the code a command chose, with its last output line as the error", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, 3);
    const end = terminalEndOf([
      item(r.id, "running tests\n\n  2 failed, 5 passed\n\n"),
    ]);
    expect(end).toEqual({ exit: 3, error: "2 failed, 5 passed" });
  });

  it("gives a failure an error text even when it printed nothing", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, 127);
    expect(terminalEndOf([item(r.id, "")])).toEqual({
      exit: 127,
      error: "exited with code 127",
    });
    expect(terminalEndOf([item(r.id, "   \n\n  ")])?.error).toBe(
      "exited with code 127",
    );
  });

  it("a command we stopped is not marked as timed out: that is the time limit", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    r.stoppedFor = "stopped";
    finishCommand(r, 1);
    const end = terminalEndOf([item(r.id, "partial")]);
    expect(end).toMatchObject({ exit: 1 });
    expect(end?.timedOut).toBeUndefined();
  });

  it("marks a command that hit the time limit", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, null, undefined, { signal: "SIGTERM", timedOut: true });
    expect(terminalEndOf([item(r.id, "slow")])).toEqual({
      signal: "SIGTERM",
      timedOut: true,
      error: "timed out",
    });
  });

  it("reports a command ended by a signal by the signal, with no exit code", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, null, undefined, { signal: "SIGKILL" });
    const end = terminalEndOf([item(r.id, "Killed")]);
    expect(end).toEqual({ signal: "SIGKILL", error: "Killed" });
    expect("exit" in (end ?? {})).toBe(false);
  });

  it("names the signal when the command printed nothing", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, null, undefined, { signal: "SIGTERM" });
    expect(terminalEndOf([item(r.id, "")])?.error).toBe("ended by SIGTERM");
  });

  it("a command stopped by a runaway check, with no code, is reported as stopped", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    r.stoppedFor = "flood" as never;
    finishCommand(r, null);
    expect(terminalEndOf([item(r.id, "")])).toEqual({ error: "stopped" });
  });

  it("keeps the exit code and the signal when both are known", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, 143, undefined, { signal: "SIGTERM" });
    expect(terminalEndOf([item(r.id, "")])).toMatchObject({
      exit: 143,
      signal: "SIGTERM",
    });
  });

  it("a command that timed out and exited with a code keeps both", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, 1, undefined, { timedOut: true });
    expect(terminalEndOf([item(r.id, "boom")])).toEqual({
      exit: 1,
      error: "boom",
      timedOut: true,
    });
  });

  it("a clean exit has no signal and no time-out", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, 0);
    expect(terminalEndOf([item(r.id, "ok")])).toEqual({ exit: 0 });
  });

  it("says nothing about a command that is still running", () => {
    const r = registerCommand({
      toolCallId: "t",
      command: "x",
      background: true,
    });
    expect(terminalEndOf([item(r.id, "started")])).toBeUndefined();
  });

  it("says nothing when the process ended with no code and no known reason", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, null);
    expect(terminalEndOf([item(r.id, "killed")])).toBeUndefined();
  });

  it("says nothing for other tools and for an id that is not known", () => {
    expect(terminalEndOf(undefined)).toBeUndefined();
    expect(terminalEndOf([])).toBeUndefined();
    expect(terminalEndOf([item(undefined, "a file")])).toBeUndefined();
    expect(terminalEndOf([item("cmd-999", "x")])).toBeUndefined();
  });

  it("reads the terminal item among several items", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    finishCommand(r, 2);
    const end = terminalEndOf([item(undefined, "note"), item(r.id, "boom")]);
    expect(end).toEqual({ exit: 2, error: "boom" });
  });
});
