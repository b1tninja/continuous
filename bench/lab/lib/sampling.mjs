// Sampling settings: what the lab sends, what it records as sent, and what an
// engine would apply when the lab sends nothing ("inherit"). Pure.
//
// `--temperature inherit` sends no sampling option at all (no temperature, top_p,
// top_k, penalty or seed unless --seed asks for one), so the engine's own defaults
// and, on Ollama, the Modelfile PARAMETER lines apply. Token caps (num_predict)
// and the context size (num_ctx) are not sampling and are still sent.

export const INHERIT = "inherit";
export const INHERITED = "inherited";

/** The sampling knobs whose absence from a request means "the engine decides". */
const KNOBS = [
  ["temperature", "temperature"],
  ["top_p", "topP"],
  ["top_k", "topK"],
  ["min_p", "minP"],
  ["presence_penalty", "presencePenalty"],
  ["repeat_penalty", "repeatPenalty"],
];

/** The temperature to put in a request, or undefined to send none. */
export function temperatureToSend(cfg, fallback) {
  if (cfg?.temperature === INHERIT) return undefined;
  return cfg?.temperature ?? fallback;
}

/**
 * The seed of one pass. `--seed N` is the base: pass p uses N + p - 1, so the
 * passes of a prompt are distinct draws at temperature above 0 and a rerun
 * reproduces each of them. (A constant seed would make every pass an exact
 * repeat, which is what temperature 0 already does.)
 */
export function seedFor(cfg, pass = 1) {
  return cfg?.seed == null ? undefined : cfg.seed + (pass - 1);
}

/**
 * The sampling a request actually carried, read back from its body: numbers for
 * what was sent, the string "inherited" for a temperature that was not, and
 * `inherited` listing every knob the engine chose.
 */
export function samplingSent(api, body) {
  const o = api === "ollama-chat" || api === "ollama-raw" ? body.options : body;
  const src = o ?? {};
  const out = { temperature: src.temperature ?? INHERITED };
  const inherited = [];
  for (const [wire, name] of KNOBS) {
    if (src[wire] == null) inherited.push(wire);
    else if (name !== "temperature") out[name] = src[wire];
  }
  if (Number.isInteger(src.seed)) out.seed = src.seed;
  const cap = src.num_predict ?? src.max_tokens ?? src.n_predict;
  if (Number.isInteger(cap) && cap > 0) out.maxTokens = cap;
  out.inherited = inherited;
  return out;
}

/**
 * The body shape for `samplingSent` when only the options of a request are
 * known (a request that failed before any reply, or the plain Ollama client).
 */
export function sentShape(api, options = {}, bodyExtra) {
  const ollama = api === "ollama-chat" || api === "ollama-raw";
  const base = ollama
    ? {
        options: Object.fromEntries(
          Object.entries(options).filter(([, v]) => v != null),
        ),
      }
    : {
        ...(options.temperature != null && {
          temperature: options.temperature,
        }),
        ...(options.seed != null && { seed: options.seed }),
        ...(options.num_predict > 0 && { max_tokens: options.num_predict }),
      };
  return mergeBodyExtra(base, bodyExtra);
}

const plain = (x) => x && typeof x === "object" && !Array.isArray(x);

/**
 * `--body-extra` merged into a request body. The `options` object is merged
 * key by key (a shallow assign would replace it and silently drop the
 * temperature, num_predict and num_ctx the lab put there); every other key is
 * replaced.
 */
export function mergeBodyExtra(body, extra) {
  if (!extra) return body;
  for (const [k, v] of Object.entries(extra)) {
    if (k === "options" && plain(v) && plain(body.options))
      body.options = { ...body.options, ...v };
    else body[k] = v;
  }
  return body;
}

const scalar = (v) => {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
};

/**
 * The `parameters` text of Ollama's /api/show (the Modelfile PARAMETER lines,
 * "temperature 1\ntop_k 20\nstop \"<|im_end|>\"") as an object. A repeated
 * key (stop) becomes an array. These are the defaults an Ollama request
 * inherits from the model; anything the Modelfile does not name falls back to
 * the server's own built-in default, which /api/show does not report.
 */
export function parseModelfileParameters(text) {
  if (typeof text !== "string" || !text.trim()) return undefined;
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][\w]*)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const v = scalar(m[2]);
    if (m[1] in out) out[m[1]] = [].concat(out[m[1]], v);
    else out[m[1]] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * llama-server's startup sampling defaults from /props
 * (`default_generation_settings.params`), the sampling keys only.
 */
export function llamaSamplingDefaults(props) {
  const p = props?.default_generation_settings?.params;
  if (!plain(p)) return undefined;
  const keys = [
    "temperature",
    "top_k",
    "top_p",
    "min_p",
    "presence_penalty",
    "frequency_penalty",
    "repeat_penalty",
    "seed",
  ];
  const out = {};
  for (const k of keys) if (p[k] !== undefined) out[k] = p[k];
  return Object.keys(out).length ? out : undefined;
}

/** The chat format a llama-server names in /props, wherever the build puts it. */
export function chatFormatFromProps(props) {
  const c =
    props?.chat_format ??
    props?.default_generation_settings?.chat_format ??
    props?.default_generation_settings?.params?.chat_format;
  return typeof c === "string" && c ? c : undefined;
}
