import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";

import type { RequestOptions } from "../index.js";
import { editConfigFile, getContinueGlobalPath } from "../util/paths.js";
import { networkFetch } from "../util/networkFetch.js";

import { setOpenRouterCatalog } from "./utils/catalogPricing.js";
import {
  CATALOG_SCHEMA_VERSION,
  MAX_CATALOG_BYTES,
  OPENROUTER_MODELS_URL,
  parseOpenRouterModels,
  validateCatalog,
  type ModelCatalog,
} from "./openRouterCatalog.js";

/**
 * The downloaded OpenRouter list, kept as a dated file in the global folder
 * (`model-catalog/openrouter.json`). Written when the person asks for it
 * (Pull now, Refresh, `continuous models refresh`) and, when they have stored
 * `modelCatalog: automatic`, by the background refresh in
 * `modelCatalogRefresh.ts` when the copy is older than the refresh interval.
 * Nothing is stored as automatic: a fresh config does not refresh on its own.
 * The file is read, never fetched, everywhere else, including when updates
 * are manual. Holds public catalogue data and nothing else.
 */

export function modelCatalogDir(): string {
  return path.join(getContinueGlobalPath(), "model-catalog");
}

export function openRouterCatalogPath(): string {
  return path.join(modelCatalogDir(), "openrouter.json");
}

/** The cached list, or undefined when there is none or it cannot be trusted. */
export function readOpenRouterCatalog(
  file = openRouterCatalogPath(),
): ModelCatalog | undefined {
  try {
    if (fs.statSync(file).size > MAX_CATALOG_BYTES) return undefined;
    return validateCatalog(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Write through a temporary file so a reader never sees a half-written list. */
export function writeOpenRouterCatalog(
  catalog: ModelCatalog,
  file = openRouterCatalogPath(),
): void {
  const text = JSON.stringify(catalog);
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) {
    throw new Error("The model list is larger than the size limit");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    throw e;
  }
}

/**
 * Put the copy on disk (if any) in front of the cost functions of this
 * process. A local read; never fetches. `maxAgeDays` is for a dollar budget:
 * a list older than that prices nothing. With model information updates
 * `off` the copy is not used either: the bundled model data applies.
 */
export function loadOpenRouterPrices(
  opts: {
    maxAgeDays?: number;
    file?: string;
    settings?: ModelCatalogSettings;
  } = {},
): ModelCatalog | undefined {
  const settings = opts.settings ?? readModelCatalogSettings();
  const catalog =
    settings.policy === "off" ? undefined : readOpenRouterCatalog(opts.file);
  setOpenRouterCatalog(catalog, { maxAgeDays: opts.maxAgeDays });
  return catalog;
}

/**
 * The only headers sent to openrouter.ai: what is wanted back, and a fixed
 * User-Agent with no version, platform or install id in it. The user's
 * `requestOptions.headers` are dropped (`networkFetch`), so a gateway token
 * never reaches this host.
 */
export const CATALOG_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/json",
  "user-agent": "continuous",
};

/**
 * Download the public list and keep it. One GET, no key, no body. Throws with
 * a short message when the host cannot be reached or the answer is not a
 * model list; the cached file is left as it was.
 */
export async function pullOpenRouterCatalog(
  requestOptions?: RequestOptions,
  opts: { file?: string; now?: () => Date } = {},
): Promise<ModelCatalog> {
  const response = await networkFetch(
    OPENROUTER_MODELS_URL,
    { method: "GET", headers: { ...CATALOG_REQUEST_HEADERS } },
    requestOptions,
  );
  if (!response.ok) {
    throw new Error(`openrouter.ai answered ${response.status}`);
  }
  const length = Number(response.headers?.get?.("content-length") ?? 0);
  if (length > MAX_CATALOG_BYTES) {
    throw new Error("The model list is larger than the size limit");
  }
  const text = await response.text();
  if (text.length > MAX_CATALOG_BYTES) {
    throw new Error("The model list is larger than the size limit");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("openrouter.ai did not return a model list");
  }
  const models = parseOpenRouterModels(body);
  if (models.length === 0) {
    throw new Error("openrouter.ai returned no models");
  }
  const catalog: ModelCatalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: OPENROUTER_MODELS_URL,
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    models,
  };
  writeOpenRouterCatalog(catalog, opts.file);
  // Prices apply to the next request of this process, with no restart
  setOpenRouterCatalog(catalog);
  return catalog;
}

/**
 * "Model information updates", the one setting for the OpenRouter list:
 *
 * - `ask` (default when nothing is stored): only when the person asks (Pull
 *   now, Refresh, `continuous models refresh`); provider setup offers the
 *   download. Written to config.yaml as `manual`.
 * - `automatic`: a stored loosening. Refreshed in the background when the
 *   copy on this computer is older than `refreshHours`
 *   (`modelCatalogRefresh.ts`). Written as `automatic`, never by deleting
 *   the line, so it stays distinct from the default.
 * - `never`: as `ask`, but provider setup does not offer it ("Don't ask
 *   again" in builds 2.16.0 and 2.16.1, which is how it got there).
 * - `off`: nothing is ever requested from openrouter.ai; the bundled model
 *   data is used instead of a downloaded list.
 *
 * Ollama's list is not covered: it is fetched only from Ollama's own setup.
 * models.dev and the AWS Price List are separate opt-ins (`community`,
 * `priceList`), both off unless stored.
 */
