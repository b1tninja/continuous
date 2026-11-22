import { useCallback, useEffect, useRef, useState } from "react";

/**
 * When the connection test runs by itself. The rule, in one place:
 *
 * 1. A server is picked (a found server, a usual address): at once.
 * 2. A key or an address is pasted: 300 ms after the paste, once the form
 *    holds the pasted text.
 * 3. A key or an address is typed: after a pause of one second, and only if
 *    it looks complete (a key of 20 characters or more with no space; an
 *    http or https address with a host). Never on a keystroke.
 *
 * In every case the required fields must be filled, and the same provider,
 * address and key are tested by themselves only once: after that the person
 * presses the button. Any change to them drops a test that is waiting, and
 * the tester throws away the answer of one that is already on its way.
 */
export const AUTO_TEST_PAUSE_MS = 1000;
export const AUTO_TEST_AFTER_PASTE_MS = 300;
export const COMPLETE_KEY_MIN_LENGTH = 20;
// A paste or a pick reaches the form a render or two later; a change within
// this long of one is taken to be its result.
const CAUSE_WINDOW_MS = 100;

export function looksLikeCompleteKey(key: string | undefined): boolean {
  return (
    !!key && key.length >= COMPLETE_KEY_MIN_LENGTH && !/\s/.test(key.trim())
  );
}

export function looksLikeAddress(address: string | undefined): boolean {
  try {
    const url = new URL((address ?? "").trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname
    );
  } catch {
    return false;
  }
}

export interface AutoTestInput {
  /** Provider, address and key as one string: what a test would be about. */
  signature: string;
  /** Required fields are filled and there is something to test with. */
  canTest: boolean;
  /** What was typed looks finished (rule 3). */
  looksComplete: boolean;
}

export interface AutoTest {
  /** Goes up by one each time a test should run by itself. */
  token: number;
  /** Call from the field's onPaste. */
  pasted: () => void;
  /** Call when the person types in a field the test is about. */
  typed: () => void;
  /** Call when a server or a usual address is picked. */
  picked: () => void;
}

export function useAutoTest({
  signature,
  canTest,
  looksComplete,
}: AutoTestInput): AutoTest {
  const [token, setToken] = useState(0);
  // Bumped by picked(), so a pick that leaves the form as it was still counts
  const [picks, setPicks] = useState(0);
  const pastedAt = useRef(-Infinity);
  const typedAt = useRef(-Infinity);
  const pickedAt = useRef(-Infinity);
  const tested = useRef<string>(undefined);
  const latest = useRef({ signature, canTest });
  latest.current = { signature, canTest };

  useEffect(() => {
    const now = Date.now();
    const why =
      now - pickedAt.current < CAUSE_WINDOW_MS
        ? "pick"
        : now - pastedAt.current < CAUSE_WINDOW_MS
          ? "paste"
          : now - typedAt.current < CAUSE_WINDOW_MS
            ? "typed"
            : undefined;
    // A change the person did not make (the form filling itself in) tests nothing
    if (!why || (why === "typed" && !looksComplete)) return;
    const delay =
      why === "pick"
        ? 0
        : why === "paste"
          ? AUTO_TEST_AFTER_PASTE_MS
          : AUTO_TEST_PAUSE_MS;
    const timer = setTimeout(() => {
      const form = latest.current;
      if (!form.canTest || tested.current === form.signature) return;
      tested.current = form.signature;
      setToken((t) => t + 1);
    }, delay);
    // A change before the delay is over: this test is not run
    return () => clearTimeout(timer);
  }, [signature, picks]);

  const pasted = useCallback(() => {
    pastedAt.current = Date.now();
  }, []);
  const typed = useCallback(() => {
    typedAt.current = Date.now();
  }, []);
  const picked = useCallback(() => {
    pickedAt.current = Date.now();
    setPicks((n) => n + 1);
  }, []);

  return { token, pasted, typed, picked };
}
