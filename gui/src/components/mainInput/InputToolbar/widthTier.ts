import {
  createContext,
  RefObject,
  useContext,
  useLayoutEffect,
  useState,
} from "react";

/**
 * How much room the row under the prompt has. The steps are the width of the
 * row itself, not of the window, so the same toolbar adapts inside the
 * sidebar, an editor tab or the JetBrains tool window. See
 * `plans/research/status-row-layout.md` for what each step shows.
 */
export type WidthTier = "narrow" | "medium" | "wide";

/**
 * Below this the row is `narrow`: icons and numbers only. The row is about
 * 40 px narrower than the panel, so this is a panel of about 340 px.
 */
export const MEDIUM_MIN_PX = 300;
/**
 * From this the row is `wide`: labels come back. The labelled status group is
 * about 520 px, so below this it would push the model name out.
 */
export const WIDE_MIN_PX = 600;

export function widthTier(px: number): WidthTier {
  if (px >= WIDE_MIN_PX) return "wide";
  if (px >= MEDIUM_MIN_PX) return "medium";
  return "narrow";
}

/** The tier of the row a control sits in; `wide` outside a toolbar. */
export const ToolbarWidthContext = createContext<WidthTier>("wide");

export function useToolbarWidthTier(): WidthTier {
  return useContext(ToolbarWidthContext);
}

/**
 * Measures `ref` and follows it as it resizes. Before the first measurement,
 * and where the element has no layout (a hidden toolbar), the window width
 * stands in, which in a webview is the panel's width.
 */
export function useWidthTier(ref: RefObject<HTMLElement | null>): WidthTier {
  const [tier, setTier] = useState<WidthTier>(() =>
    widthTier(typeof window === "undefined" ? WIDE_MIN_PX : window.innerWidth),
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (px?: number) => {
      const width =
        px && px > 0
          ? px
          : el.getBoundingClientRect().width || window.innerWidth;
      setTier(widthTier(width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      const onResize = () => measure();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const observer = new ResizeObserver((entries) => {
      measure(entries[0]?.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return tier;
}
