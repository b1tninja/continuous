/**
 * Surface facts: what a (provider, engine, API) surface does with tool calls,
 * resolved one fact at a time. The data is core/util/surfaceFacts.generated.json
 * ("what a surface did, when"); the family table in toolDialectPresetTable.ts
 * stays "what the template says". Design: plans/ROADMAP.md Track PL, row PL1.
 *
 * Pure and GUI-safe: no I/O, no clock (callers pass `now`), no import from
 * `@continuedev/openai-adapters`. Slice 1 changes no request and no choice of
 * which models get tools or recovery: the only reader is the info line of
 * Test connection (`surfaceFactsLine`).
 *
 * Resolution order per fact, most specific first: the user's override, a
 * measured result for this endpoint, a surface row naming the model family, a
 * surface row for the provider/engine/API, then unknown. Presets only suggest:
 * `actionAllowed` is the evidence floor that says what a layer may cause.
 */
import { claudeRefusesSampling } from "./anthropicSamplingGuard.js";
import data from "./surfaceFacts.generated.json";

export type FactLevel = "declared" | "measured" | "derived";

export type ToolChoiceMode = "auto" | "required" | "named" | "none";

/** Value types by fact name. `toolChoice` lists only the modes the source speaks to. */
export interface FactValues {
  /** Whether structured tool calls come back; "per-endpoint" when upstreams differ. */
  toolsHonoured: boolean | "per-endpoint";
  toolChoice: Partial<Record<ToolChoiceMode, boolean>>;
  parallelCalls: boolean;
  /** Tool arguments while streaming: incremental, whole, refused by the service, or broken. */
  streamingToolArgs: "incremental" | "whole" | "refused" | "broken";
  /** Name of the response field carrying reasoning. */
  reasoningField: string;
  /** A parser name, "none", or "flag:<option>" when the parser is opt-in. */
  serverParses: string;
  /** Declared quantization notes only; never measured here. */
  quantization: string;
  toolForce: "honoured" | "ignored" | "rejected";
  toolForceThinking: "kept" | "skipped";
  toolStrictArgs: "engine" | "provider-strict" | "none";
  /**
   * Whether the reply text can be constrained to a JSON schema by the server
   * (Anthropic `output_config.format`, OpenAI `text.format`/`response_format`,
   * Ollama `format`, Bedrock `outputConfig.textFormat`). "per-model" when the
   * surface offers it for some models only.
   */
  schemaOutput: "json-schema" | "json-object" | "per-model" | "none";
  /** Whether a raw grammar is accepted: "gbnf" (llama.cpp), "grammar" (vLLM, any dialect its backend takes), "none". */
  grammar: "gbnf" | "grammar" | "none";
  /**
   * Whether `temperature`, `top_p` and `top_k` may be sent. "refused": the
   * surface answers HTTP 400 for a non-default value (Claude 4.7 and later),
   * so the request leaves them out (core/util/anthropicSamplingGuard.ts).
   */
  samplingParams: "accepted" | "refused";
}

export type FactName = keyof FactValues;

export interface Fact<N extends FactName = FactName> {
  value: FactValues[N];
  level: FactLevel;
  /** URL, file path or run id the value rests on. */
  source: string;
  /** Date the source was read or the run was made, YYYY-MM-DD. */
  readOn: string;
  /** Observations that agreed with the value, out of `n`. Required when measured. */
  k?: number;
  n?: number;
  /** Run that produced a measured fact. */
  runId?: string;
  /** The client path the measurement went through. */
  clientPath?: string;
  /** YYYY-MM-DD after which the fact is shown as stale (never acted on). */
  expires?: string;
  note?: string;
}

export interface SurfaceRow {
  id: string;
  provider: string;
  engine: string;
  api: string;
  /** Preset id of the model family (toolDialectPresetTable) or a named generation. */
  modelFamily?: string;
  facts: { [N in FactName]?: Fact<N> };
}

