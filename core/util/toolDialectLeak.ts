/**
 * Spotting a tool call a model wrote as text in a reply that was seen live.
 * Only warns: the caller shows a notice and never turns recovery on by itself.
 * Markup inside a code fence is a mention and does not count
 * (classifyToolReply). Design: plans/tool-dialect-detection.md, sections 3 and 5.
 */
import type { ToolDialectSetting } from "@continuedev/config-yaml";
import {
  ACCEPT_THRESHOLD,
  classifyToolReply,
  stripCode,
  type ToolCallLike,
} from "./toolDialectDetect.js";
import { resolveToolDialectPreset } from "./toolDialectPresets.js";

/**
 * The dialects the recovery switch can turn into calls, as `toolDialect`
 * values. Typed over every setting but the three that name no markup, so a
 * dialect added to TOOL_DIALECT_VALUES does not compile until it is listed
 * here, and the nudge test iterates the same list (it fails when a value has
 * no fixture the nudge counts).
 */
type MarkupDialect = Exclude<ToolDialectSetting, "auto" | "native" | "off">;
const RECOVERABLE: Record<MarkupDialect, ToolDialectSetting> = {
  "qwen-xml": "qwen-xml",
  pythonic: "pythonic",
  "llama-json": "llama-json",
  "hermes-json": "hermes-json",
  "glm-xml": "glm-xml",
  harmony: "harmony",
  mistral: "mistral",
  dsml: "dsml",
  "deepseek-v31": "deepseek-v31",
  "deepseek-r1": "deepseek-r1",
  "kimi-tokens": "kimi-tokens",
  "kimi-xtml": "kimi-xtml",
  "minimax-xml": "minimax-xml",
  "minimax-ns-xml": "minimax-ns-xml",
  "granite-tokens": "granite-tokens",
  "lfm-tokens": "lfm-tokens",
  "hy3-tags": "hy3-tags",
  "solar-tokens": "solar-tokens",
  "longcat-json": "longcat-json",
  "olmo-function-calls": "olmo-function-calls",
  "seed-xml": "seed-xml",
  "toolcall-json": "toolcall-json",
  "cohere-action": "cohere-action",
};

/**
 * Providers whose chat stream goes through the OpenAI-compatible adapter
 * (packages/openai-adapters, apis/OpenAI.ts), which recovers calls from text
 * when asked. The IDE reaches it for these providers; Ollama's IDE path is its
 * own native chat and does not (the CLI reaches it for Ollama too).
 */
const OPENAI_COMPATIBLE = new Set([
  "openai",
  "lmstudio",
  "llama.cpp",
  "llamafile",
  "vllm",
  "text-gen-webui",
  "msty",
]);

/**
 * Whether this provider recovers calls from text: the Bedrock handlers and
 * the OpenAI-compatible adapter. `surface` is where the request is made.
 */
export function providerRecoversText(
  provider: string | undefined,
  surface: "ide" | "cli" = "ide",
): boolean {
  if (!provider) return false;
  return (
    provider === "bedrock" ||
    OPENAI_COMPATIBLE.has(provider) ||
    (surface === "cli" && provider === "ollama")
  );
}

/** The `toolDialect` value that recovers this classifier dialect, or undefined when none does. */
export function recoverableDialect(
  dialect: string,
): ToolDialectSetting | undefined {
  return Object.hasOwn(RECOVERABLE, dialect)
    ? (RECOVERABLE as Record<string, ToolDialectSetting>)[dialect]
    : undefined;
}

export interface ToolDialectLeak {
  dialect: ToolDialectSetting;
}

/**
 * The dialect a reply leaked, or undefined: no markup, markup only in a code
 * fence, structured calls present, a dialect recovery cannot handle, or the
 * model already has a `toolDialect` set, or the server parses the calls.
 */
export function detectToolDialectLeak(args: {
  content: string | null | undefined;
  toolCalls?: ToolCallLike[];
  knownTools?: string[];
  current?: ToolDialectSetting;
  /** The server parses this model's calls itself (MetadataHint.serverParses). */
  serverParses?: boolean;
  /** Model id, name or slug: a family whose template renders no tools gets no suggestion. */
  model?: string;
}): ToolDialectLeak | undefined {
  if (args.serverParses) return undefined;
  if (args.current && args.current !== "auto") return undefined;
  const c = classifyToolReply({
    content: args.content,
    toolCalls: args.toolCalls,
    knownTools: args.knownTools,
  });
  const dialect = (RECOVERABLE as Record<string, ToolDialectSetting>)[
    c.dialect
  ];
  if (!dialect || c.confidence < ACCEPT_THRESHOLD) return undefined;
  if (!dialectFitsModel(dialect, args.model)) return undefined;
  return { dialect };
}

/**
 * Whether suggesting `dialect` for this model is sound. A family whose preset
 * says it has no text dialect (Gemma 3: its template renders no tools, so any
 * call it writes is a prompt-engineered convention, fixture
 * gemma3-has-no-tool-section) gets no suggestion, whatever shape the reply
 * had; RQ7 found the bare Llama JSON accepted only because a scan forced
 * llama-json on it. A bare JSON object is below the classifier's bar today, so
 * this is the guard that keeps it that way if the bar moves.
 */
