import type { ChatHistoryItem, SessionUsage } from "core/index.js";
import type { PriceSource } from "core/llm/utils/calculateRequestCost.js";
import { distinctPriceSources } from "core/llm/utils/priceSourceText.js";
import { clipMasked } from "core/tools/permissions/audit/mask.js";
import {
  maskArgsForDisplay,
  maskCommandForDisplay,
} from "core/tools/permissions/displayMask.js";

import { idgafObjectionCount } from "../audit/idgafObjections.js";
import type { ModelInUse } from "../services/modelInUse.js";

import {
  STREAM_JSON_SCHEMA_VERSION,
  type InitEvent,
  type PriceSourceJson,
  type RunErrorKind,
  type RunStatus,
  type StreamJsonEvent,
  type StreamJsonEventBody,
  type ToolDecisionEvent,
} from "./streamJsonEvents.js";

/** The longest string kept in a `tool_use` argument. */
export const STREAM_JSON_ARG_CHARS = 2000;
/** The longest `tool_result` output. */
export const STREAM_JSON_OUTPUT_CHARS = 4000;

/** What the permission path learned about one call (see audit/cliAudit.ts). */
export interface DecisionFacts {
  verdict?: {
    by: "rules" | "reviewer" | "system";
    source?: string;
    rule?: string;
    reason?: string;
  };
  askedPerson?: boolean;
  held?: boolean;
}

export interface StreamJsonRunOptions {
  /** Writes one line, newline included. */
  write: (line: string) => void;
  now?: () => number;
  /** The session's usage totals, read after each request. */
  usage?: () => SessionUsage | undefined;
}

interface UsageMark {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Priced requests per model (`provider/model`), to tell which were priced since */
  priced: Record<string, number>;
}

function markOf(usage: SessionUsage | undefined): UsageMark {
  const priced: Record<string, number> = {};
  for (const [key, m] of Object.entries(usage?.byModel ?? {})) {
    priced[key] = m.pricedRequests;
  }
  return {
    input: usage?.promptTokens ?? 0,
    output: usage?.completionTokens ?? 0,
    cacheRead: usage?.promptTokensDetails?.cachedTokens ?? 0,
    cacheWrite: usage?.promptTokensDetails?.cacheWriteTokens ?? 0,
    cost: usage?.totalCost ?? 0,
    priced,
  };
}

/** A price source as the stream carries it: only the known fields. */
function sourceJson(s: PriceSource): PriceSourceJson {
  return {
    kind: s.kind,
    label: s.label,
    ...(s.url ? { url: s.url } : {}),
    ...(s.asOf ? { asOf: s.asOf } : {}),
  };
}

/**
 * Where the prices of the requests priced between two marks came from, and
 * the non-standard tiers their providers reported.
 */
function pricedSince(
  usage: SessionUsage | undefined,
  from: UsageMark,
  to: UsageMark,
): { sources: PriceSourceJson[]; tiers: string[] } {
  const models = Object.entries(usage?.byModel ?? {})
    .filter(([key]) => (to.priced[key] ?? 0) > (from.priced[key] ?? 0))
    .map(([, m]) => m);
  return {
    sources: distinctPriceSources(models.map((m) => m.priceSource)).map(
      sourceJson,
    ),
    tiers: [
      ...new Set(
        models.map((m) => m.servedTier).filter((t): t is string => !!t),
      ),
    ],
  };
}

/** Dollars to six places, so a sum of small requests does not print a float tail. */
function usd(n: number): number {
  return Math.round(Math.max(0, n) * 1e6) / 1e6;
}

function maskAndClip(text: string, max: number) {
  const masked = maskCommandForDisplay(text);
  return {
    text: clipMasked(masked, max),
    length: masked.length,
    truncated: masked.length > max,
  };
}

function clipStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return clipMasked(value, STREAM_JSON_ARG_CHARS);
  }
  if (Array.isArray(value)) return value.map(clipStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        clipStrings(v),
      ]),
    );
  }
  return value;
}

/** Masks every string of a call's arguments and cuts the long ones. */
function maskArgs(value: unknown): Record<string, unknown> {
  const masked = clipStrings(maskArgsForDisplay(value));
  return masked && typeof masked === "object" && !Array.isArray(masked)
    ? (masked as Record<string, unknown>)
    : { value: masked };
}

function isEnded(status: string): status is "done" | "errored" | "canceled" {
  return status === "done" || status === "errored" || status === "canceled";
}

