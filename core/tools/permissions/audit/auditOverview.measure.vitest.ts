import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASK_CASES, DENY_CASES, EVAL_CASES } from "../auto/evaluation/cases";
import { parseDataset } from "../auto/evaluation/reviewEvalDataset";
import type { RuleSourcesInput } from "../effectiveRules";
import { testToolCall } from "../testToolCall";
import { readIndex, updateIndex } from "./auditIndex";
import {
  decisionEvent,
  jsonl,
  resetSeq,
  sessionFile,
  T0,
} from "./auditIndexFixtures";
import { auditOverview } from "./overviewHandler";

/**
 * ROADMAP B70, with made-up data only: how many calls ask per 100 before and
 * after the rules the page's most-asked list offers, replayed offline over a
 * synthetic trace built from the 287-case corpus; and how long the page's data
 * call takes with 500 rules and a 100 MB audit directory. The figures are
 * printed so a run can be read; the assertions have slack for slow CI.
 */
const NOW = new Date(T0 + 3 * 86_400_000);
const CWD = "/home/dev/shop";
const SOURCES: RuleSourcesInput = {
  levels: {
    context: "cautious",
    tools: "cautious",
    edits: "cautious",
    plan: "cautious",
    questions: "cautious",
  } as never,
};
const RULE_NAME: Record<string, string> = {
  run_terminal_command: "runTerminalCommand",
  read_file: "readFile",
};

const starter = parseDataset(
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "auto",
      "evaluation",
      "datasets",
      "reviewer-starter.json",
    ),
    "utf8",
  ),
);
const dangerous = new Set([...DENY_CASES, ...ASK_CASES].map((c) => c.id));
const cases = [
  ...EVAL_CASES.map((c) => ({
    id: c.id,
    tool: c.tool as string,
    args: c.args as Record<string, unknown>,
    expect: c.expect as string,
  })),
  ...starter.cases.map((c) => ({
    id: c.id,
    tool: c.tool as string,
    args: c.args as Record<string, unknown>,
    expect: c.expected as string,
  })),
];

function decide(
  c: (typeof cases)[number],
  sources: RuleSourcesInput,
): { decision: string; source?: string } {
  const a = c.args;
  const r = testToolCall({
    tool: c.tool,
    ...(typeof a.command === "string" ? { command: a.command } : {}),
    ...(typeof a.filepath === "string" ? { path: a.filepath } : {}),
    ...(typeof a.url === "string" ? { url: a.url } : {}),
    sources,
    cwd: CWD,
  } as never);
  return { decision: r.decision, source: r.source };
}

describe("asks per 100 calls, before and after the most-asked rules", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-measure-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls, and no call the corpus labels deny or ask starts to run", async () => {
    resetSeq();
    // Assumption, stated: an ordinary call (labelled allow) is made 6 times,
    // a risky one once. The person answers allow to ordinary calls and deny
    // to the rest. Whatever the real evaluator asks about is asked.
    const calls: (typeof cases)[number][] = [];
    for (const c of cases) {
      const reps = c.expect === "allow" ? 6 : 1;
      for (let i = 0; i < reps; i++) calls.push(c);
    }
    const events: unknown[] = [];
    let before = 0;
    for (const c of calls) {
      const base = decide(c, SOURCES);
      const id = `c${events.length}`;
      if (base.decision === "ask") {
        before++;
        events.push(
          decisionEvent(id, c.tool, c.args, { source: base.source }),
          decisionEvent(id, c.tool, c.args, {
            policy: c.expect === "allow" ? "allow" : "deny",
            by: "person",
            source: undefined,
          }),
        );
      } else {
        events.push(
          decisionEvent(id, c.tool, c.args, {
            policy: base.decision as "allow" | "deny",
            source: base.source,
          }),
        );
      }
    }
    fs.writeFileSync(sessionFile(dir, "2026-11", "trace"), jsonl(events));
    updateIndex(dir, { now: NOW });

    const o = await auditOverview(
      { rules: [] },
      {
        sources: async () => SOURCES,
        cwd: async () => CWD,
        dir: () => dir,
        now: () => NOW,
      },
    );
    const allow = o.mostAsked.filter((r) => r.answer === "allow");
    const deny = o.mostAsked.filter((r) => r.answer === "deny");
    const after = {
      ...SOURCES,
      user: { allow: allow.map((r) => r.rule), deny: deny.map((r) => r.rule) },
    } as RuleSourcesInput;
    let asksAfter = 0;
    const loosened: string[] = [];
    for (const c of calls) {
      const was = decide(c, SOURCES).decision;
      const now = decide(c, after).decision;
      if (now === "ask") asksAfter++;
      if (c.expect !== "allow" && now === "allow" && was !== "allow") {
        loosened.push(`${c.id}`);
      }
    }
    const per100 = (n: number) => Math.round((n / calls.length) * 1000) / 10;
    console.log(
      `[B70] calls=${calls.length} asks before=${before} (${per100(before)} per 100) ` +
        `after=${asksAfter} (${per100(asksAfter)} per 100) rules offered=${o.mostAsked.length}`,
    );
    expect(cases).toHaveLength(287);
    expect(loosened).toEqual([]);
    expect(asksAfter).toBeLessThan(before);
    expect(o.mostAsked.length).toBeLessThanOrEqual(10);
    void RULE_NAME;
  });
});

