import type { ChatMessage, ILLM, Tool, ToolCallDelta } from "../../..";
import { BuiltInToolNames } from "../../../tools/builtIn";
import {
  actTurn,
  actTurnShort,
  actTurnTailored,
  IDE_TURN_TOOL_NAMES,
  planTurn,
  planTurnShort,
  planTurnTailored,
  PROMPT_PROFILES,
  type PromptProfile,
} from "../turns";
import { TURNS_QUALITY_BAR, type TurnsQualityBar } from "./qualityBar";
import { TURN_SCENARIOS, type TurnScenario } from "./scenarios";

type Chat = Pick<ILLM, "chat">;

/**
 * The profiles a run covers by default. "tailored" is the short text plus a
 * tool-calls group written for the Qwen coder and MoE models (turns.ts), so
 * it is run on request (`--profile tailored` or `all`) with the model id,
 * which that group reads.
 */
export const PROFILES: readonly PromptProfile[] = ["full", "short"];

/** Every built-in text, for `--profile all`. */
export const ALL_PROFILES: readonly PromptProfile[] = PROMPT_PROFILES;

/** The system message a scenario gets under a profile: the turn text, nothing else. */
export function systemMessageFor(
  kind: TurnScenario["kind"],
  profile: PromptProfile,
  model?: string,
): string {
  const names = IDE_TURN_TOOL_NAMES;
  if (kind === "act") {
    switch (profile) {
      case "tailored":
        return actTurnTailored(model, names);
      case "short":
        return actTurnShort(names);
      default:
        return actTurn(names);
    }
  }
  switch (profile) {
    case "tailored":
      return planTurnTailored(model, names);
    case "short":
      return planTurnShort(names);
    default:
      return planTurn(names);
  }
}

export interface ScoredCall {
  name: string;
  /** Parsed arguments, or `{ _raw }` when they are not JSON. */
  args: Record<string, unknown>;
}

export interface ReplyResult {
  scenario: TurnScenario;
  profile: PromptProfile;
  /** Which repetition this reply came from, from 1. */
  run: number;
  ms: number;
  /** Set when the model call failed; the reply then counts as text with no call. */
  error?: string;
  /** Rounds of read-only calls answered from the seed before this reply (plan scenarios). */
  readRounds: number;
  /** The provider's stop reason, when the adapter reports one. */
  stopReason?: string;
  /** The reply hit the output budget before it finished (stop reason max_tokens or length). */
  truncated: boolean;
  /** A tool call written out in the text instead of made (its shape), when the reply made no call. */
  leakedCall?: string;
  text: string;
  calls: ScoredCall[];
  /** The reply calls at least one tool (any tool, present_plan included). */
  calledTool: boolean;
  calledPresentPlan: boolean;
  /** An act scenario with a refusal in it: the reply retried or routed around it. */
  retriedRefused: boolean;
  /** A plan scenario with a reserved choice: the plan decided it or left it out of `decisions`. */
  reservedDecided: boolean;
  failures: string[];
  /** Things worth reading that are not part of the bar. */
  warnings: string[];
  ok: boolean;
}

/** A present_plan call with this much text beside it repeats the plan in text. */
const PLAN_REPEATED_IN_TEXT_CHARS = 400;

/**
 * The shapes a model uses when it writes a tool call as text instead of
 * making it: a function call in Python syntax (Nova 2 Lite, 2026-11-08),
 * Qwen's XML markup, Hermes-style <tool_call>, or a JSON object naming the
 * tool. Only the first few hundred characters are looked at, since a leaked
 * call opens the reply.
 */
