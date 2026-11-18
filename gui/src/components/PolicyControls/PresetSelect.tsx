import {
  AdjustmentsHorizontalIcon,
  ArrowUturnLeftIcon,
  BoltIcon,
  CheckBadgeIcon,
  CheckIcon,
  ChevronDownIcon,
  ForwardIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import {
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_LEVELS,
  POLICY_PRESET_ORDER,
  POLICY_PRESETS,
  policyLevelLabel,
  presetOf,
  type PolicyLevel,
  type PolicyLevels,
  type PolicyPresetName,
} from "core/tools/permissions/policy";
import type { StoredCustomSet } from "core/tools/permissions/settingsFile";
import { useEffect, useId, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { applyPolicyPreset } from "../../redux/thunks/policySettings";
import { customPolicyRoute } from "../../util/navigation";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "../ui";
import { CHIP, LEVEL_TONES, IDGAF_SENTENCE } from "./levelStyle";

type Glyph = typeof BoltIcon;

/**
 * One glyph per preset, so the chip reads without its text. They are not the
 * level glyphs: Accept edits and Hands off both end up at Permissive, and a
 * preset is a bundle of five levels rather than one of them. Custom has the
 * sliders, which is what it is: levels set one by one.
 */
export const PRESET_GLYPHS: Record<PolicyPresetName | "custom", Glyph> = {
  careful: ShieldCheckIcon,
  acceptEdits: CheckBadgeIcon,
  handsOff: ForwardIcon,
  reviewer: SparklesIcon,
  idgaf: BoltIcon,
  custom: AdjustmentsHorizontalIcon,
};

/**
 * The loosest level a set of levels contains, counting only the areas that
 * can change something. Context use is left out: reading is the one area
 * where Permissive is the default, and counting it would paint Careful amber,
 * the same as Hands off. The order is the order of POLICY_LEVELS, manual to
 * idgaf, so the tone says how far the trust goes in the loosest place.
 */
export function loosestLevel(levels: PolicyLevels): PolicyLevel {
  let top = 0;
  for (const area of POLICY_AREAS) {
    if (area === "context") continue;
    top = Math.max(top, POLICY_LEVELS.indexOf(levels[area]));
  }
  return POLICY_LEVELS[top];
}

/**
 * The tone of a preset or of a Custom set of levels, taken from the level
 * tones so there is one palette. A Custom set is neutral (it matches no
 * promise) unless an area is at IDGAF, which stays red.
 */
export function presetTone(
  levels: PolicyLevels,
  preset: PolicyPresetName | undefined,
): { chip: string; icon: string; level: PolicyLevel | undefined } {
  const loosest = loosestLevel(levels);
  if (!preset && loosest !== "idgaf") {
    return {
      chip: "bg-lightgray/20 text-foreground",
      icon: "",
      level: undefined,
    };
  }
  return { ...LEVEL_TONES[loosest], level: loosest };
}

/** "Cautious: Tool use, Plan edits. Manual: File edits." for one set of levels. */
export function summarizeLevels(levels: PolicyLevels): string {
  const parts: string[] = [];
  for (const level of POLICY_LEVELS) {
    const areas = POLICY_AREAS.filter((a) => levels[a] === level);
    if (areas.length === POLICY_AREAS.length) {
      return `All five areas ${policyLevelLabel("tools", level)}.`;
    }
    if (areas.length) {
      parts.push(
        `${policyLevelLabel(areas[0], level)}: ${areas
          .map((a) => POLICY_AREA_LABELS[a])
          .join(", ")}.`,
      );
    }
  }
  return parts.join(" ");
}

export const sameLevels = (a: PolicyLevels, b: PolicyLevels) =>
  POLICY_AREAS.every((area) => a[area] === b[area]);

/**
 * The chip's name for a set of levels: the preset it matches; "Custom (from
 * X)" when it is the stored custom set and that set records its preset;
 * otherwise "Custom". The stored set is only a label here, never behaviour.
 */
export function policyChipLabel(
  levels: PolicyLevels,
  stored: StoredCustomSet | undefined,
): string {
  const preset = presetOf(levels);
  if (preset) return POLICY_PRESETS[preset].label;
  if (stored?.from && sameLevels(stored.levels, levels)) {
    return `Custom (from ${POLICY_PRESETS[stored.from].label})`;
  }
  return "Custom";
}

/** The preset picker: a shortcut that sets all five areas at once. */
export function PresetSelect({
  placement = "toolbar",
}: {
  /** The toolbar's chip keeps the plain test id; Settings' copy is suffixed. */
  placement?: "toolbar" | "settings";
}) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const levels = useAppSelector((s) => s.ui.policyLevels);
  const stored = useAppSelector((s) => s.ui.policyExtras.customSet);
  const preset = presetOf(levels);
  // The saved custom set, offered when something else is in force
  const recall =
    stored && !sameLevels(stored.levels, levels) ? stored : undefined;
  const key = preset ?? "custom";
  const Glyph = PRESET_GLYPHS[key];
  const tone = presetTone(levels, preset);
  const label = policyChipLabel(levels, stored);
  const summary = summarizeLevels(levels);
  // At the top level the chip is the warning: one line, the sentence on hover and by
  // aria-describedby (there is no separate banner)
  const idgafDescriptionId = useId();
  const warn = placement === "toolbar" && preset === "idgaf";
  const sentence = IDGAF_SENTENCE;
  // The Listbox button manages its own aria-describedby, so set ours directly
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = button.current;
    if (!el) return;
    if (warn) el.setAttribute("aria-describedby", idgafDescriptionId);
    else el.removeAttribute("aria-describedby");
  }, [warn, idgafDescriptionId]);

  return (
    <Listbox
      value={key}
      onChange={(name: string) => {
        if (name === "custom") {
          void navigate(customPolicyRoute({ base: preset ?? "current" }));
        } else if (name === "recall" && recall) {
          // The same save as a preset: a raised level waits for the
          // editor's own dialog
          void dispatch(applyPolicyPreset({ ...recall.levels }));
        } else if (name in POLICY_PRESETS) {
          void dispatch(
            applyPolicyPreset(POLICY_PRESETS[name as PolicyPresetName].levels),
          );
        }
      }}
    >
      <div
        className="relative"
        title={
          warn
            ? `${sentence} Choose Careful to go back.`
            : `${label}. ${summary} Presets set all five areas at once.`
        }
      >
        <ListboxButton
          ref={button}
          data-testid={
            placement === "settings"
              ? "policy-preset-settings"
              : "policy-preset"
          }
          data-roving={placement === "toolbar" ? "" : undefined}
          aria-label={`Preset: ${label}${warn ? ", nothing asks" : ""}. ${summary}`}
          className={`${CHIP} ${tone.chip}`}
        >
          <Glyph
            className={`h-3 w-3 shrink-0 ${tone.icon}`}
            aria-hidden="true"
          />
          <span>{label}</span>
          {warn && (
            <span className="hidden min-[481px]:inline">· nothing asks</span>
          )}
          <span
            className="sr-only"
            data-testid={
              placement === "settings"
                ? "policy-preset-tone-settings"
                : "policy-preset-tone"
            }
          >
            {tone.level
              ? `, loosest level ${policyLevelLabel("tools", tone.level)}`
              : ", matches no preset"}
          </span>
          <ChevronDownIcon className="h-2 w-2 shrink-0" aria-hidden="true" />
        </ListboxButton>
        {warn && (
          <span
            id={idgafDescriptionId}
            data-testid="idgaf-description"
            className="sr-only"
          >
            {sentence}
          </span>
        )}
        <ListboxOptions className="max-w-72 min-w-48">
          {POLICY_PRESET_ORDER.map((name) => {
            const OptionGlyph = PRESET_GLYPHS[name];
            const optionTone = presetTone(POLICY_PRESETS[name].levels, name);
            return (
              <ListboxOption
                key={name}
                value={name}
                data-testid={`policy-preset-${name}`}
                className="items-start gap-1"
              >
                <OptionGlyph
                  className={`mt-0.5 h-3 w-3 shrink-0 ${optionTone.icon}`}
                  aria-hidden="true"
                />
                <div
                  className="flex flex-col"
                  title={`${POLICY_PRESETS[name].label}: ${POLICY_PRESETS[name].description} ${summarizeLevels(POLICY_PRESETS[name].levels)}`}
                >
                  <span>{POLICY_PRESETS[name].label}</span>
                  <span className="text-2xs whitespace-normal text-description">
                    {POLICY_PRESETS[name].description}
                  </span>
                  <span className="text-2xs whitespace-normal text-description">
                    {summarizeLevels(POLICY_PRESETS[name].levels)}
                  </span>
                </div>
                <CheckIcon
                  className={`ml-auto h-3 w-3 shrink-0 ${preset === name ? "" : "opacity-0"}`}
                />
              </ListboxOption>
            );
          })}
          {recall && (
            <ListboxOption
              value="recall"
              data-testid="policy-preset-recall"
              className="items-start gap-1"
            >
              <ArrowUturnLeftIcon
                className="mt-0.5 h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              <div className="flex flex-col">
                <span>{policyChipLabel(recall.levels, recall)}</span>
                <span className="text-2xs whitespace-normal text-description">
                  Your saved custom set. {summarizeLevels(recall.levels)}
                </span>
              </div>
            </ListboxOption>
          )}
          <ListboxOption
            value="custom"
            data-testid="policy-preset-custom"
            className="items-start gap-1"
          >
            <AdjustmentsHorizontalIcon
              className="mt-0.5 h-3 w-3 shrink-0"
              aria-hidden="true"
            />
            <div className="flex flex-col">
              <span>Custom…</span>
              <span className="text-2xs whitespace-normal text-description">
                Open the policy editor: levels, rules and settings, starting
                from{" "}
                {preset ? POLICY_PRESETS[preset].label : "your current set"}.
                {preset ? "" : " This is your current set."}
              </span>
            </div>
            <CheckIcon
              className={`ml-auto h-3 w-3 shrink-0 ${preset ? "opacity-0" : ""}`}
              aria-hidden="true"
            />
          </ListboxOption>
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
