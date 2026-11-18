import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mainAgentId, subagentRunToNode } from "../../../agents/fromRuns";
import { canarySecrets } from "../../../util/secretScan/canary";
import { recordPolicyDecision } from "./hook";
import {
  backgroundAuditAgent,
  loopWorkerAuditAgent,
  mainAuditAgent,
  subagentAuditAgent,
} from "./identity";
import { describeAgent, listInbox } from "./inbox";
import { callRows, listCalls, readAuditSession } from "./reader";
import { auditAgentOf } from "./record";
import { AuditTrail } from "./trail";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-identity-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = "2026-11-10T12:00:00.000Z";
const trail = () =>
  new AuditTrail({
    dir,
    enabled: true,
    now: () => new Date(T0),
    syncImportant: false,
  });

const ctx = (callId: string, agent?: ReturnType<typeof mainAuditAgent>) => ({
  session: "s1",
  callId,
  toolName: "run_terminal_command",
  parsedArgs: { command: "npm test" },
  ...(agent ? { agent } : {}),
});
const ask = { policy: "allowedWithPermission" as const };

describe("agent identity in the audit record", () => {
  it("ids match the agent map's", () => {
    const node = subagentRunToNode(
      { agent: "Explore", status: "running", toolCalls: [] } as never,
      { toolCallId: "call_1", rootId: mainAgentId("s1"), parentId: "p" },
    );
    expect(subagentAuditAgent("s1", "call_1", "Explore").id).toBe(node.id);
    expect(mainAuditAgent("s1").id).toBe(mainAgentId("s1"));
    expect(loopWorkerAuditAgent("s1", "3").id).toBe("worker-3");
  });

  it("a loop worker carries the mode it runs in, not the word loop", () => {
    expect(loopWorkerAuditAgent("s1", "3")).toEqual({
      id: "worker-3",
      kind: "loop-worker",
      role: "item 3",
      mode: "agent",
      toolRole: "agent",
      parentId: "main-s1",
    });
    expect(loopWorkerAuditAgent("s1", "3", "plan").mode).toBe("plan");
  });

  it("a background agent has its own kind, id, mode and parent", () => {
    const a = backgroundAuditAgent("s1", "t9");
    expect(a).toEqual({
      id: "bg-t9",
      kind: "background",
      role: "background task",
      mode: "background",
      toolRole: "background",
      parentId: "main-s1",
    });
    expect(auditAgentOf(a)).toEqual(a);
  });

  it("the sanitiser clips and masks the new fields like the others", () => {
    const a = auditAgentOf(
      backgroundAuditAgent(
        "s1",
        "t9",
        `Bearer ${"x".repeat(200)} token=abcd1234zzzz`,
      ),
    )!;
    expect(a.role!.length).toBeLessThan(120);
    expect(JSON.stringify(a)).not.toContain("abcd1234zzzz");
    expect(
      auditAgentOf({ id: "x", kind: "bogus" as never, parentId: "m" })?.kind,
    ).toBe("subagent");
  });

  it("writes who made the call on the decision and the outcome", () => {
    const t = trail();
    const agent = subagentAuditAgent("s1", "call_1", "Explore", "agent");
    recordPolicyDecision(t, ctx("c1", agent), "allowedWithPermission", {
      policy: "allowedWithoutPermission",
    });
    t.outcome({ callId: "c1", ran: true, exit: 0 });
    const [row] = callRows(readAuditSession(dir, "s1"));
    expect(row.agent).toEqual({
      id: "sub-call_1",
      kind: "subagent",
      role: "Explore",
      mode: "agent",
      toolRole: "agent",
      parentId: "main-s1",
    });
    expect(row.decisions[0].mode).toBe("agent");
    expect(row.outcome?.agent?.role).toBe("Explore");
  });

  it("a call with no identity writes none, and a bad kind becomes subagent", () => {
    const t = trail();
    recordPolicyDecision(t, ctx("c1"), "allowedWithPermission", ask as never);
    const [row] = callRows(readAuditSession(dir, "s1"));
    expect("agent" in row).toBe(false);
    expect(
      auditAgentOf({ id: "x", kind: "bogus", extra: "p" } as never),
    ).toEqual({ id: "x", kind: "subagent" });
    expect(auditAgentOf({ id: "" } as never)).toBeUndefined();
  });

  it("never lets a secret in a role reach the file", () => {
    const t = trail();
    const secret = canarySecrets().anthropicKey;
    const agent = subagentAuditAgent("s1", "c", `agent ${secret}`);
    recordPolicyDecision(
      t,
      ctx("c1", agent),
      "allowedWithPermission",
      ask as never,
    );
    const text = fs
      .readdirSync(path.join(dir, "2026-11"))
      .map((f) => fs.readFileSync(path.join(dir, "2026-11", f), "utf8"))
      .join("");
    expect(text).not.toContain(secret);
    expect(text).toContain("masked");
  });

  it("filters rows by the agent's role, id or kind", () => {
    const t = trail();
    recordPolicyDecision(
      t,
      ctx("c1", mainAuditAgent("s1")),
      "allowedWithPermission",
      ask as never,
    );
    recordPolicyDecision(
      t,
      ctx("c2", subagentAuditAgent("s1", "k", "Explore")),
      "allowedWithPermission",
      ask as never,
    );
    expect(listCalls(dir, { agent: "Explore" }).map((r) => r.callId)).toEqual([
      "c2",
    ]);
    expect(listCalls(dir, { agent: "main" }).map((r) => r.callId)).toEqual([
      "c1",
    ]);
    expect(listCalls(dir, { agent: "sub-k" })).toHaveLength(1);
  });
});

