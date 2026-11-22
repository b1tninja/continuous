/**
 * The fields the model configuration dialog can change in a config.yaml model
 * entry, how each is validated, and how a patch from the dialog is applied.
 *
 * Kept free of Node imports so the webview can use it too: the dialog shows
 * the same field-level messages that core checks again before it writes.
 *
 * A patch only ever touches the paths listed here. Every other key of the
 * entry (and of the file) is left exactly as it was, and credentials are only
 * ever written as `${{ secrets.NAME }}` references.
 */
import {
  CHAT_TEMPLATE_VALUES,
  modelRolesSchema,
  TOOL_DIALECT_VALUES,
  toolOverrideSchema,
} from "@continuedev/config-yaml";
import { isValidSecretName } from "../../util/unresolvedSecrets";

export type ModelEditSection =
  "connection" | "capabilities" | "generation" | "templates" | "context";

export type FieldKind =
  | "text"
  /** Text over several lines, written as typed (a prompt, a template). */
  | "multiline"
  | "url"
  | "number"
  | "boolean"
  | "enum"
  | "list"
  | "secretRef";

export interface ModelEditField {
  /** Path inside the model entry, e.g. ["defaultCompletionOptions", "temperature"]. */
  path: string[];
  section: ModelEditSection;
  label: string;
  kind: FieldKind;
  /**
   * What an absent key is. "a": a built-in value, which the sentence gives.
   * "b": absence has its own meaning (the provider decides, detected, none),
   * which the sentence says. Either way nothing is written for it.
   */
  unset: "a" | "b";
  /**
   * What happens when the key is absent, as the words after "Not set: ".
   * Taken from the code that reads the key; a function when the answer
   * depends on the provider or on what is known about the model.
   */
  notSet: string | ((c: NotSetContext) => string);
  help?: string;
  required?: boolean;
  integer?: boolean;
  min?: number;
  /** `min` itself is not allowed. */
  minExclusive?: boolean;
  max?: number;
  options?: readonly string[];
  /** URL schemes accepted by a `url` field. */
  schemes?: readonly string[];
  /** Shown only for these providers, unless the entry already has the key. */
  providers?: readonly string[];
}

/**
 * What is known about the loaded model, from the functions the requests use.
 * Every part is optional: a sentence falls back to the rule in words.
 */
export interface ModelFacts {
  /** The address requests go to (the provider's own when none is written). */
  apiBase?: string;
  contextLength?: number;
  /** `ModelDescription.contextLengthSource` (core/llm/providerModelLimits.ts). */
  contextLengthSource?: "config" | "provider" | "published" | "unknown";
  /** `completionOptions.maxTokens` as resolved; absent when none is sent. */
  maxTokens?: number;
  /** `ModelDescription.maxTokensSource`. */
  maxTokensSource?:
    "config" | "provider" | "published" | "class" | "fallback" | "none";
  /** `modelSupportsReasoning` for the model with no reasoning key written. */
  reasoningDetected?: boolean;
  /** `autodetectTemplateType` for the model id, when it names a template. */
  chatTemplate?: string;
  /** The IDE's prompt cache rules for the model (gui/src/util/promptCache.ts). */
  cache?: {
    /** A cache field is sent to this model at all. */
    control: boolean;
    /** With nothing written, Agent, Plan and Background sessions cache. */
    defaultsOn: boolean;
    /** The model has one cache lifetime (Nova on Bedrock). */
    fixedLifetime: boolean;
  };
  /** USD per million tokens from the price table, or "unknown". */
  tablePrice?: { input: number; output: number; source?: string } | "unknown";
  /** `modelSupportsNativeTools` with no capability written. */
  nativeTools?: boolean;
  /** `modelSupportsImages` with no capability written. */
  images?: boolean;
}

export interface NotSetContext {
  provider: string;
  model: string;
  /** A server on this machine or network; undefined when not known. */
  local?: boolean;
  facts?: ModelFacts;
}

/** The fallbacks named in the sentences, as the code has them. */
export const DEFAULT_CONTEXT_WINDOW = 32_768; // core/llm/constants.ts DEFAULT_CONTEXT_LENGTH
export const DEFAULT_REASONING_BUDGET = 2048; // core/llm/constants.ts DEFAULT_REASONING_TOKENS
export const LOCAL_OUTPUT_CEILING = 131_072; // core/llm/outputLimit.ts LOCAL_MAX_OUTPUT_TOKENS

export const count = (n: number) => n.toLocaleString("en-US");

const NOT_SENT = "not sent, the provider decides";
const AWS_CHAIN = "the AWS profile or the default credential chain is used";
const OWN_CACHE_PRICE =
  "the input price you set; with no price of your own, the price table's";

/** Bedrock.ts, SageMaker.ts and VertexAI.ts `defaultOptions`. */
function regionWhenNotSet(c: NotSetContext): string {
  if (c.provider === "bedrock" || c.provider === "bedrock-mantle") {
    return "us-east-1";
  }
  if (c.provider === "sagemaker") return "us-west-2";
  if (c.provider === "vertexai") {
    return "required together with the project id, unless an API key is used";
  }
  return "not used by this provider";
}

