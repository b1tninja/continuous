import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordPolicyDecision } from "./hook";
import { callRows, readAuditSession } from "./reader";
import { AuditTrail } from "./trail";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-shell-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const trail = () =>
  new AuditTrail({
    dir,
    enabled: true,
    now: () => new Date("2026-11-12T12:00:00.000Z"),
    syncImportant: false,
  });

const ask = { policy: "allowedWithPermission" as const };

describe("the audit decision says which shell read the command, and how that is known", () => {
  it("records a shell this process starts as a fact", () => {
    recordPolicyDecision(
      trail(),
      {
        session: "s1",
        callId: "c1",
        toolName: "run_terminal_command",
        parsedArgs: { command: "npm test" },
        shell: { kind: "powershell", source: "spawned" },
      },
      "allowedWithPermission",
      ask,
    );
    const [row] = callRows(readAuditSession(dir, "s1"));
    expect(row.decisions[0].reading).toEqual({
      shell: "powershell",
      shellSource: "spawned",
    });
  });

  it("records a remote window's terminal as unknown", () => {
    recordPolicyDecision(
      trail(),
      {
        session: "s1",
        callId: "c2",
        toolName: "run_terminal_command",
        parsedArgs: { command: "npm test" },
        shell: { kind: "unknown", source: "terminal" },
      },
      "allowedWithPermission",
      ask,
    );
    const [row] = callRows(readAuditSession(dir, "s1"));
    expect(row.decisions[0].reading).toEqual({
      shell: "unknown",
      shellSource: "terminal",
    });
  });

  it("writes nothing for a call that is not a terminal command, or with no shell given", () => {
    const t = trail();
    recordPolicyDecision(
      t,
      {
        session: "s1",
        callId: "c3",
        toolName: "read_file",
        parsedArgs: { filepath: "a.ts" },
        shell: { kind: "bash", source: "spawned" },
      },
      "allowedWithPermission",
      ask,
    );
    recordPolicyDecision(
      t,
      {
        session: "s1",
        callId: "c4",
        toolName: "run_terminal_command",
        parsedArgs: { command: "ls" },
      },
      "allowedWithPermission",
      ask,
    );
    const rows = callRows(readAuditSession(dir, "s1"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect("reading" in row.decisions[0]).toBe(false);
  });
});
