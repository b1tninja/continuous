import {
  EyeIcon,
  HandRaisedIcon,
  PaperAirplaneIcon,
  PlayIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import {
  policyLevelLabel,
  type PolicyLevel,
} from "core/tools/permissions/policy";

/**
 * A glyph and a colour for each level, so a chip reads without its text: the
 * glyph says what happens (a raised hand asks you, a shield checks against
 * your rules, sparkles is the reviewer model, a play triangle lets rules decide,
 * and a bolt, on the IDGAF chip only, means no check is on) and the colour says how far the trust goes, from green
 * (you decide) through blue (a reviewer) and amber (rules only) to red
 * (nothing checks).
 */
export const LEVEL_GLYPHS: Record<PolicyLevel, typeof EyeIcon> = {
  manual: HandRaisedIcon,
  cautious: ShieldCheckIcon,
  automatic: SparklesIcon,
  permissive: PlayIcon,
  // Questions only: the decision is handed off
  delegate: PaperAirplaneIcon,
};

/**
 * The tint carries the level and the label is always the foreground colour:
 * theme greens and ambers fall under 4.5:1 on a light background (1.8:1 for
 * the default green), and a label that cannot be read is no label. The glyph
 * keeps the colour.
 */
export const LEVEL_TONES: Record<PolicyLevel, { chip: string; icon: string }> =
  {
    manual: { chip: "bg-success/20 text-foreground", icon: "text-success" },
    cautious: { chip: "bg-success/20 text-foreground", icon: "text-success" },
    automatic: { chip: "bg-link/20 text-foreground", icon: "text-link" },
    permissive: { chip: "bg-warning/20 text-foreground", icon: "text-warning" },
    delegate: { chip: "bg-warning/20 text-foreground", icon: "text-warning" },
  };

/**
 * The glyph and tint of a level, or Cautious's when the value is not one. A
 * level comes from saved state and from messages of other hosts, and a value
 * this build does not know must not stop the page being drawn.
 */
export const glyphOf = (level: string): typeof EyeIcon =>
  Object.hasOwn(LEVEL_GLYPHS, level)
    ? LEVEL_GLYPHS[level as PolicyLevel]
    : LEVEL_GLYPHS.cautious;
export const toneOf = (level: string): { chip: string; icon: string } =>
  Object.hasOwn(LEVEL_TONES, level)
    ? LEVEL_TONES[level as PolicyLevel]
    : LEVEL_TONES.cautious;

/**
 * The IDGAF preset is not a level, so it has no entry above; its chip is red
 * because no safety check is on.
 */
export const IDGAF_TONE = {
  chip: "bg-error/20 text-foreground",
  icon: "text-error",
};

/** Every chip and the fold button is a target of at least 24 px (WCAG 2.5.8). */
export const CHIP =
  "flex-none min-h-6 gap-1 rounded-full border-none px-2 transition-colors duration-200 hover:brightness-110";

/**
 * What the IDGAF chip's tooltip and description say: the part that is easy to
 * miss, that with no check on rules and locks stop applying too.
 */
export const IDGAF_SENTENCE =
  "No safety check is on, so rules, protected files and locks stop nothing.";