export interface SurfaceFactsFile {
  schemaVersion: number;
  rows: SurfaceRow[];
}

export const SURFACE_FACTS = data as unknown as SurfaceFactsFile;

export type FactLayer = "user" | "measured" | "family" | "surface" | "none";

export interface SurfaceQuery {
  provider: string;
  engine?: string;
  api: string;
  modelFamily?: string;
}

/** A measured result for this exact endpoint, keyed by the caller. */
export type MeasuredFacts = { [N in FactName]?: Fact<N> };
export type UserOverrides = { [N in FactName]?: FactValues[N] };

export interface ResolvedFact<N extends FactName = FactName> {
  name: N;
  /** Undefined when no layer knows the fact. */
  value: FactValues[N] | undefined;
  layer: FactLayer;
  /** Level of the winning fact; a user override has none. */
  level?: FactLevel;
  source?: string;
  readOn?: string;
  k?: number;
  n?: number;
  rowId?: string;
  /** Past its `expires` on the date given as `now`: shown, never acted on. */
  stale?: boolean;
  /** A measured value that contradicts the preset it beat. */
  drift?: string;
}

export interface ResolveInput extends SurfaceQuery {
  userOverrides?: UserOverrides;
  measured?: MeasuredFacts;
  /** ISO date for staleness; omitted means no staleness is judged. */
  now?: string;
  /** Data to read; defaults to the generated file. */
  rows?: SurfaceRow[];
}

const LEVEL_RANK: Record<FactLevel, number> = {
  measured: 3,
  derived: 2,
  declared: 1,
};

/** Specificity of a row for a query, or -1 when it does not apply. */
function specificity(row: SurfaceRow, q: SurfaceQuery): number {
  let s = 0;
  const parts: [string, string | undefined][] = [
    [row.provider, q.provider],
    [row.engine, q.engine],
    [row.api, q.api],
  ];
  for (const [want, have] of parts) {
    if (want === "*") continue;
    if (want !== have) return -1;
    s += 1;
  }
  if (row.modelFamily !== undefined) {
    if (row.modelFamily !== q.modelFamily) return -1;
    s += 10;
  }
  return s;
}

