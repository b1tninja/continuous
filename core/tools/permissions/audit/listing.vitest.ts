import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditCallDetail,
  auditInboxPage,
  auditListPage,
  LIST_PAGE_MAX,
  suggestedRuleFor,
} from "./listing";
import { registerAuditListHandlers } from "./listingHandlers";
import { decisionDraft, outcomeDraft, type AuditAgent } from "./record";
import { AuditWriter } from "./writer";

let dir: string;
const NOW = new Date("2026-11-11T12:00:00Z");
const at = (minutesAgo: number) =>
  new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-listing-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every file under `dir`, relative, without `recursive` (older type libraries lack it). */
function allFiles(root: string, rel = ""): string[] {
  return fs
    .readdirSync(path.join(root, rel), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? allFiles(root, path.join(rel, e.name))
        : [path.join(rel, e.name)],
    );
}

interface Call {
  session?: string;
  id: string;
  tool?: string;
  args?: string;
  policy?: "allow" | "ask" | "deny";
  by?: "rules" | "reviewer" | "person" | "system";
  agent?: AuditAgent;
  minutesAgo: number;
  outcome?: boolean;
  reason?: string;
}

function write(calls: Call[]) {
  const w = new AuditWriter({ dir, now: () => NOW });
  for (const c of calls) {
    const session = c.session ?? "s1";
    w.write({
      ...decisionDraft({
        session,
        callId: c.id,
        tool: c.tool ?? "runTerminalCommand",
        args: c.args ?? "ls",
        policy: c.policy ?? "allow",
        by: c.by ?? "rules",
        agent: c.agent,
        reason: c.reason,
      }),
      ts: at(c.minutesAgo),
    });
    if (c.outcome) {
      w.write({
        ...outcomeDraft({
          session,
          callId: c.id,
          tool: c.tool ?? "runTerminalCommand",
          ran: true,
          exit: 0,
          output: "ok",
        }),
        ts: at(c.minutesAgo - 1),
      });
    }
  }
}

