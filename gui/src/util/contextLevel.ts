/** The context meter's colour step (gui/src/components/mainInput/ContextMeter.tsx). */
export type ContextLevel = "ok" | "warn" | "high";

/** From here the meter turns to the warning colour (the old battery appeared at 60%). */
export const CONTEXT_WARN_FRACTION = 0.6;
/** From here it turns to the error colour (the reply's Compact link shows past 80%). */
export const CONTEXT_HIGH_FRACTION = 0.8;

/**
 * Pruning (the oldest messages already left out) is always `high`; a
 * conversation past the size where each message costs real money (`large`)
 * is at least `warn`, whatever its share of a big window.
 */
export function contextLevel(
  fraction: number,
  opts: { pruned?: boolean; large?: boolean } = {},
): ContextLevel {
  if (opts.pruned || fraction >= CONTEXT_HIGH_FRACTION) return "high";
  if (opts.large || fraction >= CONTEXT_WARN_FRACTION) return "warn";
  return "ok";
}
