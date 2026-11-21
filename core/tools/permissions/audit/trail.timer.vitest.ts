import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordPolicyDecision } from "./hook";
import { callRows, readAuditSession } from "./reader";
import { AuditTrail } from "./trail";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-timer-"));
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

const ctx = (callId: string) => ({
  session: "s1",
  callId,
  toolName: "run_terminal_command",
  parsedArgs: { command: "npm test" },
});

const rows = () => callRows(readAuditSession(dir, "s1"));
const decisions = () =>
  rows()[0].decisions.map((d) => [d.policy, d.by, d.reason]);

describe("the audit trail for a held call", () => {
  it("a proposed allow that the person confirmed is the person's choice to run", () => {
    const t = trail();
    recordPolicyDecision(t, ctx("c1"), "allowedWithoutPermission", {
      policy: "allowedWithoutPermission",
      source: "allow-rule",
    });
    t.timerResolved(
      "c1",
      { outcome: "confirmed", final: "allow" },
      { proposed: "allow", seconds: 10 },
    );
    t.outcome({ callId: "c1", ran: true });
    const d = decisions();
    expect(d.map((x) => [x[0], x[1]])).toEqual([
      ["allow", "rules"],
      ["allow", "person"],
    ]);
    expect(d[1][2]).toContain("chose what was proposed: run");
  });

  it("a proposed allow that the person denied is refused, by the person, and has no outcome to wait for", () => {
    const t = trail();
    recordPolicyDecision(t, ctx("c2"), "allowedWithoutPermission", {
      policy: "allowedWithoutPermission",
      source: "allow-rule",
    });
    t.timerResolved(
      "c2",
      { outcome: "overridden", final: "refuse" },
      { proposed: "allow", seconds: 15 },
    );
    const [first, second] = decisions();
    expect([first[0], first[1]]).toEqual(["allow", "rules"]);
    expect([second[0], second[1]]).toEqual(["deny", "person"]);
    expect(second[2]).toContain("proposal was to run");
    expect(second[2]).toContain("chose to refuse");
    expect(rows()[0].outcome?.ran).toBe(false);
  });

  it("a default that applied is recorded by the system, never as the person's choice", () => {
    const t = trail();
    recordPolicyDecision(t, ctx("c3"), "allowedWithPermission", {
      policy: "allowedWithPermission",
      source: "tool-setting",
    });
    t.timerResolved(
      "c3",
      { outcome: "default-applied", final: "refuse" },
      { proposed: "refuse", seconds: 30 },
    );
    const [, second] = decisions();
    expect([second[0], second[1]]).toEqual(["deny", "system"]);
    expect(second[2]).toContain("No answer within 30 s");
    expect(second[2]).not.toContain("person chose");
  });

  it("an ask the person allowed inside the window is an override by the person", () => {
    const t = trail();
    recordPolicyDecision(t, ctx("c4"), "allowedWithPermission", {
      policy: "allowedWithPermission",
      source: "tool-setting",
    });
    t.timerResolved(
      "c4",
      { outcome: "overridden", final: "allow" },
      { proposed: "refuse", seconds: 5 },
    );
    t.outcome({ callId: "c4", ran: true });
    const [, second] = decisions();
    expect([second[0], second[1]]).toEqual(["allow", "person"]);
    expect(second[2]).toContain("proposal was to refuse");
    expect(second[2]).toContain("chose to run");
  });

  it("does nothing for a call it never saw, and never throws", () => {
    const t = trail();
    expect(() =>
      t.timerResolved(
        "unknown",
        { outcome: "default-applied", final: "allow" },
        { proposed: "allow", seconds: 5 },
      ),
    ).not.toThrow();
  });
});
