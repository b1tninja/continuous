import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuditTrailForTests } from "../audit/global";
import { listChanges, readAuditSession } from "../audit/reader";
import { AuditTrail } from "../audit/trail";
import { taintRegistry } from "./taintState";
import { noteToolResult, untaintSession } from "./taintWiring";

/**
 * Every add and every clear of a taint label is an audit record with where it
 * came from and why (plans/research/taint-provenance-model.md section 7), so
 * a reader can tell when taint started being forgiven.
 */
let dir = "";
let auditDir = "";
let stamp = 0;
vi.mock("../../../util/paths", async (orig) => ({
  ...(await orig<typeof import("../../../util/paths")>()),
  getContinueGlobalPath: () => dir,
}));

function setRule(rule: "ask" | "off") {
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(
    file,
    `name: user\nversion: 1.0.0\ntoolPermissions:\n  auto:\n    environment:\n      taintedSessionRule: ${rule}\n`,
  );
  const when = new Date(Date.now() + 10_000 * ++stamp);
  fs.utimesSync(file, when, when);
}

const fetched = {
  toolName: "fetch_url_content",
  parsedArgs: { url: "https://a.example/page" },
};

const taintRecords = (session: string) =>
  readAuditSession(auditDir, session).filter(
    (r) => (r as { ev: string }).ev === "taint",
  ) as unknown as Array<Record<string, unknown>>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "taint-audit-"));
  auditDir = path.join(dir, "audit");
  taintRegistry.reset();
  setAuditTrailForTests(
    new AuditTrail({ dir: auditDir, enabled: true, syncImportant: false }),
  );
});
afterEach(() => {
  setAuditTrailForTests(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("taint labels in the audit trail", () => {
  it("records an add once, with the call that brought it and the turn", () => {
    setRule("ask");
    noteToolResult({ session: "s1", call: fetched, turn: 3 });
    noteToolResult({ session: "s1", call: fetched, turn: 5 });
    const recs = taintRecords("s1");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      ev: "taint",
      op: "add",
      label: "web-fetch",
      source: "fetch_url_content",
      reason: "tool-result",
      turn: 3,
    });
  });

  it("records a clear per label, with the reason and who cleared it", () => {
    setRule("ask");
    noteToolResult({ session: "s1", call: fetched });
    noteToolResult({
      session: "s1",
      call: { toolName: "search_issues", parsedArgs: {}, mcp: true },
    });
    untaintSession("s1", "untaint-command", "/untaint");
    const clears = taintRecords("s1").filter((r) => r.op === "clear");
    expect(clears.map((r) => r.label).sort()).toEqual(
      ["mcp-result", "web-fetch"].sort(),
    );
    for (const c of clears) {
      expect(c).toMatchObject({
        reason: "untaint-command",
        source: "/untaint",
      });
    }
  });

  it("lists clears among the changes, as loosening", () => {
    setRule("ask");
    noteToolResult({ session: "s1", call: fetched });
    untaintSession("s1", "user-ack", "approval card");
    const rows = listChanges(auditDir).filter((r) => r.ev === "taint");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "taint", loosens: false });
    expect(rows[1]).toMatchObject({ kind: "taint", loosens: true });
    expect(rows[1].summary).toContain("clear web-fetch");
    expect(rows[1].summary).toContain("user-ack");
  });

  it("records what a subagent hands back, and what a child inherits", () => {
    setRule("ask");
    noteToolResult({ session: "parent", call: fetched });
    taintRegistry.fork("parent", "child");
    expect(taintRecords("child")[0]).toMatchObject({
      op: "add",
      label: "web-fetch",
      reason: "inherited",
    });
    noteToolResult({
      session: "child",
      call: { toolName: "x", parsedArgs: {}, mcp: true },
    });
    taintRegistry.join("child", "parent");
    const parentAdds = taintRecords("parent").filter((r) => r.op === "add");
    expect(parentAdds.map((r) => [r.label, r.reason])).toEqual([
      ["web-fetch", "tool-result"],
      ["mcp-result", "subagent"],
    ]);
  });

  it("writes nothing while the rule is off (the default)", () => {
    setRule("off");
    noteToolResult({ session: "s1", call: fetched });
    untaintSession("s1", "untaint-command", "/untaint");
    expect(taintRecords("s1")).toEqual([]);
  });

  it("a clear of a clean session writes nothing", () => {
    setRule("ask");
    untaintSession("s1", "new-session");
    expect(taintRecords("s1")).toEqual([]);
  });
});
