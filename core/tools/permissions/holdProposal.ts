import {
  remainingMs,
  remainingSeconds,
  resolve,
  type Proposal,
  type Resolved,
} from "./decisionTimer";

/**
 * Holds a proposal until the person answers or the window ends, and reports
 * the seconds left for a countdown. The editor and the CLI both call this, so
 * the rules are the same on both: the first of an answer or the end of the
 * window decides, an answer after that is ignored, and stopping the turn
 * cancels the hold without deciding anything.
 */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface HoldOptions {
  /** Resolves with the person's choice, if they make one. May never resolve. */
  answered: Promise<"allow" | "deny">;
  /** Called with the whole seconds left, now and then once a second until it ends */
  onTick?: (secondsLeft: number) => void;
  /** Aborting cancels the hold: the result is undefined and nothing is decided */
  signal?: AbortSignal;
  scheduler?: Scheduler;
}

export function holdProposal(
  p: Proposal,
  options: HoldOptions,
): Promise<Resolved | undefined> {
  const s = options.scheduler ?? realScheduler;
  return new Promise((resolvePromise) => {
    let done = false;
    let timer: unknown;

    const finish = (value: Resolved | undefined) => {
      if (done) return;
      done = true;
      if (timer !== undefined) s.clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise(value);
    };
    const onAbort = () => finish(undefined);

    if (options.signal?.aborted) return finish(undefined);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let lastShown = -1;
    const step = () => {
      if (done) return;
      const now = s.now();
      const left = remainingSeconds(p, now);
      if (left !== lastShown) {
        lastShown = left;
        options.onTick?.(left);
      }
      if (remainingMs(p, now) === 0) {
        finish(resolve(p, undefined, now));
        return;
      }
      // Wake at the next whole-second change, or when the window ends
      const toNextSecond = remainingMs(p, now) % 1000 || 1000;
      timer = s.setTimeout(step, toNextSecond);
    };

    options.answered.then(
      (answer) => finish(resolve(p, answer, s.now())),
      () => {
        /* an answer that cannot arrive leaves the window to decide */
      },
    );
    step();
  });
}
