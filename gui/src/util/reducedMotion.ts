import { useEffect, useState } from "react";

/** The class VS Code puts on the webview body when "Reduce Motion" is on. */
export const VSCODE_REDUCE_MOTION_CLASS = "vscode-reduce-motion";
export const VSCODE_SCREEN_READER_CLASS = "vscode-using-screen-reader";
export const VSCODE_HIGH_CONTRAST_CLASSES = [
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Whether motion should be off: the editor's Reduce Motion setting (a body
 * class) or the operating system's (the media query). The CSS reads the same
 * two signals (index.css), so this is for motion that CSS cannot stop.
 */
export function prefersReducedMotion(
  doc: Pick<Document, "body"> | undefined = typeof document === "undefined"
    ? undefined
    : document,
  win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined"
    ? undefined
    : window,
): boolean {
  if (doc?.body?.classList.contains(VSCODE_REDUCE_MOTION_CLASS)) return true;
  return !!win?.matchMedia?.(QUERY).matches;
}

/** True while a screen reader is in use, as far as VS Code says. */
export function usingScreenReader(
  doc: Pick<Document, "body"> | undefined = typeof document === "undefined"
    ? undefined
    : document,
): boolean {
  return !!doc?.body?.classList.contains(VSCODE_SCREEN_READER_CLASS);
}

/** True in either high contrast theme or when the system forces colours. */
export function highContrastActive(
  doc: Pick<Document, "body"> | undefined = typeof document === "undefined"
    ? undefined
    : document,
  win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined"
    ? undefined
    : window,
): boolean {
  const cl = doc?.body?.classList;
  if (cl && VSCODE_HIGH_CONTRAST_CLASSES.some((c) => cl.contains(c)))
    return true;
  return !!win?.matchMedia?.("(forced-colors: active)").matches;
}

/** Re-renders when either signal changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => {
    const update = () => setReduced(prefersReducedMotion());
    const mql = window.matchMedia?.(QUERY);
    mql?.addEventListener?.("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    update();
    return () => {
      mql?.removeEventListener?.("change", update);
      observer.disconnect();
    };
  }, []);
  return reduced;
}