/** core/llm/providerModelLimits.ts `resolveModelLimits`, by `maxTokensSource`. */
function maxTokensWhenNotSet(c: NotSetContext): string {
  const { maxTokens, maxTokensSource: source } = c.facts ?? {};
  if (source === "none") return "the server decides";
  if (maxTokens === undefined || source === undefined) {
    return "the provider's or the published limit for the model, at most a quarter of the window; 4,096 when none is known";
  }
  const n = count(maxTokens);
  switch (source) {
    case "provider":
      return `${n} from the ${c.local ? "server" : "provider"}`;
    case "published":
      return `${n}, the published limit, at most a quarter of the window`;
    case "fallback":
      return c.local
        ? `${n}, used when no limit is known; in chat the room left in the window is sent, up to ${count(LOCAL_OUTPUT_CEILING)}`
        : `${n}, used when no limit is known for the model`;
    default:
      // The provider class's own limit, which the config loader fills in
      return `${n}, the built-in limit for ${c.provider || "this provider"}`;
  }
}

/** core/llm/autodetect.ts `modelSupportsReasoning`, gui/src/util/sessionReasoning.ts. */
function reasoningWhenNotSet(c: NotSetContext): string {
  const detected = c.facts?.reasoningDetected;
  if (detected === true) {
    return "on in chat, this model is detected as a reasoning model; the Thinking menu changes it per mode";
  }
  if (detected === false) {
    return "nothing about reasoning is sent, the model decides";
  }
  return "on in chat for a model detected as a reasoning model, otherwise nothing is sent";
}

/** core/llm/providerModelLimits.ts `contextOf`. */
function contextLengthWhenNotSet(c: NotSetContext): string {
  const { contextLength, contextLengthSource: source } = c.facts ?? {};
  if (source === "unknown") {
    return `${count(DEFAULT_CONTEXT_WINDOW)} assumed. Set the real size, or ask the server`;
  }
  if (contextLength !== undefined && source === "provider") {
    return `${count(contextLength)} from the ${c.local ? "server" : "provider"}`;
  }
  if (contextLength !== undefined && source === "published") {
    return `${count(contextLength)} published`;
  }
  return `what the server reports, else the published window, else ${count(DEFAULT_CONTEXT_WINDOW)} assumed`;
}

const NO_CACHE_FIELD = "no cache setting is sent to this model";

/** gui/src/util/promptCache.ts `effectiveCacheSetting`. */
function promptCachingWhenNotSet(c: NotSetContext): string {
  const cache = c.facts?.cache;
  if (!cache) {
    return "in the IDE, on in Agent, Plan and Background for Claude through Anthropic or Bedrock and Nova on Bedrock, off in Chat and elsewhere";
  }
  if (!cache.control) {
    return `${NO_CACHE_FIELD}; the provider or server caches by its own rule`;
  }
  if (!cache.defaultsOn) {
    return "off, unless one of the two settings below turns a part on";
  }
  return cache.fixedLifetime
    ? "in the IDE, on in Agent, Plan and Background with a 5 minute lifetime, off in Chat"
    : "in the IDE, on in Agent, Plan and Background (5 minutes, then 1 hour in a long session), off in Chat";
}

/** core/llm/llms/anthropicCache.ts `resolveCacheParts`. */
function cachePartWhenNotSet(c: NotSetContext): string {
  return c.facts?.cache?.control === false
    ? NO_CACHE_FIELD
    : "follows Prompt caching";
}

/** `resolvePromptCacheTtl` and gui/src/util/promptCache.ts `resolvePromptCache`. */
function cacheLifetimeWhenNotSet(c: NotSetContext): string {
  const cache = c.facts?.cache;
  if (cache?.control === false) return NO_CACHE_FIELD;
  if (cache?.fixedLifetime)
    return "5 minutes, the only lifetime this model has";
  return "5 minutes; when Prompt caching is not set either, the IDE picks 5 minutes or 1 hour for each request";
}

export const NO_PRICE_KNOWN = "no price known: cost is not estimated";

export const usd = (n: number) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });

/** core/util/costOf.ts: the price table, or nothing. Never $0. */
function priceWhenNotSet(c: NotSetContext, side: "input" | "output"): string {
  const price = c.facts?.tablePrice;
  if (price === undefined) return "the price table's, if it has one";
  if (price === "unknown") return NO_PRICE_KNOWN;
  return `$${usd(price[side])} from the price table`;
}

export const MODEL_ROLES: readonly string[] = modelRolesSchema.options;
export const DEFAULT_ROLES = ["chat", "edit", "apply", "summarize"] as const;
export const TOOL_DIALECTS: readonly string[] = TOOL_DIALECT_VALUES;
export const CHAT_TEMPLATES: readonly string[] = CHAT_TEMPLATE_VALUES;

/** `crossRegionInference` values: auto, or an inference profile prefix (bedrockHelpers). */
export const CROSS_REGION_VALUES = [
  "auto",
  "us",
  "us-gov",
  "eu",
  "apac",
  "jp",
  "au",
  "ca",
  "global",
] as const;