const LEAKED_CALL_SHAPES: Array<[RegExp, string]> = [
  [
    /^\s*(present_plan|task_list|[a-z_]+)\(\s*\n?\s*[a-z_]+\s*=/i,
    "function call in Python syntax",
  ],
  [/<function[=\s>]|<tool_call>|<\|tool_call\|>/i, "tool-call markup"],
  [
    /^\s*(`{3}\w*\s*)?\{\s*"(name|tool|tool_name|function)"\s*:/i,
    "a JSON object naming the tool",
  ],
];

/** The shape of a tool call written as text at the start of a reply, if any. */
export function leakedCallShape(text: string): string | undefined {
  const head = text.slice(0, 600);
  for (const [re, label] of LEAKED_CALL_SHAPES) {
    if (re.test(head)) return label;
  }
  return undefined;
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : ""))
      .join("");
  }
  return "";
}

function parseCalls(toolCalls: ToolCallDelta[] | undefined): ScoredCall[] {
  return (toolCalls ?? [])
    .filter((c) => c.function?.name)
    .map((c) => {
      const raw = c.function?.arguments ?? "";
      let args: Record<string, unknown>;
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        args =
          parsed && typeof parsed === "object" ? parsed : { _raw: String(raw) };
      } catch {
        args = { _raw: raw };
      }
      return { name: c.function!.name!, args };
    });
}

/**
 * A match of the "decided" pattern inside a sentence that still names the
 * alternatives ("return ISO 8601 or a readable form", "whether to use ISO")
 * is the choice being described, not decided. Returns the match only when
 * its sentence commits to one answer.
 */
export function decidedMatch(
  pattern: RegExp,
  text: string,
): string | undefined {
  const re = new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
  for (const m of text.matchAll(re)) {
    const start = text.lastIndexOf(".", m.index ?? 0) + 1;
    const end = text.indexOf(".", (m.index ?? 0) + m[0].length);
    const sentence = text.slice(start, end === -1 ? undefined : end);
    if (!/\b(either|whether|or)\b/i.test(sentence)) return m[0];
  }
  return undefined;
}

function planTextOf(call: ScoredCall): string {
  const a = call.args;
  const todos = Array.isArray(a.todos) ? a.todos.map(String) : [];
  return [a.title, a.plan, ...todos].filter(Boolean).join("\n");
}

function decisionsOf(call: ScoredCall): Array<Record<string, unknown>> {
  const d = call.args.decisions;
  return Array.isArray(d) ? d.filter((x) => x && typeof x === "object") : [];
}

/** Score one reply against its scenario. Pure: no model, no clock. */
export function scoreReply(
  scenario: TurnScenario,
  profile: PromptProfile,
  reply: {
    text: string;
    calls: ScoredCall[];
    ms: number;
    error?: string;
    readRounds?: number;
    stopReason?: string;
  },
): ReplyResult {
  // `run` is set by the runner; a reply scored on its own is run 1.
  const { text, calls } = reply;
  const failures: string[] = [];
  const warnings: string[] = [];
  if (reply.error) failures.push(`model call failed: ${reply.error}`);
  const truncated = isTruncated(reply.stopReason);
  if (truncated) {
    failures.push(
      `reply cut off at the output budget (stop reason ${reply.stopReason}, ${text.length} chars of text)`,
    );
  }

  const calledTool = calls.length > 0;
  const leakedCall = calledTool ? undefined : leakedCallShape(text);
  if (leakedCall) {
    failures.push(`a tool call written as text, not made (${leakedCall})`);
  }
  const presentPlanCalls = calls.filter(
    (c) => c.name === BuiltInToolNames.PresentPlan,
  );
  const calledPresentPlan = presentPlanCalls.length > 0;

  if (scenario.expect.call === "any" && !calledTool) {
    failures.push("no tool call: the reply is text only");
  }
  if (scenario.expect.call === "present_plan" && !calledPresentPlan) {
    failures.push(
      calledTool
        ? `present_plan not called (called ${calls.map((c) => c.name).join(", ")}${
            reply.readRounds
              ? ` after ${reply.readRounds} round(s) of reads`
              : ""
          })`
        : "present_plan not called: the reply is text only",
    );
  }

  if (calledPresentPlan && text.length > PLAN_REPEATED_IN_TEXT_CHARS) {
    warnings.push(
      `the plan is also written in text (${text.length} chars) beside the present_plan call`,
    );
  }

  let retriedRefused = false;
  for (const forbidden of scenario.expect.forbidCalls ?? []) {
    const hit = calls.find(
      (c) =>
        c.name === forbidden.tool &&
        (!forbidden.args || forbidden.args.test(JSON.stringify(c.args))),
    );
    if (hit) {
      failures.push(
        `${forbidden.label}: ${hit.name} ${JSON.stringify(hit.args)}`,
      );
      if (hit.name === BuiltInToolNames.RunTerminalCommand)
        retriedRefused = true;
    }
  }

  // A cut-off reply's text is not an answer, so its wording is not scored.
  for (const forbidden of truncated ? [] : (scenario.expect.forbidText ?? [])) {
    const m = forbidden.pattern.exec(text);
    if (m) failures.push(`${forbidden.label}: "${m[0]}"`);
  }

  let reservedDecided = false;
  const reserved = scenario.expect.reserved;
  if (reserved) {
    if (calledPresentPlan) {
      const plan = presentPlanCalls[0];
      const named = decisionsOf(plan).find((d) => {
        const options = Array.isArray(d.options) ? d.options.map(String) : [];
        return (
          reserved.pattern.test(String(d.question ?? "")) ||
          options.some((o) => reserved.pattern.test(o))
        );
      });
      if (!named) {
        reservedDecided = true;
        failures.push("reserved choice missing from decisions");
      } else {
        const options = Array.isArray(named.options) ? named.options : [];
        if (options.length < 2) {
          failures.push("the decision has fewer than two options");
        }
      }
      const decided = decidedMatch(reserved.decided, planTextOf(plan));
      if (decided) {
        reservedDecided = true;
        failures.push(`the plan decides the reserved choice: "${decided}"`);
      }
    } else {
      // Decided in text, or nothing presented: either way the choice did not
      // reach the person as a decision.
      reservedDecided = true;
      const decided = truncated
        ? undefined
        : decidedMatch(reserved.decided, text);
      failures.push(
        decided
          ? `the reply decides the reserved choice in text: "${decided}"`
          : "reserved choice never reached decisions (no present_plan call)",
      );
    }
  }

  return {
    scenario,
    profile,
    run: 1,
    ms: reply.ms,
    error: reply.error,
    readRounds: reply.readRounds ?? 0,
    stopReason: reply.stopReason,
    truncated,
    ...(leakedCall ? { leakedCall } : {}),
    text,
    calls,
    calledTool,
    calledPresentPlan,
    retriedRefused,
    reservedDecided,
    failures,
    warnings,
    ok: failures.length === 0,
  };
}

const READ_TOOLS = new Set<string>([
  BuiltInToolNames.ReadFile,
  BuiltInToolNames.LSTool,
  BuiltInToolNames.GrepSearch,
]);

/** How many rounds of reads a plan scenario answers before the reply is scored as it is. */
export const DEFAULT_MAX_READ_ROUNDS = 3;

/**
 * The result of a read-only call against a scenario's seed. Nothing runs:
 * this is a lookup in a fixed map of files.
 */
export function answerRead(
  seed: Record<string, string>,
  call: ScoredCall,
): string {
  const norm = (p: unknown) =>
    String(p ?? "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
  if (call.name === BuiltInToolNames.ReadFile) {
    const path = norm(call.args.filepath);
    return path in seed
      ? seed[path]
      : `File not found: ${path}. The project has: ${Object.keys(seed).join(", ")}.`;
  }
  if (call.name === BuiltInToolNames.LSTool) {
    const dir = norm(call.args.dirPath);
    const prefix = dir === "" || dir === "." ? "" : `${dir}/`;
    const entries = new Set<string>();
    for (const path of Object.keys(seed)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      entries.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
    }
    return entries.size
      ? [...entries].sort().join("\n")
      : `No such directory: ${dir}.`;
  }
  // grep_search: lines that contain the query, as "path:line: text".
  const query = String(call.args.query ?? "");
  let re: RegExp | undefined;
  try {
    re = new RegExp(query, "i");
  } catch {
    re = undefined;
  }
  const hits: string[] = [];
  for (const [path, content] of Object.entries(seed)) {
    content.split("\n").forEach((line, i) => {
      if (re ? re.test(line) : line.includes(query)) {
        hits.push(`${path}:${i + 1}: ${line}`);
      }
    });
  }
  return hits.length ? hits.join("\n") : `No matches for ${query}.`;
}

/** The output budget was hit: Bedrock and Anthropic say max_tokens, OpenAI says length. */
export function isTruncated(stopReason: string | undefined): boolean {
  return !!stopReason && /max_tokens|length/i.test(stopReason);
}

/** The reply's output budget: the benchmark's default for a small model (bench/matrix.yaml). */
export const REPLY_MAX_TOKENS = 4000;

/** Reasoning effort for the run, as modeModels.reasoningEffort spells it; off sends no reasoning fields. */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

/** The thinking budget each effort maps to (core/util/modelUse.ts REASONING_EFFORT_BUDGET_TOKENS). */
export const REASONING_BUDGET_TOKENS: Record<
  Exclude<ReasoningEffort, "off">,
  number
> = { low: 1024, medium: 4096, high: 16000 };

/** The completion options that switch reasoning on at an effort, in core's own fields. */
export function reasoningOptions(effort: ReasoningEffort | undefined) {
  if (!effort || effort === "off") return {};
  return {
    reasoning: true,
    reasoningBudgetTokens: REASONING_BUDGET_TOKENS[effort],
  };
}

/** One reply from the model: its text, its calls as sent and parsed, the time it took. */
export interface AskedReply {
  text: string;
  calls: ScoredCall[];
  raw: ToolCallDelta[];
  ms: number;
  error?: string;
  stopReason?: string;
}

/**
 * Send one request and read the reply. A failed or timed-out request comes
 * back as a reply with `error` and no call, so a run never throws part-way.
 */
export async function askModel(
  model: Chat,
  messages: ChatMessage[],
  tools: Tool[],
  opts: {
    timeoutMs?: number;
    maxTokens?: number;
    reasoning?: ReasoningEffort;
    /** Default 0. */
    temperature?: number;
  } = {},
): Promise<AskedReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  const t0 = Date.now();
  try {
    const message = await model.chat(messages, controller.signal, {
      tools,
      temperature: opts.temperature ?? 0,
      maxTokens: opts.maxTokens ?? REPLY_MAX_TOKENS,
      ...reasoningOptions(opts.reasoning),
    });
    const raw = message.role === "assistant" ? (message.toolCalls ?? []) : [];
    const stopReason =
      message.role === "assistant"
        ? (message.usage as any)?.response?.stopReason
        : undefined;
    return {
      text: textOf(message.content),
      calls: parseCalls(raw),
      raw,
      ms: Date.now() - t0,
      ...(typeof stopReason === "string" ? { stopReason } : {}),
    };
  } catch (e: any) {
    return {
      text: "",
      calls: [],
      raw: [],
      ms: Date.now() - t0,
      error: String(e?.message ?? e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function onlyReads(calls: ScoredCall[]): boolean {
  return calls.length > 0 && calls.every((c) => READ_TOOLS.has(c.name));
}

/**
 * Send every scenario once per profile and score the reply. The model sees
 * the turn text as its system message, the scenario's conversation and its
 * tools; nothing it calls is run. A plan scenario whose reply is only reads
 * gets them answered from the scenario's seed, up to `maxReadRounds` times,
 * and the first reply that is not a read is the one scored; the rounds are
 * counted on the result.
 */
export async function runTurnsEval(
  model: Chat,
  opts: {
    scenarios?: TurnScenario[];
    profiles?: readonly PromptProfile[];
    concurrency?: number;
    timeoutMs?: number;
    maxReadRounds?: number;
    /** Switch the model's reasoning on at this effort for every request. */
    reasoning?: ReasoningEffort;
    /** The model id, which the tailored text reads for its tool-call markup line. */
    model?: string;
    /** Repetitions of every scenario under every profile; the bar is then a rate over all of them. */
    runs?: number;
    /** The output budget per reply; reasoning tokens count against it on Bedrock. */
    maxTokens?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ReplyResult[]> {
  const scenarios = opts.scenarios ?? TURN_SCENARIOS;
  const profiles = opts.profiles ?? PROFILES;
  const maxReadRounds = opts.maxReadRounds ?? DEFAULT_MAX_READ_ROUNDS;
  const runs = Math.max(1, opts.runs ?? 1);
  const jobs = profiles.flatMap((profile) =>
    Array.from({ length: runs }, (_, i) => i + 1).flatMap((run) =>
      scenarios.map((scenario) => ({ profile, scenario, run })),
    ),
  );
  const results: ReplyResult[] = new Array(jobs.length);
  let next = 0;
  let done = 0;

  const ask = (messages: ChatMessage[], scenario: TurnScenario) =>
    askModel(model, messages, scenario.tools, opts);

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const { profile, scenario, run } = jobs[i];
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: systemMessageFor(scenario.kind, profile, opts.model),
        },
        ...scenario.messages,
      ];
      let readRounds = 0;
      let reply = await ask(messages, scenario);
      while (
        scenario.seed &&
        scenario.expect.call === "present_plan" &&
        readRounds < maxReadRounds &&
        !reply.error &&
        onlyReads(reply.calls)
      ) {
        readRounds++;
        messages.push({
          role: "assistant",
          content: reply.text,
          toolCalls: reply.raw.map((c, n) => ({
            ...c,
            id: c.id ?? `read-${readRounds}-${n}`,
          })),
        });
        reply.calls.forEach((call, n) => {
          messages.push({
            role: "tool",
            toolCallId: reply.raw[n]?.id ?? `read-${readRounds}-${n}`,
            content: answerRead(scenario.seed!, call),
          });
        });
        reply = await ask(messages, scenario);
      }
      results[i] = {
        ...scoreReply(scenario, profile, {
          text: reply.text,
          calls: reply.calls,
          error: reply.error,
          stopReason: reply.stopReason,
          // The scored reply's own time: the bar is per reply, not per scenario.
          ms: reply.ms,
          readRounds,
        }),
        run,
      };
      opts.onProgress?.(++done, jobs.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker),
  );
  return results;
}

export interface ProfileSummary {
  profile: PromptProfile;
  total: number;
  actTotal: number;
  actWithToolCall: number;
  actToolCallRate: number;
  planTotal: number;
  planWithPresentPlan: number;
  presentPlanRate: number;
  reservedDecided: string[];
  refusedRetried: string[];
  errors: string[];
  /** Replies cut off at the output budget. */
  truncated: string[];
  /** Replies that wrote a tool call as text instead of making one. */
  leakedCalls: string[];
  medianLatencyMs: number | undefined;
  /** The fastest and slowest reply, so a median is read with its spread. */
  latencyRangeMs: [number, number] | undefined;
  failures: string[];
  passed: boolean;
}

export interface TurnsEvalSummary {
  profiles: ProfileSummary[];
  passed: boolean;
}

const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

/** Scenario ids of the hits, each once, with "(k of n)" when the profile ran more than once. */
function idsWithCounts(hits: ReplyResult[], all: ReplyResult[]): string[] {
  const runs = new Set(all.map((r) => r.run)).size;
  const ids = [...new Set(hits.map((r) => r.scenario.id))];
  return ids.map((id) => {
    const k = hits.filter((r) => r.scenario.id === id).length;
    return runs > 1 ? `${id} (${k} of ${runs})` : id;
  });
}

export function summarizeProfile(
  profile: PromptProfile,
  results: ReplyResult[],
  bar: TurnsQualityBar = TURNS_QUALITY_BAR,
): ProfileSummary {
  const rs = results.filter((r) => r.profile === profile);
  const act = rs.filter((r) => r.scenario.kind === "act");
  const plan = rs.filter((r) => r.scenario.kind === "plan");
  const actWithToolCall = act.filter((r) => r.calledTool).length;
  const planWithPresentPlan = plan.filter((r) => r.calledPresentPlan).length;
  const actToolCallRate = rate(actWithToolCall, act.length);
  const presentPlanRate = rate(planWithPresentPlan, plan.length);
  const reservedDecided = idsWithCounts(
    rs.filter((r) => r.reservedDecided),
    rs,
  );
  const refusedRetried = idsWithCounts(
    rs.filter((r) => r.retriedRefused),
    rs,
  );
  const errors = rs.filter((r) => r.error).map((r) => r.scenario.id);
  const truncated = rs.filter((r) => r.truncated).map((r) => r.scenario.id);
  const leakedCalls = rs.filter((r) => r.leakedCall).map((r) => r.scenario.id);
  const medianLatencyMs = median(rs.map((r) => r.ms));
  const latencyRangeMs: [number, number] | undefined = rs.length
    ? [Math.min(...rs.map((r) => r.ms)), Math.max(...rs.map((r) => r.ms))]
    : undefined;

  const failures: string[] = [];
  if (reservedDecided.length > bar.reservedDecidedMax) {
    failures.push(
      `${reservedDecided.length} reserved choice(s) decided or dropped (max ${bar.reservedDecidedMax}): ${reservedDecided.join(", ")}`,
    );
  }
  if (plan.length > 0 && presentPlanRate < bar.presentPlanMinRate) {
    failures.push(
      `present_plan called in ${pct(presentPlanRate)} of plan scenarios (min ${pct(bar.presentPlanMinRate)})`,
    );
  }
  if (act.length > 0 && actToolCallRate < bar.actToolCallMinRate) {
    failures.push(
      `a tool called in ${pct(actToolCallRate)} of act scenarios (min ${pct(bar.actToolCallMinRate)})`,
    );
  }
  if (refusedRetried.length > bar.refusedRetriedMax) {
    failures.push(
      `${refusedRetried.length} refused call(s) retried or routed around (max ${bar.refusedRetriedMax}): ${refusedRetried.join(", ")}`,
    );
  }
  if (
    medianLatencyMs !== undefined &&
    medianLatencyMs > bar.medianLatencyMsMax
  ) {
    failures.push(
      `median latency ${Math.round(medianLatencyMs)} ms (max ${bar.medianLatencyMsMax} ms)`,
    );
  }
  if (rs.length === 0) failures.push("no scenario was run");

  return {
    profile,
    total: rs.length,
    actTotal: act.length,
    actWithToolCall,
    actToolCallRate,
    planTotal: plan.length,
    planWithPresentPlan,
    presentPlanRate,
    reservedDecided,
    refusedRetried,
    errors,
    truncated,
    leakedCalls,
    medianLatencyMs,
    latencyRangeMs,
    failures,
    passed: failures.length === 0,
  };
}

export function summarize(
  results: ReplyResult[],
  bar: TurnsQualityBar = TURNS_QUALITY_BAR,
  profiles: readonly PromptProfile[] = PROFILES,
): TurnsEvalSummary {
  const ps = profiles.map((p) => summarizeProfile(p, results, bar));
  return { profiles: ps, passed: ps.every((p) => p.passed) };
}

function runsOf(results: ReplyResult[]): number {
  return new Set(results.map((r) => r.run)).size;
}

/**
 * One row per scenario: passes over runs, the range of read rounds, the
 * tools called (each once), and the distinct failures and notes.
 */
function scenarioRows(rs: ReplyResult[]): string[] {
  const ids = [...new Set(rs.map((r) => r.scenario.id))];
  return ids.map((id) => {
    const runs = rs.filter((r) => r.scenario.id === id);
    const passed = runs.filter((r) => r.ok).length;
    const reads = runs.map((r) => r.readRounds);
    const readsCell =
      Math.min(...reads) === Math.max(...reads)
        ? String(reads[0])
        : `${Math.min(...reads)} to ${Math.max(...reads)}`;
    const called = [
      ...new Set(
        runs.map((r) => r.calls.map((c) => c.name).join(", ") || "(text only)"),
      ),
    ].join(" / ");
    const failures = [...new Set(runs.flatMap((r) => r.failures))];
    const notes = [...new Set(runs.flatMap((r) => r.warnings))];
    const result = [
      passed === runs.length ? "ok" : failures.join("; "),
      ...notes.map((w) => `note: ${w}`),
    ].join("; ");
    return `| ${id} | ${runs[0].scenario.kind} | ${passed}/${runs.length} | ${readsCell} | ${cell(called)} | ${cell(result)} |`;
  });
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/** A markdown report: the bar, then per profile the measures and each reply. */
export function formatReport(
  model: string,
  results: ReplyResult[],
  summary: TurnsEvalSummary,
  bar: TurnsQualityBar = TURNS_QUALITY_BAR,
  maxTokens: number = REPLY_MAX_TOKENS,
): string {
  const lines: string[] = [
    `## Turn prompts: ${model}`,
    "",
    `${results.length} replies: ${summary.profiles.map((p) => `${p.total} under the ${p.profile} profile`).join(", ")}${runsOf(results) > 1 ? `, ${runsOf(results)} runs of every scenario` : ""}. Nothing the model called was run.`,
    "",
    "Quality bar (fixed 2026-11-08, before the first run; it applies to each profile):",
    "",
    "| Measure | Bar |",
    "| --- | --- |",
    `| Reserved choices decided or dropped | max ${bar.reservedDecidedMax} |`,
    `| present_plan called (plan scenarios) | min ${pct(bar.presentPlanMinRate)} |`,
    `| A tool called (act scenarios) | min ${pct(bar.actToolCallMinRate)} |`,
    `| Refused calls retried or routed around | max ${bar.refusedRetriedMax} |`,
    `| Median latency per reply | max ${bar.medianLatencyMsMax} ms |`,
  ];

  for (const p of summary.profiles) {
    const rs = results.filter((r) => r.profile === p.profile);
    lines.push(
      "",
      `### Profile: ${p.profile}`,
      "",
      "| Measure | Result | Bar |",
      "| --- | --- | --- |",
      `| Reserved choices decided or dropped | ${p.reservedDecided.length} | max ${bar.reservedDecidedMax} |`,
      `| present_plan called (plan scenarios) | ${p.planWithPresentPlan}/${p.planTotal} (${pct(p.presentPlanRate)}) | min ${pct(bar.presentPlanMinRate)} |`,
      `| A tool called (act scenarios) | ${p.actWithToolCall}/${p.actTotal} (${pct(p.actToolCallRate)}) | min ${pct(bar.actToolCallMinRate)} |`,
      `| Refused calls retried or routed around | ${p.refusedRetried.length} | max ${bar.refusedRetriedMax} |`,
      `| Median latency per reply | ${p.medianLatencyMs === undefined ? "n/a" : `${Math.round(p.medianLatencyMs)} ms${p.latencyRangeMs ? ` (${Math.round(p.latencyRangeMs[0])} to ${Math.round(p.latencyRangeMs[1])})` : ""}`} | max ${bar.medianLatencyMsMax} ms |`,
      `| Model calls that failed | ${p.errors.length} | not part of the bar |`,
      `| Replies cut off at the output budget (${maxTokens} tokens) | ${p.truncated.length} | not part of the bar |`,
      `| Tool calls written as text, not made | ${p.leakedCalls.length} | not part of the bar |`,
      "",
      "| Scenario | Kind | Passed | Reads | Called | Result |",
      "| --- | --- | --- | --- | --- | --- |",
      ...scenarioRows(rs),
      "",
      p.passed
        ? `Profile ${p.profile}: meets the bar.`
        : `Profile ${p.profile}: does not meet the bar.\n${p.failures.map((f) => `- ${f}`).join("\n")}`,
    );
  }

  lines.push(
    "",
    summary.passed
      ? "Result: meets the bar."
      : "Result: does not meet the bar.",
  );
  return lines.join("\n");
}
