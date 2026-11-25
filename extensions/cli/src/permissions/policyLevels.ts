import type { LoopAutonomy } from "core/index.js";
import type { ApprovalSettings } from "core/tools/permissions/approval.js";
import {
  DEFAULT_POLICY_LEVELS,
  isDeprecatedLevelSpelling,
  levelsOfArea,
  parsePolicyLevel,
  parseWebLevel,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_LEVEL_DESCRIPTIONS,
  POLICY_LEVELS,
  POLICY_PRESET_ORDER,
  POLICY_PRESETS,
  policyLevelLabel,
  presetOf,
  WEB_LEVELS,
  type PolicyArea,
  type PolicyLevel,
  type PolicyLevels,
  type PolicyPresetName,
} from "core/tools/permissions/policy.js";
import { builtinForPreset } from "core/tools/permissions/safetyDegrees.js";
import {
  readPolicyFile,
  writePolicyFile,
  type PolicyFileSettings,
  type PolicyFileUpdate,
} from "core/tools/permissions/settingsFile.js";
import {
  effectiveWebLevel,
  WEB_AREA_LABEL,
  WEB_LEVEL_DESCRIPTIONS,
  webLevelLabel,
} from "core/tools/permissions/webPolicy.js";

import { capAtDefaults, isSafeMode } from "../safeMode.js";

import { isAutoReviewEnabled } from "./coreRules.js";
import { PERMISSIONS_YAML_PATH } from "./permissionsYamlLoader.js";
import type { PermissionMode } from "./types.js";

/**
 * The level chosen for each policy area (plans/policy-areas.md), for this
 * process. The IDE keeps the same five levels in its own settings; the CLI
 * sets them with `--policy` and `/policy`.
 */
let levels: PolicyLevels = { ...DEFAULT_POLICY_LEVELS };

/** The rest of the settings file: switches, floor, plan limit, question lists. */
let extras: Omit<PolicyFileSettings, "levels"> = {};

/** `--allow`, `--ask` and `--exclude` for this process, so a loop worker can use them. */
let commandFlags: { allow?: string[]; ask?: string[]; exclude?: string[] } = {};

export function setCommandPermissionFlags(flags: {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
}): void {
  commandFlags = {
    ...(flags.allow?.length ? { allow: [...flags.allow] } : {}),
    ...(flags.ask?.length ? { ask: [...flags.ask] } : {}),
    ...(flags.exclude?.length ? { exclude: [...flags.exclude] } : {}),
  };
}

export function getCommandPermissionFlags(): {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
} {
  return {
    ...(commandFlags.allow ? { allow: [...commandFlags.allow] } : {}),
    ...(commandFlags.ask ? { ask: [...commandFlags.ask] } : {}),
    ...(commandFlags.exclude ? { exclude: [...commandFlags.exclude] } : {}),
  };
}

export function getPolicyExtras(): Omit<PolicyFileSettings, "levels"> {
  return extras;
}

/**
 * Reads ~/.continue/permissions.yaml (shared with the IDE) into this process.
 * Returns what could not be used, for a warning. Levels set on the command
 * line afterwards win.
 */
export function loadPolicyFile(file: string = PERMISSIONS_YAML_PATH): string[] {
  const { settings, notices } = readPolicyFile(file);
  const { levels: fileLevels, ...rest } = settings;
  levels = isSafeMode() ? capAtDefaults(fileLevels) : { ...fileLevels };
  extras = rest;
  return notices;
}

/** Writes the levels and the other settings back to the file. */
export function savePolicyFile(
  file: string = PERMISSIONS_YAML_PATH,
  // `web` always given, so a Web level cleared here (a preset) is cleared there
  update: PolicyFileUpdate = {
    levels: { ...levels, web: levels.web },
    ...(extras.builtin ? { builtin: extras.builtin } : {}),
  },
): void {
  writePolicyFile(file, update);
}

export function getPolicyLevels(): PolicyLevels {
  return { ...levels };
}

/** The switches of a preset chosen with `--policy <preset>` or `/policy <preset>`. */
export function setPolicyBuiltin(
  builtin: PolicyFileSettings["builtin"] | undefined,
): void {
  extras = { ...extras, builtin };
}

/** Applies a preset the way `/policy <preset>` does: its levels and its safety checks. */
export function applyPolicyPreset(name: PolicyPresetName): void {
  setPolicyLevels({ ...POLICY_PRESETS[name].levels });
  setPolicyBuiltin(builtinForPreset(name));
}

export function setPolicyLevels(next: PolicyLevels): void {
  // --safe: no area looser than its default, whatever --policy or /policy say
  levels = isSafeMode() ? capAtDefaults(next) : { ...next };
}

