import * as fs from "node:fs";
import * as path from "node:path";

import type { RequestOptions } from "../index.js";
import { networkFetch } from "../util/networkFetch.js";

import {
  COMMUNITY_CATALOG_SCHEMA_VERSION,
  MAX_COMMUNITY_CATALOG_BYTES,
  MAX_MODELS_DEV_RESPONSE_BYTES,
  MODELS_DEV_URL,
  parseModelsDev,
  validateCommunityCatalog,
  type CommunityCatalog,
} from "./communityCatalog.js";
import { ModelCatalogRefresher } from "./modelCatalogRefresh.js";
import {
  CATALOG_REQUEST_HEADERS,
  modelCatalogDir,
  readModelCatalogSettings,
  type ModelCatalogSettings,
} from "./modelCatalogStore.js";
import { calculateRequestCost } from "./utils/calculateRequestCost.js";
import { setCommunityCatalog } from "./utils/communityPricing.js";

/**
 * The trimmed copy of the community catalogue (models.dev), kept as
 * `model-catalog/models-dev.json` in the global folder beside OpenRouter's
 * list. Only prices of the mapped providers are kept.
 *
 * When models.dev is contacted (one GET to `https://models.dev/api.json`, no
 * key, no body, the same two headers as the OpenRouter request):
 *
 * - never unless the person has opted in (`modelCatalogCommunity: true`),
 *   labelled community;
 * - never when model information updates are `off`;
 * - only while a selected model has no price from a price the person entered,
 *   a provider list or the curated tables (`needsCommunityPrice`);
 * - on Refresh now, not at start-up. A stored `automatic` may also refresh it
 *   in the background, and only with the opt-in on.
 *
 * A price from this catalogue is not used for `--max-budget-usd` without
 * `--budget-allow-unpriced`.
 */

export function communityCatalogPath(): string {
  return path.join(modelCatalogDir(), "models-dev.json");
}

/** The cached copy, or undefined when there is none or it cannot be trusted. */
export function readCommunityCatalog(
  file = communityCatalogPath(),
): CommunityCatalog | undefined {
  try {
    if (fs.statSync(file).size > MAX_COMMUNITY_CATALOG_BYTES) return undefined;
    return validateCommunityCatalog(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Write through a temporary file so a reader never sees a half-written copy. */
export function writeCommunityCatalog(
  catalog: CommunityCatalog,
  file = communityCatalogPath(),
): void {
  const text = JSON.stringify(catalog);
  if (Buffer.byteLength(text) > MAX_COMMUNITY_CATALOG_BYTES) {
    throw new Error("The community catalogue is larger than the size limit");
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
 * process, as the last price source. A local read; never fetches. The copy
 * is used only with the community opt-in on, and not at all when model
 * information updates are `off`.
 */
export function loadCommunityPrices(
  opts: { file?: string; settings?: ModelCatalogSettings } = {},
): CommunityCatalog | undefined {
  const settings = opts.settings ?? readModelCatalogSettings();
  const catalog =
    settings.policy === "off" || settings.community !== true
      ? undefined
      : readCommunityCatalog(opts.file);
  setCommunityCatalog(catalog);
  return catalog;
}

/** Why models.dev may not be contacted now, or undefined when it may. */
export function communityFetchBlocked(
  settings: ModelCatalogSettings = readModelCatalogSettings(),
): string | undefined {
  if (settings.policy === "off") {
    return "Model information updates are off (modelCatalog: off), so models.dev is not contacted";
  }
  if (settings.community !== true) {
    return "The community catalogue (models.dev) is opt-in and off (modelCatalogCommunity). models.dev is not contacted";
  }
  return undefined;
}

/** A request large enough to have a price, small enough to hit no tier. */
const PROBE = { promptTokens: 1000, completionTokens: 1000 };

/**
 * Whether a model has no price from the better sources (the provider's list
 * or the curated tables), so the community catalogue is the only place one
 * could come from. A price the person entered is checked by the caller.
 */
export function needsCommunityPrice(model: {
  provider: string;
  model: string;
}): boolean {
  if (!model.provider || !model.model) return false;
  return (
    calculateRequestCost(model.provider, model.model, PROBE, {
      community: false,
    }) === null
  );
}

/**
 * Download the catalogue, keep the prices of the mapped providers and write
 * them. One GET, no key, no body. Throws with a short message when the host
 * cannot be reached or the answer is not a catalogue; the cached file is left
 * as it was.
 */
export async function pullCommunityCatalog(
  requestOptions?: RequestOptions,
  opts: { file?: string; now?: () => Date } = {},
): Promise<CommunityCatalog> {
  const response = await networkFetch(
    MODELS_DEV_URL,
    { method: "GET", headers: { ...CATALOG_REQUEST_HEADERS } },
    requestOptions,
  );
  if (!response.ok) {
    throw new Error(`models.dev answered ${response.status}`);
  }
  const length = Number(response.headers?.get?.("content-length") ?? 0);
  if (length > MAX_MODELS_DEV_RESPONSE_BYTES) {
    throw new Error("The community catalogue is larger than the size limit");
  }
  const text = await response.text();
  if (text.length > MAX_MODELS_DEV_RESPONSE_BYTES) {
    throw new Error("The community catalogue is larger than the size limit");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("models.dev did not return a catalogue");
  }
  const prices = parseModelsDev(body);
  if (prices.length === 0) {
    throw new Error("models.dev returned no prices");
  }
  const catalog: CommunityCatalog = {
    schemaVersion: COMMUNITY_CATALOG_SCHEMA_VERSION,
    source: MODELS_DEV_URL,
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    prices,
  };
  writeCommunityCatalog(catalog, opts.file);
  // Prices apply to the next request of this process, with no restart
  setCommunityCatalog(catalog);
  return catalog;
}

/**
 * The background refresh of the community catalogue. It runs only when model
 * information updates are a stored `automatic` and the community opt-in is
 * on. It checks on the same timer rules as OpenRouter's (first check 15 to
 * 60 seconds after start-up, then at most every 6 hours, every hour while
 * nothing needs it), and downloads only when `unpriced` says a selected model
 * has no better price and the copy is missing or older than the refresh
 * interval. The IDE does not start it: models.dev is an explicit refresh.
 * Not started under a test runner by its callers.
 */
export function createCommunityRefresher(opts: {
  /** Whether a selected model has no price from a better source now. */
  unpriced: () => boolean | Promise<boolean>;
  requestOptions?: () =>
    Promise<RequestOptions | undefined> | RequestOptions | undefined;
  onRefreshed?: (catalog: CommunityCatalog) => void;
  log?: (message: string) => void;
  /** Tests: the cache file and the setting, instead of the global folder. */
  file?: string;
  settings?: () => ModelCatalogSettings;
}): ModelCatalogRefresher<CommunityCatalog> {
  const settings = opts.settings ?? (() => readModelCatalogSettings());
  return new ModelCatalogRefresher<CommunityCatalog>({
    settings,
    wanted: async () => {
      if (settings().community !== true) return false;
      return opts.unpriced();
    },
    fetchedAt: () => readCommunityCatalog(opts.file)?.fetchedAt,
    pull: async () => {
      // Read again at the moment of the request: the setting may have
      // changed to off since the check
      const blocked = communityFetchBlocked(settings());
      if (blocked) throw new Error(blocked);
      return pullCommunityCatalog(await opts.requestOptions?.(), {
        file: opts.file,
      });
    },
    onRefreshed: opts.onRefreshed,
    log: opts.log,
  });
}
