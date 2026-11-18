import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordPolicyDecision, syntheticCallId } from "./hook";
import { callRows, readAuditSession } from "./reader";
import { AuditTrail } from "./trail";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-id-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const trail = () =>
  new AuditTrail({
    dir,
    enabled: true,
    now: () => new Date("2026-11-10T12:00:00.000Z"),
    syncImportant: false,
  });

describe("decisions with no call id (DS11)", () => {
  const ctx = (callId?: string) => ({
    session: "s1",
    ...(callId ? { callId } : {}),
    toolName: "run_terminal_command",
    parsedArgs: { command: "npm test" },
  });
  const allow = { policy: "allowedWithoutPermission" as const };

  it("is written under a marked, made-up id", () => {
    const t = trail();
    recordPolicyDecision(t, ctx(), "allowedWithoutPermission", allow);
    const [rec] = readAuditSession(dir, "s1");
    expect(rec).toMatchObject({
      ev: "decision",
      synthetic: true,
      policy: "allow",
    });
    expect((rec as { callId: string }).callId).toMatch(
      /^nocall-[0-9a-f]{12}-\d+$/,
    );
  });

  it("a call that has an id is unchanged and is not marked", () => {
    const t = trail();
    recordPolicyDecision(t, ctx("c1"), "allowedWithoutPermission", allow);
    const [rec] = readAuditSession(dir, "s1");
    expect(rec).toMatchObject({ callId: "c1" });
    expect("synthetic" in rec).toBe(false);
  });

  it("the same call gets the same hash; two such calls stay two rows", () => {
    expect(syntheticCallId(ctx(), 1).split("-")[1]).toBe(
      syntheticCallId(ctx(), 2).split("-")[1],
    );
    const t = trail();
    recordPolicyDecision(t, ctx(), "allowedWithoutPermission", allow);
    recordPolicyDecision(t, ctx(), "allowedWithoutPermission", allow);
    expect(callRows(readAuditSession(dir, "s1"))).toHaveLength(2);
  });

  it("a refused call with no id is audited and closed", () => {
    const t = trail();
    recordPolicyDecision(t, ctx(), "allowedWithPermission", {
      policy: "disabled",
    });
    const [row] = callRows(readAuditSession(dir, "s1"));
    expect(row.policy).toBe("deny");
    expect(row.ran).toBe(false);
  });
});
