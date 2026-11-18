import { useEffect, useRef, type RefObject } from "react";

/** A keystroke this recent means the person is typing, whatever has focus. */
export const TYPING_WINDOW_MS = 2000;

let lastKeyAt = 0;
let listening = false;

function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "keydown",
    (e) => {
      // Modifier-only and shortcut keys are not typing
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        lastKeyAt = Date.now();
      }
    },
    true,
  );
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable === true
  );
}

/**
 * Is the person in the middle of writing something? True when a field has
 * focus and holds text, or a character key went down a moment ago. An empty
 * focused field (the chat input right after a send) is not typing.
 */
export function isUserTyping(
  doc: Document = document,
  now: number = Date.now(),
  keyAt: number = lastKeyAt,
): boolean {
  if (now - keyAt < TYPING_WINDOW_MS) return true;
  const active = doc.activeElement;
  if (!isEditable(active)) return false;
  const el = active as HTMLInputElement | HTMLElement;
  const text = "value" in el ? (el as HTMLInputElement).value : el.textContent;
  return !!text?.trim();
}

/**
 * Moves focus to `target` when `key` changes to a new approval, unless the
 * person is typing: focus is never taken from the input mid-sentence.
 */
export function useApprovalFocus(
  key: string | undefined,
  target: RefObject<HTMLElement | null>,
) {
  const focusedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    listen();
  }, []);
  useEffect(() => {
    if (!key || focusedFor.current === key) return;
    focusedFor.current = key;
    if (isUserTyping()) return;
    target.current?.focus();
  }, [key, target]);
}
