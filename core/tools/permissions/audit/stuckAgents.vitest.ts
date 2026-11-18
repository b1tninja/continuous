import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loopWorkerToNode } from "../../../agents/fromRuns";
import { STUCK_NOTE_MARK } from "../../../util/stuckNotes";
import {
  loopWorkerAgentId,
  loopWorkerAuditAgent,
  LOOP_WORKER_MODE,
} from "./identity";
import { decisionDraft, outcomeDraft, type AuditAgent } from "./record";
import { agentLabel, stuckAgentNoteOf, stuckAgents } from "./stuckAgents";
import { AuditWriter, readAuditFile } from "./writer";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-stuck-agents-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const main: AuditAgent = { id: "main-s", kind: "main" };
const sub: AuditAgent = { id: "sub-c9", kind: "subagent", role: "Explore" };

/** One failing call per entry, each as [agent, turn, command]. */
function write(calls: [AuditAgent | undefined, number, string][]) {
  const w = new AuditWriter({
    dir,
    now: () => new Date("2026-11-10T12:00:00Z"),
  });
  calls.forEach(([agent, turn, command], i) => {
    const callId = `c${i}`;
    const base = { session: "s", turn, callId, tool: "Bash", agent };
    w.write(
      decisionDraft({
        ...base,
        args: JSON.stringify({ command }),
        policy: "allow",
        by: "rules",
      }),
    );
    w.write(
      outcomeDraft({
        ...base,
        ran: true,
        exit: 1,
        output: "",
        error: "Error: Cannot find module 'x'",
      }),
    );
  });
  return readAuditFile(path.join(dir, "2026-11", "s.jsonl"));
}

describe("stuck agents", () => {
  it("names a subagent that repeats while the main agent is busy", () => {
    const records = write([
      [sub, 1, "npm test --silent"],
      [main, 1, "ls"],
      [sub, 2, "npm test --verbose"],
      [main, 2, "pwd"],
    ]);
    const found = stuckAgents(records);
    expect(found.map((a) => a.id)).toEqual(["sub-c9"]);
    expect(found[0].label).toBe("Explore (sub-c9)");
    const note = stuckAgentNoteOf(records)!;
    expect(note.startsWith(STUCK_NOTE_MARK)).toBe(true);
    expect(note).toContain("Agent Explore (sub-c9) (not the main agent)");
    expect(note).toContain("same error");
  });

  it("does not name the main agent, nor an agent that is not repeating", () => {
    expect(
      stuckAgents(
        write([
          [main, 1, "npm test --silent"],
          [main, 2, "npm test --verbose"],
          [sub, 1, "ls"],
        ]),
      ),
    ).toEqual([]);
  });

  it("treats a record with no agent as the main agent", () => {
    expect(
      stuckAgents(
        write([
          [undefined, 1, "npm test --silent"],
          [undefined, 2, "npm test --verbose"],
        ]),
      ),
    ).toEqual([]);
  });

  it("masks the label: a secret in a role does not reach the note", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const label = agentLabel("worker-1", {
      id: "worker-1",
      kind: "loop-worker",
      role: `item ${secret}`,
    });
    expect(label).not.toContain(secret);
  });

  it("names a Loop worker by its item", () => {
    const worker = loopWorkerAuditAgent("s", "3");
    const records = write([
      [worker, 1, "npm test --silent"],
      [worker, 2, "npm test --verbose"],
    ]);
    expect(stuckAgents(records)[0].label).toBe("item 3 (worker-3)");
  });
});

describe("the Loop worker is one identity in the map and in the audit record", () => {
  it("agree on id, kind, role and mode", () => {
    const node = loopWorkerToNode(
      { itemId: "3", worktree: "/w/item-3", startedAt: "2026-11-10T10:00:00Z" },
      { rootId: "main-s", parentId: "main-s" },
    );
    const agent = loopWorkerAuditAgent("s", "3");
    expect(node.id).toBe(agent.id);
    expect(node.id).toBe(loopWorkerAgentId("3"));
    expect(node.kind).toBe(agent.kind);
    expect(node.role).toBe(agent.role);
    expect(node.mode).toBe(agent.mode);
    expect(node.mode).toBe(LOOP_WORKER_MODE);
    expect(node.parentId).toBe(agent.parentId);
  });
});