/**
 * One headless run's event stream. It only formats and writes: the callers
 * hand it what happened (a reply, the history after a change, a decision, a
 * finished request), and every text goes through the display masker (the
 * audit masker plus the environment-assignment pass) before it is written.
 *
 * Order: `init` first, `result` last and exactly once. For one call,
 * `tool_use` comes before its `tool_decision`, which comes before its
 * `tool_result`. Calls of one round run at the same time, so their results
 * are written as each finishes.
 */
export class StreamJsonRun {
  private seq = 0;
  private finished = false;
  private readonly started: number;
  private readonly now: () => number;
  private readonly seenCalls = new Set<string>();
  private readonly endedCalls = new Set<string>();
  private requests = 0;
  private toolCalls = 0;
  private refusals = 0;
  private startMark: UsageMark;
  private lastMark: UsageMark;

  constructor(private readonly options: StreamJsonRunOptions) {
    this.now = options.now ?? Date.now;
    this.started = this.now();
    this.startMark = this.lastMark = markOf(options.usage?.());
  }

  get isFinished(): boolean {
    return this.finished;
  }

  private emit(body: StreamJsonEventBody): void {
    if (this.finished) return;
    const { type, ...rest } = body;
    const event = {
      type,
      seq: ++this.seq,
      time: new Date(this.now()).toISOString(),
      ...rest,
    } as StreamJsonEvent;
    this.options.write(JSON.stringify(event) + "\n");
  }

  /**
   * The first line. Calls already in `history` (a resumed session) are not
   * this run's, and spend restored with the session does not count.
   */
  init(
    facts: Omit<InitEvent, "type" | "seq" | "time" | "schemaVersion">,
    history: ChatHistoryItem[] = [],
  ): void {
    for (const item of history) {
      for (const state of item.toolCallStates ?? []) {
        this.seenCalls.add(state.toolCallId);
        this.endedCalls.add(state.toolCallId);
      }
    }
    this.startMark = this.lastMark = markOf(this.options.usage?.());
    this.emit({
      type: "init",
      schemaVersion: STREAM_JSON_SCHEMA_VERSION,
      ...facts,
    });
  }

  /**
   * The model in use changed (M7): a `model` line. A record from before
   * `init` (the start model) is not one: `init` names it.
   */
  modelInUse(info: ModelInUse): void {
    if (this.seq === 0 || info.reason === "start") return;
    this.emit({
      type: "model",
      model: info.model,
      provider: info.provider,
      name: info.name,
      ...(info.effort ? { reasoningEffort: info.effort } : {}),
      reason: info.reason,
      ...(info.use ? { use: info.use } : {}),
      ...(info.agent ? { agent: info.agent } : {}),
      ...(info.fallbackReason
        ? { fallbackReason: maskCommandForDisplay(info.fallbackReason) }
        : {}),
    });
  }

  /** One reply's reasoning, whole (`--include-reasoning`). */
  reasoning(content: string, durationMs?: number): void {
    if (!content.trim()) return;
    this.emit({
      type: "reasoning",
      role: "assistant",
      content: maskCommandForDisplay(content),
      ...(durationMs !== undefined &&
        durationMs >= 0 && { durationMs: Math.round(durationMs) }),
    });
  }

  /** One complete reply of the model. */
  message(content: string): void {
    if (!content.trim()) return;
    this.emit({
      type: "message",
      role: "assistant",
      content: maskCommandForDisplay(content),
    });
  }

  /**
   * The conversation after a change: writes `tool_use` for a call not seen
   * before and `tool_result` the first time a call has ended.
   */
  observeHistory(history: ChatHistoryItem[]): void {
    for (const item of history) {
      for (const state of item.toolCallStates ?? []) {
        const callId = state.toolCallId;
        const tool = state.toolCall?.function?.name ?? "";
        if (!this.seenCalls.has(callId)) {
          this.seenCalls.add(callId);
          this.toolCalls++;
          this.emit({
            type: "tool_use",
            callId,
            tool,
            args: maskArgs(state.parsedArgs ?? {}),
          });
        }
        if (isEnded(state.status) && !this.endedCalls.has(callId)) {
          this.endedCalls.add(callId);
          const raw = (state.output ?? [])
            .map((o) => (typeof o.content === "string" ? o.content : ""))
            .join("\n");
          const out = maskAndClip(raw, STREAM_JSON_OUTPUT_CHARS);
          this.emit({
            type: "tool_result",
            callId,
            tool,
            status: state.status,
            output: out.text,
            outputLength: out.length,
            truncated: out.truncated,
          });
        }
      }
    }
  }

