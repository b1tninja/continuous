import {
  CheckCircleIcon,
  PauseCircleIcon,
  StopCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/solid";
import {
  LOOP_VISUAL,
  type LoopStateIconName,
  type LoopVisualState,
} from "./loopVisualState";

const GLYPHS = {
  check: CheckCircleIcon,
  pause: PauseCircleIcon,
  cross: XCircleIcon,
  stop: StopCircleIcon,
} satisfies Record<Exclude<LoopStateIconName, "dot">, unknown>;

/**
 * The state's glyph in its colour: a green check, a pulsing accent dot (a
 * static ring under reduced motion), an amber pause, a red cross, a grey stop.
 * Decorative: put the word beside it (LOOP_VISUAL[state].word).
 */
export function LoopStateIcon({
  state,
  className = "h-3 w-3",
}: {
  state: LoopVisualState;
  className?: string;
}) {
  const style = LOOP_VISUAL[state];
  if (style.icon === "dot") {
    return (
      <span
        data-testid="loop-state-icon"
        data-state={state}
        aria-hidden="true"
        className={`inline-flex shrink-0 items-center justify-center ${className}`}
      >
        <span
          className={`h-1.5 w-1.5 animate-pulse rounded-full ${style.fill} motion-reduce:animate-none motion-reduce:ring-2 motion-reduce:ring-link/40`}
        />
      </span>
    );
  }
  const Glyph = GLYPHS[style.icon];
  return (
    <Glyph
      data-testid="loop-state-icon"
      data-state={state}
      aria-hidden="true"
      className={`shrink-0 ${style.text} ${className}`}
    />
  );
}
