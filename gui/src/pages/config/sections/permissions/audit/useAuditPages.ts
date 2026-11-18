import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../../../../context/IdeMessenger";
import { SLOW_AFTER_MS } from "../PermissionsStates";

type Page<T> = { items: T[]; nextCursor?: string };

/**
 * Pages of a read-only list from core: the first page, then "more" with the
 * cursor core gave. `slow` turns on after SLOW_AFTER_MS without an answer and
 * `error` after a failed one, each with `reload` to ask again. The last answer
 * wins, so a slow read of an old filter never replaces a newer one. `meta` is
 * what the latest first page said besides its rows (filters, a partial read).
 */
export function useAuditPages<T, M>(
  fetchPage: (
    cursor: string | undefined,
    ideMessenger: ReturnType<typeof useIdeMessenger>,
  ) => Promise<(Page<T> & { meta: M }) | undefined>,
  deps: readonly unknown[],
) {
  const ideMessenger = useIdeMessenger();
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [meta, setMeta] = useState<M | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [slow, setSlow] = useState(false);
  const [reloads, setReloads] = useState(0);
  const seq = useRef(0);

  const run = useCallback(
    async (after: string | undefined) => {
      const mine = ++seq.current;
      const first = after === undefined;
      if (first) setLoading(true);
      else setLoadingMore(true);
      setError(false);
      const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
      let res: Awaited<ReturnType<typeof fetchPage>>;
      try {
        res = await fetchPage(after, ideMessenger);
      } catch {
        res = undefined;
      }
      clearTimeout(timer);
      if (mine !== seq.current) return;
      setSlow(false);
      setLoading(false);
      setLoadingMore(false);
      if (!res) {
        setError(true);
        return;
      }
      setItems((old) => (first ? res.items : [...old, ...res.items]));
      setCursor(res.nextCursor);
      if (first) setMeta(res.meta);
    },
    [ideMessenger, ...deps],
  );

  useEffect(() => {
    void run(undefined);
    return () => {
      seq.current++;
    };
  }, [run, reloads]);

  return {
    items,
    meta,
    loading,
    loadingMore,
    error,
    slow,
    hasMore: cursor !== undefined,
    more: () => void run(cursor),
    reload: () => setReloads((n) => n + 1),
  };
}

function useIdeMessenger() {
  return useContext(IdeMessengerContext);
}
