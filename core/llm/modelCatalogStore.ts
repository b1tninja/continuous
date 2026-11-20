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
 * (Pull now, Refresh, `continuous models refresh`) and, with model
 * information updates set to `automatic` (the default), by the background
 * refresh in `modelCatalogRefresh.ts` when the copy is older than the refresh
 * interval. Read, never fetched, everywhere else. Holds public catalogue
 * data and nothing else.
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
 * - `automatic` (default): refreshed in the background when the copy on this
 *   computer is older than `refreshHours`, at start-up and while running
 *   (`modelCatalogRefresh.ts`). Provider setup does not ask first.
 * - `ask`: only when the person asks (Pull now, Refresh,
 *   `continuous models refresh`); provider setup offers the download. Written
 *   to config.yaml as `manual`.
 * - `never`: as `ask`, but provider setup does not offer it ("Don't ask
 *   again" in builds 2.16.0 and 2.16.1, which is how it got there).
 * - `off`: nothing is ever requested from openrouter.ai; the bundled model
 *   data (and a copy downloaded earlier, if any) is used.
 *
 * Ollama's list is not covered: it is fetched only from Ollama's own setup.
 */
export type ModelCatalogPolicy = "automatic" | "ask" | "never" | "off";

/** The values of the setting as a person writes them. */
export type ModelInfoUpdates = "automatic" | "manual" | "off";

export const DEFAULT_REFRESH_HOURS = 24;
const MIN_REFRESH_HOURS = 1;
const MAX_REFRESH_HOURS = 24 * 30;

export interface ModelCatalogSettings {
  policy: ModelCatalogPolicy;
  /** How old the copy may get before an automatic refresh replaces it. */
  refreshHours: number;
}

/** Environment overrides, for the terminal agent and CI. */
export const MODEL_INFO_UPDATES_ENV = "CONTINUOUS_MODEL_INFO_UPDATES";
export const MODEL_INFO_REFRESH_HOURS_ENV =
  "CONTINUOUS_MODEL_INFO_REFRESH_HOURS";

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
 * (`CONTINUOUS_MODEL_INFO_UPDATES`, `CONTINUOUS_MODEL_INFO_REFRESH_HOURS`),
 * `modelCatalog:` and `modelCatalogRefreshHours:` in the user-level
 * config.yaml (the file the settings page and the VS Code setting write),
 * and the stand-in file kept beside the cache when there is no config.yaml.
 * A local read; nothing here fetches.
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
    "automatic";
  const refreshHours =
    parseRefreshHours(env[MODEL_INFO_REFRESH_HOURS_ENV]) ??
    parseRefreshHours(yaml.modelCatalogRefreshHours) ??
    parseRefreshHours(stored.modelCatalogRefreshHours) ??
    DEFAULT_REFRESH_HOURS;
  return { policy, refreshHours };
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

/** How a policy is written to config.yaml; undefined removes the line. */
function storedValue(policy: ModelCatalogPolicy): string | undefined {
  switch (policy) {
    case "automatic":
      return undefined;
    case "ask":
      return "manual";
    default:
      return policy;
  }
}

/**
 * Save the setting where `readModelCatalogSettings` finds it. `automatic`
 * and the default refresh interval are saved by removing the line.
 */
export function saveModelCatalogSettings(change: {
  policy?: ModelCatalogPolicy;
  refreshHours?: number;
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