const HTTP = ["http:", "https:"] as const;
const AWS = ["bedrock", "bedrock-mantle", "sagemaker"] as const;

export const MODEL_EDIT_FIELDS: readonly ModelEditField[] = [
  // Connection
  {
    path: ["provider"],
    section: "connection",
    label: "Provider",
    kind: "text",
    unset: "b",
    notSet: "required, unless the model names a provider account",
    help: "Required unless the model names a provider account with connection.",
  },
  {
    path: ["model"],
    section: "connection",
    label: "Model id",
    kind: "text",
    unset: "b",
    notSet: "a model id is required",
    required: true,
    help: "The id the provider knows the model by.",
  },
  {
    path: ["apiBase"],
    section: "connection",
    label: "API base",
    kind: "url",
    unset: "b",
    notSet: (c) =>
      c.facts?.apiBase
        ? `the provider's own address, ${c.facts.apiBase}`
        : "the provider's own address",
    schemes: HTTP,
  },
  {
    path: ["apiKey"],
    section: "connection",
    label: "API key",
    kind: "secretRef",
    unset: "b",
    notSet: "no key is sent",
  },
  {
    path: ["env", "region"],
    section: "connection",
    label: "Region",
    kind: "text",
    unset: "a",
    notSet: regionWhenNotSet,
    providers: ["bedrock", "bedrock-mantle", "sagemaker", "vertexai"],
  },
  {
    path: ["env", "profile"],
    section: "connection",
    label: "AWS profile",
    kind: "text",
    unset: "b",
    notSet: "the default AWS credential chain",
    providers: ["bedrock", "bedrock-mantle", "sagemaker"],
  },
  {
    path: ["env", "accessKeyId"],
    section: "connection",
    label: "AWS access key id",
    kind: "secretRef",
    unset: "b",
    notSet: AWS_CHAIN,
    providers: AWS,
  },
  {
    path: ["env", "secretAccessKey"],
    section: "connection",
    label: "AWS secret access key",
    kind: "secretRef",
    unset: "b",
    notSet: AWS_CHAIN,
    providers: AWS,
  },
  {
    path: ["env", "sessionToken"],
    section: "connection",
    label: "AWS session token",
    kind: "secretRef",
    unset: "b",
    notSet: AWS_CHAIN,
    providers: AWS,
    help: "Only for temporary credentials.",
  },
  {
    path: ["env", "crossRegionInference"],
    section: "connection",
    label: "Cross-region inference",
    kind: "enum",
    unset: "b",
    notSet: "off, the model id is sent as written",
    options: CROSS_REGION_VALUES,
    providers: ["bedrock"],
    help: "Adds the inference profile prefix to the model id; auto picks it from the region.",
  },
  {
    path: ["env", "serviceTier"],
    section: "connection",
    label: "Service tier",
    kind: "enum",
    unset: "b",
    notSet: "not sent, Bedrock uses its default tier",
    options: ["default", "priority", "flex", "reserved"],
    providers: ["bedrock"],
    help: "priority is faster at a higher price, flex cheaper and slower, reserved uses reserved capacity.",
  },
  {
    path: ["env", "latency"],
    section: "connection",
    label: "Latency mode",
    kind: "enum",
    unset: "b",
    notSet: "not sent, Bedrock uses standard",
    options: ["standard", "optimized"],
    providers: ["bedrock"],
    help: "optimized works only on the models and regions that offer it.",
  },
  {
    path: ["env", "guardrailIdentifier"],
    section: "connection",
    label: "Guardrail id or ARN",
    kind: "text",
    unset: "b",
    notSet: "none, no guardrail is applied",
    providers: ["bedrock"],
  },
  {
    path: ["env", "guardrailVersion"],
    section: "connection",
    label: "Guardrail version",
    kind: "text",
    unset: "a",
    notSet: "DRAFT, used only with a guardrail id",
    providers: ["bedrock"],
  },
  {
    path: ["env", "projectId"],
    section: "connection",
    label: "Project id",
    kind: "text",
    unset: "b",
    notSet: (c) =>
      c.provider === "vertexai"
        ? "required together with the region, unless an API key is used"
        : "none is sent",
    providers: ["vertexai", "watsonx"],
  },
  {
    path: ["env", "deployment"],
    section: "connection",
    label: "Deployment",
    kind: "text",
    unset: "b",
    notSet: "the model id is used as the deployment",
    providers: ["azure"],
  },
  {
    path: ["env", "deploymentId"],
    section: "connection",
    label: "Deployment id",
    kind: "text",
    unset: "b",
    notSet: "none, the project id is used",
    providers: ["watsonx"],
  },
  {
    path: ["env", "apiVersion"],
    section: "connection",
    label: "API version",
    kind: "text",
    unset: "a",
    notSet: (c) =>
      c.provider === "azure"
        ? "2024-02-15-preview"
        : c.provider === "watsonx"
          ? "required for watsonx, none is filled in"
          : "not used by this provider",
    providers: ["azure", "watsonx"],
  },
  {
    path: ["env", "apiType"],
    section: "connection",
    label: "API type",
    kind: "text",
    unset: "a",
    notSet: (c) =>
      c.provider === "azure" ? "azure-openai" : "not used by this provider",
    providers: ["azure"],
  },
  {
    path: ["requestOptions", "timeout"],
    section: "connection",
    label: "Request timeout (seconds)",
    kind: "number",
    unset: "a",
    notSet: "7,200 s",
    min: 0,
    minExclusive: true,
  },
  {
    path: ["requestOptions", "connectTimeout"],
    section: "connection",
    label: "Connect timeout (seconds)",
    kind: "number",
    unset: "a",
    notSet: "10 s",
    min: 0,
    minExclusive: true,
  },
  {
    path: ["requestOptions", "proxy"],
    section: "connection",
    label: "Proxy",
    kind: "url",
    unset: "b",
    notSet: "HTTPS_PROXY or HTTP_PROXY from the environment, else no proxy",
    schemes: ["http:", "https:", "socks:", "socks4:", "socks5:"],
  },
  {
    path: ["requestOptions", "noProxy"],
    section: "connection",
    label: "Hosts that skip the proxy",
    kind: "list",
    unset: "b",
    notSet: "NO_PROXY from the environment, else none",
    help: "One host per line.",
  },
  {
    path: ["requestOptions", "verifySsl"],
    section: "connection",
    label: "Verify TLS certificates",
    kind: "boolean",
    unset: "a",
    notSet: "on",
  },
  {
    path: ["requestOptions", "useSystemCa"],
    section: "connection",
    label: "Trust the system certificate store",
    kind: "boolean",
    unset: "a",
    notSet: "on for Windows and macOS, off for Linux",
  },
  {
    path: ["requestOptions", "caBundlePath"],
    section: "connection",
    label: "CA bundle files",
    kind: "list",
    unset: "b",
    notSet:
      "none, only the built-in certificates, NODE_EXTRA_CA_CERTS and the system store (where on) are trusted",
    help: "One path per line.",
  },
  // Capabilities
  {
    path: ["roles"],
    section: "capabilities",
    label: "Roles",
    kind: "list",
    unset: "a",
    notSet: DEFAULT_ROLES.join(", "),
    options: MODEL_ROLES,
  },
  {
    path: ["toolDialect"],
    section: "capabilities",
    label: "Tool calls written as text",
    kind: "enum",
    unset: "a",
    notSet:
      "auto, only structured tool calls run; a call written as text is reported, never run",
    options: TOOL_DIALECTS,
  },
  // Generation defaults
  {
    path: ["defaultCompletionOptions", "temperature"],
    section: "generation",
    label: "Temperature",
    kind: "number",
    unset: "b",
    notSet: (c) => (c.provider === "asksage" ? "0 is sent" : NOT_SENT),
    min: 0,
    max: 2,
  },
  {
    path: ["defaultCompletionOptions", "topP"],
    section: "generation",
    label: "Top P",
    kind: "number",
    unset: "b",
    notSet: (c) =>
      c.provider === "watsonx"
        ? "1 is sent when a temperature is set"
        : NOT_SENT,
    min: 0,
    minExclusive: true,
    max: 1,
  },
  {
    path: ["defaultCompletionOptions", "topK"],
    section: "generation",
    label: "Top K",
    kind: "number",
    unset: "b",
    notSet: (c) =>
      c.provider === "watsonx"
        ? "100 is sent when a temperature is set"
        : NOT_SENT,
    integer: true,
    min: 1,
  },
  {
    path: ["defaultCompletionOptions", "presencePenalty"],
    section: "generation",
    label: "Presence penalty",
    kind: "number",
    unset: "b",
    notSet: (c) => (c.provider === "watsonx" ? "0 is sent" : NOT_SENT),
    min: -2,
    max: 2,
  },
  {
    path: ["defaultCompletionOptions", "frequencyPenalty"],
    section: "generation",
    label: "Frequency penalty",
    kind: "number",
    unset: "b",
    notSet: (c) => (c.provider === "watsonx" ? "0 is sent" : NOT_SENT),
    min: -2,
    max: 2,
  },
  {
    path: ["defaultCompletionOptions", "maxTokens"],
    section: "generation",
    label: "Max output tokens",
    kind: "number",
    unset: "b",
    notSet: maxTokensWhenNotSet,
    integer: true,
    min: 1,
  },
  {
    path: ["defaultCompletionOptions", "stop"],
    section: "generation",
    label: "Stop sequences",
    kind: "list",
    unset: "b",
    notSet: "none",
    help: "One per line.",
  },
  {
    path: ["defaultCompletionOptions", "reasoning"],
    section: "generation",
    label: "Reasoning",
    kind: "boolean",
    unset: "b",
    notSet: reasoningWhenNotSet,
  },
  {
    path: ["defaultCompletionOptions", "reasoningBudgetTokens"],
    section: "generation",
    label: "Reasoning budget (tokens)",
    kind: "number",
    unset: "a",
    notSet: (c) =>
      c.provider === "ollama"
        ? "not sent, Ollama takes no budget"
        : `${count(DEFAULT_REASONING_BUDGET)} tokens when reasoning is on`,
    integer: true,
    min: 1,
  },
  // Templates and system message
  {
    path: ["chatOptions", "baseSystemMessage"],
    section: "templates",
    label: "Chat system message",
    kind: "multiline",
    unset: "b",
    notSet: "the built-in chat system message",
  },
  {
    path: ["chatOptions", "baseAgentSystemMessage"],
    section: "templates",
    label: "Agent system message",
    kind: "multiline",
    unset: "b",
    notSet: "the built-in agent system message",
  },
  {
    path: ["chatOptions", "basePlanSystemMessage"],
    section: "templates",
    label: "Plan system message",
    kind: "multiline",
    unset: "b",
    notSet: "the built-in plan system message",
  },
  {
    path: ["promptTemplates", "chat"],
    section: "templates",
    label: "Chat template",
    kind: "enum",
    unset: "b",
    notSet: (c) =>
      c.facts?.chatTemplate
        ? `detected from the model id (${c.facts.chatTemplate})`
        : "detected from the model id",
    options: CHAT_TEMPLATES,
    help: "Only for providers that send a raw prompt; chat APIs apply the model's own template.",
  },
  {
    path: ["promptTemplates", "edit"],
    section: "templates",
    label: "Edit prompt template",
    kind: "multiline",
    unset: "b",
    notSet: "the built-in edit prompt",
  },
  {
    path: ["promptTemplates", "apply"],
    section: "templates",
    label: "Apply prompt template",
    kind: "multiline",
    unset: "b",
    notSet: "the built-in apply prompt",
  },
  {
    path: ["promptTemplates", "autocomplete"],
    section: "templates",
    label: "Autocomplete prompt template",
    kind: "multiline",
    unset: "b",
    notSet: "the template detected for the model",
  },
  // Context and cost
  {
    path: ["contextLength"],
    section: "context",
    label: "Context length (tokens)",
    kind: "number",
    unset: "b",
    notSet: contextLengthWhenNotSet,
    integer: true,
    min: 1,
    help: "The prompt and the reply share this many tokens. The slider starts at the published window for the model. 32,768 is used only when no window is known.",
  },
  // Expert: how much of the window is held back before the history is compacted
  {
    path: ["contextManagement", "autoCompactRatio"],
    section: "context",
    label: "Expert: compact at this share of the window (0 to 1)",
    kind: "number",
    unset: "b",
    notSet:
      "the CLI keeps the larger of 20% of the input space and the output limit (up to 15,000 tokens) free",
    min: 0,
    minExclusive: true,
    max: 1,
    help: "The share of (context length minus max output tokens) at which the continuous CLI compacts. The rest is the reserve kept free for the reply. Empty: the CLI keeps the larger of 20% of the input space and the output limit (up to 15,000 tokens) free.",
  },
  {
    path: ["contextManagement", "autoCompactTokens"],
    section: "context",
    label: "Expert: compact at this many tokens",
    kind: "number",
    unset: "b",
    notSet: "the share above decides",
    integer: true,
    min: 1,
    help: "The continuous CLI compacts once the prompt reaches this many tokens.",
  },
  {
    path: ["contextManagement", "plannedCompaction"],
    section: "context",
    label: "Expert: prepare the compaction summary in the background (IDE)",
    kind: "boolean",
    unset: "a",
    notSet: (c) =>
      c.local === undefined
        ? "on for a server on this machine or network, off for cloud providers"
        : c.local
          ? "on, this is a server on this machine or network"
          : "off, this is a cloud provider",
    help: "Once the conversation passes 70% of the window (75% on a cloud provider), the summary is made while you pause, so Compact now applies it at once.",
  },
  {
    path: ["defaultCompletionOptions", "promptCaching"],
    section: "context",
    label: "Prompt caching",
    kind: "boolean",
    unset: "b",
    notSet: promptCachingWhenNotSet,
    help: "Off also overrides the cache settings below.",
  },
  {
    path: ["cacheBehavior", "cacheSystemMessage"],
    section: "context",
    label: "Cache the system prompt",
    kind: "boolean",
    unset: "b",
    notSet: cachePartWhenNotSet,
  },
  {
    path: ["cacheBehavior", "cacheConversation"],
    section: "context",
    label: "Cache the conversation",
    kind: "boolean",
    unset: "b",
    notSet: cachePartWhenNotSet,
  },
  {
    path: ["cacheBehavior", "ttl"],
    section: "context",
    label: "Cache lifetime",
    kind: "enum",
    unset: "b",
    notSet: cacheLifetimeWhenNotSet,
    options: ["auto", "5m", "1h"],
  },
  {
    path: ["cacheBehavior", "subagentTtl"],
    section: "context",
    label: "Subagent cache lifetime",
    kind: "enum",
    unset: "a",
    notSet: "5m",
    options: ["5m", "1h", "auto", "inherit"],
    help: "For subagent runs on this model. Inherit follows the chat's lifetime.",
  },
  {
    path: ["pricing", "input"],
    section: "context",
    label: "Input price (USD per million tokens)",
    kind: "number",
    unset: "b",
    notSet: (c) => priceWhenNotSet(c, "input"),
    min: 0,
  },
  {
    path: ["pricing", "output"],
    section: "context",
    label: "Output price (USD per million tokens)",
    kind: "number",
    unset: "b",
    notSet: (c) => priceWhenNotSet(c, "output"),
    min: 0,
  },
  {
    path: ["pricing", "cacheRead"],
    section: "context",
    label: "Cache read price (USD per million tokens)",
    kind: "number",
    unset: "b",
    notSet: OWN_CACHE_PRICE,
    min: 0,
  },
  {
    path: ["pricing", "cacheWrite"],
    section: "context",
    label: "Cache write price (USD per million tokens)",
    kind: "number",
    unset: "b",
    notSet: OWN_CACHE_PRICE,
    min: 0,
  },
];

