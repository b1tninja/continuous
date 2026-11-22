import { isLocalApiBase } from "core/llm/localServers";
import { PROVIDER_TOOL_SUPPORT } from "core/llm/toolSupport";
import {
  findBedrockPricing,
  findModelPricing,
  findNovaPricing,
  openAIPriceFor,
} from "core/llm/utils/calculateRequestCost";
import {
  catalogDate,
  catalogModelWithPrice,
} from "core/llm/utils/catalogPricing";
import type { ModelPackage } from "../../pages/AddNewModel/configs/models";

/**
 * What the checklist says about one model: its context window, its price and
 * whether it takes tools. Each comes from a table or a listing the code
 * already has; what none of them knows is said in words, never left blank
 * and never shown as $0.
 */
export interface ModelFacts {
  /** "200,000 tokens", or "not published". */
  context: string;
  /** "$3 in / $15 out per 1M tokens", or the reason there is no figure. */
  price: string;
  /** "yes", "no", or "not reported". */
  tools: "yes" | "no" | "not reported";
  /** The same two under a column heading that carries the unit: "200,000", "$3 / $15". */
  contextCell: string;
  priceCell: string;
}

/** The column headings; the short cell texts rely on them for the unit. */
export const FACT_HEADINGS = {
  context: "Context, tokens",
  price: "Price in / out per 1M tokens",
  tools: "Tools",
} as const;

export const CONTEXT_UNKNOWN = "not published";
export const PRICE_UNKNOWN = "no price known";
/** A server on this machine or network: nobody bills its tokens. */
export const PRICE_OWN_SERVER = "not billed per token";

export interface FactsTarget {
  /** The provider id models are saved with ("anthropic", "openai"). */
  provider: string;
  /** The entry is a server the person runs (the "Local server" provider). */
  localServer?: boolean;
  /** The address in the form, when there is one. */
  apiBase?: string;
}

const PER_M = 1_000_000;

/** "$3", "$0.15", "$1.25": a price per million tokens. */
function dollars(perMillion: number): string {
  return `$${+perMillion.toPrecision(4)}`;
}

/**
 * Input and output price per million tokens, from the table for the provider.
 * `asOf` is set for the downloaded OpenRouter list: its prices are those of
 * the day it was downloaded, and the line says so.
 */
function ratesFor(
  target: FactsTarget,
  model: string,
): { input: number; output: number; asOf?: string } | undefined {
  const { provider } = target;
  if (provider === "openrouter") {
    const hit = catalogModelWithPrice(model);
    const pricing = hit?.model.pricing;
    return hit && pricing
      ? {
          input: (pricing.prompt ?? 0) * PER_M,
          output: (pricing.completion ?? 0) * PER_M,
          asOf: catalogDate(hit.fetchedAt),
        }
      : undefined;
  }
  if (provider === "anthropic") return findModelPricing(model) ?? undefined;
  if (provider === "openai" && !target.localServer) {
    return openAIPriceFor(model);
  }
  if (provider === "bedrock" || provider === "bedrock-mantle") {
    return (
      findNovaPricing(model) ??
      findBedrockPricing(model) ??
      findModelPricing(model) ??
      undefined
    );
  }
  return undefined;
}

/** The price in full, and as it reads under the price column's heading. */
export function priceFact(
  target: FactsTarget,
  model: string,
): { full: string; cell: string } {
  const rates = ratesFor(target, model);
  if (rates) {
    const dated = rates.asOf ? `, prices as of ${rates.asOf}` : "";
    // A listed price of zero is the provider's own "free", not a missing one
    if (rates.input === 0 && rates.output === 0) {
      return { full: `free${dated}`, cell: `free${dated}` };
    }
    const [input, output] = [dollars(rates.input), dollars(rates.output)];
    return {
      full: `${input} in / ${output} out per 1M tokens${dated}`,
      cell: `${input} / ${output}${dated}`,
    };
  }
  const ownServer =
    target.localServer && (!target.apiBase || isLocalApiBase(target.apiBase));
  const words = ownServer ? PRICE_OWN_SERVER : PRICE_UNKNOWN;
  return { full: words, cell: words };
}

export function toolsFact(
  target: FactsTarget,
  pkg: ModelPackage | undefined,
  model: string,
): ModelFacts["tools"] {
  // What the provider's own listing said wins (a local server's /props)
  const reported = pkg?.params.capabilities?.tools;
  if (typeof reported === "boolean") return reported ? "yes" : "no";
  // The name table for "openai" is about OpenAI's models, not a local server's
  if (target.localServer) return "not reported";
  const byName = PROVIDER_TOOL_SUPPORT[target.provider];
  if (!byName) return "not reported";
  if (byName(model)) return "yes";
  // The table answers no for a name it does not know. That is a fact only
  // about a model the provider's own list offers.
  return pkg ? "no" : "not reported";
}

export function modelFacts(
  target: FactsTarget,
  pkg: ModelPackage | undefined,
  model: string,
): ModelFacts {
  const window = pkg?.params.contextLength;
  const known = typeof window === "number" && window > 0;
  const price = priceFact(target, model);
  return {
    context: known
      ? `${window.toLocaleString("en-US")} tokens`
      : CONTEXT_UNKNOWN,
    contextCell: known ? window.toLocaleString("en-US") : CONTEXT_UNKNOWN,
    price: price.full,
    priceCell: price.cell,
    tools: toolsFact(target, pkg, model),
  };
}

/**
 * The "Tools:" part of the test line, for the models a server listed: "yes"
 * when every one takes tools, "no" when none does, a count when they differ,
 * and "not reported" when the listing does not say.
 */
export function toolsSummary(tools: ModelFacts["tools"][]): string {
  const known = tools.filter((t) => t !== "not reported");
  if (known.length === 0) return "not reported";
  const yes = known.filter((t) => t === "yes").length;
  if (yes === tools.length) return "yes";
  if (yes === 0 && known.length === tools.length) return "no";
  return `${yes} of ${tools.length}`;
}
