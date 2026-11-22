import type { ModeModelsConfig, ModelDescription } from "core";
import { DEFAULT_REASONING_BUDGET } from "core/config/modelEdit/modelEditFields";
import { modelSupportsReasoning } from "core/llm/autodetect";
import { budgetTokensToEffort } from "core/llm/llms/anthropicThinking";
import { promptProfile } from "core/llm/prompts/turns";
import {
  isPromptProfile,
  promptChoiceFor,
  tailFor,
} from "core/llm/prompts/usePrompts";
import { USE_FALLBACK } from "core/util/modelUse";
import type { ModeDrafts, TableMode } from "./modeModelsDraft";

/**
 * What the "not set" choice of the per-mode table and of the chat toolbar's
 * Thinking menu does, in words, from the functions the requests use.
 */

/**
 * With no model starred for a mode the model id is not known here, so the
 * choice says only that it is not set; the table's text gives the rule.
 */
const NOT_SET = "Not set";

/** With no effort for the mode, the model's own reasoning setting is sent. */
export const EFFORT_NOT_SET = "the model's setting";

const PROFILE_LABEL = { full: "Full", short: "Short", tailored: "Tailored" };

/** The draft as the resolved `modeModels` the prompt functions read. */
function draftAsModeModels(
  drafts: ModeDrafts,
  blocks: readonly string[],
): ModeModelsConfig {
  const out: ModeModelsConfig = {};
  for (const [mode, draft] of Object.entries(drafts) as [
    TableMode,
    ModeDrafts[TableMode],
  ][]) {
    out[mode] = {
      ...(draft.defaultTitle ? { title: draft.defaultTitle } : {}),
      ...(draft.prompt
        ? {
            prompt: draft.prompt,
            // A loaded prompt block; a name that matches none is ignored
            ...(!isPromptProfile(draft.prompt) && blocks.includes(draft.prompt)
              ? { promptText: "" }
              : {}),
          }
        : {}),
      ...(draft.tail !== undefined ? { tail: draft.tail } : {}),
    };
  }
  return out;
}

/** The id of the model a mode runs on: its starred one, else its fallback's. */
function modelIdFor(
  mode: TableMode,
  drafts: ModeDrafts,
  models: readonly Pick<ModelDescription, "title" | "model">[],
): string | undefined {
  const fallback = USE_FALLBACK[mode] as TableMode | undefined;
  const title =
    drafts[mode].defaultTitle ??
    (fallback ? drafts[fallback]?.defaultTitle : undefined);
  return title ? models.find((m) => m.title === title)?.model : undefined;
}

/**
 * The Prompt choice of a mode when none is set: the fallback mode's choice
 * (Loop takes Agent's, Re-plan takes Plan's), else the text the model id
 * selects (core/llm/prompts/turns.ts `promptProfile`).
 */
export function promptNotSetLabel(
  mode: TableMode,
  drafts: ModeDrafts,
  models: readonly Pick<ModelDescription, "title" | "model">[],
  /** The names of the loaded prompt blocks. */
  blocks: readonly string[] = [],
): string {
  // The empty choice: what holds once this mode's own prompt is gone
  const unset = { ...drafts, [mode]: { ...drafts[mode], prompt: undefined } };
  const choice = promptChoiceFor(draftAsModeModels(unset, blocks), mode);
  if (choice?.text !== undefined) {
    // Only a fallback can supply a block here: this mode has no prompt
    return `Not set: as ${USE_FALLBACK[mode] === "plan" ? "Plan" : "Agent"}`;
  }
  if (choice?.profile) return `Not set: ${PROFILE_LABEL[choice.profile]}`;
  const id = modelIdFor(mode, drafts, models);
  return id ? `Not set: ${PROFILE_LABEL[promptProfile(id)]}` : NOT_SET;
}

/**
 * The Reminder of a mode when none is set: on or off, as `tailFor` decides
 * (on for Loop items and for a model on the short or tailored text).
 */
export function reminderNotSetLabel(
  mode: TableMode,
  drafts: ModeDrafts,
  models: readonly Pick<ModelDescription, "title" | "model">[],
  /** The names of the loaded prompt blocks. */
  blocks: readonly string[] = [],
): string {
  const unset = { ...drafts, [mode]: { ...drafts[mode], tail: undefined } };
  const modeModels = draftAsModeModels(unset, blocks);
  const id = modelIdFor(mode, drafts, models);
  if (!id && mode !== "loop" && !promptChoiceFor(modeModels, mode)) {
    return NOT_SET;
  }
  // Chat has no built-in line, so "on" adds nothing there either
  return tailFor(modeModels, mode, id) ? "Not set: on" : "Not set: off";
}

/**
 * The Thinking menu's empty choice: what the model's own setting sends.
 * "Model setting (medium)" for a reasoning model with the 2,048 token
 * budget, "(off)" when the model or the session turned reasoning off.
 * `compact` is for a toolbar with no room: "(med)", "(off)".
 */
export function modelSettingLabel(
  model: ModelDescription | null | undefined,
  sessionReasoning: boolean | undefined,
  compact = false,
): string {
  // Compact is the level alone, in brackets, and no wider than "Medium":
  // the menu is as wide as its longest choice, and the model name beside
  // it gives up the room
  const label = (level: string) =>
    compact
      ? `(${level === "medium" ? "med" : level})`
      : `Model setting (${level})`;
  if (!model) return compact ? "Model" : "Model setting";
  const on =
    sessionReasoning ??
    (modelSupportsReasoning(model) &&
      model.completionOptions?.reasoning !== false);
  if (!on) return label("off");
  // Ollama takes no budget, so there is no level to name
  if (model.underlyingProviderName === "ollama") return label("on");
  const budget =
    model.completionOptions?.reasoningBudgetTokens ?? DEFAULT_REASONING_BUDGET;
  return label(budgetTokensToEffort(budget));
}