function dialectFitsModel(
  dialect: ToolDialectSetting,
  model: string | undefined,
): boolean {
  if (!model) return true;
  if (dialect === "llama-json" && /gemma/i.test(model)) return false;
  return resolveToolDialectPreset(model)?.textDialect !== "none";
}

/** The notice's text. */
export function leakNoticeText(_dialect: string): string {
  // The format name goes in the button tooltip, where it does not crowd the line
  return "This model typed a tool request as plain text, so it did not run. Let Continuous read that format for this model?";
}

/** The CLI's one-line hint. */
export function leakHintText(model: string, dialect: string): string {
  return `${model} wrote a tool call as text (looks like ${dialect}). To recover such calls, set \`toolDialect: ${dialect}\` on the model in config.yaml.`;
}

function mentionsTool(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  // `functions.NAME` is how Harmony addresses a call, so that prefix counts.
  return new RegExp(
    String.raw`(?:(?<=\bfunctions\.)|(?<![\w.-]))${escaped}(?![\w-])`,
  ).test(text);
}

const escapeRe = (name: string) =>
  name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Where the call's name sits for the token dialects, whose section tokens
 * alone can appear in an explanation: Kimi K2 `functions.NAME:IDX`, Harmony
 * `to=functions.NAME`, DeepSeek after the call-begin token (V3.1) or the
 * separator that follows `function` (R1).
 */
const NAME_SLOT: Record<string, (name: string) => RegExp> = {
  "kimi-tokens": (n) =>
    new RegExp(String.raw`functions\.${escapeRe(n)}:\d+(?![\w-])`),
  harmony: (n) => new RegExp(String.raw`to=functions\.${escapeRe(n)}(?![\w-])`),
  "deepseek-v31": (n) =>
    new RegExp(
      String.raw`tool▁call▁begin[｜|]>(?:(?:function|tool)<[｜|]tool▁sep[｜|]>)?${escapeRe(n)}(?![\w-])`,
    ),
  "deepseek-r1": (n) =>
    new RegExp(String.raw`tool▁sep[｜|]>${escapeRe(n)}(?![\w-])`),
};

function jsonNamesTool(text: string, known: string[]): boolean {
  try {
    const name = (JSON.parse(text.trim()) as { name?: unknown }).name;
    return typeof name === "string" && known.includes(name);
  } catch {
    return false;
  }
}

const THINK_TAG = /<(\/?)think(?:ing)?>/g;

/**
 * The reply without its reasoning: closed `<think>` / `<thinking>` spans, an
 * unterminated one to the end, and a leading span whose opener the chat
 * template wrote into the prompt (text up to a first stray close tag). A call
 * written inside reasoning is not a call the turn failed to make (vLLM #39056),
 * so the nudge reads what is left. One pass over the tags, so a reply near the
 * 1 MiB hold cap costs no more than reading it.
 */
export function stripThinkBlocks(text: string): string {
  let out = "";
  let kept = 0; // start of the text not yet decided
  let open = false;
  for (const m of text.matchAll(THINK_TAG)) {
    const closing = m[1] === "/";
    if (closing) {
      // a stray close drops what came before it; a matched one ends a span
      kept = m.index + m[0].length;
      open = false;
    } else if (!open) {
      out += text.slice(kept, m.index);
      open = true;
    }
  }
  return open ? out : out + text.slice(kept);
}

/**
 * Whether a reply is a tool call written as text, whatever the provider and
 * whatever `toolDialect` says: the turn that reply ends has done nothing, and
 * the harness nudges the model to call the tool (core/util/turnEnd.ts, H13).
 * Nothing is parsed and nothing runs. Conservative on purpose: a reply with
 * structured calls is not a leak; only a markup shape the classifier accepts
 * counts; the markup must sit outside code fences and inline code (an example
 * is not a call); it must sit outside any think block (stripThinkBlocks);
 * and it must name a tool that was actually offered.
 */
export function isLeakedToolCall(args: {
  content: string | null | undefined;
  toolCalls?: ToolCallLike[];
  knownTools?: string[];
}): boolean {
  const known = args.knownTools ?? [];
  if (known.length === 0 || (args.toolCalls?.length ?? 0) > 0) return false;
  const content = stripThinkBlocks(args.content ?? "");
  const c = classifyToolReply({
    content,
    toolCalls: args.toolCalls,
    knownTools: known,
  });
  if (
    c.dialect === "native-structured" ||
    c.dialect === "prose" ||
    c.dialect === "unknown"
  ) {
    return false;
  }
  const { outside } = stripCode(content);
  // A whole reply that is one JSON object naming an offered tool is below the
  // classifier's bar on its own (an object with a name is common), but the
  // offered-tool check makes it safe here.
  if (c.confidence < ACCEPT_THRESHOLD) {
    return c.confidence >= 0.7 && jsonNamesTool(outside, known);
  }
  // The token dialects write the name in one fixed place; prose that merely
  // names their tokens next to an offered tool is not a call.
  const slot = NAME_SLOT[c.dialect];
  if (slot) return known.some((name) => slot(name).test(outside));
  return known.some((name) => mentionsTool(outside, name));
}
