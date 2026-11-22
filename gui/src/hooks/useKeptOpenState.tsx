import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * What the person opened or closed in the conversation, by row and part.
 * The transcript unmounts a row that scrolls away, which drops component
 * state; this outlives the row. It lives in memory only and is emptied when
 * the session changes, so it holds one conversation's choices at most.
 */
const kept = new Map<string, boolean>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget every choice. Called when another session takes the screen. */
export function clearKeptOpenState(): void {
  if (kept.size === 0) return;
  kept.clear();
  listeners.forEach((listener) => listener());
}

const ScopeContext = createContext<string | null>(null);

/**
 * Names the row (or, nested, a part of it such as one tool call) that the
 * disclosures inside belong to. The id must stay the same across remounts.
 */
export function KeptOpenScope({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const parent = useContext(ScopeContext);
  return (
    <ScopeContext.Provider value={parent === null ? id : `${parent}/${id}`}>
      {children}
    </ScopeContext.Provider>
  );
}

/**
 * Open or closed state that survives the row being unmounted.
 *
 * `open` follows `defaultOpen` (which may change, say with streaming) until
 * the person chooses; after that their choice wins. Outside a KeptOpenScope,
 * or with no part name, it is plain component state.
 */
export function useKeptOpenState(
  part: string | undefined,
  defaultOpen: boolean,
): [boolean, (next: boolean) => void] {
  const scope = useContext(ScopeContext);
  const key =
    scope === null || part === undefined ? undefined : `${scope}/${part}`;

  const [local, setLocal] = useState<boolean | undefined>(undefined);
  const stored = useSyncExternalStore(subscribe, () =>
    key === undefined ? undefined : kept.get(key),
  );

  const setOpen = useCallback(
    (next: boolean) => {
      if (key === undefined) {
        setLocal(next);
        return;
      }
      if (kept.get(key) === next) return;
      kept.set(key, next);
      listeners.forEach((listener) => listener());
    },
    [key],
  );

  return [(key === undefined ? local : stored) ?? defaultOpen, setOpen];
}
