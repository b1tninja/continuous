import * as fs from "node:fs";
import * as path from "node:path";

import type { Command } from "commander";
import {
  modelInfoFetchBlocked,
  openRouterCatalogPath,
  pullOpenRouterCatalog,
  readModelCatalogSettings,
  readOpenRouterCatalog,
  type ModelCatalogSettings,
} from "core/llm/modelCatalogStore.js";
import {
  OPENROUTER_MODELS_URL,
  catalogAgeDays,
  type ModelCatalog,
} from "core/llm/openRouterCatalog.js";
import { getContinueGlobalPath } from "core/util/paths.js";
import * as YAML from "yaml";

import {
  priceListStatus,
  stalePriceWarning,
} from "../budget/openRouterPrices.js";
import { safeStderr, safeStdout } from "../init.js";
import { gracefulExit } from "../util/exit.js";

/**
 * `continuous models refresh` and `continuous models list` (also `cn models`):
 * the CLI side of "Pull the latest model information from OpenRouter?". The
 * refresh says which host it contacts and what it keeps before it does
 * anything, and is refused when model information updates are `off`. With
 * updates `automatic` (the default) a run also refreshes a stale list in the
 * background (`../modelInfoRefresh.ts`).
 */

export interface ModelsIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const stdio: ModelsIo = {
  out: (l) => safeStdout(`${l}\n`),
  err: (l) => safeStderr(`${l}\n`),
};

export interface ModelsDeps {
  pull: (requestOptions: unknown, file?: string) => Promise<ModelCatalog>;
  read: (file?: string) => ModelCatalog | undefined;
  /** Where the copy is kept. */
  file: () => string;
  /** The user's `requestOptions` (proxy, CA bundle), or undefined. */
  requestOptions: () => unknown;
  now: () => number;
  /** Model information updates; `off` refuses the refresh. */
  settings?: () => ModelCatalogSettings;
}

