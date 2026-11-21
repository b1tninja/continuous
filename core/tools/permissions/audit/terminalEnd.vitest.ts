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

  it("marks a command we stopped", () => {
    const r = registerCommand({ toolCallId: "t", command: "x" });
    r.stoppedFor = "stopped";
    finishCommand(r, 1);
    expect(terminalEndOf([item(r.id, "partial")])).toMatchObject({
      exit: 1,
      timedOut: true,
    });
  });

  it("says nothing about a command that is still running", () => {
    const r = registerCommand({
      toolCallId: "t",
      command: "x",
      background: true,
    });
    expect(terminalEndOf([item(r.id, "started")])).toBeUndefined();
  });

  it("says nothing when the process ended without a code", () => {
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
