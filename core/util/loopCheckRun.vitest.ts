import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counts every process start, and lets the real one through
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  spawn.mockImplementation(real.spawn);
  return { ...real, default: { ...real, spawn }, spawn };
});

import { recordPolicyDecision } from "../tools/permissions/audit/hook";
import { callRows, readAuditSession } from "../tools/permissions/audit/reader";
import { AuditTrail } from "../tools/permissions/audit/trail";
import { resetCommandLintGate } from "../tools/permissions/commandLint";
import { getCommandExecutor } from "./commandExecutor";
import { containerUnavailableMessage } from "./containerStatus";
import {
  loopCheckBlocked,
  runAuditedLoopCheck,
  runLoopCheckCommand,
} from "./loopCheckRun";
import { getAllRunningProcessIds } from "./processTerminalStates";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-check-"));
  spawn.mockClear();
  resetCommandLintGate();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A script in the test's folder, as a command both PowerShell and bash read. */
function nodeScript(name: string, source: string): string {
  const file = path.join(dir, name).replace(/\\/g, "/");
  fs.writeFileSync(file, source);
  return `node "${file}"`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const trail = () =>
  new AuditTrail({
    dir,
    enabled: true,
    now: () => new Date("2026-11-21T12:00:00.000Z"),
    syncImportant: false,
  });

/** The decision the webview asks for before it sends the check. */
function decided(t: AuditTrail, callId: string, command: string): void {
  recordPolicyDecision(
    t,
    {
      session: "s1",
      callId,
      toolName: "run_terminal_command",
      parsedArgs: { command },
    },
    "allowedWithoutPermission",
    { policy: "allowedWithoutPermission" },
  );
}

const outcomes = () =>
  readAuditSession(dir, "s1").filter(
    (r) => r.ev === "outcome",
  ) as unknown as Record<string, unknown>[];

describe("a Loop check in the editor runs through the command executor", () => {
  it("returns the executor's unavailable text and starts no process when the container runtime is missing", async () => {
    const status = { state: "not-installed", runtime: "docker" } as const;
    const executor = getCommandExecutor({
      terminalShell: { kind: "container", runtime: "docker" },
      containerStatus: status,
    });
    const result = await runLoopCheckCommand("npm test", {
      cwd: dir,
      executor,
    });
    expect(result).toEqual({
      exitCode: null,
      output: containerUnavailableMessage(status),
      notRun: true,
    });
    expect(result.output).toBeTruthy();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the command and returns its own exit code and output", async () => {
    const result = await runLoopCheckCommand(
      nodeScript("exit3.js", `console.log("three"); process.exit(3);`),
      { cwd: dir },
    );
    expect(result).toEqual({ exitCode: 3, output: "three" });
    expect(getAllRunningProcessIds()).toEqual([]);
  });

  it("does not hand a secret-named variable to the check", async () => {
    vi.stubEnv("LOOP_CHECK_API_KEY", "sk-secret");
    vi.stubEnv("LOOP_CHECK_PLAIN", "plain");
    const result = await runLoopCheckCommand(
      nodeScript(
        "env.js",
        `console.log(String(process.env.LOOP_CHECK_API_KEY), String(process.env.LOOP_CHECK_PLAIN));`,
      ),
      { cwd: dir },
    );
    expect(result).toEqual({ exitCode: 0, output: "undefined plain" });
  });

  it("stops a check that outlives its timeout, with the process it started, and says it timed out", async () => {
    const pidFile = path.join(dir, "pids.txt").replace(/\\/g, "/");
    const child = path.join(dir, "child.js").replace(/\\/g, "/");
    fs.writeFileSync(child, `setInterval(() => {}, 1000);`);
    const command = nodeScript(
      "parent.js",
      `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "inherit" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, process.pid + " " + c.pid);
console.log("started");
setInterval(() => {}, 1000);`,
    );
    const result = await runLoopCheckCommand(command, {
      cwd: dir,
      timeoutMs: 3_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("started");
    const pids = fs.readFileSync(pidFile, "utf8").split(" ").map(Number);
    expect(pids).toHaveLength(2);
    // The kill is asynchronous: both are gone soon after
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), {
      timeout: 10_000,
      interval: 100,
    });
    expect(getAllRunningProcessIds()).toEqual([]);
  }, 30_000);

  it("stops a command the lint is sure about, as the terminal tool does, and starts nothing", async () => {
    const executor = getCommandExecutor({
      platform: "win32",
      env: {},
      terminalShell: "default",
    });
    expect(executor.shell.kind).toBe("powershell");
    // `export` is not a PowerShell command
    const blocked = loopCheckBlocked("export CI=1; npm test", executor);
    expect(blocked).toContain("The command was not run");
    const result = await runLoopCheckCommand("export CI=1; npm test", {
      cwd: dir,
      executor,
    });
    expect(result).toEqual({ exitCode: null, output: blocked, notRun: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not start a check here for a remote window", async () => {
    const result = await runLoopCheckCommand("npm test", {
      cwd: dir,
      remoteName: "ssh-remote",
    });
    expect(result.notRun).toBe(true);
    expect(result.output).toContain("remote window");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("a Loop check's outcome is written to the audit trail", () => {
  it("records the exit code of a check that ran, under its decision's call", async () => {
    const t = trail();
    decided(t, "loop-check-1", "npm test");
    const result = await runAuditedLoopCheck(
      { command: "npm test", callId: "loop-check-1" },
      {
        trail: t,
        cwd: dir,
        run: async () => ({ exitCode: 2, output: "1 test failed" }),
      },
    );
    expect(result.exitCode).toBe(2);
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({
      callId: "loop-check-1",
      tool: "run_terminal_command",
      ran: true,
      exit: 2,
    });
    expect(outcomes()[0].errSig).toBeTruthy();
    const [row] = callRows(readAuditSession(dir, "s1"));
    expect(row.outcome).toMatchObject({ ran: true, exit: 2 });
  });

  it("records a check that timed out as timed out, with no exit code", async () => {
    const t = trail();
    decided(t, "loop-check-2", "npm test");
    await runAuditedLoopCheck(
      { command: "npm test", callId: "loop-check-2" },
      {
        trail: t,
        cwd: dir,
        run: async () => ({ exitCode: null, output: "", timedOut: true }),
      },
    );
    expect(outcomes()[0]).toMatchObject({
      callId: "loop-check-2",
      ran: true,
      timedOut: true,
    });
    expect("exit" in outcomes()[0]).toBe(false);
  });

  it("records a check the executor could not run as not run", async () => {
    const t = trail();
    decided(t, "loop-check-3", "npm test");
    const status = { state: "not-installed", runtime: "docker" } as const;
    const result = await runAuditedLoopCheck(
      { command: "npm test", callId: "loop-check-3" },
      {
        trail: t,
        cwd: dir,
        executor: getCommandExecutor({
          terminalShell: { kind: "container", runtime: "docker" },
          containerStatus: status,
        }),
      },
    );
    expect(result.output).toBe(containerUnavailableMessage(status));
    expect(outcomes()[0]).toMatchObject({ callId: "loop-check-3", ran: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses a message with no command and runs nothing", async () => {
    const run = vi.fn();
    const result = await runAuditedLoopCheck(
      { command: "  ", callId: "loop-check-4" },
      { trail: trail(), cwd: dir, run },
    );
    expect(result.notRun).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