describe("auditListPage", () => {
  it("lists newest first and pages with a cursor that names a place", () => {
    write(
      Array.from({ length: 7 }, (_, i) => ({
        id: `c${i}`,
        minutesAgo: 70 - i,
      })),
    );
    const first = auditListPage(dir, { limit: 3 });
    expect(first.rows.map((r) => r.callId)).toEqual(["c6", "c5", "c4"]);
    expect(first.nextCursor).toBeDefined();
    const second = auditListPage(dir, { limit: 3, cursor: first.nextCursor });
    expect(second.rows.map((r) => r.callId)).toEqual(["c3", "c2", "c1"]);
    const third = auditListPage(dir, { limit: 3, cursor: second.nextCursor });
    expect(third.rows.map((r) => r.callId)).toEqual(["c0"]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("never returns more than the page cap, whatever is asked", () => {
    write(
      Array.from({ length: LIST_PAGE_MAX + 20 }, (_, i) => ({
        id: `c${i}`,
        minutesAgo: 500 - i,
      })),
    );
    expect(auditListPage(dir, { limit: 100000 }).rows).toHaveLength(
      LIST_PAGE_MAX,
    );
    expect(auditListPage(dir, { limit: -5 }).rows).toHaveLength(1);
    expect(auditListPage(dir, {}).rows).toHaveLength(50);
  });

  it("filters by decision, tool and agent, and a missing agent is main", () => {
    const sub: AuditAgent = {
      id: "sub-1",
      kind: "subagent",
      role: "Explore",
      parentId: "main-s1",
    };
    const worker: AuditAgent = { id: "worker-3", kind: "loop-worker" };
    write([
      { id: "old", minutesAgo: 50 }, // no agent: before #576
      {
        id: "main",
        minutesAgo: 40,
        agent: { id: "main-s1", kind: "main" },
        policy: "deny",
      },
      { id: "sub", minutesAgo: 30, agent: sub, tool: "readFile" },
      { id: "wrk", minutesAgo: 20, agent: worker, by: "reviewer" },
    ]);
    const ids = (r: Parameters<typeof auditListPage>[1]) =>
      auditListPage(dir, r).rows.map((x) => x.callId);
    expect(ids({ agent: "main" }).sort()).toEqual(["main", "old"]);
    expect(ids({ agent: "Explore" })).toEqual(["sub"]);
    expect(ids({ agent: "loop-worker" })).toEqual(["wrk"]);
    expect(ids({ decision: "deny" })).toEqual(["main"]);
    expect(ids({ decision: "reviewer" })).toEqual(["wrk"]);
    expect(ids({ tool: "readFile" })).toEqual(["sub"]);
    const facets = auditListPage(dir).facets;
    expect(facets.agents).toEqual(["Explore", "loop-worker", "main"]);
    expect(facets.tools).toEqual(["readFile", "runTerminalCommand"]);
  });

  it("returns masked text only, and masks again", () => {
    write([
      {
        id: "c1",
        minutesAgo: 5,
        args: "curl -H 'Authorization: Bearer abcdef1234567890abcdef' x",
        reason: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 seen",
      },
    ]);
    const res = JSON.stringify(auditListPage(dir));
    expect(res).not.toContain("abcdef1234567890abcdef");
    expect(res).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    // A record whose file somehow holds an unmasked secret is masked on the way out
    const file = allFiles(dir).find((f) => f.endsWith(".jsonl"))!;
    const full = path.join(dir, file);
    const lines = fs
      .readFileSync(full, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    lines[0].argsMasked =
      "echo AKIAABCDEFGHIJKLMNOP and password=hunter2hunter2";
    lines[0].reason = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    fs.writeFileSync(
      full,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    const out = JSON.stringify(auditListPage(dir));
    expect(out).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  });

  it("says when a read limit made the figures partial", () => {
    write(
      Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        minutesAgo: 30 - i,
      })),
    );
    const res = auditListPage(dir, {}, { limits: { maxRows: 4 } });
    expect(res.partial).toBe("rows");
    expect(res.rows.length).toBeLessThanOrEqual(4);
  });

  it("is empty for a directory that does not exist", () => {
    const res = auditListPage(path.join(dir, "nope"));
    expect(res.rows).toEqual([]);
    expect(res.facets.agents).toEqual(["main"]);
  });
});

describe("auditInboxPage", () => {
  const asks: Call[] = [
    { id: "dead", session: "dead", minutesAgo: 60 * 30, policy: "ask" },
    { id: "stale", session: "stale", minutesAgo: 60 * 3, policy: "ask" },
    { id: "fresh", session: "live", minutesAgo: 2, policy: "ask" },
    {
      id: "answered",
      session: "live",
      minutesAgo: 90,
      policy: "ask",
      outcome: true,
    },
    { id: "allowed", session: "live", minutesAgo: 90, policy: "allow" },
  ];

  it("lists open asks oldest first and hides those older than 24 hours", () => {
    write(asks);
    const res = auditInboxPage(dir, {}, { now: NOW });
    expect(res.items.map((i) => i.callId)).toEqual(["stale", "fresh"]);
    expect(res.hiddenOlder).toBe(1);
    expect(res.maxAgeHours).toBe(24);
    const all = auditInboxPage(dir, { includeOlder: true }, { now: NOW });
    expect(all.items.map((i) => i.callId)).toEqual(["dead", "stale", "fresh"]);
    expect(all.hiddenOlder).toBe(0);
    expect(all.maxAgeHours).toBeUndefined();
  });

  it("flags an old ask whose session file has not been written for a while", () => {
    write([{ id: "old", session: "gone", minutesAgo: 120, policy: "ask" }]);
    for (const f of allFiles(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const t = new Date(NOW.getTime() - 100 * 60_000);
      fs.utimesSync(path.join(dir, f), t, t);
    }
    const res = auditInboxPage(dir, {}, { now: NOW });
    expect(res.items[0].possiblyEnded).toBe(true);
    expect(res.items[0].ageMs).toBe(120 * 60_000);
  });

  it("pages oldest first and filters by agent, main included", () => {
    write([
      { id: "a", minutesAgo: 50, policy: "ask" },
      {
        id: "b",
        minutesAgo: 40,
        policy: "ask",
        agent: { id: "sub-9", kind: "subagent", role: "Explore" },
      },
      { id: "c", minutesAgo: 30, policy: "ask" },
    ]);
    const p1 = auditInboxPage(dir, { limit: 2 }, { now: NOW });
    expect(p1.items.map((i) => i.callId)).toEqual(["a", "b"]);
    const p2 = auditInboxPage(
      dir,
      { limit: 2, cursor: p1.nextCursor },
      { now: NOW },
    );
    expect(p2.items.map((i) => i.callId)).toEqual(["c"]);
    expect(
      auditInboxPage(dir, { agent: "main" }, { now: NOW }).items.map(
        (i) => i.callId,
      ),
    ).toEqual(["a", "c"]);
    expect(
      auditInboxPage(dir, { agent: "Explore" }, { now: NOW }).items.map(
        (i) => i.callId,
      ),
    ).toEqual(["b"]);
  });

  it("suggests the narrow Always rule only when the arguments are plain", () => {
    expect(
      suggestedRuleFor(
        "run_terminal_command",
        JSON.stringify({ command: "git push origin x" }),
      ),
    ).toBe("runTerminalCommand(git push origin x)");
    expect(
      suggestedRuleFor(
        "run_terminal_command",
        JSON.stringify({ command: "rm -rf *" }),
      ),
    ).toBeUndefined();
    expect(
      suggestedRuleFor("run_terminal_command", '{"command":"echo «secret»"}'),
    ).toBeUndefined();
    expect(
      suggestedRuleFor("run_terminal_command", "not json"),
    ).toBeUndefined();
    expect(suggestedRuleFor("run_terminal_command", "[1]")).toBeUndefined();
  });

  it("puts the suggestion on the item", () => {
    write([
      {
        id: "p",
        minutesAgo: 5,
        policy: "ask",
        tool: "run_terminal_command",
        args: JSON.stringify({ command: "make build" }),
      },
    ]);
    expect(auditInboxPage(dir, {}, { now: NOW }).items[0].suggestedRule).toBe(
      "runTerminalCommand(make build)",
    );
  });
});

describe("auditCallDetail", () => {
  it("returns the call with its decisions and outcome, masked", () => {
    write([
      { id: "c1", minutesAgo: 20, policy: "ask", by: "rules", reason: "level" },
    ]);
    const w = new AuditWriter({ dir, now: () => NOW });
    w.write({
      ...decisionDraft({
        session: "s1",
        callId: "c1",
        tool: "runTerminalCommand",
        args: "ls",
        policy: "allow",
        by: "person",
      }),
      ts: at(19),
    });
    w.write({
      ...outcomeDraft({
        session: "s1",
        callId: "c1",
        tool: "runTerminalCommand",
        ran: true,
        exit: 2,
        output: "x",
        error: "boom at C:/Users/jane/key",
      }),
      ts: at(18),
    });
    const d = auditCallDetail(dir, { session: "s1", callId: "c1" });
    expect(d?.policy).toBe("allow");
    expect(d?.by).toBe("person");
    expect(d?.asked).toBe(true);
    expect(d?.decisions.map((x) => x.by)).toEqual(["rules", "person"]);
    expect(d?.outcome?.exit).toBe(2);
    expect(d?.argsMasked).toContain("ls");
  });

  it("returns undefined for an unknown call or a malformed request", () => {
    write([{ id: "c1", minutesAgo: 5 }]);
    expect(
      auditCallDetail(dir, { session: "s1", callId: "zz" }),
    ).toBeUndefined();
    expect(auditCallDetail(dir, { session: "nope", callId: "c1" })).toBe(
      undefined,
    );
    expect(auditCallDetail(dir, undefined as never)).toBeUndefined();
  });
});

describe("registerAuditListHandlers", () => {
  it("answers the four messages and writes nothing", async () => {
    write([{ id: "c1", minutesAgo: 5, policy: "ask" }]);
    const handlers = new Map<string, (m: { data: any }) => Promise<unknown>>();
    registerAuditListHandlers((n, h) => void handlers.set(n, h), {
      dir: () => dir,
      status: () => ({ enabled: true, retentionDays: 30, via: "default" }),
      now: () => NOW,
    });
    expect([...handlers.keys()].sort()).toEqual([
      "audit/get",
      "audit/inbox",
      "audit/list",
      "audit/status",
    ]);
    const before = allFiles(dir).length;
    const list: any = await handlers.get("audit/list")!({ data: undefined });
    expect(list.rows).toHaveLength(1);
    const inbox: any = await handlers.get("audit/inbox")!({ data: {} });
    expect(inbox.items).toHaveLength(1);
    const got: any = await handlers.get("audit/get")!({
      data: { session: "s1", callId: "c1" },
    });
    expect(got.callId).toBe("c1");
    expect(
      await handlers.get("audit/get")!({
        data: { session: "s1", callId: "x" },
      }),
    ).toBeNull();
    expect(
      ((await handlers.get("audit/status")!({ data: undefined })) as any).via,
    ).toBe("default");
    expect(allFiles(dir).length).toBe(before);
  });
});
