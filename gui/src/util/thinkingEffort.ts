import type { ModeModelsConfig, ModeReasoningEffort, ModelUse } from "core";
import type { ModeModelsInput } from "core/config/yaml/saveModeModels";

/**
 * The values `modeModels.<use>.reasoningEffort` already accepts. The empty
 * one means no effort for the mode: the menu shows what the model's own
 * setting then sends (`modelSettingLabel`).
 */
export const THINKING_EFFORTS: {
  value: ModeReasoningEffort | "";
  label: string;
}[] = [
  { value: "", label: "Model setting" },
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const EFFORTS = new Set<string>(["off", "low", "medium", "high"]);

export function parseThinkingEffort(
  raw: string,
): ModeReasoningEffort | undefined {
  return EFFORTS.has(raw) ? (raw as ModeReasoningEffort) : undefined;
}

/**
 * An entry the schema will keep: a model, a list, a prompt or a tail.
 * `reasoningEffort` alone is dropped on save.
 */
function anchored(entry: ModeModelsConfig[ModelUse] | undefined): boolean {
  return !!(
    entry?.title ||
    entry?.titles?.length ||
    entry?.prompt ||
    entry?.tail
  );
}

/**
 * The Thinking menu's change: the `config/setModeModels` body (the same
 * `reasoningEffort` field the mode table writes) and the `modeModels` map to
 * show until that save reloads. A mode with no entry yet also gets the
 * selected model's name, because an effort with nothing else is not valid
 * config.
 */
export function applyThinkingEffort(
  modeModels: ModeModelsConfig | undefined,
  use: ModelUse,
  effort: ModeReasoningEffort | undefined,
  modelTitle: string | undefined,
): { modeModels: ModeModelsConfig | undefined; update: ModeModelsInput } {
  const entry = modeModels?.[use];
  const change: NonNullable<ModeModelsInput[ModelUse]> = {
    reasoningEffort: effort ?? null,
  };
  if (effort && !anchored(entry) && modelTitle) {
    change.model = modelTitle;
  }

  const nextEntry = { ...(entry ?? {}) };
  if (effort) nextEntry.reasoningEffort = effort;
  else delete nextEntry.reasoningEffort;
  if (change.model) nextEntry.title = change.model;

  const next: ModeModelsConfig = { ...(modeModels ?? {}) };
  if (
    nextEntry.title ||
    nextEntry.titles?.length ||
    nextEntry.prompt ||
    nextEntry.tail ||
    nextEntry.reasoningEffort
  ) {
    next[use] = nextEntry;
  } else {
    delete next[use];
  }
  return {
    modeModels: Object.keys(next).length > 0 ? next : undefined,
    update: { [use]: change },
  };
}