export function resetPolicyLevels(): void {
  levels = { ...DEFAULT_POLICY_LEVELS };
  extras = {};
  commandFlags = {};
}

/**
 * What core's engine is given besides the levels. `--auto` is the IDGAF
 * preset for this run: Permissive on the tool areas and no safety check on.
 * That lasts for the run only, so it is added here and never written to the
 * file. Every other mode uses the switches the file and the flags set.
 */
export function approvalExtras(
  mode?: PermissionMode,
): Pick<ApprovalSettings, "builtin" | "floor"> {
  const builtin =
    mode === "auto"
      ? { ...(extras.builtin ?? {}), ...builtinForPreset("idgaf") }
      : extras.builtin;
  return {
    ...(builtin ? { builtin } : {}),
    ...(extras.floor?.length ? { floor: extras.floor } : {}),
  };
}

/**
 * True when nothing here changes what the CLI does on its own, so core's
 * engine need not run for a call that has no rules.
 */
export function policyIsDefault(
  l: PolicyLevels,
  mode?: PermissionMode,
): boolean {
  const extra = approvalExtras(mode);
  return (
    toolLevelsAreDefault(l) &&
    // A Web level of its own changes what a fetch does (WB45)
    l.web === undefined &&
    !extra.floor &&
    !Object.values(extra.builtin ?? {}).includes(false)
  );
}

const TOOL_AREAS: readonly PolicyArea[] = ["context", "tools", "edits"];

/**
 * The levels in force. The CLI's `auto` mode (`--auto`) allowed everything,
 * which is the IDGAF preset: Permissive on the three tool areas (its switches
 * are added by approvalExtras) and a plan that goes on; and
 * `--auto-review` hands what a rule leaves open to the reviewer, which is
 * Automatic wherever the level is Cautious. A level the person set higher
 * than that is kept.
 */
export function effectiveLevels(mode: PermissionMode): PolicyLevels {
  const result = { ...levels };
  if (mode === "auto") {
    for (const area of TOOL_AREAS) result[area] = "permissive";
    if (result.plan === "manual" || result.plan === "cautious") {
      result.plan = "permissive";
    }
  } else if (isAutoReviewEnabled()) {
    for (const area of TOOL_AREAS) {
      if (result[area] === "cautious") result[area] = "automatic";
    }
    // Web, when set apart from Tool use, follows the same rule
    if (result.web === "cautious") result.web = "automatic";
  }
  return result;
}

/**
 * True when the three tool areas are as the CLI has always behaved (the
 * tool's own setting and the user's rules decide), so core's engine need not
 * run for a call that has no rules.
 */
export function toolLevelsAreDefault(l: PolicyLevels): boolean {
  return TOOL_AREAS.every((a) => l[a] === DEFAULT_POLICY_LEVELS[a]);
}

const AREA_KEYS: Record<string, PolicyArea> = {
  context: "context",
  tools: "tools",
  tool: "tools",
  edits: "edits",
  edit: "edits",
  plan: "plan",
  plans: "plan",
  questions: "questions",
  question: "questions",
};

/** `web=<level>` (WB45): the sixth area, with Off and Listed of its own. */
const WEB_KEYS = new Set(["web"]);

/** `yolo` is the old name of the IDGAF preset: still read. */
const DEPRECATED_PRESET = "yolo";

function toLevel(word: string): PolicyLevel | undefined {
  return parsePolicyLevel(word);
}

export type PolicySpecResult =
  | {
      ok: true;
      levels: PolicyLevels;
      /** A preset also sets the safety checks; absent for levels given one by one */
      builtin?: ReturnType<typeof builtinForPreset>;
      /** The old spelling was used (`yolo`): the caller says so on stderr */
      deprecated?: string;
    }
  | { ok: false; error: string };

/** The one line printed (on stderr) when a spec used the old name. */
export const YOLO_DEPRECATION_NOTE =
  '"yolo" is now called "idgaf"; the old name still works for now.';

/**
 * A preset name (`careful`, `acceptEdits`, `handsOff`, `reviewer`, `idgaf`),
 * or area=level pairs separated by commas or spaces, applied on top of
 * `from`: `tools=permissive,plan=manual`. A bare level sets every area.
 */