describe("the page's data call with 500 rules and a 100 MB audit directory", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-perf-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the index, not the trail", async () => {
    resetSeq();
    // One ~1 MB block of fake lines, written 100 times over 5 session files
    let block = "";
    for (let i = 0; block.length < 1024 * 1024; i++) {
      const command = `npm run lint src/f${i % 400}.ts`;
      const id = `p${i}`;
      block += jsonl([
        decisionEvent(id, "run_terminal_command", { command }),
        decisionEvent(
          id,
          "run_terminal_command",
          { command },
          {
            policy: "allow",
            by: "person",
            source: undefined,
          },
        ),
      ]);
    }
    for (let f = 0; f < 5; f++) {
      const fd = fs.openSync(sessionFile(dir, "2026-11", `big${f}`), "w");
      for (let n = 0; n < 20; n++) fs.writeSync(fd, block);
      fs.closeSync(fd);
    }
    const bytes = fs
      .readdirSync(path.join(dir, "2026-11"))
      .reduce((n, f) => n + fs.statSync(path.join(dir, "2026-11", f)).size, 0);
    expect(bytes).toBeGreaterThan(100 * 1024 * 1024);

    const t0 = performance.now();
    const built = updateIndex(dir, { now: NOW, maxBytes: 200 * 1024 * 1024 });
    const buildMs = performance.now() - t0;
    expect(built.index.complete).toBe(true);
    expect(built.stats.bytesRead).toBe(bytes);

    const t1 = performance.now();
    const again = updateIndex(dir, { now: NOW });
    const idleMs = performance.now() - t1;
    expect(again.stats.bytesRead).toBe(0);

    const rules = Array.from(
      { length: 500 },
      (_, i) => `runTerminalCommand(tool${i} *)`,
    );
    const sources: RuleSourcesInput = {
      ...SOURCES,
      user: { allow: rules },
    };
    const host = {
      sources: async () => sources,
      cwd: async () => CWD,
      dir: () => dir,
      now: () => NOW,
    };
    // The first call judges rows with the real evaluator (under a time budget)
    const tc = performance.now();
    await auditOverview({ rules }, host);
    const coldMs = performance.now() - tc;
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const o = await auditOverview({ rules }, host);
      runs.push(performance.now() - t);
      expect(Object.keys(o.rules)).toHaveLength(500);
    }
    runs.sort((a, b) => a - b);
    const indexKB = Math.round(
      fs.statSync(path.join(dir, "audit-index.json")).size / 1024,
    );
    console.log(
      `[B70] trail=${Math.round(bytes / 1048576)} MB, index=${indexKB} KB, ` +
        `first build=${Math.round(buildMs)} ms, idle update=${Math.round(idleMs)} ms, ` +
        `page data call (500 rules) first=${Math.round(coldMs)} ms, then median=${Math.round(runs[2])} ms, max=${Math.round(runs[4])} ms`,
    );
    expect(readIndex(dir)?.complete).toBe(true);
    // The target is 200 ms; CI machines get a wide margin
    expect(coldMs).toBeLessThan(1000);
    expect(runs[2]).toBeLessThan(1000);
  }, 180_000);
});
