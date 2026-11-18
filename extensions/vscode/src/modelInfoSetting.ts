import {
  modelInfoUpdatesOf,
  readModelCatalogSettings,
  saveModelCatalogSettings,
  type ModelCatalogPolicy,
  type ModelCatalogSettings,
} from "core/llm/modelCatalogStore";
import * as vscode from "vscode";

export const MODEL_INFO_UPDATES = "continuous.modelInformationUpdates";
export const MODEL_INFO_REFRESH_HOURS =
  "continuous.modelInformationRefreshHours";

type Mode = "automatic" | "manual" | "off";
const MODES: Mode[] = ["automatic", "manual", "off"];

export interface ModelInfoSettingDeps {
  read: () => ModelCatalogSettings;
  save: (change: {
    policy?: ModelCatalogPolicy;
    refreshHours?: number;
  }) => boolean;
}

const realDeps: ModelInfoSettingDeps = {
  read: () => readModelCatalogSettings(),
  save: (change) => saveModelCatalogSettings(change),
};

/**
 * Copy the VS Code settings, where the person set them in their user
 * settings, into the shared store (`modelCatalog:` and
 * `modelCatalogRefreshHours:` in the user-level config.yaml), which the IDE
 * core, JetBrains and the terminal agent all read. A setting left at its
 * default changes nothing, so a value written by the settings page or by hand
 * stays. Returns what was written.
 */
export function syncModelInfoSetting(
  mode: unknown,
  refreshHours: unknown,
  deps: ModelInfoSettingDeps = realDeps,
): { policy?: ModelCatalogPolicy; refreshHours?: number } | undefined {
  const current = deps.read();
  const change: { policy?: ModelCatalogPolicy; refreshHours?: number } = {};
  if (
    typeof mode === "string" &&
    MODES.includes(mode as Mode) &&
    modelInfoUpdatesOf(current.policy) !== mode
  ) {
    change.policy = mode === "manual" ? "ask" : (mode as ModelCatalogPolicy);
  }
  if (
    typeof refreshHours === "number" &&
    Number.isFinite(refreshHours) &&
    refreshHours > 0 &&
    refreshHours !== current.refreshHours
  ) {
    change.refreshHours = refreshHours;
  }
  if (change.policy === undefined && change.refreshHours === undefined) {
    return undefined;
  }
  return deps.save(change) ? change : undefined;
}

/** Apply the settings now and whenever they change. */
export function registerModelInfoSetting(
  context: vscode.ExtensionContext,
  deps: ModelInfoSettingDeps = realDeps,
): void {
  const apply = () => {
    const config = vscode.workspace.getConfiguration();
    try {
      syncModelInfoSetting(
        config.inspect(MODEL_INFO_UPDATES)?.globalValue,
        config.inspect(MODEL_INFO_REFRESH_HOURS)?.globalValue,
        deps,
      );
    } catch (e) {
      console.warn("Could not save the model information setting", e);
    }
  };
  apply();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(MODEL_INFO_UPDATES) ||
        e.affectsConfiguration(MODEL_INFO_REFRESH_HOURS)
      ) {
        apply();
      }
    }),
  );
}