/** `chatOptions.toolOverrides.<tool>`: one tool's override, set as a whole. */
export function isToolOverridePath(path: readonly string[]): boolean {
  return (
    path.length === 3 &&
    path[0] === "chatOptions" &&
    path[1] === "toolOverrides" &&
    /^[A-Za-z0-9_.:-]+$/.test(path[2])
  );
}

/** Header names whose values are credentials: only a secret reference may be written. */
export const SENSITIVE_HEADER =
  /authorization|api[-_]?key|token|secret|cookie|password/i;
/** Keys anywhere in an entry whose plain values are never sent to the webview. */
export const SENSITIVE_KEY =
  /^(apiKey|accessKeyId|secretAccessKey|sessionToken|passphrase|password|token)$|authorization|api[-_]?key|secret|cookie|password/i;

const SECRET_REF = /^\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

export const pathKey = (path: readonly string[]) => path.join(".");

/** The words after "Not set: " for a field, for this model. */
export function notSetText(field: ModelEditField, c: NotSetContext): string {
  return typeof field.notSet === "function" ? field.notSet(c) : field.notSet;
}

/** "Not set: 7,200 s", "Not set: not sent, the provider decides". */
export function notSetSentence(
  field: ModelEditField,
  c: NotSetContext,
): string {
  return `Not set: ${notSetText(field, c)}`;
}

