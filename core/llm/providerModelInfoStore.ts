import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  ModelInfoProvider,
  ProviderModelFacts,
} from "../util/providerModelLookup.js";
import { lookupBase } from "../util/providerModelLookup.js";

import {
  modelCatalogDir,
  readModelCatalogSettings,
  type ModelCatalogSettings,
} from "./modelCatalogStore.js";

/**
 * What Anthropic's or OpenAI's own `GET /v1/models/{id}` last said about a
 * model, per provider and account: `model-catalog/provider-<provider>-<hash>.json`
 * in the global folder. The hash is of the API base and the key, so the key
 * itself is never written and two accounts never share an answer (one may
 * have access to a model the other has not). Holds public model facts and
 * dates only.
 *
 * Read by `BaseLLM` (core/llm/providerModelLimits.ts) for the context window
 * and output cap when the person has not set them, between their own config
 * and the bundled llm-info. With "Model information updates" off, nothing
 * here is used: the bundled data applies.
 */

export const PROVIDER_INFO_SCHEMA_VERSION = 1;
/** Entries kept per account; the oldest go first. */
export const MAX_PROVIDER_INFO_ENTRIES = 50;
const MAX_FILE_BYTES = 256 * 1024;

export interface ProviderModelTarget {
  provider: ModelInfoProvider;
  apiBase?: string;
  apiKey?: string;
  model: string;
}

export interface CachedModelFacts extends ProviderModelFacts {
  /** ISO time the provider answered. */
  fetchedAt: string;
}

interface ProviderInfoFile {
  schemaVersion: number;
  provider: ModelInfoProvider;
  models: Record<string, CachedModelFacts>;
}

/** Provider + API base + key, hashed; the file name's account part. */
export function accountFingerprint(
  target: Pick<ProviderModelTarget, "provider" | "apiBase" | "apiKey">,
): string {
  return createHash("sha256")
    .update(
      `${target.provider}\n${lookupBase(target.provider, target.apiBase)}\n${target.apiKey ?? ""}`,
    )
    .digest("hex")
    .slice(0, 24);
}

export function providerInfoPath(
  target: Pick<ProviderModelTarget, "provider" | "apiBase" | "apiKey">,
  dir = modelCatalogDir(),
): string {
  return path.join(
    dir,
    `provider-${target.provider}-${accountFingerprint(target)}.json`,
  );
}

const memory = new Map<string, ProviderInfoFile | null>();

function readFile(file: string): ProviderInfoFile | undefined {
  if (memory.has(file)) return memory.get(file) ?? undefined;
  let parsed: ProviderInfoFile | undefined;
  try {
    if (fs.statSync(file).size <= MAX_FILE_BYTES) {
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        p?.schemaVersion === PROVIDER_INFO_SCHEMA_VERSION &&
        p.models &&
        typeof p.models === "object"
      ) {
        parsed = p as ProviderInfoFile;
      }
    }
  } catch {
    parsed = undefined;
  }
  memory.set(file, parsed ?? null);
  return parsed;
}

/** For tests: forget what was read. */
export function clearProviderInfoMemory(): void {
  memory.clear();
  settingsMemo = undefined;
}

let settingsMemo: { at: number; value: ModelCatalogSettings } | undefined;
const SETTINGS_MEMO_MS = 30_000;

/** The setting, read at most every 30 s: LLMs are constructed in bursts. */
function currentSettings(): ModelCatalogSettings {
  const now = Date.now();
  if (!settingsMemo || now - settingsMemo.at > SETTINGS_MEMO_MS) {
    settingsMemo = { at: now, value: readModelCatalogSettings() };
  }
  return settingsMemo.value;
}

/** The cached entry, whatever the setting (the refresher's own bookkeeping). */
export function readCachedModelFacts(
  target: ProviderModelTarget,
  dir?: string,
): CachedModelFacts | undefined {
  try {
    return readFile(providerInfoPath(target, dir))?.models[target.model];
  } catch {
    return undefined;
  }
}

/**
 * The facts to use for a model, or undefined: only for Anthropic and OpenAI,
 * and never with model information updates off. A file read at most once
 * per account per process; never fetches, never throws.
 */
export function providerModelFactsFor(
  provider: string,
  target: Omit<ProviderModelTarget, "provider">,
  opts: { settings?: ModelCatalogSettings; dir?: string } = {},
): CachedModelFacts | undefined {
  if (provider !== "anthropic" && provider !== "openai") return undefined;
  if (!target.model) return undefined;
  try {
    const settings = opts.settings ?? currentSettings();
    if (settings.policy === "off") return undefined;
    return readCachedModelFacts({ ...target, provider }, opts.dir);
  } catch {
    return undefined;
  }
}

/** Keep one answer, through a temporary file; never throws. */
export function writeCachedModelFacts(
  target: ProviderModelTarget,
  facts: ProviderModelFacts,
  opts: { now?: Date; dir?: string } = {},
): CachedModelFacts | undefined {
  const file = providerInfoPath(target, opts.dir);
  const entry: CachedModelFacts = {
    ...facts,
    fetchedAt: (opts.now ?? new Date()).toISOString(),
  };
  const prior = readFile(file);
  const models = { ...(prior?.models ?? {}), [target.model]: entry };
  const keys = Object.keys(models).sort((a, b) =>
    models[a].fetchedAt.localeCompare(models[b].fetchedAt),
  );
  for (const k of keys.slice(
    0,
    Math.max(0, keys.length - MAX_PROVIDER_INFO_ENTRIES),
  )) {
    delete models[k];
  }
  const next: ProviderInfoFile = {
    schemaVersion: PROVIDER_INFO_SCHEMA_VERSION,
    provider: target.provider,
    models,
  };
  memory.set(file, next);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    // Read-only home or full disk: the answer still applies to this process
  }
  return entry;
}
