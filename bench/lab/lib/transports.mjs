// The transports: one case, one tool list and one sampling set, sent over
// each surface a local engine offers. Every field name below was checked
// against the engine's own documentation (see README "Transports and what
// was verified"); a field the docs do not list is marked UNVERIFIED and is
// only ever read, never required.
//
//   ollama-chat   POST /api/chat                 (Ollama native)
//   ollama-v1     POST /v1/chat/completions      (Ollama's OpenAI shim)
//   ollama-raw    POST /api/generate, raw: true  (no template: we render it)
//   openai-chat   POST /v1/chat/completions      (llama-server)
//   llamacpp-raw  POST /apply-template then POST /completion (llama-server)
//
// Reply shape (shared with OllamaClient.chat):
//   { text, thinking, toolCalls: [{name, arguments: "<json>"}], doneReason,
//     usage, chunks?, meta: { reasoningField?, request } }
import crypto from "node:crypto";
import {
  LabError,
  OllamaClient,
  assertLoopback,
  toOllamaTools,
} from "./ollama.mjs";
import { renderToolsPrompt } from "./prompts.mjs";
import { readChatFormat } from "./server.mjs";
import {
  chatFormatFromProps,
  llamaSamplingDefaults,
  mergeBodyExtra,
  parseModelfileParameters,
  samplingSent,
} from "./sampling.mjs";

export const APIS = [
  "ollama-chat",
  "ollama-v1",
  "ollama-raw",
  "openai-chat",
  "llamacpp-raw",
];
export const isLlamaApi = (api) =>
  api === "openai-chat" || api === "llamacpp-raw";
export const isRawApi = (api) => api === "ollama-raw" || api === "llamacpp-raw";
export const THINK_VALUES = ["on", "off", "default", "low", "medium", "high"];
export const TOOL_CHOICES = ["auto", "required", "none"];

/** `auto|required|none` stay strings, anything else is a function name. */
export function toolChoiceBody(choice) {
  if (choice == null) return undefined;
  return TOOL_CHOICES.includes(choice)
    ? choice
    : { type: "function", function: { name: choice } };
}

/** The lab's think setting as each surface spells it; undefined = leave unset. */
export function thinkValue(think) {
  if (think == null || think === "default") return undefined;
  if (typeof think === "boolean") return think;
  if (think === "on") return true;
  if (think === "off") return false;
  return think; // low | medium | high
}

/**
 * Render messages as ChatML. This is OUR rendering, not the model's template:
 * Ollama exposes no way to render its Go template, so `ollama-raw` is only a
 * faithful contrast for ChatML-family models (Qwen). `llamacpp-raw` uses the
 * server's own /apply-template instead.
 */
