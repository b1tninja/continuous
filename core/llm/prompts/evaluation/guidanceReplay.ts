import type { ChatMessage, ILLM, Tool } from "../../..";
import type { PromptProfile } from "../turns";
import {
  failedCallOf,
  GUIDANCE_CASES,
  type GuidanceCase,
} from "./guidanceCases";
import {
  askModel,
  leakedCallShape,
  systemMessageFor,
  type ReasoningEffort,
  type ScoredCall,
} from "./runner";
import { wilsonInterval } from "./wilson";

type Chat = Pick<ILLM, "chat">;

/**
 * The guidance replay: send a conversation that ends in a failed or refused
 * tool call, with the result worded one way per arm, and score the model's
 * next call. Three questions per trial, each a rate over the trials of a
 * class and arm:
 *
 * - changed: the next call is not the failed call again;
 * - valid: it names an offered tool and its arguments fit that tool's schema;
 * - succeeded: it is valid and does what the case needs against the case's
 *   project (GuidanceCase.succeeded).
 *
 * A reply with no call counts against all three. Only the first call of a
 * reply is scored: it is the one the result was written to shape.
 */

/**
 * Trials vary only if the model samples, and an interval over repeats of one
 * reply would claim more than was measured, so the replay does not run at
 * the harness's temperature 0 unless asked to.
 */
export const REPLAY_TEMPERATURE = 0.7;

/** Under this many trials per arm a difference is a hint, not a result (RQ10). */
export const SCREENING_TRIALS = 10;

/** Trials per arm at which a 0.3 difference can be told apart (RQ10). */
export const DECIDING_TRIALS = 33;