  /** The permission system's decision on one call. */
  toolDecision(
    call: { id: string; name: string },
    facts: DecisionFacts,
    result: { approved: boolean; denialMessage?: string },
  ): void {
    const asked = !!(facts.askedPerson || facts.held);
    const decision: ToolDecisionEvent["decision"] = asked
      ? "asked"
      : result.approved
        ? "allowed"
        : "refused";
    if (!result.approved && !facts.held) this.refusals++;
    const v = facts.verdict;
    const reason = v?.reason ?? result.denialMessage;
    this.emit({
      type: "tool_decision",
      callId: call.id,
      tool: call.name,
      decision,
      by: facts.askedPerson ? "person" : (v?.by ?? "rules"),
      ...(v?.source ? { source: v.source } : {}),
      ...(v?.rule ? { rule: maskCommandForDisplay(v.rule) } : {}),
      ...(reason ? { reason: maskCommandForDisplay(reason) } : {}),
      ...(facts.askedPerson
        ? {
            answer: result.approved
              ? ("approved" as const)
              : ("denied" as const),
          }
        : {}),
      ...(facts.held ? { held: true as const } : {}),
    });
  }

  /** A model request finished and its usage is on the session. */
  requestDone(): void {
    const usage = this.options.usage?.();
    const mark = markOf(usage);
    const last = this.lastMark;
    this.lastMark = mark;
    this.requests++;
    const priced = pricedSince(usage, last, mark);
    this.emit({
      type: "usage",
      request: this.requests,
      inputTokens: Math.max(0, mark.input - last.input),
      outputTokens: Math.max(0, mark.output - last.output),
      cacheReadTokens: Math.max(0, mark.cacheRead - last.cacheRead),
      cacheWriteTokens: Math.max(0, mark.cacheWrite - last.cacheWrite),
      costUsd: usd(mark.cost - last.cost),
      totalCostUsd: usd(mark.cost - this.startMark.cost),
      costEstimated: !!usage?.costEstimated,
      ...(priced.sources[0] ? { priceSource: priced.sources[0] } : {}),
      ...(priced.tiers[0] ? { servedTier: priced.tiers[0] } : {}),
    });
  }

  runLimit(stop: {
    reason: "budget" | "turns" | "duration";
    phase: "before-call" | "after-call";
    detail: string;
    spentUsd?: number;
    exitCode: number;
  }): void {
    this.emit({
      type: "run_limit",
      reason: stop.reason,
      phase: stop.phase,
      message: stop.detail,
      exitCode: stop.exitCode,
      ...(stop.spentUsd === undefined ? {} : { spentUsd: usd(stop.spentUsd) }),
    });
  }

  error(kind: RunErrorKind, message: string, code?: string): void {
    this.emit({
      type: "error",
      kind,
      message: maskCommandForDisplay(message),
      ...(code ? { code } : {}),
    });
  }

  /** The last line. A second call writes nothing. */
  finish(end: { status: RunStatus; exitCode: number; result?: string }): void {
    if (this.finished) return;
    const usage = this.options.usage?.();
    const mark = markOf(usage);
    const start = this.startMark;
    const priced = pricedSince(usage, start, mark);
    this.emit({
      type: "result",
      schemaVersion: STREAM_JSON_SCHEMA_VERSION,
      status: end.status,
      exitCode: end.exitCode,
      result: maskCommandForDisplay(end.result ?? ""),
      durationMs: Math.max(0, this.now() - this.started),
      numRequests: this.requests,
      numToolCalls: this.toolCalls,
      numRefusals: this.refusals,
      numIdgafObjections: idgafObjectionCount(),
      usage: {
        inputTokens: Math.max(0, mark.input - start.input),
        outputTokens: Math.max(0, mark.output - start.output),
        cacheReadTokens: Math.max(0, mark.cacheRead - start.cacheRead),
        cacheWriteTokens: Math.max(0, mark.cacheWrite - start.cacheWrite),
      },
      totalCostUsd: usd(mark.cost - start.cost),
      costEstimated: !!usage?.costEstimated,
      priceSources: priced.sources,
      ...(priced.tiers.length > 0 ? { servedTiers: priced.tiers } : {}),
    });
    this.finished = true;
  }
}

let active: StreamJsonRun | undefined;

/** The run's event stream, when `--format stream-json` is on. */
export function activeStreamJson(): StreamJsonRun | undefined {
  return active;
}

export function setActiveStreamJson(run: StreamJsonRun | undefined): void {
  active = run;
}
