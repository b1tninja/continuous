import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuditTrail } from "core/tools/permissions/audit/trail.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auditCommand } from "./audit.js";

let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-audit-"));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
    stdout.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
    stderr.push(String(s));
    return true;
  });
  const trail = new AuditTrail({
    dir,
    enabled: true,
    now: () => new Date("2026-11-10T12:00:00Z"),
    syncImportant: false,
  });
  trail.decision({
    session: "sess-a",
    callId: "1",
    tool: "Bash",
    args: JSON.stringify({ command: "ls" }),
    policy: "allow",
    by: "rules",
    source: "allow-rule",
  });
  trail.outcome({ callId: "1", ran: true });
  trail.decision({
    session: "sess-b",
    callId: "2",
    tool: "Write",
    args: JSON.stringify({ path: "a.txt" }),
    policy: "ask",
    by: "rules",
  });
  trail.decision({
    session: "sess-b",
    callId: "2",
    tool: "Write",
    args: JSON.stringify({ path: "a.txt" }),
    policy: "deny",
    by: "reviewer",
    reviewer: { model: "haiku-test", latencyMs: 700 },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const text = () => stdout.join("");

describe("continuous audit", () => {
  it("lists setting changes with their surface, and leaves calls alone", () => {
    const trail = new AuditTrail({
      dir,
      enabled: true,
      now: () => new Date("2026-11-10T13:00:00Z"),
      syncImportant: false,
    });
    trail.setting({
      kind: "level",
      op: "set",
      source: "cli-policy",
      name: "tools",
      from: "cautious",
      to: "permissive",
      loosens: true,
      confirmed: "prompt",
    });
    expect(auditCommand("changes", undefined, { dir })).toBe(0);
    expect(text()).toContain("cli-policy");
    expect(text()).toContain(
      "set tools: cautious -> permissive (confirmed: prompt)",
    );
    stdout.length = 0;
    expect(auditCommand("list", undefined, { dir, json: true })).toBe(0);
    expect(JSON.parse(text())).toHaveLength(2);
  });

  it("says so when no setting changed", () => {
    expect(auditCommand("changes", undefined, { dir })).toBe(0);
    expect(text()).toContain("No setting changes recorded.");
  });

  it("lists calls as JSON, filtered", () => {
    expect(auditCommand("list", undefined, { dir, json: true })).toBe(0);
    const all = JSON.parse(text());
    expect(all.map((r: any) => r.callId)).toEqual(["1", "2"]);
    stdout = [];

    auditCommand("list", undefined, { dir, json: true, decision: "reviewer" });
    expect(JSON.parse(text()).map((r: any) => r.callId)).toEqual(["2"]);
    stdout = [];

    auditCommand("list", undefined, { dir, json: true, tool: "Bash" });
    expect(JSON.parse(text()).map((r: any) => r.callId)).toEqual(["1"]);
    stdout = [];

    auditCommand("list", undefined, { dir, json: true, session: "sess-b" });
    expect(JSON.parse(text())).toHaveLength(1);
  });

  it("names the agent in the list, filters by it and lists the inbox", () => {
    const trail = new AuditTrail({
      dir,
      enabled: true,
      now: () => new Date("2026-11-10T12:00:00Z"),
      syncImportant: false,
    });
    trail.decision({
      session: "sess-c",
      callId: "3",
      tool: "Bash",
      args: JSON.stringify({ command: "npm test" }),
      policy: "ask",
      by: "rules",
      agent: {
        id: "sub-9",
        kind: "subagent",
        role: "Explore",
        parentId: "main-sess-c",
      },
    });
    auditCommand("list", undefined, { dir, json: true, agent: "Explore" });
    const rows = JSON.parse(text());
    expect(rows.map((r: any) => r.callId)).toEqual(["3"]);
    expect(rows[0].agent.parentId).toBe("main-sess-c");
    stdout = [];

    expect(auditCommand("inbox", undefined, { dir })).toBe(0);
    const lines = text().trim().split(/\r?\n/);
    // the earlier ask in sess-b was refused, so only the open one waits
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Explore under main-sess-c");
    expect(lines[0]).toContain("npm test");
  });

  it("prints one line per call in the default form", () => {
    auditCommand(undefined, undefined, { dir });
    const lines = text().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("allow");
    expect(lines[1]).toContain("reviewer:haiku-test");
  });

  it("shows a session with its decisions", () => {
    expect(auditCommand("show", "sess-b", { dir })).toBe(0);
    expect(text()).toContain("ask by rules");
    expect(text()).toContain("deny by reviewer, model haiku-test, 700 ms");
  });

  it("shows raw records with --json and fails for an unknown session", () => {
    auditCommand("show", "sess-a", { dir, json: true });
    expect(JSON.parse(text()).map((r: any) => r.ev)).toEqual([
      "decision",
      "outcome",
    ]);
    expect(auditCommand("show", "nope", { dir })).toBe(1);
    expect(auditCommand("show", undefined, { dir })).toBe(2);
  });

  it("rejects a bad filter", () => {
    expect(auditCommand("list", undefined, { dir, decision: "maybe" })).toBe(2);
    expect(auditCommand("list", undefined, { dir, since: "tomorrow" })).toBe(2);
    expect(auditCommand("frobnicate", undefined, { dir })).toBe(2);
  });

  it("prunes files past the retention", () => {
    const file = path.join(dir, "2026-11", "sess-a.jsonl");
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(file, old, old);
    expect(
      auditCommand("prune", undefined, { dir, dryRun: true, days: 30 }),
    ).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    stdout = [];
    auditCommand("prune", undefined, { dir, days: 30, json: true });
    expect(JSON.parse(text()).deleted).toEqual([file]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(dir, "2026-11", "sess-b.jsonl"))).toBe(true);
  });
});