function isStale(f: Fact, now: string | undefined): boolean {
  return !!now && !!f.expires && f.expires < now;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Candidate {
  fact: Fact;
  row: SurfaceRow;
  spec: number;
}

function bestSurfaceFact(
  name: FactName,
  q: SurfaceQuery,
  rows: SurfaceRow[],
): Candidate | undefined {
  let best: Candidate | undefined;
  for (const row of rows) {
    const fact = row.facts[name] as Fact | undefined;
    if (!fact) continue;
    const spec = specificity(row, q);
    if (spec < 0) continue;
    if (
      !best ||
      spec > best.spec ||
      (spec === best.spec &&
        (LEVEL_RANK[fact.level] > LEVEL_RANK[best.fact.level] ||
          (fact.level === best.fact.level && fact.readOn > best.fact.readOn)))
    ) {
      best = { fact, row, spec };
    }
  }
  return best;
}

function fromFact(
  name: FactName,
  layer: FactLayer,
  f: Fact,
  now: string | undefined,
  rowId?: string,
): ResolvedFact {
  return {
    name,
    value: f.value,
    layer,
    level: f.level,
    source: f.source,
    readOn: f.readOn,
    ...(f.k === undefined ? {} : { k: f.k }),
    ...(f.n === undefined ? {} : { n: f.n }),
    ...(rowId ? { rowId } : {}),
    ...(isStale(f, now) ? { stale: true } : {}),
  };
}

/** Resolve one fact through the layers. */
export function resolveFact<N extends FactName>(
  name: N,
  input: ResolveInput,
): ResolvedFact<N> {
  const user = input.userOverrides?.[name];
  if (user !== undefined) {
    return { name, value: user, layer: "user" } as ResolvedFact<N>;
  }
  const best = bestSurfaceFact(name, input, input.rows ?? SURFACE_FACTS.rows);
  const measured = input.measured?.[name] as Fact | undefined;
  // A weak measurement (a handful of probes, level "declared") never beats a
  // stronger surface fact, which keeps answering.
  const weak =
    !!measured &&
    measured.level === "declared" &&
    !!best &&
    LEVEL_RANK[best.fact.level] > LEVEL_RANK[measured.level];
  if (measured && !weak) {
    const r = fromFact(name, "measured", measured, input.now);
    if (best && !sameValue(best.fact.value, measured.value)) {
      r.drift = `measured ${JSON.stringify(measured.value)} contradicts ${best.row.id} (${best.fact.level}, read ${best.fact.readOn}): ${JSON.stringify(best.fact.value)}`;
    }
    return r as ResolvedFact<N>;
  }
  if (best) {
    const layer = best.row.modelFamily === undefined ? "surface" : "family";
    return fromFact(
      name,
      layer,
      best.fact,
      input.now,
      best.row.id,
    ) as ResolvedFact<N>;
  }
  return { name, value: undefined, layer: "none" } as ResolvedFact<N>;
}

export const FACT_NAMES: FactName[] = [
  "toolsHonoured",
  "toolChoice",
  "parallelCalls",
  "streamingToolArgs",
  "reasoningField",
  "serverParses",
  "quantization",
  "toolForce",
  "toolForceThinking",
  "toolStrictArgs",
  "schemaOutput",
  "grammar",
  "samplingParams",
];

export type ResolvedFacts = { [N in FactName]: ResolvedFact<N> };

/**
 * Every fact for a surface, each with the layer that answered it. A surface
 * that knows only `toolChoice` does not hide anything another layer knows.
 */
export function resolveSurfaceFacts(input: ResolveInput): ResolvedFacts {
  const out: Partial<Record<FactName, ResolvedFact>> = {};
  for (const name of FACT_NAMES) out[name] = resolveFact(name, input);
  return out as ResolvedFacts;
}

export type SurfaceAction =
  /** Show a warning or a suggestion. */
  | "warn"
  /** Turn tools off, or route non-streaming: a safe degradation. */
  | "disableTools"
  /** Turn tools on by default for the surface. */
  | "enableTools"
  /** Turn text recovery on by default. */
  | "enableRecovery";

/** Evidence floor for enabling tools: k of n, with n at the battery minimum. */
export const ENABLE_TOOLS_MIN_N = 8;

/**
 * The evidence floor. Precedence says which layer wins; this says what the
 * winner may cause:
 * - warn: any known fact (declared, derived or measured);
 * - disableTools: declared or measured, not derived;
 * - enableTools: measured only, k equal to n and n at least 8, not stale;
 * - enableRecovery: only the user's own override, never a preset or a
 *   measurement, until the zero-false-call bar (RQ7) holds for the dialect.
 * A user override may do anything it is asked: it is the user's decision.
 */
export function actionAllowed(
  action: SurfaceAction,
  fact: ResolvedFact,
): boolean {
  if (fact.value === undefined || fact.layer === "none") return false;
  if (fact.layer === "user") return true;
  switch (action) {
    case "warn":
      return true;
    case "disableTools":
      return fact.level === "declared" || fact.level === "measured";
    case "enableTools":
      return (
        fact.level === "measured" &&
        !fact.stale &&
        fact.n !== undefined &&
        fact.k !== undefined &&
        fact.n >= ENABLE_TOOLS_MIN_N &&
        fact.k === fact.n
      );
    case "enableRecovery":
      return false;
  }
}

/** The evidence-floor table as data, for docs and the test. */
export const EVIDENCE_FLOOR: Record<SurfaceAction, string> = {
  warn: "declared, derived or measured",
  disableTools: "declared or measured",
  enableTools: "measured, k = n, n >= 8, not stale",
  enableRecovery: "the user's override only",
};

const MODES: ToolChoiceMode[] = ["auto", "required", "named", "none"];

function phrase(r: ResolvedFact): string | undefined {
  if (r.value === undefined) return undefined;
  switch (r.name) {
    case "toolChoice": {
      const v = r.value as FactValues["toolChoice"];
      const no = MODES.filter((m) => v[m] === false);
      const yes = MODES.filter((m) => v[m] === true);
      if (no.length === 0 && yes.length === 0) return undefined;
      return no.length
        ? `tool_choice ${no.join("/")} not supported`
        : `tool_choice ${yes.join("/")} supported`;
    }
    case "toolsHonoured":
      return r.value === "per-endpoint"
        ? "tools support differs per upstream endpoint"
        : r.value
          ? "tools honoured"
          : "tools not honoured as structured calls";
    case "streamingToolArgs":
      return r.value === "refused"
        ? "tools refused while streaming"
        : r.value === "broken"
          ? "streamed tool arguments arrive broken"
          : undefined;
    case "serverParses": {
      const s = String(r.value);
      return s.startsWith("flag:")
        ? `server parses calls only with ${s.slice(5)}`
        : s === "none"
          ? "server does not parse calls"
          : `server parses calls (${s})`;
    }
    case "toolForce":
      return r.value === "rejected"
        ? "forced tool choice is rejected"
        : undefined;
    default:
      return undefined;
  }
}

function suffix(r: ResolvedFact): string {
  if (r.layer === "user") return "your setting";
  const k = r.k !== undefined && r.n !== undefined ? ` ${r.k}/${r.n}` : "";
  return `${r.level}${k}, read ${r.readOn}${r.stale ? ", stale" : ""}`;
}

/**
 * One info line for Test connection, for example
 * "Provider facts: Ollama /v1: tool_choice required/named/none not supported
 * (declared, read 2026-11-10)". Undefined when nothing is known. Information
 * only: nothing gates on it.
 */
export function surfaceFactsLine(
  label: string,
  input: ResolveInput,
): string | undefined {
  const all = resolveSurfaceFacts(input);
  const parts: string[] = [];
  for (const name of FACT_NAMES) {
    const r = all[name] as ResolvedFact;
    const p = phrase(r);
    if (p) parts.push(`${p} (${suffix(r)})`);
  }
  if (parts.length === 0) return undefined;
  return `Provider facts: ${label}: ${parts.slice(0, 3).join("; ")}`;
}

/** The surface for a Continue provider name, or undefined when unlisted. */
export function surfaceForProvider(
  provider: string,
): { query: SurfaceQuery; label: string } | undefined {
  switch (provider) {
    case "ollama":
      return {
        query: { provider: "ollama", engine: "ollama", api: "openai-chat" },
        label: "Ollama /v1",
      };
    case "llama.cpp":
    case "llamacpp":
      return {
        query: { provider: "llamacpp", engine: "llamacpp", api: "openai-chat" },
        label: "llama.cpp server",
      };
    case "vllm":
      return {
        query: { provider: "vllm", engine: "vllm", api: "openai-chat" },
        label: "vLLM",
      };
    case "openrouter":
      return {
        query: { provider: "openrouter", api: "openai-chat" },
        label: "OpenRouter",
      };
    case "openai":
      return {
        query: { provider: "openai", api: "openai-chat" },
        label: "OpenAI chat",
      };
    default:
      return undefined;
  }
}

/** Claude's 5.5 generation, where forced tool choice returns 400. */
const CLAUDE_5_5 =
  /claude[-.]?(?:opus|sonnet)[-.]5[-.]5|fable[-.]5|mythos[-.]5/i;

/** The family key rows use: the preset id, or the named Claude generation (5.5, or 4.7 up to 5.4). */
export function surfaceFamily(
  presetId: string | undefined,
  modelId: string | undefined,
): string | undefined {
  if (modelId && CLAUDE_5_5.test(modelId)) return "claude-5.5-generation";
  if (modelId && claudeRefusesSampling(modelId)) return "claude-4.7-generation";
  return presetId;
}