export function fieldFor(path: readonly string[]): ModelEditField | undefined {
  const key = pathKey(path);
  return MODEL_EDIT_FIELDS.find((f) => pathKey(f.path) === key);
}

/** `${{ secrets.NAME }}` -> NAME, or undefined for anything else. */
export function secretRefName(value: unknown): string | undefined {
  return typeof value === "string"
    ? SECRET_REF.exec(value.trim())?.[1]
    : undefined;
}

export function secretRef(name: string): string {
  return `\${{ secrets.${name} }}`;
}

/** Is this value a template reference of any kind (secrets, inputs, ...)? */
function isTemplate(value: string): boolean {
  return /^\$\{\{[^}]*\}\}$/.test(value.trim());
}

/** What the dialog is told about a credential: never its value. */
export type CredentialState =
  | { state: "none" }
  | { state: "secret"; secretName: string }
  /** A template that is not a secret, such as `${{ inputs.X }}`, shown as written. */
  | { state: "template"; text: string }
  /** Written in plain text in the file; the value is withheld. */
  | { state: "plaintext" };

export function credentialState(value: unknown): CredentialState {
  if (value === undefined || value === null || value === "") {
    return { state: "none" };
  }
  const name = secretRefName(value);
  if (name) return { state: "secret", secretName: name };
  if (typeof value === "string" && isTemplate(value)) {
    return { state: "template", text: value.trim() };
  }
  return { state: "plaintext" };
}

