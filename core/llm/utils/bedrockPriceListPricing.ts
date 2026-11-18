import { GEO_PREFIX, nameMatchesModelId } from "../llms/bedrockModelNames.js";

/**
 * Bedrock prices from the AWS Price List (the public `AmazonBedrock` offer
 * file for one region, downloaded by bedrockPriceList.ts), turned into the
 * per-million-token prices the cost functions use. Pure: no Node imports,
 * since calculateRequestCost also runs in the webview.
 */

export type PriceRowKind =
  "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h";
export type PriceRowTier = "standard" | "flex" | "priority" | "batch";
export type PriceRowRoute = "in-region" | "cross-region" | "global";

/** One token price of the offer file, in USD per million tokens. */
export interface BedrockPriceRow {
  /** The model's name in the Price List ("Nova Pro"), or one derived from the usage type */
  model: string;
  kind: PriceRowKind;
  tier: PriceRowTier;
  route: PriceRowRoute;
  /** Rows for the bedrock-mantle endpoint (`-mantle-` usage types) */
  mantle?: boolean;
  usdPerMTok: number;
  usagetype: string;
}

export interface BedrockPriceList {
  schemaVersion: number;
  region: string;
  /** The offer file it was read from */
  source: string;
  /** ISO time it was downloaded */
  fetchedAt: string;
  /** The offer's version and publication date, when the file has them */
  version?: string;
  publicationDate?: string;
  rows: BedrockPriceRow[];
}

export const PRICE_LIST_SCHEMA_VERSION = 1;

/**
 * What a usage type (with the product's `inferenceType` and description, if
 * any) prices, or undefined for a row that is not a per-token inference
 * price: provisioned throughput, customization, storage, images, latency
 * optimized, long-context variants and so on.
 *
 * Usage types look like `USE1-Nova2.0Lite-input-tokens`,
 * `USE1-Nova2.0Lite-cache-read-input-token-count`,
 * `USE1-Llama4-Scout-17B-input-tokens-flex`,
 * `USE1-Qwen3-32B-mantle-input-tokens-standard`.
 */
export function classifyUsageType(
  usagetype: string,
  extra = "",
):
  | {
      kind: PriceRowKind;
      tier: PriceRowTier;
      route: PriceRowRoute;
      mantle: boolean;
      model: string;
    }
  | undefined {
  const u = usagetype.toLowerCase();
  const all = `${u} ${extra.toLowerCase()}`;
  if (
    /provisioned|custom|training|storage|image|video|audio|embed|latency|optimi[sz]ed|long-?context|lctx|reserved|commitment|guardrail|knowledge|rerank/.test(
      all,
    )
  ) {
    return undefined;
  }
  let kind: PriceRowKind | undefined;
  if (/cache-?read/.test(u)) kind = "cacheRead";
  else if (/cache-?write/.test(u)) {
    kind = /1h|1-hour|one-hour|60m/.test(u) ? "cacheWrite1h" : "cacheWrite";
  } else if (/input-?tokens?/.test(u)) kind = "input";
  else if (/output-?tokens?/.test(u)) kind = "output";
  if (!kind) return undefined;
  const tier: PriceRowTier = /flex/.test(u)
    ? "flex"
    : /priority/.test(u)
      ? "priority"
      : /batch/.test(u)
        ? "batch"
        : "standard";
  const route: PriceRowRoute = /global/.test(u)
    ? "global"
    : /cross-?region|-cris\b|-geo\b/.test(u)
      ? "cross-region"
      : "in-region";
  // The model part: drop the region code in front and everything from the
  // first classifying word on
  const model = usagetype
    .replace(/^[A-Z]{2,4}\d?-/, "")
    .replace(
      /-(?:mantle|cross-?region|global|input|output|cache|flex|priority|batch|standard)(?:-.*)?$/i,
      "",
    );
  return { kind, tier, route, mantle: /mantle/.test(u), model };
}

/**
 * A price per unit as USD per million tokens, from the price dimension's
 * unit ("1K tokens", "1M tokens", "Tokens") or, failing that, its
 * description ("per 1K input tokens"). Undefined for any other unit.
 */
export function perMillionTokens(
  usdPerUnit: number,
  unit: string | undefined,
  description = "",
): number | undefined {
  if (!Number.isFinite(usdPerUnit) || usdPerUnit < 0) return undefined;
  const scale = (text: string): number | undefined => {
    const t = text.toLowerCase();
    if (/\b(1m|million|mtok)\b/.test(t)) return 1;
    if (/\b(1k|1,000|thousand)\b/.test(t)) return 1000;
    if (/^\s*(tokens?|count)\s*$/.test(t)) return 1_000_000;
    return undefined;
  };
  const factor =
    (unit ? scale(unit) : undefined) ??
    (/per\s+(1m|million|1k|1,000|thousand)/i.test(description)
      ? scale(/per\s+(1m|million|1k|1,000|thousand)/i.exec(description)![1])
      : undefined);
  if (factor === undefined) return undefined;
  return Math.round(usdPerUnit * factor * 1e6) / 1e6;
}

/** The route a request to `modelId` takes, from its profile prefix. */
export function priceRouteOf(modelId: string): PriceRowRoute {
  if (/^global\./i.test(modelId)) return "global";
  return GEO_PREFIX.test(modelId) ? "cross-region" : "in-region";
}

export interface ListPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  tier: PriceRowTier;
  route: PriceRowRoute;
}

/**
 * The Price List's prices for `modelId` at `tier`, or undefined when the
 * list has no input and output price for it. Rows for the request's route
 * (`global.`, a geographic profile, or in-region) come first; a route the
 * list does not price separately falls back to the in-region rows, which is
 * what AWS bills a geographic profile at for the models it lists. Standard
 * endpoint rows come before bedrock-mantle rows unless `mantle` is set.
 */
export function priceListPricing(
  list: BedrockPriceList,
  modelId: string,
  opts: { tier?: PriceRowTier; mantle?: boolean } = {},
): ListPricing | undefined {
  const tier = opts.tier ?? "standard";
  const mine = list.rows.filter(
    (r) => r.tier === tier && nameMatchesModelId(r.model, modelId),
  );
  if (mine.length === 0) return undefined;
  const wanted = priceRouteOf(modelId);
  const routes: PriceRowRoute[] =
    wanted === "in-region" ? ["in-region"] : [wanted, "in-region"];
  const endpoints = opts.mantle ? [true, false] : [false, true];
  for (const route of routes) {
    for (const mantle of endpoints) {
      const rows = mine.filter(
        (r) => r.route === route && !!r.mantle === mantle,
      );
      const get = (kind: PriceRowKind) =>
        rows.find((r) => r.kind === kind)?.usdPerMTok;
      const input = get("input");
      const output = get("output");
      if (input === undefined || output === undefined) continue;
      return {
        input,
        output,
        cacheRead: get("cacheRead"),
        cacheWrite: get("cacheWrite"),
        cacheWrite1h: get("cacheWrite1h"),
        tier,
        route,
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The list the cost functions of this process use

let activeList: BedrockPriceList | undefined;

/**
 * Put a downloaded list in front of the Bedrock cost functions of this
 * process (the region of the selected Bedrock model), or remove it.
 */
export function setBedrockPriceList(list: BedrockPriceList | undefined): void {
  activeList = list && list.rows.length > 0 ? list : undefined;
}

export function getBedrockPriceList(): BedrockPriceList | undefined {
  return activeList;
}
