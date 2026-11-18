/**
 * Follow `nextCursor` on a list method with hard caps. An untrusted server
 * could stream pages forever or return a huge list; the caps bound the memory
 * and the tool count, and the result says so, so the caller can show a warning.
 */

export const MAX_LIST_PAGES = 20;
export const MAX_LIST_ITEMS = 2000;

export interface PagedResult<T> {
  items: T[];
  /** Set when a cap or a cursor loop stopped the listing early. */
  warning?: string;
}

export interface PageOptions<T> {
  /** Shown in the warning, e.g. "tools". */
  kind: string;
  maxPages?: number;
  maxItems?: number;
  /** Identity for dropping repeats across pages (default: keep all). */
  keyOf?: (item: T) => string;
  signal?: AbortSignal;
}

export async function listAllPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  opts: PageOptions<T>,
): Promise<PagedResult<T>> {
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES;
  const maxItems = opts.maxItems ?? MAX_LIST_ITEMS;
  const items: T[] = [];
  const seenKeys = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 1; ; page++) {
    opts.signal?.throwIfAborted();
    const res = await fetchPage(cursor);
    for (const item of res.items) {
      if (opts.keyOf) {
        const key = opts.keyOf(item);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      if (items.length >= maxItems) {
        return {
          items,
          warning: `The server returned more than ${maxItems} ${opts.kind}; the rest were ignored.`,
        };
      }
      items.push(item);
    }
    const next =
      typeof res.nextCursor === "string" && res.nextCursor !== ""
        ? res.nextCursor
        : undefined;
    if (!next) return { items };
    if (seenCursors.has(next)) {
      return {
        items,
        warning: `The server repeated a page cursor while listing ${opts.kind}; listing stopped after ${page} pages.`,
      };
    }
    if (page >= maxPages) {
      return {
        items,
        warning: `The server offered more than ${maxPages} pages of ${opts.kind}; the rest were ignored.`,
      };
    }
    seenCursors.add(next);
    cursor = next;
  }
}
