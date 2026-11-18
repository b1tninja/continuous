/**
 * Pure helpers for the Bedrock Mantle provider (OpenAI-compatible endpoint
 * `bedrock-mantle.<region>.api.aws`). Kept free of imports so they can be
 * shared with the GUI and tested without the OpenAI client.
 */

/**
 * Regions that have a `bedrock-mantle` endpoint (AWS "Regional availability by
 * endpoints"). `bedrock-runtime` is available in more regions.
 */
export const MANTLE_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-central-1",
  "eu-north-1",
  "eu-south-1",
  "eu-west-1",
  "eu-west-2",
  "ap-northeast-1",
  "ap-south-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "sa-east-1",
  "us-gov-east-1",
  "us-gov-west-1",
] as const;

export function isMantleRegion(region: string | undefined): boolean {
  return !!region && (MANTLE_REGIONS as readonly string[]).includes(region);
}

/** Path prefixes Mantle serves models under; most use /v1, some /openai/v1. */
export const MANTLE_PATH_PREFIXES = ["/v1", "/openai/v1"] as const;

/** Accepts "v1", "/v1/", "openai/v1" and returns "/v1" or "/openai/v1" style. */
export function normalizeMantlePrefix(
  prefix: string | undefined,
): string | undefined {
  if (!prefix) return undefined;
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : undefined;
}

/** Base URL (with trailing slash, as the OpenAI client expects). */
export function mantleBaseUrl(region: string, prefix = "/v1"): string {
  const p = normalizeMantlePrefix(prefix) ?? "/v1";
  return `https://bedrock-mantle.${region}.api.aws${p}/`;
}

/** The other documented prefix, for retrying a "wrong route" rejection. */
export function alternateMantlePrefix(prefix: string): string {
  return normalizeMantlePrefix(prefix) === "/openai/v1" ? "/v1" : "/openai/v1";
}

/** Mantle rejects a model requested on the wrong prefix with this message. */
export function isWrongRouteError(message: string): boolean {
  return /isn.?t supported on this route/i.test(message);
}

export type MaxTokensParam = "max_tokens" | "max_completion_tokens";

/**
 * Some models reject `max_tokens` (and, in principle, others reject
 * `max_completion_tokens`). Returns the parameter to switch to, or undefined
 * when the error is not about the token-limit parameter.
 */
export function maxTokensParamFromError(
  message: string,
): MaxTokensParam | undefined {
  if (/unsupported parameter:?\s*'?max_tokens'?/i.test(message)) {
    return "max_completion_tokens";
  }
  if (/unsupported parameter:?\s*'?max_completion_tokens'?/i.test(message)) {
    return "max_tokens";
  }
  return undefined;
}

/**
 * Request fields a Mantle model refuses and that can be left out without
 * changing what the request asks for. Measured on Daybreak Blue
 * (openai.gpt-daybreak-blue-5.6-sol, 2026-11-14): "Unsupported parameter:
 * 'stop' is not supported with this model." The token-limit parameters are
 * handled by `maxTokensParamFromError` (renamed, not dropped).
 */
export const DROPPABLE_MANTLE_PARAMS = [
  "stop",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "presence_penalty",
  "frequency_penalty",
  "seed",
] as const;
export type DroppableMantleParam = (typeof DROPPABLE_MANTLE_PARAMS)[number];

/** The droppable field an "Unsupported parameter" error names, or undefined. */
export function droppableParamFromError(
  message: string,
): DroppableMantleParam | undefined {
  const named = /unsupported parameter:?\s*'?([a-z_]+)'?/i.exec(message)?.[1];
  return DROPPABLE_MANTLE_PARAMS.find((p) => p === named?.toLowerCase());
}

/**
 * Daybreak Blue reasons by default and refuses function tools with reasoning
 * on in Chat Completions: "Function tools with reasoning_effort are not
 * supported for gpt-daybreak-blue-5.6-sol in /v1/chat/completions. To use
 * function tools, use /v1/responses or set reasoning_effort to 'none'." It
 * says so even when the request sent no reasoning_effort (measured
 * 2026-11-14), so the fix is to send `reasoning_effort: "none"` with tools.
 */
export function toolsNeedReasoningOffFromError(message: string): boolean {
  return /function tools with reasoning_effort are not supported/i.test(
    message,
  );
}

/**
 * What an IAM refusal says about why, for a hint that names the next step.
 * `explicit-deny` names the policy; `no-allow` names the action. AWS words
 * the two differently (measured on Mantle, 2026-11-14):
 *   "... with an explicit deny in an identity-based policy: arn:...:policy/NAME"
 *   "... because no identity-based policy allows the bedrock-mantle:X action"
 */
