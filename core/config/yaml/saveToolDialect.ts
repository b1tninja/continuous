import type { ConfigYaml, ToolDialectSetting } from "@continuedev/config-yaml";
import { editConfigFile } from "../../util/paths";

/**
 * The name the picker shows for a models entry. A `from:` reference takes its
 * name from the catalog (`from` itself, unless the entry sets `name`), which
 * is the title the notice sends.
 */
function shownName(m: any): string | undefined {
  if (!m || typeof m !== "object") return undefined;
  if (typeof m.from === "string") {
    return typeof m.name === "string" ? m.name : m.from;
  }
  return typeof m.name === "string" ? m.name : undefined;
}

/**
 * Set `toolDialect` on the model named `name` in a config.yaml object, or
 * return the config as it is when no model entry has that name (a model that
 * comes from a hub block or a `uses:` entry cannot be edited here). A `from:`
 * entry is the model the picker shows, so the setting is written on it and
 * the catalog merge keeps it.
 */
export function applyToolDialect(
  config: ConfigYaml,
  name: string,
  toolDialect: ToolDialectSetting,
): ConfigYaml {
  const models = config.models;
  if (!Array.isArray(models)) return config;
  let found = false;
  const next = models.map((m: any) => {
    if (shownName(m) === name) {
      found = true;
      return { ...m, toolDialect };
    }
    return m;
  });
  return found ? ({ ...config, models: next } as ConfigYaml) : config;
}

/**
 * Write the setting to the selected config.yaml, keeping comments and key
 * order. False when there was no local YAML file or no model of that name.
 */
export function saveToolDialect(
  name: string,
  toolDialect: ToolDialectSetting,
): boolean {
  let saved = false;
  editConfigFile(
    (config) => config,
    (config) => {
      const next = applyToolDialect(config, name, toolDialect);
      saved = next !== config;
      return next;
    },
  );
  return saved;
}