export type ModelCatalogPolicy = "automatic" | "ask" | "never" | "off";

/** When `modelCatalog` is absent. Explicit refresh only. */
export const DEFAULT_MODEL_CATALOG_POLICY: ModelCatalogPolicy = "ask";

/** The values of the setting as a person writes them. */
export type ModelInfoUpdates = "automatic" | "manual" | "off";

export const DEFAULT_REFRESH_HOURS = 24;
const MIN_REFRESH_HOURS = 1;
const MAX_REFRESH_HOURS = 24 * 30;

export interface ModelCatalogSettings {
  policy: ModelCatalogPolicy;
  /** How old the copy may get before an automatic refresh replaces it. */
  refreshHours: number;
  /**
   * models.dev, labelled community. Absent or false: off. A price from it is
   * never a `--max-budget-usd` price without `--budget-allow-unpriced`.
   */
  community?: boolean;
  /**
   * The bulk AWS Price List for a Bedrock region. Absent or false: off. A
   * download is kept for days (`PRICE_LIST_CACHE_DAYS`).
   */
  priceList?: boolean;
}

/** Environment overrides, for the terminal agent and CI. */
export const MODEL_INFO_UPDATES_ENV = "CONTINUOUS_MODEL_INFO_UPDATES";
export const MODEL_INFO_REFRESH_HOURS_ENV =
  "CONTINUOUS_MODEL_INFO_REFRESH_HOURS";
/** `on` or `true` opts in to the community catalogue (models.dev). */
export const MODEL_INFO_COMMUNITY_ENV = "CONTINUOUS_MODEL_INFO_COMMUNITY";
/** `on` or `true` opts in to the bulk AWS Price List download. */
export const BEDROCK_PRICE_LIST_ENV = "CONTINUOUS_BEDROCK_PRICE_LIST";

/** A stored or typed value as a policy; undefined when it is not one. */
export function parseModelCatalogPolicy(
  value: unknown,
): ModelCatalogPolicy | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "automatic":
    case "auto":
      return "automatic";
    case "manual":
    case "ask":
      return "ask";
    case "never":
      return "never";
    case "off":
      return "off";
    default:
      return undefined;
  }
}

/** The person-facing value of a policy (`never` is a quiet `manual`). */
export function modelInfoUpdatesOf(
  policy: ModelCatalogPolicy,
): ModelInfoUpdates {
  return policy === "automatic"
    ? "automatic"
    : policy === "off"
      ? "off"
      : "manual";
}

/** A stored opt-in. Absent is off, which is the default. */
export function parseModelInfoOptIn(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "on":
    case "yes":
      return true;
    case "0":
    case "false":
    case "off":
    case "no":
      return false;
    default:
      return undefined;
  }
}

function parseRefreshHours(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(MAX_REFRESH_HOURS, Math.max(MIN_REFRESH_HOURS, n));
}

function policyFile(): string {
  return path.join(modelCatalogDir(), "policy.json");
}