export type IamRefusal =
  | { kind: "explicit-deny"; policy?: string }
  | { kind: "no-allow"; action?: string };

export function iamRefusalFromError(message: string): IamRefusal | undefined {
  const deny = /with an explicit deny in an? [\w-]+ policy(?::\s*(\S+))?/i.exec(
    message,
  );
  if (deny) {
    const arn = deny[1]?.replace(/["'.,]+$/, "");
    return { kind: "explicit-deny", policy: arn?.split("/").pop() };
  }
  const noAllow = /no [\w-]+ policy allows the (\S+) action/i.exec(message);
  if (noAllow) {
    return { kind: "no-allow", action: noAllow[1] };
  }
  return undefined;
}

export interface MantleModelOption {
  id: string;
  name: string;
  provider: string;
  kind: "on-demand";
}

const VENDOR_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  qwen: "Qwen",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
  mistral: "Mistral AI",
  meta: "Meta",
  google: "Google",
  zai: "Z.AI",
  minimax: "MiniMax",
  nvidia: "NVIDIA",
  xai: "xAI",
  amazon: "Amazon",
};

const TOKEN_CASE: Record<string, string> = {
  gpt: "GPT",
  oss: "OSS",
  glm: "GLM",
  llm: "LLM",
  vl: "VL",
  ai: "AI",
};

// Ids that are not chat models (Mantle also serves embeddings and speech).
const NON_CHAT_MANTLE_ID =
  /embed|rerank|image|whisper|tts|speech|moderation|transcribe/i;

/** `openai.gpt-oss-120b` -> `GPT OSS 120B`; falls back to the id's shape. */
export function prettyMantleModelName(id: string): string {
  const base = id.includes(".") ? id.slice(id.indexOf(".") + 1) : id;
  const words = base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      if (TOKEN_CASE[lower]) return TOKEN_CASE[lower];
      // Sizes such as 120b / 20b / 235b
      if (/^\d+(\.\d+)?b$/i.test(token)) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    });
  return words.length > 0 ? words.join(" ") : id;
}

/** Turn `GET /models` ids (`openai.gpt-oss-120b`) into picker options. */
export function mantleModelOptions(ids: string[]): MantleModelOption[] {
  return [...new Set(ids)]
    .filter((id) => !NON_CHAT_MANTLE_ID.test(id))
    .map((id) => {
      const vendor = id.includes(".") ? id.split(".")[0] : "other";
      return {
        id,
        name: prettyMantleModelName(id),
        provider:
          VENDOR_NAMES[vendor] ??
          vendor.charAt(0).toUpperCase() + vendor.slice(1),
        kind: "on-demand" as const,
      };
    })
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
}

/** One-line next step for common Mantle failures, or undefined. */
export function getMantleErrorHint(
  message: string,
  ctx: { region?: string },
): string | undefined {
  if (isWrongRouteError(message)) {
    return "This model is served under a different path prefix. Set `mantlePathPrefix` to `/v1` or `/openai/v1` (see the model card under Programmatic Access).";
  }
  if (/ENOTFOUND|getaddrinfo|Could not resolve host|EAI_AGAIN/i.test(message)) {
    return isMantleRegion(ctx.region)
      ? `Could not reach bedrock-mantle in ${ctx.region}. Check your network/proxy.`
      : `bedrock-mantle isn't available in ${ctx.region ?? "this region"}. Mantle regions: ${MANTLE_REGIONS.join(", ")}.`;
  }
  const iam = iamRefusalFromError(message);
  if (iam?.kind === "explicit-deny") {
    return `An IAM policy${iam.policy ? ` (${iam.policy})` : ""} explicitly denies this request. A deny wins over any allow, so the key can't be used for this model or region; ask whoever manages the policy, or pick a model it allows.`;
  }
  if (iam?.kind === "no-allow") {
    return `No IAM policy allows ${iam.action ?? "this action"} here. Policies are often limited to one region and to named models: check the region${ctx.region ? ` (now ${ctx.region})` : ""} and the model ID.`;
  }
  if (
    /\b(401|403)\b|unauthorized|forbidden|invalid.*(api )?key|access ?denied/i.test(
      message,
    )
  ) {
    return "Authentication failed. Use a Bedrock API key for the same region, and make sure its IAM principal allows bedrock-mantle:CreateInference.";
  }
  if (/\b404\b|not found/i.test(message) && /models?/i.test(message)) {
    return "Model not found on this endpoint. Check the model ID with Test connection, and the path prefix (`/v1` vs `/openai/v1`).";
  }
  return undefined;
}
