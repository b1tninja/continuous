import { describe, expect, it } from "vitest";
import { ROWS, type Row } from "../corpus/corpusRows";
import type { PolicyLevel } from "../policy";
import { testToolCall } from "../testToolCall";
import {
  formatReplay,
  replayTaint,
  type ReplayDecide,
  type ReplayMix,
  type ReplayOptions,
} from "./taintReplay";
import { SINK_CLASSES } from "./taintSinks";
import type { TaintFact } from "./taintState";

/**
 * ROADMAP X17, step one: how many extra asks the tainted-session rule causes,
 * replayed offline over synthetic traces sampled from the 287 labelled calls
 * with taint injected at several points. No audit directory is read and no
 * model is called. The tables are printed so a run can be read; the assertions
 * hold the properties that must never change (no call loosened, no refusal
 * changed, one decision per row without the fact).
 */
const FACT: TaintFact = { kinds: ["web-fetch"], firstTurn: 1 };
const LEVELS = (level: PolicyLevel) => ({
  context: level,
  tools: level,
  edits: level,
  plan: level,
  questions: level,
});

function engine(level: PolicyLevel): ReplayDecide<Row> {
  return (row, taint) => {
    const r = testToolCall({
      tool: row.tool,
      args: row.args,
      levels: LEVELS(level),
      sources: {
        user: { auto: { environment: { trustedDomains: row.trusted } } },
      },
      cwd: "/home/dev/shop",
      shell: "bash",
      ...(taint ? { taint } : {}),
    });
    return {
      decision: r.decision,
      ...(r.taintSink ? { sink: r.taintSink } : {}),
    };
  };
}

/** The corpus label as the baseline: what the whole system should come to, reviewer included. */
const labels: ReplayDecide<Row> = (row, taint) => {
  const engineSays = engine("cautious")(row, taint);
  const sink = engineSays.sink;
  return {
    decision: sink && row.expect === "allow" ? "ask" : row.expect,
    ...(sink ? { sink } : {}),
  };
};

const MIXES: ReplayMix[] = [
  { name: "corpus as labelled", weights: { allow: 135, ask: 50, deny: 102 } },
  { name: "benign-weighted", weights: { allow: 90, ask: 8, deny: 2 } },
];
const OPTIONS: ReplayOptions = {
  traceLength: 100,
  traces: 400,
  taintAt: [0, 0.25, 0.5, 0.75],
  mixes: MIXES,
  seed: 2026_11_11,
};

const VIEWS: [string, ReplayDecide<Row>][] = [
  ["labels", labels],
  ["cautious", engine("cautious")],
  ["permissive", engine("permissive")],
  ["idgaf", engine("idgaf")],
];

/** Per class, over the 287 rows once each: sinks, already asking, new asks. */
function rowTable(decide: ReplayDecide<Row>) {
  const out = Object.fromEntries(
    SINK_CLASSES.map((c) => [c, { sinks: 0, already: 0, fresh: 0 }]),
  );
  for (const row of ROWS) {
    const was = decide(row, undefined).decision;
    const now = decide(row, FACT);
    if (!now.sink || was === "deny") continue;
    out[now.sink.class].sinks++;
    if (was === "ask") out[now.sink.class].already++;
    else out[now.sink.class].fresh++;
  }
  return out;
}

describe("the tainted-session rule replayed on the 287 labelled calls", () => {
  it("covers all 287 calls", () => {
    expect(ROWS.length).toBe(287);
  });

  for (const [name, decide] of VIEWS) {
    it(`${name}: never loosens a call and never changes a refusal`, () => {
      const cells = replayTaint(ROWS, decide, FACT, OPTIONS);
      for (const c of cells) {
        expect(c.loosened).toBe(0);
        expect(c.deniesChanged).toBe(0);
      }
    });

    it(`${name}: prints the replay`, () => {
      const cells = replayTaint(ROWS, decide, FACT, OPTIONS);
      const rows = rowTable(decide);
      const total = Object.values(rows).reduce((n, c) => n + c.fresh, 0);
      console.log(
        `\n=== tainted-session replay, baseline: ${name} ===\n` +
          `per row (287 rows once each), sinks / already ask / new asks: ` +
          Object.entries(rows)
            .filter(([, c]) => c.sinks > 0)
            .map(([k, c]) => `${k} ${c.sinks}/${c.already}/${c.fresh}`)
            .join(", ") +
          `; new asks ${total} of 287\n` +
          formatReplay(cells),
      );
      expect(cells.length).toBe(MIXES.length * OPTIONS.taintAt.length);
    });
  }

  it("with no taint fact the engine answers as it did (rule off)", () => {
    for (const row of ROWS) {
      const a = engine("permissive")(row, undefined);
      expect(a.sink).toBeUndefined();
    }
  });
});
