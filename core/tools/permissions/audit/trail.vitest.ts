import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canarySecrets } from "../../../util/secretScan/canary";
import type { AutoReviewReply } from "../auto/handler";
import {
  auditEnabledFromEnv,
  auditEnabledFromYaml,
  auditSettings,
} from "./global";
import { recordPolicyDecision, recordReviewDecision } from "./hook";
import {
  callRows,
  listAuditFiles,
  listCalls,
  pruneAudit,
  readAuditSession,
} from "./reader";
import { auditToSteps } from "./steps";
import { AuditTrail } from "./trail";
import { readAuditFile } from "./writer";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-trail-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = "2026-11-10T12:00:00.000Z";
const trailAt = (
  over: Partial<ConstructorParameters<typeof AuditTrail>[0]> = {},
) =>
  new AuditTrail({
    dir,
    enabled: true,
    now: () => new Date(T0),
    syncImportant: false,
    ...over,
  });

const ctx = (callId: string, command = "npm test") => ({
  session: "s1",
  callId,
  toolName: "run_terminal_command",
  parsedArgs: { command },
});

function rows() {
  return callRows(readAuditSession(dir, "s1"));
}

describe("decisions and outcomes", () => {
  it("records an allow by a rule with its outcome", () => {
    const trail = trailAt();
    recordPolicyDecision(trail, ctx("c1"), "allowedWithPermission", {
      policy: "allowedWithoutPermission",
      source: "allow-rule",
      rule: "Bash(npm test)",
      reason: "Allowed by your rule.",
    });
    trail.outcome({ callId: "c1", ran: true, output: "ok" });
    const [row] = rows();
    expect(row).toMatchObject({
      callId: "c1",
      policy: "allow",
      by: "rules",
      source: "allow-rule",
      rule: "Bash(npm test)",
      ran: true,
    });
    expect(row.outcome?.outHash).toBeTruthy();
  });

  it("records an ask answered by the person as two decisions and an outcome", () => {
    const trail = trailAt();
    recordPolicyDecision(trail, ctx("c1"), "allowedWithPermission", {
      policy: "allowedWithPermission",
      source: "tool-setting",
    });
    trail.answer("c1", true);
    trail.outcome({ callId: "c1", ran: true });
    const [row] = rows();
    expect(row.decisions.map((d) => [d.policy, d.by])).toEqual([
      ["ask", "rules"],
      ["allow", "person"],
    ]);
    expect(row.decisions[1].answers).toBe(row.decisions[0].seq);
    expect(row.asked).toBe(true);
    expect(row.policy).toBe("allow");
  });

  it("records an answer over an unauthenticated connection as the system, not the person", () => {
    const trail = trailAt();
    recordPolicyDecision(trail, ctx("c1"), "allowedWithPermission", {
      policy: "allowedWithPermission",
    });
    trail.answer("c1", true, "system");
    const [row] = rows();
    expect(row.decisions.map((d) => d.by)).toEqual(["rules", "system"]);
  });

  it("records a refusal by the person as a deny and a call that did not run", () => {
    const trail = trailAt();
    recordPolicyDecision(trail, ctx("c1"), "allowedWithPermission", {
      policy: "allowedWithPermission",
    });
    trail.answer("c1", false);
    const [row] = rows();
    expect(row.policy).toBe("deny");
    expect(row.ran).toBe(false);
  });

  it("records a deny rule and closes the call as not run", () => {
    const trail = trailAt();
    recordPolicyDecision(
      trail,
      ctx("c1", "rm -rf /"),
      "allowedWithPermission",
      {
        policy: "disabled",
        source: "deny-rule",
        rule: "Bash(rm *)",
        reason: "Blocked by your rule.",
      },
    );
    const [row] = rows();
    expect(row).toMatchObject({
      policy: "deny",
      ran: false,
      rule: "Bash(rm *)",
    });
  });

  it("clamps an allow the tool setting does not permit, as the GUI does", () => {
    const trail = trailAt();
    recordPolicyDecision(trail, ctx("c1"), "allowedWithPermission", {
      policy: "allowedWithoutPermission",
      source: "default",
    });
    expect(rows()[0].policy).toBe("ask");
  });

  it("records the reviewer's decision with model, latency and usage", () => {
    const trail = trailAt();
    recordPolicyDecision(trail, ctx("c1"), "allowedWithPermission", {
      policy: "allowedWithPermission",
      source: "tool-setting",
    });
    const reply: AutoReviewReply = {
      decision: "allow",
      reason: "Looks routine.",
      by: "reviewer",
      reviewer: {
        model: "haiku-test",
        latencyMs: 812,
        usage: { input: 900, output: 40 },
      },
    };
    recordReviewDecision(trail, ctx("c1"), reply);
    trail.outcome({ callId: "c1", ran: true });
    const [row] = rows();
    expect(row.by).toBe("reviewer");
    expect(row.reviewerModel).toBe("haiku-test");
    expect(row.decisions[1].reviewer).toMatchObject({
      latencyMs: 812,
      usage: { input: 900, output: 40 },
    });
    expect(row.decisions[1].answers).toBe(row.decisions[0].seq);
  });

  it("does not record a rules reply a second time", () => {
    const trail = trailAt();
    recordReviewDecision(trail, ctx("c1"), {
      decision: "ask",
      reason: "r",
      by: "rules",
    });
    expect(rows()).toEqual([]);
  });

  it("records a call with no id under a marked, made-up id", () => {
    const trail = trailAt();
    recordPolicyDecision(
      trail,
      { toolName: "x", parsedArgs: {} },
      "allowedWithoutPermission",
      { policy: "allowedWithoutPermission" },
    );
    const files = listAuditFiles(dir);
    expect(files).toHaveLength(1);
    const [rec] = readAuditFile(files[0].file) as any[];
    expect(rec.synthetic).toBe(true);
    expect(rec.callId).toMatch(/^nocall-/);
  });

  it("is a no-op when disabled", () => {
    const trail = trailAt({ enabled: false });
    recordPolicyDecision(trail, ctx("c1"), "allowedWithoutPermission", {
      policy: "allowedWithoutPermission",
    });
    trail.outcome({ callId: "c1", ran: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("masking", () => {
  it("masks secrets in arguments before writing and hashing", () => {
    const trail = trailAt();
    const secret = canarySecrets().anthropicKey;
    const command = `curl -H "x-api-key: ${secret}" https://api.example.com`;
    recordPolicyDecision(trail, ctx("c1", command), "allowedWithPermission", {
      policy: "allowedWithPermission",
      displayValue: command,
      reason: `asks about ${secret}`,
    });
    trail.outcome({ callId: "c1", ran: true, output: `echo ${secret}` });
    const text = fs
      .readdirSync(path.join(dir, "2026-11"))
      .map((f) => fs.readFileSync(path.join(dir, "2026-11", f), "utf8"))
      .join("\n");
    expect(text).not.toContain(secret);
    expect(text).toContain("masked:");
    // the hash is of the masked text, so two commands with different secrets match
    const trail2 = trailAt();
    recordPolicyDecision(
      trail2,
      ctx("c2", command.replace(secret, canarySecrets(99).anthropicKey)),
      "allowedWithPermission",
      { policy: "allowedWithPermission" },
    );
    const all = callRows(readAuditSession(dir, "s1"));
    expect(all[0].decisions[0].argsHash).toBe(all[1].decisions[0].argsHash);
  });
});

describe("a failing disk", () => {
  it("never throws, and reports once", () => {
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const onError = vi.fn();
    // the audit directory is a file: every mkdir fails
    const trail = trailAt({ dir: blocker, onError });
    expect(() => {
      for (let i = 0; i < 5; i++) {
        recordPolicyDecision(trail, ctx(`c${i}`), "allowedWithPermission", {
          policy: "allowedWithoutPermission",
          source: "allow-rule",
        });
        trail.outcome({ callId: `c${i}`, ran: true });
        trail.answer(`c${i}`, true);
      }
      trail.turn({ session: "s1", textChars: 1, calls: 0 });
    }).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(
      /audit trail could not be written/,
    );
  });

  it("survives an onError that throws", () => {
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const trail = trailAt({
      dir: blocker,
      onError: () => {
        throw new Error("boom");
      },
    });
    expect(() =>
      trail.outcome({ callId: "c", tool: "t", ran: true }),
    ).not.toThrow();
  });
});

describe("rotation and prune", () => {
  it("starts a new part when a file reaches the size cap", () => {
    const trail = trailAt({ maxFileBytes: 600 });
    for (let i = 0; i < 6; i++) {
      recordPolicyDecision(
        trail,
        ctx(`c${i}`, `echo ${i}`),
        "allowedWithoutPermission",
        {
          policy: "allowedWithoutPermission",
        },
      );
    }
    const files = listAuditFiles(dir).filter((f) => f.session === "s1");
    expect(files.length).toBeGreaterThan(1);
    expect(files.every((f) => f.bytes <= 900)).toBe(true);
    expect(readAuditSession(dir, "s1")).toHaveLength(6);
  });

  it("deletes whole files past the retention and keeps the rest", () => {
    const trail = trailAt();
    trail.turn({ session: "old", textChars: 1, calls: 0 });
    trail.turn({ session: "new", textChars: 1, calls: 0 });
    const [oldFile] = listAuditFiles(dir).filter((f) => f.session === "old");
    const longAgo = new Date("2026-09-01T00:00:00Z");
    fs.utimesSync(oldFile.file, longAgo, longAgo);
    const result = trail.prune();
    expect(result.deleted).toEqual([oldFile.file]);
    expect(listAuditFiles(dir).map((f) => f.session)).toEqual(["new"]);
  });

  it("removes an emptied month folder, and honours a dry run", () => {
    const trail = trailAt();
    trail.turn({ session: "old", textChars: 1, calls: 0 });
    const [f] = listAuditFiles(dir);
    const longAgo = new Date("2026-09-01T00:00:00Z");
    fs.utimesSync(f.file, longAgo, longAgo);
    const now = new Date(T0);
    expect(
      pruneAudit(dir, { retentionDays: 30, now, dryRun: true }).deleted,
    ).toHaveLength(1);
    expect(fs.existsSync(f.file)).toBe(true);
    pruneAudit(dir, { retentionDays: 30, now });
    expect(fs.existsSync(path.join(dir, "2026-11"))).toBe(false);
  });
});

describe("reading", () => {
  function seed() {
    const trail = trailAt();
    recordPolicyDecision(trail, ctx("c1"), "allowedWithoutPermission", {
      policy: "allowedWithoutPermission",
      source: "allow-rule",
    });
    trail.outcome({ callId: "c1", ran: true });
    recordPolicyDecision(
      trail,
      { ...ctx("c2", "git push"), toolName: "other_tool" },
      "allowedWithPermission",
      { policy: "allowedWithPermission" },
    );
    recordReviewDecision(
      trail,
      { ...ctx("c2"), toolName: "other_tool" },
      {
        decision: "deny",
        reason: "no",
        by: "reviewer",
      },
    );
    recordPolicyDecision(trail, { ...ctx("c3"), session: "s2" }, "disabled", {
      policy: "disabled",
      source: "deny-rule",
    });
  }

  it("filters by session, decision, tool and date", () => {
    seed();
    expect(listCalls(dir).map((r) => r.callId)).toEqual(["c1", "c2", "c3"]);
    expect(listCalls(dir, { session: "s2" }).map((r) => r.callId)).toEqual([
      "c3",
    ]);
    expect(listCalls(dir, { decision: "deny" }).map((r) => r.callId)).toEqual([
      "c2",
      "c3",
    ]);
    expect(
      listCalls(dir, { decision: "reviewer" }).map((r) => r.callId),
    ).toEqual(["c2"]);
    expect(listCalls(dir, { decision: "ask" }).map((r) => r.callId)).toEqual([
      "c2",
    ]);
    expect(listCalls(dir, { tool: "other_tool" }).map((r) => r.callId)).toEqual(
      ["c2"],
    );
    expect(listCalls(dir, { since: "2026-11-11" })).toEqual([]);
    expect(listCalls(dir, { until: "2026-11-10" })).toHaveLength(3);
    expect(listCalls(dir, { until: "2026-11-09" })).toEqual([]);
  });

  it("feeds the stuck signals through auditToSteps", () => {
    const trail = trailAt();
    for (const id of ["a", "b"]) {
      recordPolicyDecision(
        trail,
        { ...ctx(id), turn: Number(id === "b") },
        "allowedWithoutPermission",
        {
          policy: "allowedWithoutPermission",
        },
      );
      trail.outcome({
        callId: id,
        ran: true,
        exit: 1,
        error: "Error 42: nope",
      });
    }
    const steps = auditToSteps(readAuditSession(dir, "s1"));
    expect(steps).toHaveLength(2);
    expect(steps[0].calls[0]).toMatchObject({
      tool: "run_terminal_command",
      error: true,
    });
  });

  it("reads files the writer left with a torn last line", () => {
    const trail = trailAt();
    trail.turn({ session: "s1", textChars: 1, calls: 0 });
    const [f] = listAuditFiles(dir);
    fs.appendFileSync(f.file, '{"v":1,"ev":"turn"');
    expect(readAuditFile(f.file)).toHaveLength(1);
  });
});

describe("settings", () => {
  it("is on by default and off by environment or config.yaml, the environment first", () => {
    expect(auditSettings({}, "").enabled).toBe(true);
    expect(auditSettings({ CONTINUE_AUDIT: "off" }, "").enabled).toBe(false);
    expect(auditSettings({}, "audit:\n  enabled: false\n").enabled).toBe(false);
    expect(
      auditSettings({ CONTINUE_AUDIT: "on" }, "audit:\n  enabled: false\n")
        .enabled,
    ).toBe(true);
    expect(
      auditSettings({ CONTINUE_AUDIT: "off" }, "audit:\n  enabled: true\n")
        .enabled,
    ).toBe(false);
    expect(auditEnabledFromEnv({ CONTINUE_AUDIT: "maybe" })).toBeUndefined();
    expect(auditEnabledFromYaml("name: x\n")).toBeUndefined();
    expect(
      auditSettings({}, "audit:\n  retentionDays: 7\n").retentionDays,
    ).toBe(7);
    expect(auditSettings({}, ": : bad").enabled).toBe(true);
  });
});