export function parsePolicySpec(
  spec: string,
  from: PolicyLevels = levels,
): PolicySpecResult {
  const text = spec.trim();
  if (!text) return { ok: false, error: "Nothing to set." };
  const lowered = text.toLowerCase();
  const preset = POLICY_PRESET_ORDER.find(
    (p) =>
      p.toLowerCase() === (lowered === DEPRECATED_PRESET ? "idgaf" : lowered),
  );
  if (preset) {
    return {
      ok: true,
      // A preset sets Web too: absent, Web follows Tool use, which is the
      // preset's own Web level (POLICY_PRESET_WEB), and a Web level set
      // before is cleared (savePolicyFile writes its absence)
      levels: { ...POLICY_PRESETS[preset].levels },
      builtin: builtinForPreset(preset),
      ...(lowered === DEPRECATED_PRESET
        ? { deprecated: YOLO_DEPRECATION_NOTE }
        : {}),
    };
  }

  const next = { ...from };
  let deprecated: string | undefined;
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const [key, value, ...rest] = part.split("=");
    if (value === undefined) {
      const level = toLevel(key);
      if (isDeprecatedLevelSpelling(key)) deprecated = YOLO_DEPRECATION_NOTE;
      if (!level) {
        return {
          ok: false,
          error: `"${part}" is not a preset, a level or area=level. Presets: ${POLICY_PRESET_ORDER.join(", ")}.`,
        };
      }
      // A bare level sets every area it is a level of: Delegate is Questions' only
      if (POLICY_AREAS.some((area) => !levelsOfArea(area).includes(level))) {
        return {
          ok: false,
          error: `"${level}" is a level of Questions only. Use questions=${level}.`,
        };
      }
      for (const area of POLICY_AREAS) next[area] = level;
      // Web follows Tool use, so it is at this level too
      delete next.web;
      continue;
    }
    if (WEB_KEYS.has(key.trim().toLowerCase())) {
      const web = parseWebLevel(value);
      if (isDeprecatedLevelSpelling(value)) deprecated = YOLO_DEPRECATION_NOTE;
      if (rest.length || !web) {
        return {
          ok: false,
          error: `"${value}" is not a Web level. Levels: ${WEB_LEVELS.join(", ")}.`,
        };
      }
      next.web = web;
      continue;
    }
    const area = AREA_KEYS[key.trim().toLowerCase()];
    const level = toLevel(value);
    if (isDeprecatedLevelSpelling(value)) deprecated = YOLO_DEPRECATION_NOTE;
    if (rest.length || !area) {
      return {
        ok: false,
        error: `"${part}": the areas are ${[...POLICY_AREAS, "web"].join(", ")}.`,
      };
    }
    if (level && !levelsOfArea(area).includes(level)) {
      return {
        ok: false,
        error: `"${value}" is a level of Questions only, not of ${key}.`,
      };
    }
    if (!level) {
      const webOnly = parseWebLevel(value);
      return {
        ok: false,
        error: webOnly
          ? `"${value}" is a Web level only (web=${webOnly}). Levels for ${key}: ${POLICY_LEVELS.join(", ")}.`
          : `"${value}" is not a level. Levels: ${POLICY_LEVELS.join(", ")} (yolo is the old name of idgaf).`,
      };
    }
    next[area] = level;
  }
  return { ok: true, levels: next, ...(deprecated ? { deprecated } : {}) };
}

/** The five levels and what each means, for `/policy`. */
export function describePolicy(l: PolicyLevels): string[] {
  const preset = presetOf(l);
  const lines = [
    `Preset: ${preset ? POLICY_PRESETS[preset].label : "Custom"}`,
    "",
    "Level of each area:",
  ];
  for (const area of POLICY_AREAS) {
    lines.push(
      `  ${POLICY_AREA_LABELS[area].padEnd(12)} ${policyLevelLabel(area, l[area]).padEnd(10)} ${POLICY_LEVEL_DESCRIPTIONS[area][l[area]]}`,
    );
  }
  const web = effectiveWebLevel(l);
  lines.push(
    `  ${WEB_AREA_LABEL.padEnd(12)} ${webLevelLabel(web.level).padEnd(10)} ${WEB_LEVEL_DESCRIPTIONS[web.level]}${web.source === "tools" ? " (follows Tool use)" : ""}`,
  );
  lines.push(
    "",
    "A preset sets all five levels at once. Rules (Never, Ask, Always) are listed with `continuous permissions list`; they and the built-in rules apply before the level.",
  );
  return lines;
}

/**
 * The Plan edits and Questions levels the old loop autonomy names stood for,
 * so a caller that still names a level (the TUI's cycle key, `loopAutonomy`
 * on `cn serve`) moves the two policy areas.
 */
export function levelsForAutonomy(
  autonomy: LoopAutonomy,
): Pick<PolicyLevels, "plan" | "questions"> {
  switch (autonomy) {
    case "supervised":
      return { plan: "manual", questions: "manual" };
    case "auto":
      return { plan: "cautious", questions: "cautious" };
    case "unattended":
      return { plan: "permissive", questions: "cautious" };
    case "idgaf":
      // Questions: the agent decides everything (Delegate), as IDGAF did there
      return { plan: "permissive", questions: "delegate" };
  }
}
