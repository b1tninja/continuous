import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/** The elements Tab can reach inside `root`, in document order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[hidden],[inert],[aria-hidden='true']"),
  );
}

/**
 * Keeps keyboard focus inside a modal dialog (WAI-ARIA dialog pattern): Tab
 * on the last element goes to the first and Shift+Tab on the first goes to
 * the last; focus that lands outside (a click on the backdrop's controls, a
 * focus() call elsewhere) is brought back. When the dialog closes, focus
 * returns to the element that opened it, if it is still on the page.
 *
 * The app's shared dialog container has no trap of its own, so this is per
 * dialog. The element behind `ref` must stay the same while the dialog is open.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener =
      document.activeElement instanceof HTMLElement &&
      !root.contains(document.activeElement)
        ? document.activeElement
        : null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first || active === root) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (target instanceof Node && !root.contains(target)) {
        (focusableIn(root)[0] ?? root).focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}
