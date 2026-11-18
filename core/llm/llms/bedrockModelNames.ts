/**
 * Matching Bedrock model IDs to the prose names AWS uses elsewhere: Service
 * Quotas ("... tokens per minute for Anthropic Claude Sonnet 4.5 V1") and the
 * AWS Price List (`model` attribute "Nova Pro", usage type
 * `USE1-Nova2.0Lite-input-tokens`). Neither carries the model ID, so the
 * match is by words. No Node imports: the cost functions use this in the
 * webview too.
 */

/** Words between a vendor's name and the model name ("Mistral AI"). */
const COMPANY_WORDS = new Set(["ai", "labs", "inc"]);
/** Words that one side carries and the other often leaves out. */
const FILLER_WORDS = new Set(["instruct"]);

/**
 * Lowercase words, with numbers split from letters ("llama4" is llama, 4),
 * dotted versions split ("4.5" is 4, 5) and a ".0" minor dropped ("Nova
 * 2.0 Lite" is nova, 2, lite).
 */
export function nameWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\d)\.0(?!\d)/g, "$1")
    .replace(/(\d)\.(\d)/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .flatMap((w) => w.match(/[a-z]+|\d+/g) ?? [])
    .filter((w) => !FILLER_WORDS.has(w));
}

/** The cross-region inference profile prefixes of a Bedrock model ID. */
export const GEO_PREFIX = /^(us-gov|us|eu|apac|jp|au|ca|global)\./i;

/**
 * A Bedrock model ID as words: vendor, model words, and version (`-v2:0` is
 * 2, none is 1). A date (`-20250929`) is dropped. Undefined for an ARN,
 * which names no model.
 */
export function modelIdKey(
  modelId: string,
): { vendor: string; words: string[]; version: number } | undefined {
  if (!modelId || modelId.startsWith("arn:")) return undefined;
  const id = modelId.replace(GEO_PREFIX, "");
  const dot = id.indexOf(".");
  if (dot <= 0) return undefined;
  const vendor = id.slice(0, dot).toLowerCase();
  let rest = id.slice(dot + 1);
  let version = 1;
  const v = /-v(\d+)(?::\d+)?$/i.exec(rest) ?? /-(\d+):\d+$/.exec(rest);
  if (v) {
    version = Number(v[1]);
    rest = rest.slice(0, v.index);
  }
  rest = rest.replace(/:\d+$/, "").replace(/-\d{8}(?=-|$)/, "");
  const words = nameWords(rest);
  return words.length > 0 ? { vendor, words, version } : undefined;
}

/**
 * Whether a prose model name names `modelId`. The vendor's words are dropped
 * from the front ("Anthropic", "Mistral AI", "Moonshot AI"), a trailing
 * "V2" is the version (none is 1), and what is left must be exactly the
 * model ID's words. A variant ("... 1M Context Length") does not match.
 */
export function nameMatchesModelId(name: string, modelId: string): boolean {
  const key = modelIdKey(modelId);
  if (!key) return false;
  const parts = name.trim().split(/\s+/);
  let version = 1;
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^v\d+$/i.test(last)) {
    version = Number(last.slice(1));
    parts.pop();
  }
  if (version !== key.version) return false;
  const words = nameWords(parts.join(" "));
  const vendor = key.vendor.replace(/[^a-z0-9]/g, "");
  for (let drop = 0; drop <= Math.min(2, words.length - 1); drop++) {
    const dropped = words.slice(0, drop);
    if (!dropped.every((w) => vendor.includes(w) || COMPANY_WORDS.has(w))) {
      break;
    }
    const rest = words.slice(drop);
    if (
      rest.length === key.words.length &&
      rest.every((w, i) => w === key.words[i])
    ) {
      return true;
    }
  }
  return false;
}
