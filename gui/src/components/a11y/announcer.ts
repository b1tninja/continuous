import { useSyncExternalStore } from "react";

export type Politeness = "polite" | "assertive";

export interface Announcement {
  text: string;
  /** Bumps on every announce, so the same sentence twice is read twice. */
  seq: number;
}

type Listener = () => void;

const EMPTY: Announcement = { text: "", seq: 0 };
const state: Record<Politeness, Announcement> = {
  polite: EMPTY,
  assertive: EMPTY,
};
const listeners = new Set<Listener>();

/**
 * Says something to a screen reader through the live regions in
 * <LiveRegions/>. Callers must pass text that is already safe to read aloud
 * (masked with maskCommandForDisplay when it can hold a command).
 */
export function announce(text: string, politeness: Politeness = "polite") {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
  state[politeness] = { text: clean, seq: state[politeness].seq + 1 };
  listeners.forEach((l) => l());
}

export function getAnnouncement(politeness: Politeness): Announcement {
  return state[politeness];
}

/** For tests. */
export function resetAnnouncer() {
  state.polite = EMPTY;
  state.assertive = EMPTY;
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useAnnouncement(politeness: Politeness): Announcement {
  return useSyncExternalStore(
    subscribe,
    () => state[politeness],
    () => EMPTY,
  );
}
