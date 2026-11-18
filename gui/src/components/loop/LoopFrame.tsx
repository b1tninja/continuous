import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "../../util/reducedMotion";
import "./loopFrame.css";

export type LoopFrameState =
  "running" | "waiting" | "failed" | "finished" | "stopped";

export interface LoopFrameProps {
  /** The loop's state: the ring's colour. The icon and word stay beside it. */
  state: LoopFrameState;
  /**
   * Let the highlight arc turn. The caller says so only for the one focused
   * loop; it still stays still unless the state is running, the page is
   * visible and the person has not asked for reduced motion.
   */
  animate?: boolean;
  children?: ReactNode;
  className?: string;
  testId?: string;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * The gradient loop frame (loopFrame.css): a 2 px ring that hugs what it
 * holds and takes the loop's state colour. Decoration plus redundancy, so it
 * announces nothing (it has no role). Static by default; `animate` turns the
 * highlight arc only for a running loop on a visible page without reduced
 * motion. The border is always 2 px, so a state change never moves layout.
 */
export function LoopFrame({
  state,
  animate = false,
  children,
  className,
  testId = "loop-frame",
}: LoopFrameProps) {
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const sweep = animate && state === "running" && visible && !reduced;
  return (
    <div
      data-testid={testId}
      data-state={state}
      data-motion={sweep ? "sweep" : "off"}
      className={`loop-frame min-w-0 ${className ?? ""}`.trim()}
    >
      {children}
    </div>
  );
}
