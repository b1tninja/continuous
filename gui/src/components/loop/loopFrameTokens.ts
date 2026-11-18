/**
 * The ring colours of the loop frame (loopFrame.css has the same values; the
 * test checks they agree) and the WCAG 1.4.11 contrast they were chosen for.
 * Dark values: the Continuous logo's stops plus VS Code-like state colours.
 * Light values are darker, because the logo's own stops are down to 2.45:1 on
 * the input surface in light themes.
 */
export const LOOP_FRAME_TOKENS = {
  dark: {
    g1: "#4c8dff",
    g2: "#8b7cf6",
    g3: "#a78bfa",
    amber: "#e0b84a",
    red: "#f48771",
    green: "#89d185",
    grey: "#a0a0a0",
  },
  light: {
    g1: "#2563eb",
    g2: "#5b4bd6",
    g3: "#6d45d9",
    amber: "#7a5700",
    red: "#b3261e",
    green: "#1a6b2a",
    grey: "#5c5c5c",
  },
} as const;

/** The surfaces of VS Code's Dark Modern and Light Modern: page, card, input. */
export const LOOP_FRAME_SURFACES = {
  dark: { page: "#1e1e1e", card: "#252526", input: "#2b2b2b" },
  light: { page: "#ffffff", card: "#f5f5f5", input: "#f3f3f3" },
} as const;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (hi + 0.05) / (lo + 0.05);
}
