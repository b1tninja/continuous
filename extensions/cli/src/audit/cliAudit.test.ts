import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setAuditTrailForTests } from "core/tools/permissions/audit/global.js";
import { loopWorkerAuditAgent } from "core/tools/permissions/audit/identity.js";
import {
  callRows,
  readAuditSession,
} from "core/tools/permissions/audit/reader.js";
import { AuditTrail } from "core/tools/permissions/audit/trail.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  recordCliDecision,
  recordCliOutcome,
  setCliAuditAgent,
} from "./cliAudit.js";

vi.mock("../session.js", () => ({
  getCurrentSession: () => ({ sessionId: "cli-sess" }),
}));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-audit-hook-"));
  setAuditTrailForTests(
    new AuditTrail({ dir, enabled: true, syncImportant: false }),
  );
});
afterEach(() => {
  setCliAuditAgent(undefined);
  setAuditTrailForTests(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (id: string) => ({
  id,
  name: "Bash",
  arguments: { command: "npm test" },
});
const rows = () => callRows(readAuditSession(dir, "cli-sess"));

describe("the CLI permission path writes the audit", () => {
  it("allow by a rule, then its outcome", () => {
    recordCliDecision(
      call("1"),
      { verdict: { decision: "allow", by: "rules", source: "allow-rule" } },
      { approved: true },
    );
    recordCliOutcome(call("1"), { ran: true, output: "ok" });
    expect(rows()[0]).toMatchObject({ policy: "allow", ran: true });
  });

  it("an ask the person approved", () => {
    recordCliDecision(call("1"), { askedPerson: true }, { approved: true });
    recordCliOutcome(call("1"), { ran: true });
    const [row] = rows();
    expect(row.decisions.map((d) => `${d.policy}:${d.by}`)).toEqual([
      "ask:rules",
      "allow:person",
    ]);
  });

  it("a deny by a rule and a refusal by the person", () => {
    recordCliDecision(
      call("1"),
      {
        verdict: {
          decision: "deny",
          by: "rules",
          source: "deny-rule",
          rule: "Bash(rm *)",
          reason: "Blocked",
        },
      },
      { approved: false, denialMessage: "Blocked" },
    );
    recordCliOutcome(call("1"), { ran: false });
    recordCliDecision(call("2"), { askedPerson: true }, { approved: false });
    const [a, b] = rows();
    expect(a).toMatchObject({ policy: "deny", rule: "Bash(rm *)", ran: false });
    expect(b).toMatchObject({ policy: "deny", by: "person", asked: true });
  });

  it("a reviewer decision keeps model and latency", () => {
    recordCliDecision(
      call("1"),
      {
        verdict: {
          decision: "allow",
          by: "reviewer",
          reviewer: { model: "haiku-test", latencyMs: 640 },
        },
      },
      { approved: true },
    );
    const [row] = rows();
    expect(row.by).toBe("reviewer");
    expect(row.decisions[0].reviewer).toMatchObject({
      model: "haiku-test",
      latencyMs: 640,
    });
  });
});

describe("who the CLI says is calling", () => {
  const agents = () =>
    readAuditSession(dir, "cli-sess").map((r) =>
      "agent" in r ? r.agent : undefined,
    );

  it("is the session's main agent unless a worker named itself", () => {
    recordCliDecision(
      call("1"),
      { verdict: { decision: "allow", by: "rules" } },
      { approved: true },
    );
    expect(agents()[0]).toEqual({ id: "main-cli-sess", kind: "main" });
  });

  it("is the Loop worker the parent named, in the mode every host uses", () => {
    setCliAuditAgent(loopWorkerAuditAgent("parent-sess", "3"));
    recordCliDecision(
      call("1"),
      { verdict: { decision: "allow", by: "rules" } },
      { approved: true },
    );
    recordCliOutcome(call("1"), { ran: true, output: "ok" });
    expect(agents()).toEqual([
      expect.objectContaining({
        id: "worker-3",
        kind: "loop-worker",
        mode: "agent",
        parentId: "main-parent-sess",
      }),
      expect.objectContaining({ id: "worker-3" }),
    ]);
  });
});
