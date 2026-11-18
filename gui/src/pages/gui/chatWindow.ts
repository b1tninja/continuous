/**
 * Which transcript rows stay mounted.
 *
 * This is the webview's scroll memory: rows far from the viewport are not
 * rendered, so a long chat does not keep every message node in the DOM. The
 * conversation stays in Redux and on disk; scrolling back mounts those rows
 * again. It is not the prompt-token ageing in core/util/contextAgeing.ts.
 */

export const CHAT_WINDOW_ESTIMATE_PX = 96;
export const CHAT_WINDOW_OVERSCAN = 4;

export interface ChatWindowRange {
  /** Inclusive index of the first mounted row. */
  start: number;
  /** Exclusive index after the last mounted row. */
  end: number;
  /** Height of the unmounted rows above the window, in px. */
  top: number;
  /** Height of the unmounted rows below the window, in px. */
  bottom: number;
  total: number;
}

export interface ChatWindowInput {
  count: number;
  scrollTop: number;
  viewport: number;
  /** Measured row heights. Missing, or non-positive, means "not measured yet". */
  heights?: readonly (number | undefined)[];
  estimate?: number;
  overscan?: number;
  /** Pin the window to the last rows (the person is following the reply). */
  stickToEnd?: boolean;
}

function sizeAt(
  heights: readonly (number | undefined)[] | undefined,
  index: number,
  estimate: number,
): number {
  const measured = heights?.[index];
  // 0 is a real measurement (a tool row that renders nothing). Undefined is not.
  if (measured === undefined) return estimate;
  return measured > 0 ? measured : 0;
}

function prefixSums(
  count: number,
  heightAt: (index: number) => number,
): number[] {
  const prefix = new Array<number>(count + 1);
  prefix[0] = 0;
  for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i] + heightAt(i);
  return prefix;
}

const EMPTY: ChatWindowRange = {
  start: 0,
  end: 0,
  top: 0,
  bottom: 0,
  total: 0,
};

/**
 * The mounted slice of a variable-height list. A viewport of 0 (the box has
 * not been laid out, as in unit tests that do not set a height) mounts
 * everything, so callers that cannot measure still show the conversation.
 */
export function chatWindowRange(input: ChatWindowInput): ChatWindowRange {
  const count = input.count;
  if (count <= 0) return EMPTY;
  const estimate = input.estimate ?? CHAT_WINDOW_ESTIMATE_PX;
  const overscan = input.overscan ?? CHAT_WINDOW_OVERSCAN;
  const heightAt = (index: number) => sizeAt(input.heights, index, estimate);
  const prefix = prefixSums(count, heightAt);
  const total = prefix[count];
  const viewport = input.viewport;

  if (viewport <= 0 || total <= viewport) {
    return { start: 0, end: count, top: 0, bottom: 0, total };
  }

  if (input.stickToEnd) {
    const need = viewport + overscan * estimate;
    let start = count;
    // Largest start whose rows still cover the viewport and the overscan.
    while (start > 0 && total - prefix[start] < need) start--;
    start = Math.max(0, start - overscan);
    return {
      start,
      end: count,
      top: prefix[start],
      bottom: 0,
      total,
    };
  }

  const from = Math.max(0, input.scrollTop);
  const viewStart = Math.max(0, from - overscan * estimate);
  const viewEnd = from + viewport + overscan * estimate;
  let start = 0;
  while (start < count && prefix[start + 1] <= viewStart) start++;
  let end = start;
  // Height 0 still advances the index, so a run of empty tool rows cannot
  // stall the scan. Once a row starts at or past viewEnd, stop.
  while (end < count && prefix[end] < viewEnd) end++;
  return {
    start,
    end,
    top: prefix[start],
    bottom: total - prefix[end],
    total,
  };
}
