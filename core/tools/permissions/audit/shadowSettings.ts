import fs from "node:fs";
import * as YAML from "yaml";
import { getConfigYamlPath } from "../../../util/paths";
import {
  DEFAULT_SHADOW_TIMEOUT_MS,
  MAX_SHADOW_TIMEOUT_MS,
} from "./shadowLimits";

/**
 * Shadow mode for the reviewer (ROADMAP B16): `audit.shadowReviewer` in the
 * person's OWN user-level config.yaml. It spends money and sends tool-call
 * text to a model, so it is read from that one file and nowhere else: not from
 * the loaded assistant, a hub block or a workspace file, and no environment
 * variable turns it on. It runs only when `enabled: true` and a dollar budget
 * is set; anything else is off.
 *
 *     audit:
 *       shadowReviewer:
 *         enabled: true
 *         budgetUsd: 0.25     # all shadow reviews kept in the audit trail
 *         timeoutMs: 5000    # a slower review is dropped
 */
export interface ShadowSettings {
  /** The most the shadow reviews recorded in the retained trail may cost, in USD */
  budgetUsd: number;
  timeoutMs: number;
}

export { DEFAULT_SHADOW_TIMEOUT_MS, MAX_SHADOW_TIMEOUT_MS };

/** The settings in a config.yaml text; undefined means off. */
export function shadowSettingsFromYaml(
  text: string,
): ShadowSettings | undefined {
  let raw: any;
  try {
    raw = YAML.parse(text)?.audit?.shadowReviewer;
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || raw.enabled !== true) return undefined;
  const budget = raw.budgetUsd;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return undefined;
  }
  const t = raw.timeoutMs;
  const timeoutMs =
    typeof t === "number" && Number.isFinite(t) && t > 0
      ? Math.min(t, MAX_SHADOW_TIMEOUT_MS)
      : DEFAULT_SHADOW_TIMEOUT_MS;
  return { budgetUsd: budget, timeoutMs };
}

/** Read the user's own config.yaml; a missing or unreadable file is off. */
export function readShadowSettings(
  file: string = getConfigYamlPath(),
): ShadowSettings | undefined {
  try {
    return shadowSettingsFromYaml(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