function readYamlSettings(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readStandIn(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The setting, from (first that has it): the environment
 * (`CONTINUOUS_MODEL_INFO_UPDATES`, `CONTINUOUS_MODEL_INFO_REFRESH_HOURS`,
 * `CONTINUOUS_MODEL_INFO_COMMUNITY`, `CONTINUOUS_BEDROCK_PRICE_LIST`),
 * `modelCatalog:`, `modelCatalogRefreshHours:`, `modelCatalogCommunity:` and
 * `bedrockPriceList:` in the user-level config.yaml (the file the settings
 * page and the VS Code setting write), and the stand-in file kept beside the
 * cache when there is no config.yaml. An absent policy is `ask`, not
 * `automatic`: a stored `automatic` is kept. A local read; nothing here fetches.
 */
export function readModelCatalogSettings(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
  standIn = policyFile(),
  env: NodeJS.ProcessEnv = process.env,
): ModelCatalogSettings {
  const yaml = readYamlSettings(file);
  const stored = readStandIn(standIn);
  const policy =
    parseModelCatalogPolicy(env[MODEL_INFO_UPDATES_ENV]) ??
    parseModelCatalogPolicy(yaml.modelCatalog) ??
    parseModelCatalogPolicy(stored.modelCatalog) ??
    DEFAULT_MODEL_CATALOG_POLICY;
  const refreshHours =
    parseRefreshHours(env[MODEL_INFO_REFRESH_HOURS_ENV]) ??
    parseRefreshHours(yaml.modelCatalogRefreshHours) ??
    parseRefreshHours(stored.modelCatalogRefreshHours) ??
    DEFAULT_REFRESH_HOURS;
  const community =
    parseModelInfoOptIn(env[MODEL_INFO_COMMUNITY_ENV]) ??
    parseModelInfoOptIn(yaml.modelCatalogCommunity) ??
    parseModelInfoOptIn(stored.modelCatalogCommunity) ??
    false;
  const priceList =
    parseModelInfoOptIn(env[BEDROCK_PRICE_LIST_ENV]) ??
    parseModelInfoOptIn(yaml.bedrockPriceList) ??
    parseModelInfoOptIn(stored.bedrockPriceList) ??
    false;
  return { policy, refreshHours, community, priceList };
}

/**
 * Start-up arms the background refreshers only for a stored `automatic`.
 * A fresh config is explicit refresh only.
 */
export function modelInfoRefreshesInBackground(
  settings: ModelCatalogSettings = readModelCatalogSettings(),
): boolean {
  return settings.policy === "automatic";
}

export function readModelCatalogPolicy(
  file?: string,
  standIn?: string,
  env?: NodeJS.ProcessEnv,
): ModelCatalogPolicy {
  return readModelCatalogSettings(file, standIn, env).policy;
}

/**
 * Why a request to openrouter.ai may not be made now, or undefined when it
 * may. Only `off` forbids it; the other values decide when it is made.
 */
export function modelInfoFetchBlocked(
  settings: ModelCatalogSettings = readModelCatalogSettings(),
): string | undefined {
  return settings.policy === "off"
    ? "Model information updates are off (modelCatalog: off), so openrouter.ai is not contacted"
    : undefined;
}

/**
 * Refresh now / Pull now: one request to openrouter.ai. models.dev is
 * contacted only when the community opt-in is on, and only through
 * `pullCommunity`, whose failure does not fail this refresh.
 */
export async function pullRequestedModelInfo(
  opts: {
    requestOptions?: RequestOptions;
    file?: string;
    settings?: ModelCatalogSettings;
    pullCommunity?: () => Promise<void>;
    log?: (message: string) => void;
  } = {},
): Promise<
  | { ok: true; fetchedAt: string; models: ModelCatalog["models"] }
  | { ok: false; error: string }
> {
  const settings = opts.settings ?? readModelCatalogSettings();
  const blocked = modelInfoFetchBlocked(settings);
  if (blocked) return { ok: false, error: blocked };
  try {
    const catalog = await pullOpenRouterCatalog(opts.requestOptions, {
      file: opts.file,
    });
    if (settings.community === true && opts.pullCommunity) {
      try {
        await opts.pullCommunity();
      } catch (e) {
        opts.log?.(
          `Community catalogue refresh failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return {
      ok: true,
      fetchedAt: catalog.fetchedAt,
      models: catalog.models,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * How a policy is written to config.yaml. `automatic` is written, not
 * removed: an absent line is the default (`ask`), and a stored `automatic`
 * has to stay visible as a loosening.
 */
function storedValue(policy: ModelCatalogPolicy): string | undefined {
  switch (policy) {
    case "ask":
      return "manual";
    default:
      return policy;
  }
}

/**
 * Save the setting where `readModelCatalogSettings` finds it. The default
 * refresh interval is saved by removing the line. `automatic` is saved as
 * the word `automatic`. An opt-in is saved as `true` and cleared by removing
 * the line.
 */
export function saveModelCatalogSettings(change: {
  policy?: ModelCatalogPolicy;
  refreshHours?: number;
  community?: boolean;
  priceList?: boolean;
}): boolean {
  const policy =
    change.policy === undefined
      ? undefined
      : parseModelCatalogPolicy(change.policy);
  if (change.policy !== undefined && !policy) return false;
  const hours =
    change.refreshHours === undefined
      ? undefined
      : parseRefreshHours(change.refreshHours);
  if (change.refreshHours !== undefined && hours === undefined) return false;
  const apply = (target: Record<string, unknown>) => {
    if (policy) {
      const v = storedValue(policy);
      if (v === undefined) delete target.modelCatalog;
      else target.modelCatalog = v;
    }
    if (hours !== undefined) {
      if (hours === DEFAULT_REFRESH_HOURS) {
        delete target.modelCatalogRefreshHours;
      } else target.modelCatalogRefreshHours = hours;
    }
    if (change.community !== undefined) {
      if (change.community) target.modelCatalogCommunity = true;
      else delete target.modelCatalogCommunity;
    }
    if (change.priceList !== undefined) {
      if (change.priceList) target.bedrockPriceList = true;
      else delete target.bedrockPriceList;
    }
  };
  let saved = false;
  try {
    editConfigFile(
      (c) => c,
      (config) => {
        saved = true;
        const next: Record<string, unknown> = { ...config };
        apply(next);
        return next as typeof config;
      },
      "main",
    );
  } catch {
    saved = false;
  }
  if (saved) {
    // One source of truth: drop the stand-in file if it exists
    try {
      fs.rmSync(policyFile(), { force: true });
    } catch {
      // harmless
    }
    return true;
  }
  try {
    const next = readStandIn(policyFile());
    apply(next);
    fs.mkdirSync(modelCatalogDir(), { recursive: true });
    fs.writeFileSync(policyFile(), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function saveModelCatalogPolicy(policy: ModelCatalogPolicy): boolean {
  return saveModelCatalogSettings({ policy });
}
