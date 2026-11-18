import fs from "node:fs";
import * as YAML from "yaml";
import { editConfigYamlFile, getConfigYamlPath } from "../../../util/paths";
import {
  DEFAULT_SHADOW_TIMEOUT_MS,
  MAX_SHADOW_BUDGET_USD,
  MAX_SHADOW_TIMEOUT_MS,
  MIN_SHADOW_TIMEOUT_MS,
} from "./shadowLimits";

export { MAX_SHADOW_BUDGET_USD, MIN_SHADOW_TIMEOUT_MS };

/**
 * The Settings page's way to change `audit.shadowReviewer` (ROADMAP B67).
 *
 * The switch is read from the person's own config.yaml and nowhere else
 * (shadowSettings.ts), so it is written there and nowhere else: always
 * `getConfigYamlPath()`, never the selected assistant or a workspace file, and
 * only the three keys of this one block. Everything else in the file, comments
 * and key order included, goes through `editYamlText`, which edits the parsed
 * document instead of re-serialising it. The file must already exist and
 * parse; a file that does not is refused, not rewritten.
 */

export interface ShadowForm {
  enabled: boolean;
  budgetUsd?: number;
  timeoutMs: number;
}

export interface ShadowChange {
  enabled?: boolean;
  budgetUsd?: number;
  timeoutMs?: number;
}

export type ShadowChangeCheck =
  { ok: true; change: ShadowChange } | { ok: false; error: string };

/** What the page shows, including values saved while it is off. */
export function shadowFormFromYaml(text: string): ShadowForm {
  let raw: any;
  try {
    raw = YAML.parse(text)?.audit?.shadowReviewer;
  } catch {
    raw = undefined;
  }
  const budget = raw?.budgetUsd;
  const t = raw?.timeoutMs;
  return {
    enabled: raw?.enabled === true,
    ...(typeof budget === "number" && Number.isFinite(budget) && budget > 0
      ? { budgetUsd: budget }
      : {}),
    timeoutMs:
      typeof t === "number" && Number.isFinite(t) && t > 0
        ? Math.min(t, MAX_SHADOW_TIMEOUT_MS)
        : DEFAULT_SHADOW_TIMEOUT_MS,
  };
}

export function readShadowForm(file: string = getConfigYamlPath()): ShadowForm {
  try {
    return shadowFormFromYaml(fs.readFileSync(file, "utf8"));
  } catch {
    return { enabled: false, timeoutMs: DEFAULT_SHADOW_TIMEOUT_MS };
  }
}

function checkBudget(v: unknown): { value: number } | { error: string } {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v <= 0 ||
    v > MAX_SHADOW_BUDGET_USD
  ) {
    return {
      error: `The budget must be more than 0 and at most ${MAX_SHADOW_BUDGET_USD} dollars.`,
    };
  }
  // Hundredths of a cent are plenty; a longer tail is noise in the file
  const value = Math.round(v * 10_000) / 10_000;
  return value > 0
    ? { value }
    : { error: "The budget must be at least 0.0001 dollars." };
}

/**
 * Check what the page sent. Named fields only: nothing else it sends is
 * looked at. A budget is a finite number above zero and at most
 * MAX_SHADOW_BUDGET_USD; a timeout is whole milliseconds in range.
 */
export function checkShadowChange(input: unknown): ShadowChangeCheck {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Nothing to save." };
  }
  const { enabled, budgetUsd, timeoutMs } = input as Record<string, unknown>;
  const change: ShadowChange = {};
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") {
      return { ok: false, error: "On or off must be true or false." };
    }
    change.enabled = enabled;
  }
  if (budgetUsd !== undefined) {
    const b = checkBudget(budgetUsd);
    if ("error" in b) return { ok: false, error: b.error };
    change.budgetUsd = b.value;
  }
  if (timeoutMs !== undefined) {
    if (
      typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_SHADOW_TIMEOUT_MS ||
      timeoutMs > MAX_SHADOW_TIMEOUT_MS
    ) {
      return {
        ok: false,
        error: `The timeout must be between ${MIN_SHADOW_TIMEOUT_MS} and ${MAX_SHADOW_TIMEOUT_MS} milliseconds.`,
      };
    }
    change.timeoutMs = timeoutMs;
  }
  if (Object.keys(change).length === 0) {
    return { ok: false, error: "Nothing to save." };
  }
  return { ok: true, change };
}

export type ShadowWriteResult =
  | { result: "saved"; form: ShadowForm }
  | { result: "unchanged"; form: ShadowForm }
  | { result: "refused"; error: string };

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Write a checked change. Enabling needs a budget, from the change or already
 * in the file: a switch with no cap would run nothing, so the page is told
 * instead of saving a switch that does nothing.
 */
export function writeShadowChange(
  change: ShadowChange,
  file: string = getConfigYamlPath(),
): ShadowWriteResult {
  const before = readShadowForm(file);
  if (
    change.enabled === true &&
    (change.budgetUsd ?? before.budgetUsd) === undefined
  ) {
    return { result: "refused", error: "Set a budget before turning it on." };
  }
  let problem: string | undefined;
  const res = editConfigYamlFile(file, (config) => {
    const audit = (config as Record<string, unknown>).audit;
    if (audit !== undefined && !isMap(audit)) {
      problem =
        "`audit` in config.yaml is not a mapping, so it was left alone.";
      return config;
    }
    const block = audit?.shadowReviewer;
    if (block !== undefined && !isMap(block)) {
      problem =
        "`audit.shadowReviewer` in config.yaml is not a mapping, so it was left alone.";
      return config;
    }
    // Switching off when nothing is saved has nothing to write
    const offOnly =
      change.enabled === false &&
      change.budgetUsd === undefined &&
      change.timeoutMs === undefined;
    if (block === undefined && offOnly) return config;
    const next: Record<string, unknown> = { ...block };
    if (change.enabled !== undefined) next.enabled = change.enabled;
    if (change.budgetUsd !== undefined) next.budgetUsd = change.budgetUsd;
    if (change.timeoutMs !== undefined) next.timeoutMs = change.timeoutMs;
    return {
      ...config,
      audit: { ...audit, shadowReviewer: next },
    } as typeof config;
  });
  if (problem) return { result: "refused", error: problem };
  if (!res.ok) return { result: "refused", error: res.error };
  const form = readShadowForm(file);
  return { result: res.changed ? "saved" : "unchanged", form };
}