export interface NextCallScore {
  /** The reply made a call at all. */
  called: boolean;
  changed: boolean;
  valid: boolean;
  succeeded: boolean;
  /** Why the call is not valid, when it is not. */
  invalid?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fitsType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Why a call is not one the tools on offer would accept, or undefined when it
 * is. The top level of the schema only: required parameters, declared types
 * and enums, which is what the surfaces check before a tool runs.
 */
export function invalidCall(
  call: ScoredCall,
  tools: Tool[],
): string | undefined {
  const tool = tools.find((t) => t.function.name === call.name);
  if (!tool) return `${call.name} is not an offered tool`;
  if ("_raw" in call.args) return "the arguments are not a JSON object";
  const schema = (tool.function.parameters ?? {}) as {
    required?: string[];
    properties?: Record<string, { type?: unknown; enum?: unknown[] }>;
  };
  for (const key of schema.required ?? []) {
    if (call.args[key] === undefined) return `${key} is missing`;
  }
  for (const [key, value] of Object.entries(call.args)) {
    const declared = schema.properties?.[key];
    if (!declared) continue;
    if (!fitsType(value, declared.type)) {
      return `${key} is not of type ${String(declared.type)}`;
    }
    if (declared.enum && !declared.enum.includes(value)) {
      return `${key} is not one of its allowed values`;
    }
  }
  return undefined;
}

/** Score the next call of one trial. Pure: no model, no clock. */
export function scoreNextCall(
  c: GuidanceCase,
  calls: ScoredCall[],
): NextCallScore {
  const next = calls[0];
  if (!next) {
    return { called: false, changed: false, valid: false, succeeded: false };
  }
  const failed = failedCallOf(c);
  const changed =
    next.name !== failed.name ||
    canonical(next.args) !== canonical(failed.args);
  const invalid = invalidCall(next, c.tools);
  return {
    called: true,
    changed,
    valid: !invalid,
    succeeded: !invalid && c.succeeded(next, c.project),
    ...(invalid ? { invalid } : {}),
  };
}

export interface ReplayTrial extends NextCallScore {
  case: GuidanceCase;
  arm: string;
  /** Which repetition this is, from 1. */
  trial: number;
  ms: number;
  /** Set when the model call failed; the trial then counts as no call. */
  error?: string;
  text: string;
  calls: ScoredCall[];
  /** A tool call written out in the text instead of made (its shape). */
  leakedCall?: string;
}

/** The conversation one trial sends: the case's history, then the arm's text as the result. */
export function replayMessages(
  c: GuidanceCase,
  arm: string,
  system: string,
): ChatMessage[] {
  return [
    { role: "system", content: system },
    ...c.messages,
    { role: "tool", toolCallId: failedCallOf(c).id, content: c.arms[arm] },
  ];
}

/**
 * Send every case under every one of its arms `trials` times and score the
 * next call. Nothing the model calls is run for real: `succeeded` is decided
 * against the case's map of files.
 */
export async function runGuidanceReplay(
  model: Chat,
  opts: {
    cases?: GuidanceCase[];
    /** Repetitions of every case under every arm (default 1). */
    trials?: number;
    /** The act turn text sent as the system message (default full). */
    profile?: PromptProfile;
    /** The model id, which the tailored text reads. */
    model?: string;
    temperature?: number;
    concurrency?: number;
    timeoutMs?: number;
    maxTokens?: number;
    reasoning?: ReasoningEffort;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ReplayTrial[]> {
  const cases = opts.cases ?? GUIDANCE_CASES;
  const trials = Math.max(1, opts.trials ?? 1);
  const system = systemMessageFor("act", opts.profile ?? "full", opts.model);
  const jobs = cases.flatMap((c) =>
    Object.keys(c.arms).flatMap((arm) =>
      Array.from({ length: trials }, (_, i) => ({ c, arm, trial: i + 1 })),
    ),
  );
  const results: ReplayTrial[] = new Array(jobs.length);
  let next = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const { c, arm, trial } = jobs[i];
      const reply = await askModel(
        model,
        replayMessages(c, arm, system),
        c.tools,
        {
          timeoutMs: opts.timeoutMs,
          maxTokens: opts.maxTokens,
          reasoning: opts.reasoning,
          temperature: opts.temperature ?? REPLAY_TEMPERATURE,
        },
      );
      const leakedCall = reply.calls.length
        ? undefined
        : leakedCallShape(reply.text);
      results[i] = {
        ...scoreNextCall(c, reply.calls),
        case: c,
        arm,
        trial,
        ms: reply.ms,
        ...(reply.error ? { error: reply.error } : {}),
        text: reply.text,
        calls: reply.calls,
        ...(leakedCall ? { leakedCall } : {}),
      };
      opts.onProgress?.(++done, jobs.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker),
  );
  return results;
}

/** One rate with its 95% Wilson interval. */
export interface ReplayRate {
  count: number;
  low: number;
  high: number;
}

export interface ReplayRow {
  failureClass: string;
  arm: string;
  n: number;
  changed: ReplayRate;
  valid: ReplayRate;
  succeeded: ReplayRate;
  /** Trials whose reply made no call (model errors included). */
  noCall: number;
  /** Trials whose model call failed. */
  errors: number;
}

function rateOf(count: number, n: number): ReplayRate {
  const [low, high] = wilsonInterval(count, n);
  return { count, low, high };
}

/** One row per class and arm, in the order they first appear. */
export function summarizeReplay(trials: ReplayTrial[]): ReplayRow[] {
  const groups = new Map<string, ReplayTrial[]>();
  for (const t of trials) {
    const key = `${t.case.failureClass}\n${t.arm}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()].map((ts) => {
    const n = ts.length;
    const count = (pick: (t: ReplayTrial) => boolean) => ts.filter(pick).length;
    return {
      failureClass: ts[0].case.failureClass,
      arm: ts[0].arm,
      n,
      changed: rateOf(
        count((t) => t.changed),
        n,
      ),
      valid: rateOf(
        count((t) => t.valid),
        n,
      ),
      succeeded: rateOf(
        count((t) => t.succeeded),
        n,
      ),
      noCall: count((t) => !t.called),
      errors: count((t) => !!t.error),
    };
  });
}

const pct = (x: number) => `${Math.round(x * 100)}`;

function rateCell(r: ReplayRate, n: number): string {
  return `${r.count}/${n} (${pct(r.low)} to ${pct(r.high)}%)`;
}

/** What the number of trials per arm supports, in a sentence. */
function sampleSizeNote(rows: ReplayRow[]): string {
  const least = Math.min(...rows.map((r) => r.n));
  if (least < SCREENING_TRIALS) {
    return `N is ${least} per arm at the least: too few to compare arms. Read the intervals, not the rates.`;
  }
  if (least < DECIDING_TRIALS) {
    return `N is ${least} per arm at the least, which is small: this is screening. Only a large difference between arms shows at this size, and a wording should not become the default on it (${DECIDING_TRIALS} per arm for a 0.3 difference).`;
  }
  return `N is ${least} per arm at the least, enough to tell a 0.3 difference between arms apart.`;
}

/**
 * The markdown report: one table, a row per class and arm, each rate with
 * its 95% Wilson interval.
 */
export function formatReplayReport(
  label: string,
  trials: ReplayTrial[],
  opts: { temperature?: number; stub?: boolean } = {},
): string {
  const rows = summarizeReplay(trials);
  const errors = rows.reduce((sum, r) => sum + r.errors, 0);
  const lines = [
    `## Guidance replay: ${label}`,
    "",
    `${trials.length} trials. Each sends a conversation that ends in a failed or refused tool call, with the result worded as the arm words it, and scores the next call: changed (not the same call again), valid (an offered tool, arguments that fit its schema), succeeded (valid, and it does what the case needs against the case's files). Each cell is count/N with the 95% Wilson interval.`,
    "",
    "| Class | Arm | N | Changed | Valid | Succeeded | No call |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.failureClass} | ${r.arm} | ${r.n} | ${rateCell(r.changed, r.n)} | ${rateCell(r.valid, r.n)} | ${rateCell(r.succeeded, r.n)} | ${r.noCall} |`,
    ),
    "",
  ];
  if (opts.stub) {
    lines.push(
      "This run used a stand-in, not a model: it shows that the replay and its scoring work, and says nothing about any wording.",
    );
  } else {
    lines.push(
      sampleSizeNote(rows),
      `Temperature ${opts.temperature ?? REPLAY_TEMPERATURE}; one case per class unless more were added, so a rate is about that case.`,
    );
  }
  if (errors > 0) {
    lines.push(
      `${errors} model call(s) failed and are counted as no call: ${[...new Set(trials.filter((t) => t.error).map((t) => t.error))].join("; ")}`,
    );
  }
  return lines.join("\n");
}