export const MASK = "••••••";

/**
 * A copy of the entry safe to hand to the webview: every plain value under a
 * credential-like key is replaced by MASK. References stay as written.
 */
export function maskEntry(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => maskEntry(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskEntry(v, k)]),
    );
  }
  if (
    key &&
    SENSITIVE_KEY.test(key) &&
    typeof value === "string" &&
    value !== "" &&
    !isTemplate(value)
  ) {
    return MASK;
  }
  return value;
}

/** Mask a plain credential value on one line of YAML text (for the diff view). */
export function maskYamlLine(line: string): string {
  const m = /^(\s*(?:-\s+)?["']?([^"':#]+?)["']?\s*:\s+)(.+?)(\s+#.*)?$/.exec(
    line,
  );
  if (!m) return line;
  const [, head, key, value, comment = ""] = m;
  if (!SENSITIVE_KEY.test(key.trim())) return line;
  const bare = value.replace(/^["']|["']$/g, "");
  if (isTemplate(bare) || bare === "" || /^[|>]/.test(bare)) return line;
  return `${head}${MASK}${comment}`;
}

/**
 * One change from the dialog. `path` must name a field above, a request
 * header (["requestOptions", "headers", NAME]) or the capabilities list.
 * `value: undefined` removes the key.
 */
export interface ModelPatchOp {
  path: string[];
  value?: unknown;
}

export interface FieldError {
  path: string[];
  message: string;
}

export function isAllowedPath(path: readonly string[]): boolean {
  if (fieldFor(path)) return true;
  if (path.length === 1 && path[0] === "capabilities") return true;
  if (isToolOverridePath(path)) return true;
  return (
    path.length === 3 &&
    path[0] === "requestOptions" &&
    path[1] === "headers" &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(path[2])
  );
}

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

function numberError(f: ModelEditField, v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return "Enter a number.";
  if (f.integer && !Number.isInteger(v)) return "Enter a whole number.";
  if (f.min !== undefined) {
    if (f.minExclusive ? v <= f.min : v < f.min) {
      return f.minExclusive
        ? `Must be more than ${f.min}.`
        : `Must be ${f.min} or more.`;
    }
  }
  if (f.max !== undefined && v > f.max) return `Must be ${f.max} or less.`;
  return undefined;
}

/**
 * Paths that are not fields of the registry (a request header, the
 * capabilities list, one tool's override): the message, or undefined when
 * valid. `false` when the path is none of these.
 */
function validateOtherPath(
  path: readonly string[],
  value: unknown,
): string | undefined | false {
  if (path[0] === "requestOptions" && path[1] === "headers") {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return "A header value is text.";
    if (SENSITIVE_HEADER.test(path[2]) && !secretRefName(value)) {
      return `${path[2]} carries a credential: store it as a secret and use \${{ secrets.NAME }}.`;
    }
    return undefined;
  }
  if (path.length === 1 && path[0] === "capabilities") {
    if (value === undefined) return undefined;
    return Array.isArray(value) && value.every((c) => typeof c === "string")
      ? undefined
      : "Capabilities is a list of names.";
  }
  if (isToolOverridePath(path)) {
    if (value === undefined) return undefined;
    const parsed = toolOverrideSchema.safeParse(value);
    if (parsed.success) return undefined;
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
    return `${where}${issue.message}`;
  }
  return false;
}

/** The message for one field's new value, or undefined when it is valid. */
export function validateFieldValue(
  path: readonly string[],
  value: unknown,
): string | undefined {
  const other = validateOtherPath(path, value);
  if (other !== false) return other;
  const f = fieldFor(path);
  if (!f) return "This setting cannot be changed here.";
  if (value === undefined) {
    return f.required ? `${f.label} is required.` : undefined;
  }
  switch (f.kind) {
    case "text":
      if (typeof value !== "string") return "Enter text.";
      if (f.required && value.trim() === "") return `${f.label} is required.`;
      return undefined;
    case "multiline":
      return typeof value === "string" ? undefined : "Enter text.";
    case "url": {
      if (typeof value !== "string" || value.trim() === "") {
        return "Enter a URL.";
      }
      if (isTemplate(value)) return undefined;
      const url = value.includes("://") ? parseUrl(value.trim()) : undefined;
      if (!url) {
        return "Enter a full URL, such as https://host:port/v1.";
      }
      if (f.schemes && !f.schemes.includes(url.protocol)) {
        return `Use ${f.schemes.map((s) => s.replace(":", "://")).join(" or ")}.`;
      }
      if (url.username || url.password) {
        return "Do not put a user name or password in the URL.";
      }
      return undefined;
    }
    case "number":
      return numberError(f, value);
    case "boolean":
      return typeof value === "boolean" ? undefined : "Choose on or off.";
    case "enum":
      return typeof value === "string" && f.options?.includes(value)
        ? undefined
        : `Choose one of: ${f.options?.join(", ")}.`;
    case "list": {
      if (
        pathKey(f.path) === "requestOptions.caBundlePath" &&
        typeof value === "string"
      ) {
        return value.trim() ? undefined : "Enter a path.";
      }
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return "Enter one item per line.";
      }
      if (value.some((v) => v.trim() === "")) return "Remove the empty line.";
      if (f.options) {
        const bad = value.filter((v) => !f.options!.includes(v));
        if (bad.length) return `Unknown: ${bad.join(", ")}.`;
        if (value.length === 0) return "Pick at least one.";
      }
      return undefined;
    }
    case "secretRef": {
      if (typeof value !== "string") return "Choose a secret.";
      const name = secretRefName(value);
      if (!name) {
        return f.path[0] === "apiKey"
          ? "Keys are never written into config.yaml: store the key as a secret and refer to it."
          : `${f.label} is a credential and is never written into config.yaml: store it as a secret and refer to it.`;
      }
      return isValidSecretName(name)
        ? undefined
        : "A secret name is letters, digits and _, not starting with a digit.";
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Apply the patch to a copy of the entry. Parent maps are created as needed,
 * and a map left empty by a removal is removed too. Nothing outside the
 * patched paths changes.
 */
export function applyModelPatch(
  entry: Record<string, unknown>,
  ops: readonly ModelPatchOp[],
): { entry: Record<string, unknown>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const next = structuredClone(entry);
  for (const op of ops) {
    if (!Array.isArray(op.path) || !isAllowedPath(op.path)) {
      errors.push({
        path: op.path ?? [],
        message: "This setting cannot be changed here.",
      });
      continue;
    }
    const message = validateFieldValue(op.path, op.value);
    if (message) {
      errors.push({ path: op.path, message });
      continue;
    }
    setPath(next, op.path, op.value);
  }
  return { entry: next, errors };
}

function setPath(
  obj: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    if (value === undefined) delete obj[head];
    else obj[head] = value;
    return;
  }
  let child = obj[head];
  if (!isPlainObject(child)) {
    if (value === undefined) return;
    child = {};
    obj[head] = child;
  }
  setPath(child as Record<string, unknown>, rest, value);
  if (value === undefined && Object.keys(child as object).length === 0) {
    delete obj[head];
  }
}

export function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameValue(x, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameValue(a[k], b[k]));
  }
  return false;
}

/** Does a managed path lie below `prefix`? The entry itself is `[]`. */
function hasManagedChild(prefix: readonly string[]): boolean {
  if (prefix.length === 0) return true;
  const key = pathKey(prefix);
  if (key === "requestOptions.headers" || key === "chatOptions.toolOverrides") {
    return true;
  }
  return MODEL_EDIT_FIELDS.some(
    (f) =>
      f.path.length > prefix.length && prefix.every((x, i) => f.path[i] === x),
  );
}

export interface EntryEditResult {
  ops: ModelPatchOp[];
  /** Paths that differ but cannot be changed here (dot-joined). */
  refused: string[];
}

/**
 * The patch that turns `before` into `after`, for the Advanced (YAML) tab.
 * Both are the entry as the dialog sees it (credentials masked), so a masked
 * value left alone is equal and produces no operation. A difference at a path
 * the dialog manages becomes an operation on that path, validated like any
 * other; a difference anywhere else is listed in `refused` and never
 * written. A map that appears or disappears is walked as an empty one, so
 * adding `pricing: {input: 1, output: 2}` is two operations.
 */
export function opsFromEntryEdit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): EntryEditResult {
  const ops: ModelPatchOp[] = [];
  const refused: string[] = [];
  const isMapOrAbsent = (v: unknown) => v === undefined || isPlainObject(v);
  const walk = (path: string[], a: unknown, b: unknown) => {
    if (path.length > 0 && isAllowedPath(path)) {
      if (!sameValue(a, b)) {
        ops.push(b === undefined ? { path } : { path, value: b });
      }
      return;
    }
    if (hasManagedChild(path) && isMapOrAbsent(a) && isMapOrAbsent(b)) {
      const ao = (a ?? {}) as Record<string, unknown>;
      const bo = (b ?? {}) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
        walk([...path, k], ao[k], bo[k]);
      }
      return;
    }
    if (!sameValue(a, b)) refused.push(pathKey(path));
  };
  walk([], before, after);
  return { ops, refused };
}

