import { XMarkIcon } from "@heroicons/react/24/outline";
import {
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_LEVELS,
  POLICY_PRESET_ORDER,
  POLICY_PRESETS,
  policyLevelLabel,
  type PolicyArea,
} from "core/tools/permissions/policy";
import {
  LEVEL_GLYPHS,
  LEVEL_TONES,
} from "../../../../components/PolicyControls/levelStyle";
import {
  PRESET_GLYPHS,
  presetTone,
} from "../../../../components/PolicyControls/PresetSelect";

/**
 * One sentence per area, in the words of the vocabulary: an area has a level,
 * a preset sets all five levels, a rule is Never, Ask or Always.
 */
const AREA_SENTENCES: Record<PolicyArea, string> = {
  context: "Reading files and searching your code.",
  tools: "Running commands, fetching pages and calling MCP tools.",
  edits: "Writing and changing files.",
  plan: "Plans and re-plans in Loop.",
  questions: "Who answers the agent's questions.",
};

/**
 * A short card for a first-time user. It uses the glyph and tone of each
 * level (levelStyle) and of each preset (PresetSelect), so what a chip looks
 * like here is what it looks like in the toolbar. The tone is never the only
 * signal: every chip carries its words.
 */
export function FirstRunOverview({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section
      aria-labelledby="permissions-intro-title"
      className="mb-3 min-w-0 rounded-sm border border-solid border-border bg-input px-3 py-2"
      data-testid="permissions-intro"
    >
      <div className="flex items-start gap-2">
        <h4
          id="permissions-intro-title"
          className="m-0 flex-1 text-xs font-semibold"
        >
          How permissions work
        </h4>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Got it, dismiss the permissions overview"
          data-testid="permissions-intro-dismiss"
          className="flex h-6 min-w-6 flex-none cursor-pointer items-center justify-center gap-1 rounded-sm border border-solid border-border bg-transparent px-1 text-2xs text-foreground"
        >
          <XMarkIcon className="h-3 w-3" aria-hidden="true" />
          <span>Got it</span>
        </button>
      </div>
      <p className="my-1 text-2xs text-description-muted">
        The agent&apos;s power is split into five areas. Each area has its own
        level, from Manual (you decide everything) to IDGAF (nothing asks).
      </p>
      <ul className="m-0 flex flex-col gap-0.5 p-0 text-2xs">
        {POLICY_AREAS.map((area) => (
          <li key={area} className="list-none">
            <strong>{POLICY_AREA_LABELS[area]}</strong>: {AREA_SENTENCES[area]}
          </li>
        ))}
      </ul>
      <div
        className="mt-2 flex flex-wrap gap-1"
        role="list"
        aria-label="The five levels"
        data-testid="permissions-intro-levels"
      >
        {POLICY_LEVELS.map((level) => {
          const Glyph = LEVEL_GLYPHS[level];
          const tone = LEVEL_TONES[level];
          return (
            <span
              key={level}
              role="listitem"
              className={`inline-flex min-h-6 items-center gap-1 rounded-full px-2 text-2xs ${tone.chip}`}
            >
              <Glyph
                className={`h-3 w-3 shrink-0 ${tone.icon}`}
                aria-hidden="true"
              />
              {policyLevelLabel("tools", level)}
            </span>
          );
        })}
      </div>
      <p className="mt-2 mb-1 text-2xs text-description-muted">
        A preset sets all five levels at once. Pick one in the toolbar above the
        input or in the Levels view below:
      </p>
      <ul
        className="m-0 flex flex-col gap-0.5 p-0 text-2xs"
        data-testid="permissions-intro-presets"
      >
        {POLICY_PRESET_ORDER.map((name) => {
          const Glyph = PRESET_GLYPHS[name];
          const tone = presetTone(POLICY_PRESETS[name].levels, name);
          return (
            <li key={name} className="flex list-none items-start gap-1">
              <Glyph
                className={`mt-0.5 h-3 w-3 shrink-0 ${tone.icon}`}
                aria-hidden="true"
              />
              <span>
                <strong>{POLICY_PRESETS[name].label}</strong>:{" "}
                {POLICY_PRESETS[name].description}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 mb-0 text-2xs text-description-muted">
        On top of the level you can add rules: Never, Ask or Always. Built-in
        rules and locked rules apply first, and no rule of yours can loosen
        them. This card is shown once; the tabs below are the page.
      </p>
    </section>
  );
}
