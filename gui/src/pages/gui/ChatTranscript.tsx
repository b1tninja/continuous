import {
  memo,
  ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { KeptOpenScope } from "../../hooks/useKeptOpenState";
import { CHAT_WINDOW_ESTIMATE_PX, chatWindowRange } from "./chatWindow";

/**
 * The scroll node's ref is attached after its children's layout effects.
 * Call this in the component that owns the ref so the element is known
 * before paint, and pass it into ChatTranscript.
 */
export function useScrollBox(
  ref: React.RefObject<HTMLDivElement | null>,
): HTMLDivElement | null {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const next = ref.current;
    setElement((prev) => (prev === next ? prev : next));
  });
  return element;
}

function observeSize(el: Element, read: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(read);
  observer.observe(el);
  return () => observer.disconnect();
}

interface ChatTranscriptProps<T> {
  /** The scroll box, once its ref has been attached. Null until then. */
  scrollElement: HTMLDivElement | null;
  items: readonly T[];
  /** True while auto-scroll is following the latest reply. */
  stickToEnd: boolean;
  /** Mount every row (find is open and searches the rendered text). */
  suspend?: boolean;
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
}

/**
 * Renders only the rows near the viewport. The top and bottom spacers keep
 * the scroll height, so the person can scroll back to a turn that was
 * unmounted. The items array itself is unchanged.
 */
export function ChatTranscript<T>({
  scrollElement,
  items,
  stickToEnd,
  suspend = false,
  itemKey,
  renderItem,
}: ChatTranscriptProps<T>) {
  const heights = useRef<(number | undefined)[]>([]);
  const [version, setVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [layoutReady, setLayoutReady] = useState(false);

  useLayoutEffect(() => {
    const el = scrollElement;
    if (!el) return;
    setLayoutReady(true);
    const read = () => {
      setViewport((prev) =>
        prev === el.clientHeight ? prev : el.clientHeight,
      );
      setScrollTop((prev) => (prev === el.scrollTop ? prev : el.scrollTop));
    };
    read();
    const onScroll = () => {
      setScrollTop((prev) => (prev === el.scrollTop ? prev : el.scrollTop));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const stopObserving = observeSize(el, read);
    return () => {
      el.removeEventListener("scroll", onScroll);
      stopObserving();
    };
  }, [scrollElement]);

  const range = useMemo(
    () =>
      chatWindowRange({
        count: items.length,
        scrollTop,
        // A zero viewport mounts every row. Suspend does that on purpose
        // while find is searching the rendered conversation.
        viewport: suspend ? 0 : viewport,
        heights: heights.current,
        stickToEnd: stickToEnd && !suspend,
      }),
    [items.length, scrollTop, viewport, stickToEnd, suspend, version],
  );

  // The browser keeps the view in place too when something above it changes
  // height (scroll anchoring). onHeight below does that itself, and with both
  // the view moved twice: each row measured for the first time shifted what
  // the person was reading by the row's height less the estimate. So the
  // browser's is off while ours is on.
  useLayoutEffect(() => {
    const el = scrollElement;
    if (!el || stickToEnd || suspend) return;
    el.style.setProperty("overflow-anchor", "none");
    return () => {
      el.style.removeProperty("overflow-anchor");
    };
  }, [scrollElement, stickToEnd, suspend]);

  const onHeight = useCallback(
    (index: number, height: number) => {
      const prevMeasured = heights.current[index];
      if (prevMeasured === height) return;
      const prev =
        prevMeasured === undefined ? CHAT_WINDOW_ESTIMATE_PX : prevMeasured;
      heights.current[index] = height;
      const el = scrollElement;
      if (el && !stickToEnd && !suspend) {
        let top = 0;
        for (let i = 0; i < index; i++) {
          const measured = heights.current[i];
          top += measured === undefined ? CHAT_WINDOW_ESTIMATE_PX : measured;
        }
        if (top < el.scrollTop) el.scrollTop += height - prev;
      }
      setVersion((v) => v + 1);
    },
    [scrollElement, stickToEnd, suspend],
  );

  useLayoutEffect(() => {
    if (!layoutReady || suspend || !stickToEnd) return;
    const el = scrollElement;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    el.scrollTop = el.scrollHeight;
  }, [
    layoutReady,
    suspend,
    stickToEnd,
    range.start,
    range.end,
    range.top,
    items.length,
    scrollElement,
  ]);

  // Before the scroll box has been measured, keep a single spacer instead of
  // mounting every row. The measurement effect runs before paint.
  if (!layoutReady && !suspend) {
    return (
      <div
        aria-hidden
        data-testid="chat-window-spacer"
        style={{ height: items.length * CHAT_WINDOW_ESTIMATE_PX }}
      />
    );
  }

  const rows: ReactNode[] = [];
  for (let index = range.start; index < range.end; index++) {
    const item = items[index];
    const key = itemKey(item, index);
    rows.push(
      <MeasuredRow
        key={key}
        rowKey={key}
        index={index}
        item={item}
        renderItem={renderItem}
        onHeight={onHeight}
      />,
    );
  }

  return (
    <>
      {range.top > 0 && (
        <div
          aria-hidden
          data-testid="chat-window-spacer"
          data-edge="top"
          style={{ height: range.top }}
        />
      )}
      {rows}
      {range.bottom > 0 && (
        <div
          aria-hidden
          data-testid="chat-window-spacer"
          data-edge="bottom"
          style={{ height: range.bottom }}
        />
      )}
    </>
  );
}

interface MeasuredRowProps<T> {
  rowKey: string;
  index: number;
  item: T;
  renderItem: (item: T, index: number) => ReactNode;
  onHeight: (index: number, height: number) => void;
}

function MeasuredRowInner<T>({
  rowKey,
  index,
  item,
  renderItem,
  onHeight,
}: MeasuredRowProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      // offsetHeight 0 is a real empty row (a tool message that draws nothing).
      onHeight(index, el.offsetHeight);
    };
    read();
    return observeSize(el, read);
  }, [index, onHeight]);
  return (
    <div ref={ref} data-testid="chat-transcript-row" data-chat-index={index}>
      {/* What the person opened in this row outlives its unmount */}
      <KeptOpenScope id={rowKey}>{renderItem(item, index)}</KeptOpenScope>
    </div>
  );
}

// A scroll or a measured height renders the transcript again, several times
// for one step. The rows are the same unless the owner rendered, which is
// when renderItem changes, so they are not rendered again for those.
const MeasuredRow = memo(MeasuredRowInner) as typeof MeasuredRowInner;