/** Capability names the dialog sets; any other name in the list is kept as it is. */
export const DIALOG_CAPABILITIES = ["tool_use", "image_input"] as const;

export type TriState = "auto" | "on" | "off";

/**
 * The `capabilities` list for the dialog's two choices, keeping names the
 * dialog does not manage (next_edit, or a name a newer version knows).
 * Undefined when both are auto and nothing else is listed: the key is then
 * removed and both are detected again.
 */
export function capabilitiesFor(
  current: unknown,
  tools: TriState,
  images: TriState,
): { value: string[] | undefined; error?: string } {
  const others = Array.isArray(current)
    ? current.filter(
        (c): c is string =>
          typeof c === "string" &&
          !(DIALOG_CAPABILITIES as readonly string[]).includes(c),
      )
    : [];
  if (tools === "auto" && images === "auto" && others.length === 0) {
    return { value: undefined };
  }
  if (tools === "auto" || images === "auto") {
    return {
      value: undefined,
      error:
        others.length > 0
          ? `capabilities also lists ${others.join(", ")}, so tool use and image input must each be set to yes or no.`
          : "Capabilities is one list: once one of these is set by hand, set the other by hand too, or set both to auto-detect.",
    };
  }
  const value = [
    ...(tools === "on" ? ["tool_use"] : []),
    ...(images === "on" ? ["image_input"] : []),
    ...others,
  ];
  return { value };
}

/** The dialog's tri-state for one capability, read from the entry. */
export function capabilityState(current: unknown, name: string): TriState {
  if (!Array.isArray(current)) return "auto";
  return current.includes(name) ? "on" : "off";
}

/**
 * Checks that need the whole entry: a provider is required unless the model
 * names a provider account (`connection:`), which supplies it.
 */
export function validateEntry(entry: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  const provider = entry.provider;
  const hasConnection =
    typeof entry.connection === "string" && entry.connection !== "";
  if (
    !hasConnection &&
    (typeof provider !== "string" || provider.trim() === "")
  ) {
    errors.push({ path: ["provider"], message: "Provider is required." });
  }
  return errors;
}
