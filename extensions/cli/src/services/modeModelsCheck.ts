import type { ModelConfig } from "@continuedev/config-yaml";
import { appliesReasoningEffort } from "@continuedev/openai-adapters";
import type { ModelUse } from "core/index.js";
import { USE_FALLBACK } from "core/util/modelUse.js";

/**
 * What the CLI skips in a config's `modeModels` without a word (ROADMAP
 * M8): a name that matches no model, a name that is not a chat model, and a
 * `reasoningEffort` the CLI does not send. Pure, so the messages can be
 * tested; ModelService shows them once per config load.
 *
 * Only the CLI's reading is checked. The IDE reads the same entries its own
 * way (core's resolveModeModels reports unknown names there, and it maps an
 * effort to completion options per provider), so none of this goes to the
 * IDE's config errors.
 */

/** One `modeModels` entry as written. */
interface Entry {
  model?: string;
  models?: string[];
  reasoningEffort?: string;
}

/** The uses whose entry switches the CLI's chat model (ModelService.switchToModelForUse). */
const SWITCHING_USES = ["plan", "agent", "loop", "replan"] as const;

const nameOf = (m: ModelConfig) => String(m.name ?? m.model);
const isChat = (m: ModelConfig) =>
  m.roles === undefined || m.roles.includes("chat");

/** The name the CLI reads from an entry: `model`, else the first of `models`. */
const cliName = (entry: Entry | undefined) =>
  entry?.model ?? entry?.models?.[0];

/** The model an effort applies to: the entry's own, else its fallback's. */
function modelNameFor(
  modeModels: Record<string, Entry | undefined>,
  use: ModelUse,
): string | undefined {
  const own = cliName(modeModels[use]);
  if (own) return own;
  const fallback = USE_FALLBACK[use];
  return fallback ? cliName(modeModels[fallback]) : undefined;
}

export function checkModeModelsForCli(
  modeModels: Record<string, Entry | undefined> | undefined,
  models: ModelConfig[],
): string[] {
  if (!modeModels) return [];
  const warnings: string[] = [];
  const find = (name: string) => models.find((m) => nameOf(m) === name);

  for (const use of SWITCHING_USES) {
    const entry = modeModels[use];
    if (!entry) continue;
    const name = cliName(entry);
    if (name) {
      const model = find(name);
      if (!model) {
        warnings.push(
          `modeModels.${use}: no model is named "${name}", so the CLI does not switch models for ${use}.`,
        );
      } else if (!isChat(model)) {
        warnings.push(
          `modeModels.${use}: "${name}" is not a chat model (roles: ${(model.roles ?? []).join(", ") || "none"}), so the CLI does not switch to it for ${use}.`,
        );
      }
    }

    const effort = entry.reasoningEffort;
    if (!effort) continue;
    if (effort === "off") {
      warnings.push(
        `modeModels.${use}: reasoningEffort "off" is not applied by the CLI: there is no request field that turns reasoning off for every provider, so the model's own setting stays.`,
      );
      continue;
    }
    const target = modelNameFor(modeModels, use);
    const model = target ? find(target) : undefined;
    if (model && isChat(model) && !appliesReasoningEffort(model.provider)) {
      warnings.push(
        `modeModels.${use}: reasoningEffort "${effort}" is not applied to "${target}": the CLI's ${model.provider} adapter sends no reasoning field.`,
      );
    }
  }

  const reviewer = modeModels.reviewer;
  if (reviewer?.model && !find(reviewer.model)) {
    warnings.push(
      `modeModels.reviewer: no model is named "${reviewer.model}", so --auto-review asks the first model with the reviewer role.`,
    );
  }
  if (reviewer?.reasoningEffort) {
    warnings.push(
      `modeModels.reviewer: reasoningEffort "${reviewer.reasoningEffort}" is not applied by the CLI's reviewer; a catalog variant (Name#variant) sets the reviewer's effort there.`,
    );
  }
  return warnings;
}
