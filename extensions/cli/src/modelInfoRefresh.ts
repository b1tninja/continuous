import type { CommunityCatalog } from "core/llm/communityCatalog.js";
import {
  createCommunityRefresher,
  loadCommunityPrices,
  needsCommunityPrice,
} from "core/llm/communityCatalogStore.js";
import {
  createOpenRouterRefresher,
  underTestRunner,
  type ModelCatalogRefresher,
} from "core/llm/modelCatalogRefresh.js";
import { loadOpenRouterPrices } from "core/llm/modelCatalogStore.js";

import { userRequestOptions } from "./commands/models.js";
import { logger } from "./util/logger.js";

let refresher: ModelCatalogRefresher | undefined;
let communityRefresher: ModelCatalogRefresher<CommunityCatalog> | undefined;

type ModelId = { provider: string; model: string } | null | undefined;

/**
 * Whether the run's model has no price from the provider's list or the
 * curated tables, so only the community catalogue could price it.
 */
export function modelUnpriced(model: ModelId): boolean {
  try {
    return !!model && needsCommunityPrice(model);
  } catch {
    return false;
  }
}

/**
 * The downloaded prices this process prices with: OpenRouter's list and the
 * community catalogue (models.dev), each a file read that honours model
 * information updates (`off` uses neither). Loaded together so a community
 * price is never asked for where OpenRouter's list has one.
 */
export function loadDownloadedPrices(): void {
  try {
    loadOpenRouterPrices();
    loadCommunityPrices();
  } catch (e) {
    logger.debug(`Could not read the downloaded prices: ${String(e)}`);
  }
}

/**
 * Model information updates for the terminal agent, the same setting the
 * IDEs read (`modelCatalog:` in the user-level config.yaml, or
 * `CONTINUOUS_MODEL_INFO_UPDATES`). With `automatic` (the default) a stale
 * OpenRouter list is refreshed in the background: the first check runs one
 * to three seconds after start-up and later ones while the session lasts.
 * The community catalogue (models.dev) is checked on the same timing and
 * downloaded only while `currentModel` has no price from a better source.
 * The timers do not keep the process alive and a run never waits for them;
 * a run that ends sooner simply makes no request.
 */
export function startModelInfoRefresh(
  create: typeof createOpenRouterRefresher = createOpenRouterRefresher,
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    /** The run's model, read at each check (it is chosen after start-up). */
    currentModel?: () => ModelId;
    createCommunity?: typeof createCommunityRefresher;
  } = {},
): ModelCatalogRefresher | undefined {
  if (refresher || underTestRunner(env)) return refresher;
  loadDownloadedPrices();
  refresher = create({
    requestOptions: () => userRequestOptions() as never,
    log: (m) => logger.debug(m),
  });
  refresher.start({ delayMs: 1000, jitterMs: 2000 });
  const currentModel = opts.currentModel;
  if (currentModel) {
    communityRefresher = (opts.createCommunity ?? createCommunityRefresher)({
      unpriced: () => modelUnpriced(currentModel()),
      requestOptions: () => userRequestOptions() as never,
      log: (m) => logger.debug(m),
    });
    communityRefresher.start({ delayMs: 1000, jitterMs: 2000 });
  }
  return refresher;
}

export function stopModelInfoRefresh(): void {
  refresher?.stop();
  refresher = undefined;
  communityRefresher?.stop();
  communityRefresher = undefined;
}
