import {
  BoltIcon,
  EyeIcon,
  HandRaisedIcon,
  LockOpenIcon,
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
 * your rules, sparkles is the reviewer model, an open lock lets rules decide,
 * a bolt ignores them) and the colour says how far the trust goes, from green
 * (you decide) through blue (a reviewer) and amber (rules only) to red
 * (nothing checks).
 */
export const LEVEL_GLYPHS: Record<PolicyLevel, typeof EyeIcon> = {
  manual: HandRaisedIcon,
  cautious: ShieldCheckIcon,
  automatic: SparklesIcon,
  permissive: LockOpenIcon,
  idgaf: BoltIcon,
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
    idgaf: { chip: "bg-error/20 text-foreground", icon: "text-error" },
  };

/** Every chip and the fold button is a target of at least 24 px (WCAG 2.5.8). */
export const CHIP =
  "flex-none min-h-6 gap-1 rounded-full border-none px-2 transition-colors duration-200 hover:brightness-110";

/**
 * What the top-level chip's tooltip and description say. The chip and the area
 * selectors already show which areas are at IDGAF and that nothing asks, so
 * this names only the part that is easy to miss: rules stop applying too.
 */
export const IDGAF_SENTENCE = "Every rule is ignored.";
