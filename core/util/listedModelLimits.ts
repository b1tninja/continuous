/**
 * Context window and output cap as an OpenAI-compatible server reports them
 * in its own `GET /models` entry or its server-properties endpoint. Servers
 * name the field differently, and some report the window the model was
 * trained for rather than the one the server runs with, so each field has a
 * kind and the runtime values win. Pure: nothing is fetched here.
 */

export type WindowKind =
  /** The window the server runs the model with right now. */
  | "loaded"
  /** The most the model supports, as the server lists it. */
  | "max"
  /** The window the model was trained for; a ceiling, not a setting. */
  | "trained";

export interface ListedLimits {
  contextLength?: number;
  maxOutputTokens?: number;
  /** The field the window came from, for the sentence shown to the person. */
  field?: string;
  kind?: WindowKind;
}

interface WindowField {
  path: string[];
  kind: WindowKind;
}

/** In priority order: the first one a server sends is used. */
const WINDOW_FIELDS: readonly WindowField[] = [
  { path: ["loaded_context_length"], kind: "loaded" }, // LM Studio
  { path: ["default_generation_settings", "n_ctx"], kind: "loaded" }, // llama.cpp /props
  { path: ["context_length"], kind: "max" }, // OpenRouter, Together, Fireworks
  { path: ["top_provider", "context_length"], kind: "max" }, // OpenRouter
  { path: ["max_model_len"], kind: "max" }, // vLLM
  { path: ["context_window"], kind: "max" }, // Groq
  { path: ["max_context_length"], kind: "max" }, // LM Studio
  { path: ["meta", "n_ctx_train"], kind: "trained" }, // llama.cpp /v1/models
];

const OUTPUT_PATHS: readonly string[][] = [
  ["top_provider", "max_completion_tokens"],
  ["max_completion_tokens"],
  ["max_output_tokens"],
];

function at(value: unknown, path: readonly string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** A whole number of tokens of at least 1, from a number or a numeric string. */
export function tokenCount(value: unknown): number | undefined {
  const n =
    typeof value === "string" && value.trim() !== ""
      ? Number(value.trim())
      : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** The limits one entry (a `/models` item or a `/props` body) reports. */
export function limitsOfEntry(entry: unknown): ListedLimits {
  const out: ListedLimits = {};
  for (const f of WINDOW_FIELDS) {
    const n = tokenCount(at(entry, f.path));
    if (n !== undefined) {
      out.contextLength = n;
      out.field = f.path.join(".");
      out.kind = f.kind;
      break;
    }
  }
  for (const p of OUTPUT_PATHS) {
    const n = tokenCount(at(entry, p));
    if (n !== undefined) {
      out.maxOutputTokens = n;
      break;
    }
  }
  return out;
}

/**
 * The limits for one model id in a `/models` body (`{ data: [...] }` or a
 * bare array). Undefined when the id is not listed or its entry says nothing.
 */
export function limitsFromModelsBody(
  body: unknown,
  modelId: string,
): ListedLimits | undefined {
  const list = Array.isArray(body)
    ? body
    : ((body as { data?: unknown; models?: unknown } | null)?.data ??
      (body as { models?: unknown } | null)?.models);
  if (!Array.isArray(list)) return undefined;
  const entry = list.find((m) => {
    const id = (m as { id?: unknown; model?: unknown; name?: unknown })?.id;
    return id === modelId;
  });
  if (!entry) return undefined;
  const limits = limitsOfEntry(entry);
  return limits.contextLength !== undefined ||
    limits.maxOutputTokens !== undefined
    ? limits
    : undefined;
}

/**
 * Ollama's `POST /api/show` body: `parameters` text may hold the model's
 * `num_ctx` (what Ollama runs it with); `model_info` holds the trained
 * window as `<architecture>.context_length`.
 */
export function limitsFromOllamaShow(body: unknown): ListedLimits {
  const params = (body as { parameters?: unknown } | null)?.parameters;
  if (typeof params === "string") {
    const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(params);
    const n = m ? tokenCount(m[1]) : undefined;
    if (n !== undefined) {
      return { contextLength: n, field: "parameters.num_ctx", kind: "loaded" };
    }
  }
  const info = (body as { model_info?: unknown } | null)?.model_info;
  if (info && typeof info === "object") {
    for (const [key, value] of Object.entries(info)) {
      if (!key.endsWith(".context_length")) continue;
      const n = tokenCount(value);
      if (n !== undefined) {
        return { contextLength: n, field: key, kind: "trained" };
      }
    }
  }
  return {};
}

/** One sentence for the Test connection result. */
export function describeListedLimits(l: ListedLimits): string | undefined {
  if (l.contextLength === undefined) return undefined;
  const n = l.contextLength.toLocaleString();
  switch (l.kind) {
    case "loaded":
      return `The server runs this model with a window of ${n} tokens.`;
    case "trained":
      return `The model was trained for ${n} tokens. The server may run it with less.`;
    default:
      return `The server reports a window of ${n} tokens for this model.`;
  }
}