export function renderChatml(messages) {
  const turns = messages.map(
    (m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`,
  );
  return turns.join("") + "<|im_start|>assistant\n";
}

/** Messages for a raw surface: tools, when the case sends them, go in the system text. */
export function rawMessages(messages, tools, style = "codeblock") {
  if (!tools?.length) return messages;
  const block = renderToolsPrompt(style, tools);
  const out = messages.map((m) => ({ ...m }));
  const sys = out.find((m) => m.role === "system");
  if (sys) sys.content = `${sys.content}\n\n${block}`;
  else out.unshift({ role: "system", content: block });
  return out;
}

const sha = (s) =>
  s
    ? crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16)
    : undefined;

/**
 * The request for one surface: { path, body, stream, notes }. `notes` lists
 * settings the surface cannot carry (so the record says "asked, not sent").
 */
export function buildRequest(api, a) {
  const {
    model,
    messages,
    tools,
    stream = false,
    temperature,
    numPredict,
    numCtx,
    think,
    toolChoice,
    seed,
    keepAlive,
    style,
    bodyExtra,
    prompt,
  } = a;
  const notes = [];
  const noPredict = numPredict == null || numPredict < 0;
  const hasTools = Boolean(tools?.length);
  let path, body;
  if (api === "ollama-chat") {
    path = "/api/chat";
    body = { model, messages, stream, options: {} };
    if (hasTools) body.tools = toOllamaTools(tools);
    const t = thinkValue(think);
    if (t !== undefined) body.think = t;
    if (toolChoice != null)
      notes.push("tool_choice not documented on /api/chat: not sent");
    if (temperature != null) body.options.temperature = temperature;
    if (!noPredict) body.options.num_predict = numPredict;
    if (numCtx != null) body.options.num_ctx = numCtx;
    if (seed != null) body.options.seed = seed;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
  } else if (api === "ollama-raw") {
    path = "/api/generate";
    body = {
      model,
      prompt:
        prompt ??
        renderChatml(rawMessages(messages, hasTools ? tools : [], style)),
      raw: true,
      stream,
      options: {},
    };
    const t = thinkValue(think);
    if (t !== undefined) body.think = t;
    if (hasTools)
      notes.push(
        "tools rendered into the system text (no tools field in raw mode)",
      );
    if (toolChoice != null)
      notes.push("tool_choice has no meaning in raw mode: not sent");
    if (temperature != null) body.options.temperature = temperature;
    if (!noPredict) body.options.num_predict = numPredict;
    if (numCtx != null) body.options.num_ctx = numCtx;
    if (seed != null) body.options.seed = seed;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
  } else if (api === "ollama-v1" || api === "openai-chat") {
    path = "/v1/chat/completions";
    body = { model, messages, stream };
    if (hasTools) body.tools = toOllamaTools(tools); // same {type:"function",function:{...}} shape
    const tc = toolChoiceBody(toolChoice);
    if (tc !== undefined) body.tool_choice = tc; // Ollama documents it as unsupported: sent on purpose (RQ21)
    if (temperature != null) body.temperature = temperature;
    if (!noPredict) body.max_tokens = numPredict;
    if (seed != null) body.seed = seed;
    if (stream) body.stream_options = { include_usage: true };
    const t = thinkValue(think);
    if (api === "ollama-v1") {
      if (t === false) body.reasoning_effort = "none";
      else if (t === true) body.reasoning_effort = "medium";
      else if (t !== undefined) body.reasoning_effort = t;
      if (numCtx != null)
        notes.push(
          "num_ctx cannot be set on /v1: the server's context applies",
        );
      if (keepAlive !== undefined)
        notes.push("keep_alive cannot be set on /v1");
    } else {
      if (t === false) body.chat_template_kwargs = { enable_thinking: false };
      else if (t === true)
        body.chat_template_kwargs = { enable_thinking: true };
      else if (t !== undefined) body.reasoning_effort = t;
      if (numCtx != null)
        notes.push("context is the server's -c: num_ctx not sent");
    }
  } else if (api === "llamacpp-raw") {
    path = "/completion";
    body = {
      prompt,
      stream: false,
      cache_prompt: true,
    };
    if (temperature != null) body.temperature = temperature;
    if (!noPredict) body.n_predict = numPredict;
    if (seed != null) body.seed = seed;
    if (hasTools)
      notes.push("tools rendered into the system text before /apply-template");
    if (toolChoice != null)
      notes.push("tool_choice has no meaning on /completion: not sent");
    if (stream) notes.push("llamacpp-raw is not streamed");
  } else throw new LabError("refused", `unknown --api ${api}`);
  if (bodyExtra) mergeBodyExtra(body, bodyExtra);
  return { path, body, stream: Boolean(body.stream), notes };
}

// --- reply parsing ----------------------------------------------------------

const ms = (ns) => (ns != null ? ns / 1e6 : undefined);

/** Ollama native and generate: durations are nanoseconds. */
export function ollamaUsage(obj) {
  return {
    promptTokens: obj.prompt_eval_count,
    outputTokens: obj.eval_count,
    promptEvalMs: ms(obj.prompt_eval_duration),
    evalMs: ms(obj.eval_duration),
    loadMs: ms(obj.load_duration),
    totalMs: ms(obj.total_duration),
  };
}

/** OpenAI-style `usage` plus llama-server's `timings` (milliseconds). */
export function openaiUsage(usage, timings) {
  const t = timings ?? {};
  const cached = t.cache_n ?? usage?.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens:
      usage?.prompt_tokens ??
      (t.prompt_n != null ? t.prompt_n + (t.cache_n ?? 0) : undefined),
    outputTokens: usage?.completion_tokens ?? t.predicted_n,
    cachedTokens: cached,
    promptEvalTokens: t.prompt_n,
    promptEvalMs: t.prompt_ms,
    evalMs: t.predicted_ms,
    promptPerSecond: t.prompt_per_second,
    predictedPerSecond: t.predicted_per_second,
  };
}

/** Prometheus text exposition: `llamacpp:name value` lines to {name: number}. */
export function parseMetrics(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = /^llamacpp:([A-Za-z0-9_]+)\s+(\S+)\s*$/.exec(line);
    if (m && Number.isFinite(Number(m[2]))) out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * GET /slots as the lab keeps it: every scalar field of each slot, the
 * `next_token` block, and none of `params` (sampling settings, large and
 * constant). The cache state is whatever the build reports; none is assumed.
 */
export function slimSlots(json) {
  if (!Array.isArray(json)) return undefined;
  return json.map((sl) => {
    const o = {};
    for (const [k, v] of Object.entries(sl ?? {}))
      if (k === "next_token" && v && typeof v === "object") o[k] = v;
      else if (k !== "params" && (v == null || typeof v !== "object")) o[k] = v;
    return o;
  });
}

const errText = (e) =>
  typeof e === "string" ? e : (e?.message ?? JSON.stringify(e));

/** One OpenAI-style object: a whole reply or one stream chunk. */
export function takeOpenAI(obj, out, acc, mark) {
  if (obj.error) throw new LabError("http", errText(obj.error));
  const ch = obj.choices?.[0];
  if (ch) {
    const m = ch.message ?? ch.delta ?? {};
    if (m.content) {
      out.text += m.content;
      out.chunks?.push(m.content);
      mark?.();
    }
    for (const k of ["reasoning_content", "reasoning", "thinking"]) {
      if (m[k]) {
        out.thinking += m[k];
        out.meta.reasoningField ??= k;
        mark?.();
        break;
      }
    }
    for (const tc of m.tool_calls ?? []) {
      const i =
        tc.index ??
        (tc.id && acc.byId.has(tc.id) ? acc.byId.get(tc.id) : acc.list.length);
      if (tc.id) acc.byId.set(tc.id, i);
      const cur = (acc.list[i] ??= { name: "", arguments: "" });
      if (tc.function?.name && !cur.name) cur.name = tc.function.name;
      const a = tc.function?.arguments;
      if (a != null)
        cur.arguments += typeof a === "string" ? a : JSON.stringify(a);
      mark?.();
    }
    if (ch.finish_reason) out.doneReason = ch.finish_reason;
  }
  if (obj.usage) acc.usage = obj.usage;
  if (obj.timings) acc.timings = obj.timings;
}

function takeOllama(obj, out, mark, key) {
  if (obj.error) throw new LabError("http", errText(obj.error));
  const m =
    key === "chat"
      ? (obj.message ?? {})
      : { content: obj.response, thinking: obj.thinking };
  if (m.content) {
    out.text += m.content;
    out.chunks?.push(m.content);
    mark?.();
  }
  if (m.thinking) {
    out.thinking += m.thinking;
    mark?.();
  }
  for (const c of m.tool_calls ?? []) {
    const args = c.function?.arguments;
    out.toolCalls.push({
      name: c.function?.name ?? "",
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    });
    mark?.();
  }
  if (obj.done) {
    out.doneReason = obj.done_reason;
    out.usage = ollamaUsage(obj);
  }
}

// --- the client -------------------------------------------------------------

export class Engine extends OllamaClient {
  /**
   * baseUrl is the engine being measured. For the llama-server surfaces,
   * `ollamaUrl` is where Ollama would be, only ever asked "is a model loaded".
   */
  constructor({
    api = "ollama-chat",
    ollamaUrl = "http://127.0.0.1:11434",
    sidecar = {},
    serverLog,
    declaredParser,
    ...rest
  } = {}) {
    super(rest);
    if (!APIS.includes(api))
      throw new LabError("refused", `unknown --api ${api}`);
    this.api = api;
    this.sidecar = sidecar; // { slots, metrics } booleans: poll after each request
    this.serverLog = serverLog; // llama-server log file, for the Chat format: line
    this.declaredParser = declaredParser; // what the operator says the tool parser is (--tool-parser); vLLM reports none
    this.ollamaOrigin = assertLoopback(ollamaUrl, rest.allowRemote);
  }

  /** Ollama's own "what is loaded", also asked while a llama-server run is planned. */
  async ps() {
    if (!isLlamaApi(this.api)) return super.ps();
    try {
      const res = await this.fetch(this.ollamaOrigin + "/api/ps", {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? await res.json() : { models: [] };
    } catch {
      return { models: [] }; // no Ollama answering: nothing of its is loaded
    }
  }

  async unload(model) {
    return isLlamaApi(this.api) ? true : super.unload(model);
  }

  /** Read-only GET returning JSON, or undefined when the endpoint is absent. */
  async get(pathname) {
    try {
      return await this.json(pathname, undefined, {
        method: "GET",
        timeoutMs: 15_000,
      });
    } catch {
      return undefined;
    }
  }

  /** What engine, build and template answered: goes into every record. */
  async describe(model) {
    if (isLlamaApi(this.api)) {
      const props = await this.get("/props");
      if (!props) {
        // no llama-server /props: vLLM answers GET /version with {"version": "0.25.1"}
        const ver = await this.get("/version");
        if (typeof ver?.version === "string")
          return {
            engine: "vllm",
            api: this.api,
            version: ver.version,
            parserDeclared: this.declaredParser,
          };
      }
      // /props first (b12206 prints no "Chat format:" log line), then the log
      let chatFormat = chatFormatFromProps(props);
      let chatFormatSource = chatFormat ? "props" : undefined;
      if (!chatFormat) {
        chatFormat = readChatFormat(this.serverLog);
        if (chatFormat) chatFormatSource = "log";
      }
      if (!chatFormat) {
        // no log to read (a server the lab did not start): /slots may name it
        const sl = await this.get("/slots");
        const cf = Array.isArray(sl)
          ? (sl[0]?.chat_format ?? sl[0]?.params?.chat_format)
          : undefined;
        if (typeof cf === "string") {
          chatFormat = cf;
          chatFormatSource = "slots";
        }
      }
      return {
        chatFormat,
        chatFormatSource,
        chatTemplateChars: props?.chat_template?.length,
        engine: "llama-server",
        api: this.api,
        build: props?.build_info,
        slots: props?.total_slots,
        modelPath: props?.model_path,
        nCtx: props?.default_generation_settings?.n_ctx,
        chatTemplateSha: sha(props?.chat_template),
        // what a request that sends no sampling options gets from the server
        samplingDefaults: llamaSamplingDefaults(props),
        parserDeclared: this.declaredParser,
      };
    }
    const version = await this.get("/api/version");
    const show = model
      ? await this.json("/api/show", { model }, { timeoutMs: 30_000 }).catch(
          () => undefined,
        )
      : undefined;
    return {
      engine: "ollama",
      api: this.api,
      version: version?.version,
      templateSha: sha(show?.template),
      parser: show?.parser,
      renderer: show?.renderer,
      quant: show?.details?.quantization_level,
      // the Modelfile PARAMETER lines a request inherits (see README)
      parameters: parseModelfileParameters(show?.parameters),
      parserDeclared: this.declaredParser,
    };
  }

  /** One poll of the sidecar endpoints; never throws, never blocks a result. */
  async pollSidecar() {
    const want = this.sidecar ?? {};
    if (!isLlamaApi(this.api) || (!want.slots && !want.metrics)) return;
    const out = {};
    const text = async (p) => {
      const res = await this.fetch(this.origin + p, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    };
    if (want.slots)
      try {
        out.slots = slimSlots(JSON.parse(await text("/slots")));
      } catch (e) {
        out.slotsError = String(e.message ?? e);
      }
    if (want.metrics)
      try {
        out.metrics = parseMetrics(await text("/metrics"));
      } catch (e) {
        out.metricsError = String(e.message ?? e);
      }
    return out;
  }

  async roundtrip(pathname, body, { timeoutMs, stream, sse, take }) {
    const t0 = Date.now();
    const { res, done, timedOut } = await this.call(pathname, body, {
      timeoutMs,
    });
    let first;
    const mark = () => {
      first ??= Date.now() - t0;
    };
    try {
      if (!stream) take(await res.json(), mark);
      else {
        const dec = new TextDecoder();
        let buf = "";
        const line = (raw) => {
          const l = raw.trim();
          if (!l || l.startsWith(":")) return;
          const data = sse
            ? l.startsWith("data:")
              ? l.slice(5).trim()
              : null
            : l;
          if (data == null || data === "[DONE]") return;
          take(JSON.parse(data), mark);
        };
        for await (const part of res.body) {
          buf += dec.decode(part, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            line(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        }
        line(buf);
      }
    } catch (e) {
      if (e instanceof LabError) throw e;
      if (timedOut())
        throw new LabError(
          "timeout",
          `no reply within ${timeoutMs ?? this.requestTimeoutMs} ms`,
        );
      if (this.signal?.aborted) throw new LabError("aborted", "aborted");
      throw new LabError(
        "network",
        `reply cut off: ${String(e?.message ?? e)}`,
      );
    } finally {
      done();
    }
    return { wallMs: Date.now() - t0, ttftMs: first };
  }

  async chat(args) {
    const api = args.api ?? this.api;
    const out = {
      text: "",
      thinking: "",
      toolCalls: [],
      doneReason: undefined,
      usage: {},
      meta: {},
    };
    const a = { ...args };
    // options-style callers (runSuite) pass sampling inside `options`
    const o = args.options ?? {};
    a.temperature ??= o.temperature;
    a.numPredict ??= o.num_predict;
    a.numCtx ??= o.num_ctx;
    a.seed ??= o.seed;
    if (api === "llamacpp-raw") {
      const msgs = rawMessages(
        a.messages,
        a.tools?.length ? a.tools : [],
        a.style,
      );
      const tpl = await this.call(
        "/apply-template",
        { messages: msgs },
        { timeoutMs: args.timeoutMs },
      );
      let rendered;
      try {
        rendered = (await tpl.res.json()).prompt; // README: response is {prompt}
      } finally {
        tpl.done();
      }
      if (typeof rendered !== "string")
        throw new LabError("http", "/apply-template returned no prompt string");
      a.prompt = rendered;
    }
    const req = buildRequest(api, a);
    out.meta.request = {
      api,
      path: req.path,
      notes: req.notes,
      toolChoice: a.toolChoice,
      sampling: samplingSent(api, req.body),
    };
    if (req.stream) out.chunks = [];
    const acc = { list: [], byId: new Map() };
    let kind = api === "ollama-chat" ? "chat" : "generate";
    const take = (obj, mark) => {
      if (api === "ollama-v1" || api === "openai-chat")
        takeOpenAI(obj, out, acc, mark);
      else if (api === "llamacpp-raw") {
        if (obj.error) throw new LabError("http", errText(obj.error));
        out.text += obj.content ?? "";
        mark?.();
        out.doneReason = obj.stop_type ?? out.doneReason; // none|eos|limit|word
        out.usage = {
          ...openaiUsage(
            {
              prompt_tokens: obj.tokens_evaluated,
              completion_tokens: obj.timings?.predicted_n,
            },
            obj.timings,
          ),
          cachedTokens: obj.timings?.cache_n ?? obj.tokens_cached,
        };
      } else takeOllama(obj, out, mark, kind);
    };
    const t = await this.roundtrip(req.path, req.body, {
      timeoutMs: args.timeoutMs,
      stream: req.stream,
      sse: api === "ollama-v1" || api === "openai-chat",
      take,
    });
    if (api === "ollama-v1" || api === "openai-chat") {
      out.toolCalls = acc.list.filter(Boolean);
      out.usage = openaiUsage(acc.usage, acc.timings);
    }
    const side = await this.pollSidecar();
    if (side) out.sidecar = side;
    out.usage.wallMs = t.wallMs;
    if (t.ttftMs != null) out.usage.ttftMs = t.ttftMs;
    return out;
  }
}
