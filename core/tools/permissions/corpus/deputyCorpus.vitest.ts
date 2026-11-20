import { describe, expect, it } from "vitest";
import { deputyCallHit } from "../deputyCall";
import type { PolicyLevel } from "../policy";
import { testToolCall, type TestDecision } from "../testToolCall";
import { getBaseToolDefinitions } from "../../index";
import { ROWS, type Row } from "./corpusRows";

// protected-edits-06 edits /etc/hosts: labelled ask, and a floor case.
// context-secrets-08 reads ~/.bash_history. With ask-outside-paths off the file
// tools no longer ask for a path outside the workspace by themselves either
// (core/tools/policies/fileAccess.ts), so the switch accounts for both reads
// and writes; before, only the write showed up here because the read was
// still asked by the tool's own hidden check.
const EXPECTED_NEW_ASKS = ["context-secrets-08", "protected-edits-06"];
const EXPECTED_SCHEMA_ASKS: string[] = [];

/**
 * What the confused-deputy rule for the host file tools changes on the 287
 * labelled calls (ROADMAP piece 14): each call through the real evaluator with
 * `ask-outside-paths` off ("off") and on ("on"), at Permissive and at
 * Automatic. The corpus is mostly terminal commands, which this rule does not
 * read; the file-tool calls it does read are listed by id so a change shows.
 * The floors inside the rule (device paths, streams, the global folder) have
 * no switch, so they are counted straight from the path check.
 */
const LEVELS = (level: PolicyLevel) => ({
  context: level,
  tools: level,
  edits: level,
  plan: level,
  questions: level,
});
const ORDER = { allow: 0, ask: 1, deny: 2 } as const;

function decide(row: Row, level: PolicyLevel, deputy: "off" | "on") {
  return testToolCall({
    tool: row.tool,
    args: row.args,
    levels: LEVELS(level),
    sources: {
      user: { auto: { environment: { trustedDomains: row.trusted } } },
      ...(deputy === "off" ? { builtin: { "ask-outside-paths": false } } : {}),
    },
    cwd: "/home/dev/shop",
    shell: "bash",
  }).decision as TestDecision;
}

function measure(level: PolicyLevel) {
  const newAsks: string[] = [];
  const newDenies: string[] = [];
  const loosened: string[] = [];
  for (const row of ROWS) {
    const off = decide(row, level, "off");
    const on = decide(row, level, "on");
    if (off === "allow" && on === "ask") newAsks.push(row.id);
    if (off !== "deny" && on === "deny") newDenies.push(row.id);
    if (ORDER[on] < ORDER[off]) loosened.push(`${row.id}: ${off} -> ${on}`);
  }
  return { newAsks, newDenies, loosened };
}

describe("the confused-deputy rule on the 287 labelled calls", () => {
  it("covers all 287 calls", () => {
    expect(ROWS.length).toBe(287);
  });

  for (const level of ["permissive", "automatic"] as const) {
    it(`at ${level}: no call is loosened and none is newly refused`, () => {
      const m = measure(level);
      expect(m.loosened).toEqual([]);
      expect(m.newDenies).toEqual([]);
    });
  }

  it("at Permissive: new asks on file-tool calls only", () => {
    const m = measure("permissive");
    const fileTools = new Set(
      ROWS.filter((r) => r.tool !== "run_terminal_command").map((r) => r.id),
    );
    expect(m.newAsks.every((id) => fileTools.has(id))).toBe(true);
    expect(m.newAsks).toEqual(EXPECTED_NEW_ASKS);
  });

  it("at Automatic: the same call stops going to the reviewer model", () => {
    let reviewerOff = 0;
    let reviewerOn = 0;
    for (const row of ROWS) {
      const run = (deputy: "off" | "on") =>
        testToolCall({
          tool: row.tool,
          args: row.args,
          levels: LEVELS("automatic"),
          sources: {
            user: { auto: { environment: { trustedDomains: row.trusted } } },
            ...(deputy === "off"
              ? { builtin: { "ask-outside-paths": false } }
              : {}),
          },
          cwd: "/home/dev/shop",
          shell: "bash",
        }).wouldAskReviewer;
      if (run("off")) reviewerOff++;
      if (run("on")) reviewerOn++;
    }
    // WB45: fetches to trustedDomains hosts no longer reach the reviewer (5 calls)
    expect([reviewerOff, reviewerOn]).toEqual([188, 187]);
  });

  it("no corpus call trips a floor inside the rule", () => {
    const floors = ROWS.filter((r) => {
      const hit = deputyCallHit({
        toolName: r.tool,
        parsedArgs: r.args,
        cwd: "/home/dev/shop",
        home: "/home/dev",
        flavor: "posix",
        // Treat the path as inside the workspace: only the floors can fire.
        resolved: { withinWorkspace: true },
      });
      return hit !== undefined;
    }).map((r) => r.id);
    expect(floors).toEqual([]);
  });
});

/**
 * The schema evidence for MCP path arguments (mcpPathSchema.ts) on the same
 * 287 calls. The corpus has no MCP calls, so each row is replayed as if an
 * MCP tool had made it, with that tool's real built-in schema as the
 * `inputSchema`: "off" reads the names only (the rule before), "on" adds the
 * schema. The rule only ever returns an ask, so a new deny is impossible by
 * construction; the test counts asks and checks nothing is loosened.
 */
describe("MCP schema evidence on the 287 labelled calls", () => {
  const defs = new Map(
    getBaseToolDefinitions().map((t) => [t.function.name, t]),
  );
  const replay = (row: Row, withSchema: boolean) =>
    deputyCallHit({
      toolName: row.tool,
      parsedArgs: row.args,
      mcp: true,
      schema: withSchema ? defs.get(row.tool)?.function.parameters : undefined,
      cwd: "/home/dev/shop",
      home: "/home/dev",
      flavor: "posix",
    });

  it("adds asks only, never loosens, never denies", () => {
    const newAsks: string[] = [];
    const loosened: string[] = [];
    for (const row of ROWS) {
      const off = replay(row, false);
      const on = replay(row, true);
      if (!off && on) newAsks.push(row.id);
      if (off && !on) loosened.push(row.id);
    }
    expect(loosened).toEqual([]);
    expect(newAsks).toEqual(EXPECTED_SCHEMA_ASKS);
  });
});
