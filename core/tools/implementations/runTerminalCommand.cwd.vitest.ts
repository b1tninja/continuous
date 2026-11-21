import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolExtras } from "../..";
import * as processTerminalStates from "../../util/processTerminalStates";
import { testTempDir } from "../../util/testTempDir";
import { runTerminalCommandTool } from "../definitions/runTerminalCommand";
import { runTerminalCommandImpl } from "./runTerminalCommand";

vi.unmock("node:child_process");
vi.unmock("node:util");

/**
 * The `cwd` argument: a command starts in the folder it was asked to, and
 * only in a workspace folder or below one.
 */
let root: string;
let sub: string;
let outside: string;

beforeAll(() => {
  root = testTempDir("terminal-cwd-");
  sub = path.join(root, "workspace", "pkg");
  fs.mkdirSync(sub, { recursive: true });
  outside = path.join(root, "elsewhere");
  fs.mkdirSync(outside);
  processTerminalStates.clearAllBackgroundProcesses();
});

afterAll(async () => {
  processTerminalStates.clearAllBackgroundProcesses();
  // A background command may still hold its folder for a moment on Windows
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (e: any) {
      if (e?.code !== "EPERM" && e?.code !== "EBUSY") throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // Left for the system's temp cleanup rather than failing a passing suite
});

const workspace = () => path.join(root, "workspace");

function extras(): ToolExtras {
  return {
    ide: {
      getIdeInfo: async () => ({ remoteName: "local" }),
      getWorkspaceDirs: async () => [pathToFileURL(workspace()).href],
    },
    toolCallId: "cwd-test",
  } as unknown as ToolExtras;
}

const PRINT_CWD = `node -e "console.log('CWD=' + process.cwd())"`;

function printedCwd(
  result: Awaited<ReturnType<typeof runTerminalCommandImpl>>,
) {
  const text = result.map((r) => r.content).join("\n");
  return /CWD=(.+)/.exec(text)?.[1]?.trim();
}

describe("run_terminal_command cwd", () => {
  it("runs in the workspace root when no cwd is given", async () => {
    const out = await runTerminalCommandImpl({ command: PRINT_CWD }, extras());
    expect(printedCwd(out)).toBe(workspace());
  });

  it("runs in a sub-folder when asked, relative to the workspace root", async () => {
    const out = await runTerminalCommandImpl(
      { command: PRINT_CWD, cwd: "pkg" },
      extras(),
    );
    expect(printedCwd(out)).toBe(sub);
  });

  it("accepts an absolute path inside the workspace", async () => {
    const out = await runTerminalCommandImpl(
      { command: PRINT_CWD, cwd: sub },
      extras(),
    );
    expect(printedCwd(out)).toBe(sub);
  });

  it("does not run a command whose cwd leaves the workspace", async () => {
    for (const bad of ["..", "../elsewhere", outside]) {
      const out = await runTerminalCommandImpl(
        { command: PRINT_CWD, cwd: bad },
        extras(),
      );
      const text = out.map((r) => r.content).join("\n");
      expect(text, bad).toContain("outside the workspace");
      expect(printedCwd(out), bad).toBeUndefined();
    }
  });

  it("does not run a command whose cwd does not exist", async () => {
    const out = await runTerminalCommandImpl(
      { command: PRINT_CWD, cwd: "missing" },
      extras(),
    );
    expect(out.map((r) => r.content).join("\n")).toContain("does not exist");
    expect(printedCwd(out)).toBeUndefined();
  });

  it("works for a background command too", async () => {
    const out = await runTerminalCommandImpl(
      { command: PRINT_CWD, cwd: "pkg", waitForCompletion: false },
      extras(),
    );
    expect(out.length).toBeGreaterThan(0);
    // the background call returns at once; the folder is validated before it starts
    const bad = await runTerminalCommandImpl(
      { command: PRINT_CWD, cwd: "..", waitForCompletion: false },
      extras(),
    );
    expect(bad.map((r) => r.content).join("\n")).toContain(
      "outside the workspace",
    );
  });
});

describe("the cwd parameter in the tool definition", () => {
  const params = runTerminalCommandTool.function.parameters as {
    required: string[];
    properties: Record<string, { type: string; description: string }>;
  };

  it("is optional and a string", () => {
    expect(params.required).toEqual(["command"]);
    expect(params.properties.cwd.type).toBe("string");
  });

  it("is appended after the existing parameters, so the cached prefix of an older request stays a prefix", () => {
    expect(Object.keys(params.properties)).toEqual([
      "command",
      "waitForCompletion",
      "cwd",
    ]);
  });

  it("tells the agent the shell keeps nothing between calls", () => {
    expect(params.properties.cwd.description).toMatch(
      /keeps nothing between calls/,
    );
  });
});
