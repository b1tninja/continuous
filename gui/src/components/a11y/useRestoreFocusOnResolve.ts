import { useCallback, useEffect, useRef, type FocusEvent } from "react";

/**
 * Keeps keyboard focus from being dropped when a panel the person was
 * operating goes away.
 *
 * Spread the returned handlers on the panel's root. When `active` turns false
 * (the panel unmounts its content) and focus was inside the panel at that
 * moment, `restore` runs, but only if focus is now on the document body, so
 * a person who already moved on is left where they are.
 */
export function useRestoreFocusOnResolve(active: boolean, restore: () => void) {
  const hadFocus = useRef(false);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  const onFocus = useCallback(() => {
    hadFocus.current = true;
  }, []);

  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    // A browser may report a blur for an element that is being removed. That
    // is the case this hook exists for, so keep the flag when the target is
    // already gone and nothing else took focus.
    if (e.relatedTarget === null && !e.target.isConnected) return;
    hadFocus.current = false;
  }, []);

  const wasActive = useRef(active);
  useEffect(() => {
    const resolved = wasActive.current && !active;
    wasActive.current = active;
    if (!resolved) return;
    const focusLost =
      !document.activeElement || document.activeElement === document.body;
    if (hadFocus.current && focusLost) restoreRef.current();
    hadFocus.current = false;
  }, [active]);

  return { onFocus, onBlur };
}
