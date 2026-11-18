import { SINK_CLASSES, type Sink, type SinkClass } from "./taintSinks";
import type { TaintFact } from "./taintState";

/**
 * Measure-only replay of the tainted-session rule (ROADMAP X17). It replays
 * synthetic traces built from labelled calls (the 287-case corpus, never a
 * person's audit directory) with taint injected at chosen points, and counts
 * what the rule would ask on. It decides nothing and writes nothing.
 *
 * The decision function is injected, so this file stays free of the engine:
 * the measurement test hands it `testToolCall` run with and without the fact.
 */
export type Label = "allow" | "ask" | "deny";

export interface ReplayRow {
  id: string;
  /** What the call should come to, as the corpus labels it */
  expect: Label;
}

export interface ReplayVerdict {
  decision: Label;
  /** Present when the call is a sink (only with a taint fact) */
  sink?: Sink;
}

export type ReplayDecide<R extends ReplayRow> = (
  row: R,
  taint: TaintFact | undefined,
) => ReplayVerdict;

export interface ReplayMix {
  name: string;
  /** Relative weight of rows labelled allow, ask and deny when a trace is sampled */
  weights: Record<Label, number>;
}

export interface ReplayOptions {
  traceLength: number;
  traces: number;
  /** Where in the trace the taint enters, as a fraction of its length */
  taintAt: number[];
  mixes: ReplayMix[];
  seed: number;
}

export interface ClassCount {
  /** Calls that are sinks and not refused: the calls the rule asks on */
  sinkCalls: number;
  /** Of those, calls that already asked without the rule */
  alreadyAsked: number;
  /** Of those, calls that would have run: the new asks */
  newAsks: number;
}

export interface ReplayCell {
  mix: string;
  taintAt: number;
  calls: number;
  callsAfterTaint: number;
  perClass: Record<SinkClass, ClassCount>;
  newAsks: number;
  /** Over all calls of the traces, taint or not yet */
  newAsksPer100Calls: number;
  /** Over the calls after the taint entered */
  newAsksPer100TaintedCalls: number;
  /** Share of traces with at least one new ask: the interruptions if the person acknowledges at the first */
  tracesInterrupted: number;
  /** Rows the rule turned into a lesser decision; must be 0 */
  loosened: number;
  /** Rows the rule changed from refused; must be 0 */
  deniesChanged: number;
}

const ORDER: Record<Label, number> = { allow: 0, ask: 1, deny: 2 };

/** A small seeded generator, so a replay gives the same numbers every time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyClasses(): Record<SinkClass, ClassCount> {
  return Object.fromEntries(
    SINK_CLASSES.map((c) => [c, { sinkCalls: 0, alreadyAsked: 0, newAsks: 0 }]),
  ) as Record<SinkClass, ClassCount>;
}

function sampler<R extends ReplayRow>(
  rows: R[],
  mix: ReplayMix,
  rand: () => number,
) {
  const byLabel: Record<Label, R[]> = { allow: [], ask: [], deny: [] };
  for (const r of rows) byLabel[r.expect].push(r);
  const labels = (Object.keys(mix.weights) as Label[]).filter(
    (l) => mix.weights[l] > 0 && byLabel[l].length > 0,
  );
  const total = labels.reduce((n, l) => n + mix.weights[l], 0);
  return (): R => {
    let x = rand() * total;
    const label = labels.find((l) => (x -= mix.weights[l]) < 0) ?? labels[0];
    const pool = byLabel[label];
    return pool[Math.floor(rand() * pool.length)];
  };
}

export function replayTaint<R extends ReplayRow>(
  rows: R[],
  decide: ReplayDecide<R>,
  fact: TaintFact,
  options: ReplayOptions,
): ReplayCell[] {
  // The engine is deterministic: one decision per row, with and without the fact
  const base = new Map<string, ReplayVerdict>();
  const tainted = new Map<string, ReplayVerdict>();
  for (const r of rows) {
    base.set(r.id, decide(r, undefined));
    tainted.set(r.id, decide(r, fact));
  }
  const cells: ReplayCell[] = [];
  for (const mix of options.mixes) {
    for (const at of options.taintAt) {
      const rand = seeded(options.seed);
      const draw = sampler(rows, mix, rand);
      const cell: ReplayCell = {
        mix: mix.name,
        taintAt: at,
        calls: 0,
        callsAfterTaint: 0,
        perClass: emptyClasses(),
        newAsks: 0,
        newAsksPer100Calls: 0,
        newAsksPer100TaintedCalls: 0,
        tracesInterrupted: 0,
        loosened: 0,
        deniesChanged: 0,
      };
      let interrupted = 0;
      for (let t = 0; t < options.traces; t++) {
        const start = Math.round(at * options.traceLength);
        let hit = false;
        for (let i = 0; i < options.traceLength; i++) {
          const row = draw();
          cell.calls++;
          if (i < start) continue;
          cell.callsAfterTaint++;
          const was = base.get(row.id)!;
          const now = tainted.get(row.id)!;
          if (ORDER[now.decision] < ORDER[was.decision]) cell.loosened++;
          if (was.decision === "deny" && now.decision !== "deny") {
            cell.deniesChanged++;
          }
          if (!now.sink || was.decision === "deny") continue;
          const k = cell.perClass[now.sink.class];
          k.sinkCalls++;
          if (was.decision === "ask") k.alreadyAsked++;
          else if (now.decision === "ask") {
            k.newAsks++;
            cell.newAsks++;
            hit = true;
          }
        }
        if (hit) interrupted++;
      }
      cell.newAsksPer100Calls = (100 * cell.newAsks) / cell.calls;
      cell.newAsksPer100TaintedCalls = cell.callsAfterTaint
        ? (100 * cell.newAsks) / cell.callsAfterTaint
        : 0;
      cell.tracesInterrupted = interrupted / options.traces;
      cells.push(cell);
    }
  }
  return cells;
}

/** A plain-text table of a replay, for a test log or a pull request. */
export function formatReplay(cells: ReplayCell[]): string {
  const lines = [
    "mix | taint at | new asks /100 calls | /100 tainted calls | traces interrupted | sink calls (already ask) by class",
  ];
  for (const c of cells) {
    const classes = SINK_CLASSES.filter((k) => c.perClass[k].sinkCalls > 0)
      .map(
        (k) =>
          `${k} ${c.perClass[k].sinkCalls} (${c.perClass[k].alreadyAsked})`,
      )
      .join(", ");
    lines.push(
      `${c.mix} | ${Math.round(c.taintAt * 100)}% | ${c.newAsksPer100Calls.toFixed(2)} | ${c.newAsksPer100TaintedCalls.toFixed(2)} | ${(100 * c.tracesInterrupted).toFixed(0)}% | ${classes || "none"}`,
    );
  }
  return lines.join("\n");
}