/** The `requestOptions` block of the user-level config.yaml, if any. */
export function userRequestOptions(): unknown {
  try {
    const file = path.join(getContinueGlobalPath(), "config.yaml");
    if (!fs.existsSync(file)) return undefined;
    const v = (YAML.parse(fs.readFileSync(file, "utf8")) as any)
      ?.requestOptions;
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

const defaultDeps: ModelsDeps = {
  pull: (requestOptions, file) =>
    pullOpenRouterCatalog(requestOptions as never, { file }),
  read: (file) => readOpenRouterCatalog(file),
  file: openRouterCatalogPath,
  requestOptions: userRequestOptions,
  now: Date.now,
  settings: () => readModelCatalogSettings(),
};

export async function modelsRefreshCommand(
  options: { json?: boolean },
  io: ModelsIo = stdio,
  deps: ModelsDeps = defaultDeps,
): Promise<number> {
  const file = deps.file();
  const blocked = deps.settings
    ? modelInfoFetchBlocked(deps.settings())
    : undefined;
  if (blocked) {
    const hint =
      "Set modelCatalog: manual or automatic in config.yaml (or CONTINUOUS_MODEL_INFO_UPDATES) to allow it";
    if (options.json) {
      io.out(JSON.stringify({ ok: false, error: blocked, file }));
    } else {
      io.err(`${blocked}. ${hint}.`);
    }
    return 1;
  }
  if (!options.json) {
    io.out(
      `Contacting openrouter.ai (${OPENROUTER_MODELS_URL}): one public GET. No account, key or prompt is sent.`,
    );
    io.out(
      `Storing the public model list (names, ids, context sizes, per-token prices) with today's date in ${file}.`,
    );
  }
  try {
    const catalog = await deps.pull(deps.requestOptions(), file);
    const priced = catalog.models.filter((m) => m.pricing).length;
    if (options.json) {
      io.out(
        JSON.stringify({
          ok: true,
          source: catalog.source,
          fetchedAt: catalog.fetchedAt,
          models: catalog.models.length,
          priced,
          file,
        }),
      );
    } else {
      io.out(
        `Saved ${catalog.models.length} models (${priced} with prices), downloaded ${catalog.fetchedAt.slice(0, 10)}. Prices are estimates.`,
      );
    }
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (options.json) {
      io.out(JSON.stringify({ ok: false, error: message, file }));
    } else {
      io.err(
        `Could not download the model list: ${message}. The list already on this computer is unchanged.`,
      );
    }
    return 1;
  }
}

function perMillion(rate: number | undefined): number | null {
  return rate === undefined ? null : +(rate * 1_000_000).toPrecision(6);
}

export function modelsListCommand(
  options: { json?: boolean; search?: string },
  io: ModelsIo = stdio,
  deps: ModelsDeps = defaultDeps,
): number {
  const catalog = deps.read(deps.file());
  const needle = options.search?.toLowerCase();
  const models = (catalog?.models ?? []).filter(
    (m) =>
      !needle ||
      m.id.toLowerCase().includes(needle) ||
      m.name.toLowerCase().includes(needle),
  );
  if (options.json) {
    io.out(
      JSON.stringify({
        source: catalog?.source ?? null,
        fetchedAt: catalog?.fetchedAt ?? null,
        ageDays: catalog ? catalogAgeDays(catalog.fetchedAt, deps.now()) : null,
        pricesUsdPerMillionTokens: true,
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          contextLength: m.contextLength ?? null,
          maxCompletionTokens: m.maxCompletionTokens ?? null,
          supportsTools: m.supportsTools,
          input: perMillion(m.pricing?.prompt),
          output: perMillion(m.pricing?.completion),
          cacheRead: perMillion(m.pricing?.inputCacheRead),
          cacheWrite: perMillion(m.pricing?.inputCacheWrite),
          cacheWrite1h: perMillion(m.pricing?.inputCacheWrite1h),
          tiers: (m.pricing?.overrides ?? []).map((t) => ({
            minPromptTokens: t.minPromptTokens,
            input: perMillion(t.prompt),
            output: perMillion(t.completion),
          })),
        })),
      }),
    );
    return 0;
  }
  if (!catalog) {
    io.out(
      "No downloaded model list on this computer. To download the public list from openrouter.ai, run `continuous models refresh`.",
    );
    return 0;
  }
  io.out(
    `Prices from openrouter.ai as of ${catalog.fetchedAt.slice(0, 10)} (estimates), USD per million tokens. ${models.length} of ${catalog.models.length} models.`,
  );
  const warning = stalePriceWarning(
    priceListStatus(catalog.fetchedAt, deps.now()),
  );
  if (warning) io.err(`Warning: ${warning}`);
  const money = (n: number | null) => (n === null ? "-" : `$${n}`);
  for (const m of models) {
    io.out(
      `${m.id}  context ${m.contextLength ?? "-"}  in ${money(perMillion(m.pricing?.prompt))}  out ${money(perMillion(m.pricing?.completion))}${m.supportsTools ? "" : "  (no tools)"}`,
    );
  }
  return 0;
}

export function registerModelsCommand(program: Command): void {
  const models = program
    .command("models")
    .description(
      "The model list from OpenRouter, kept on this computer with its date: refresh it, list it",
    );
  models
    .command("refresh")
    .description(
      "Download OpenRouter's public model list (names, context sizes, per-token prices) now. Contacts openrouter.ai; refused when model information updates are off",
    )
    .option("--json", "Machine-readable output")
    .action(async (options) => {
      await gracefulExit(await modelsRefreshCommand(options));
    });
  models
    .command("list")
    .description(
      "List the downloaded models with their prices (reads the local copy; never contacts the network)",
    )
    .option("--json", "Machine-readable output")
    .option("--search <text>", "Only ids or names containing this text")
    .action(async (options) => {
      await gracefulExit(modelsListCommand(options));
    });
}
