/**
 * The contract between the product and the dev-only local lab (bench/lab, and
 * later the lab repository). Pure: no imports, no I/O, no clock, no network.
 *
 * The lab may import the product only through this module, and the product
 * must never import the lab. `LAB_CONTRACT_VERSION` is pinned by
 * `labContract.pin.json` (a vitest fails when an export, a function's arity or
 * a constant changes without the pin being updated together with the version),
 * and `labContract.golden.json` holds vectors that the product's vitest and the
 * lab's start-up check both run against their own loaded copy.
 */

/**
 * Bump when anything exported here changes shape or meaning.
 * 2: server identity (`ServerIdentity`, `SERVER_PARSER_SOURCES`).
 * 3: a request may send no sampling option (`TEMPERATURE_INHERITED`).
 */
export const LAB_CONTRACT_VERSION = 3;

/**
 * The temperature recorded for a request that sent none, so the engine's own
 * (or the Modelfile's) sampling applied. Distinct from `"default"`, which
 * names the product's default setting, and from 0, which is sent.
 */
export const TEMPERATURE_INHERITED = "inherited" as const;

/** What one captured reply was, for the rates. Errors stay out of denominators. */
export const PROBE_OUTCOMES = [
  "structured",
  "leak",
  "refused",
  "error",
] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/**
 * Which server answered and how it parses tool calls, so a result can be tied
 * to a version (vLLM changed its Qwen3 parser between minor versions and the
 * new one strips whitespace from string arguments, vLLM issue 48753). Every
 * field is what the server reported; a field it does not report is absent,
 * never guessed. `parserSource` says where `parser` came from.
 */
export interface ServerIdentity {
  /** "llama-server", "vllm", "ollama", "bedrock", ... */
  name: string;
  /** Release or build: llama.cpp /props build_info, vLLM /version, Ollama /api/version. */
  version?: string;
  /** Tool-call parser or handler name. */
  parser?: string;
  /** "reported" (Ollama /api/show parser, llama.cpp Chat format) or "declared" (the operator said so). */
  parserSource?: "reported" | "declared";
  /** First 16 hex characters of the SHA-256 of the chat template the server uses. */
  templateSha?: string;
}

export const SERVER_PARSER_SOURCES = ["reported", "declared"] as const;

/** A tool call as the wire carried it. */
export interface CaptureToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** One request as sent, before any engine-specific encoding. */
export interface CaptureRequestShape {
  model: string;
  transport: "bedrock" | "openai" | "ollama" | "llamacpp";
  streamed: boolean;
  temperature: "default" | typeof TEMPERATURE_INHERITED | 0;
  promptId: string;
}

/** One reply as received, before any parsing of ours. */
export interface CaptureReplyShape {
  text: string;
  toolCalls: CaptureToolCall[];
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
}

/** The outcome of one dialect probe of one arm. */
export interface DialectProbeResult {
  model: string;
  outcome: ProbeOutcome;
  /** The dialect the leak detector named, or "none". */
  dialect: string;
  k: number;
  n: number;
}

export interface Rate {
  k: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
}

/** The two-sided 95 percent normal quantile. */
export const Z95 = 1.959963984540054;

/** Wilson score interval for k successes in n trials; the whole range at n = 0. */
export function wilson(k: number, n: number, z: number = Z95): Rate {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError(`wilson needs integers 0 <= k <= n, got ${k}/${n}`);
  }
  if (n === 0) return { k, n, rate: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    k,
    n,
    rate: p,
    lo: Math.max(0, centre - margin),
    hi: Math.min(1, centre + margin),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** "2/8 = 25% [7%, 59%]"; "0/0 = n/a" with no trials. */
export function formatRate(r: Rate): string {
  if (r.n === 0) return "0/0 = n/a";
  return `${r.k}/${r.n} = ${pct(r.rate)} [${pct(r.lo)}, ${pct(r.hi)}]`;
}

/** Lower-case, non-alphanumerics collapsed to single dashes, no edge dashes. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** The id of a captured corpus fixture; the corpus pins the format. */
export function captureFixtureId(parts: {
  model: string;
  transport: string;
  streamed: boolean;
  temperature: "default" | typeof TEMPERATURE_INHERITED | 0;
  pass: number;
  promptId: string;
}): string {
  const mode = parts.streamed ? "stream" : "whole";
  return `live-${slug(parts.model)}-${parts.transport}-${mode}-t${parts.temperature}-p${parts.pass}-${parts.promptId}`;
}

/** Problems with a probe result, or an empty list when it is well formed. */
export function validateProbeResult(x: unknown): string[] {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    return ["not an object"];
  }
  const r = x as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof r.model !== "string" || r.model === "") {
    problems.push("model must be a non-empty string");
  }
  if (!PROBE_OUTCOMES.includes(r.outcome as ProbeOutcome)) {
    problems.push(`outcome must be one of ${PROBE_OUTCOMES.join(", ")}`);
  }
  if (typeof r.dialect !== "string") problems.push("dialect must be a string");
  const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  if (!isCount(r.k)) problems.push("k must be a non-negative integer");
  if (!isCount(r.n)) problems.push("n must be a non-negative integer");
  if (isCount(r.k) && isCount(r.n) && (r.k as number) > (r.n as number)) {
    problems.push("k must not exceed n");
  }
  return problems;
}

/** Problems with a server identity, or an empty list when it is well formed. */
export function validateServerIdentity(x: unknown): string[] {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    return ["not an object"];
  }
  const r = x as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof r.name !== "string" || r.name === "") {
    problems.push("name must be a non-empty string");
  }
  for (const key of ["version", "parser", "templateSha"]) {
    if (key in r && (typeof r[key] !== "string" || r[key] === "")) {
      problems.push(`${key} must be a non-empty string when present`);
    }
  }
  if (
    "parserSource" in r &&
    !SERVER_PARSER_SOURCES.includes(r.parserSource as "reported")
  ) {
    problems.push(
      `parserSource must be one of ${SERVER_PARSER_SOURCES.join(", ")}`,
    );
  }
  if ("parserSource" in r && !("parser" in r)) {
    problems.push("parserSource needs a parser");
  }
  return problems;
}

/** "vllm 0.25.1, parser qwen3_coder (declared)"; the name alone when nothing else is known. */
export function serverIdentityLabel(id: ServerIdentity): string {
  const head = id.version ? `${id.name} ${id.version}` : id.name;
  const parts = [head];
  if (id.parser) {
    parts.push(
      `parser ${id.parser}${id.parserSource ? ` (${id.parserSource})` : ""}`,
    );
  }
  if (id.templateSha) parts.push(`template ${id.templateSha}`);
  return parts.join(", ");
}