describe("the inbox", () => {
  it("lists asks with no answer and names the agent waiting", () => {
    const t = trail();
    const sub = subagentAuditAgent("s1", "k", "Explore", "agent");
    recordPolicyDecision(
      t,
      ctx("c1", sub),
      "allowedWithPermission",
      ask as never,
    );
    recordPolicyDecision(
      t,
      ctx("c2", mainAuditAgent("s1")),
      "allowedWithPermission",
      ask as never,
    );
    recordPolicyDecision(t, ctx("c3"), "allowedWithPermission", {
      policy: "allowedWithoutPermission",
      source: "allow-rule",
    });
    t.answer("c2", true);
    t.outcome({ callId: "c2", ran: true });
    const items = listInbox(dir);
    expect(items.map((i) => i.callId)).toEqual(["c1"]);
    expect(describeAgent(items[0].agent)).toBe("Explore [agent] under main-s1");
    expect(describeAgent(undefined)).toBe("unknown agent");
  });

  it("a refused ask leaves the inbox, and age cuts the list", () => {
    const t = trail();
    recordPolicyDecision(t, ctx("c1"), "allowedWithPermission", ask as never);
    expect(listInbox(dir)).toHaveLength(1);
    expect(
      listInbox(
        dir,
        {},
        { now: new Date("2026-11-12T00:00:00Z"), maxAgeMs: 3600_000 },
      ),
    ).toHaveLength(0);
    t.answer("c1", false);
    expect(listInbox(dir)).toHaveLength(0);
  });
});

describe("the role the tool table applied", () => {
  it("is recorded for each kind of agent, from its mode", () => {
    expect(mainAuditAgent("s1", "plan").toolRole).toBe("planner");
    expect(mainAuditAgent("s1", "agent").toolRole).toBe("agent");
    expect(mainAuditAgent("s1").toolRole).toBeUndefined();
    expect(subagentAuditAgent("s1", "c1", "Explore", "plan").toolRole).toBe(
      "planner",
    );
    expect(loopWorkerAuditAgent("s1", "i1").toolRole).toBe("agent");
    expect(backgroundAuditAgent("s1", "t1").toolRole).toBe("background");
  });

  it("survives the copy a record makes of an agent", () => {
    expect(auditAgentOf(mainAuditAgent("s1", "plan"))?.toolRole).toBe(
      "planner",
    );
  });
});
