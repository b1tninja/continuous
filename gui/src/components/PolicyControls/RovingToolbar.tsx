import { useCallback, useEffect, useRef, type ReactNode } from "react";

/** Marks a control that joins the toolbar's arrow-key order. */
const ITEM = "[data-roving]";

function itemsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM)).filter(
    // A control a breakpoint hides is not a stop (jsdom has no checkVisibility)
    (el) => typeof el.checkVisibility !== "function" || el.checkVisibility(),
  );
}

/**
 * One Tab stop for a row of controls (WAI-ARIA toolbar): Left and Right (and
 * Home, End) move between the controls marked `data-roving`, Tab leaves. The
 * control last used keeps tabindex 0, the others -1. Each control keeps its
 * own name and its own Enter, Space and Down behaviour.
 */
export function RovingToolbar({
  label,
  testId,
  className,
  children,
  copyKey,
  onItemFocus,
}: {
  label: string;
  testId?: string;
  className?: string;
  children: ReactNode;
  /**
   * Set on a message's action row so a shortcut can find that message.
   * Absent on toolbars that are not a message.
   */
  copyKey?: string;
  /** A roving control in this toolbar received focus. */
  onItemFocus?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLElement | null>(null);

  const apply = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const items = itemsOf(root);
    const stop =
      current.current && items.includes(current.current)
        ? current.current
        : items[0];
    for (const item of items) {
      item.tabIndex = item === stop ? 0 : -1;
    }
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    apply();
    // Controls mount and unmount as the panel changes width or state
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [apply]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const root = ref.current;
    const target = e.target as HTMLElement;
    if (!root || !target.matches(ITEM)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const items = itemsOf(root);
    const at = items.indexOf(target);
    let next: number | undefined;
    if (e.key === "ArrowRight") next = (at + 1) % items.length;
    else if (e.key === "ArrowLeft") {
      next = (at - 1 + items.length) % items.length;
    } else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next === undefined) return;
    e.preventDefault();
    current.current = items[next];
    apply();
    items[next].focus();
  };

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      data-testid={testId}
      data-message-actions={copyKey === undefined ? undefined : ""}
      data-copy-key={copyKey}
      className={className}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const t = e.target as HTMLElement;
        if (t.matches(ITEM)) {
          current.current = t;
          apply();
          onItemFocus?.();
        }
      }}
    >
      {children}
    </div>
  );
}
