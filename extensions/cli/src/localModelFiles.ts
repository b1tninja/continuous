import * as fs from "fs";
import * as path from "path";

import {
  CatalogModel,
  modelsFileSchema,
  ProviderInstance,
  providersFileSchema,
} from "@continuedev/config-yaml";
import {
  decideFromFiles,
  readScopeFilesFromDisk,
} from "core/config/projectTrust.js";
import type { ProjectConfigScope } from "core/config/projectTrust.js";
import * as YAML from "yaml";

import { env } from "./env.js";
import { isSafeMode } from "./safeMode.js";
import { logger } from "./util/logger.js";

function readYaml(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    logger.warn(`Could not read ${file}: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * Workspace files are applied only after this project is trusted for them,
 * and a name from the user's own file is kept. `.continue` is read before
 * `.continuous`, so the newer file wins on a name the user does not have.
 */
function workspaceFirst(files: { path: string }[]): { path: string }[] {
  return [...files].sort((a, b) => {
    const aLegacy = a.path.includes(`${path.sep}.continue${path.sep}`);
    const bLegacy = b.path.includes(`${path.sep}.continue${path.sep}`);
    if (aLegacy !== bLegacy) return aLegacy ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

function workspaceFilesTrusted(
  cwd: string,
  scope: ProjectConfigScope,
): { path: string; content: string }[] {
  // --safe: the project's files are not read, trusted or not
  if (isSafeMode()) return [];
  const files = readScopeFilesFromDisk(cwd, scope);
  if (files.length === 0) return [];
  const decision = decideFromFiles(cwd, scope, files);
  if (decision.trusted)
    return workspaceFirst(files) as { path: string; content: string }[];
  logger.warn(
    `This project's ${scope === "providers" ? "providers.yaml" : "models.yaml"} is not trusted, so it was not loaded. Run \`continuous project trust\` or pass --trust-project-config.`,
  );
  return [];
}

/**
 * The provider accounts (providers.yaml) and model catalog (models.yaml) the
 * IDE uses, so a config's `connection:` and `from:` models work in `cn` too.
 * The user's file wins a shared name. A project file is used only when that
 * project is trusted, and only for a name the user does not already have.
 * A file that does not parse is skipped with a warning.
 */
export function loadLocalModelFiles(cwd: string = process.cwd()): {
  providers: ProviderInstance[];
  catalog: CatalogModel[];
} {
  const providers = new Map<string, ProviderInstance>();
  const globalProviders = path.join(env.continueHome, "providers.yaml");
  const globalProviderNames = new Set<string>();
  const globalProviderRaw = readYaml(globalProviders);
  if (globalProviderRaw !== undefined) {
    const parsed = providersFileSchema.safeParse(globalProviderRaw);
    if (parsed.success) {
      for (const provider of parsed.data.providers) {
        providers.set(provider.name, provider);
        globalProviderNames.add(provider.name);
      }
    } else {
      logger.warn(
        `${globalProviders} is not valid; its providers were skipped`,
      );
    }
  }
  for (const file of workspaceFilesTrusted(cwd, "providers")) {
    const raw = readYaml(file.path);
    if (raw === undefined) continue;
    const parsed = providersFileSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(`${file.path} is not valid; its providers were skipped`);
      continue;
    }
    for (const provider of parsed.data.providers) {
      if (globalProviderNames.has(provider.name)) {
        logger.warn(
          `Kept your provider "${provider.name}" and did not use the one from this project.`,
        );
        continue;
      }
      providers.set(provider.name, provider);
    }
  }

  const catalog = new Map<string, CatalogModel>();
  const globalModels = path.join(env.continueHome, "models.yaml");
  const globalModelNames = new Set<string>();
  const globalModelRaw = readYaml(globalModels);
  if (globalModelRaw !== undefined) {
    const parsed = modelsFileSchema.safeParse(globalModelRaw);
    if (parsed.success) {
      for (const model of parsed.data.models) {
        if (model.name.includes("#")) continue;
        catalog.set(model.name, model);
        globalModelNames.add(model.name);
      }
    } else {
      logger.warn(`${globalModels} is not valid; its models were skipped`);
    }
  }
  for (const file of workspaceFilesTrusted(cwd, "catalog")) {
    const raw = readYaml(file.path);
    if (raw === undefined) continue;
    const parsed = modelsFileSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(`${file.path} is not valid; its models were skipped`);
      continue;
    }
    for (const model of parsed.data.models) {
      if (model.name.includes("#")) continue;
      if (globalModelNames.has(model.name)) {
        logger.warn(
          `Kept your model "${model.name}" and did not use the one from this project.`,
        );
        continue;
      }
      catalog.set(model.name, model);
    }
  }

  return {
    providers: Array.from(providers.values()),
    catalog: Array.from(catalog.values()),
  };
}
