import { useCallback, useEffect, useId, useRef } from "react";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import type {
  InterruptAction,
  InterruptConfirmRequest,
} from "../redux/slices/uiSlice";
import {
  answerInterruptConfirm,
  isInterruptStillNeeded,
  selectRunningWork,
  type RunningWork,
} from "../redux/thunks/interruptConfirm";

/**
 * A key pressed this soon after the question opened does not answer it: a
 * key that was already held, or a second press of the one that opened it.
 */
export const INTERRUPT_CONFIRM_ARM_MS = 300;

/** How many prompts show each question, so the last one gone closes it. */
const mounted = new Map<number, number>();

interface Copy {
  title: string;
  confirm: string;
  keep: string;
  verb: string;
}

const COPY: Record<InterruptAction, Copy> = {
  stop: {
    title: "Stop the response?",
    confirm: "Stop",
    keep: "Keep going",
    verb: "stop",
  },
  newSession: {
    title: "Stop the agent and start a new chat?",
    confirm: "Stop and start new",
    keep: "Keep working",
    verb: "stop and start a new chat",
  },
  openSession: {
    title: "Stop the agent and open the other chat?",
    confirm: "Stop and open",
    keep: "Keep working",
    verb: "stop and open it",
  },
  switchTab: {
    title: "Stop the agent and switch tabs?",
    confirm: "Stop and switch",
    keep: "Keep working",
    verb: "stop and switch",
  },
};

/** What is running, as the first sentence of a session switch's question. */
export function describeRunningWork(work: RunningWork | undefined): string {
  if (!work) return "The agent is working in this chat.";
  const parts: string[] = [];
  if (work.streaming) parts.push("the agent is still writing its reply");
  else if (work.running) parts.push("a tool is running");
  else if (work.awaitingApproval) {
    parts.push("a tool call is waiting for your approval");
  }
  if (work.loop) parts.push("a loop is running");
  const text = parts.join(", and ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function detailFor(action: InterruptAction, work: RunningWork | undefined) {
  if (action === "stop") {
    return "What it wrote so far is kept, and so is your unsent message. Resume carries on from there.";
  }
  return `${describeRunningWork(work)} Stopping keeps this chat in History with what it did so far, and Resume carries on when you open it again. Your unsent message is kept.`;
}

/**
 * The question asked before a key or a session switch stops running work
 * (thunks/interruptConfirm). Enter (or the first button) stops, Esc (or the
 * second) keeps going. Focus moves into it, so Enter cannot send the input,
 * and goes back where it was when it closes. It closes as "keep going" when
 * the work ends meanwhile or the page that shows it goes away.
 *
 * Rendered by the chat above its input, and by the layout on other pages
 * (`floating`), so one is always mounted to answer.
 */
export function InterruptConfirm({ floating }: { floating?: boolean }) {
  const request = useAppSelector((s) => s.ui.interruptConfirm);
  if (!request) return null;
  return (
    <InterruptConfirmPrompt
      key={request.id}
      request={request}
      floating={floating}
    />
  );
}

function InterruptConfirmPrompt({
  request,
  floating,
}: {
  request: InterruptConfirmRequest;
  floating?: boolean;
}) {
  const dispatch = useAppDispatch();
  const { id, action } = request;
  const copy = COPY[action];
  const work = useAppSelector(selectRunningWork);
  const stillNeeded = useAppSelector((s) => isInterruptStillNeeded(s, action));
  const ref = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const openedAt = useRef(Date.now());
  const titleId = useId();
  const detailId = useId();

  const answer = useCallback(
    (confirmed: boolean) => {
      void dispatch(answerInterruptConfirm({ id, confirmed }));
    },
    [dispatch, id],
  );

  // Focus comes in, and goes back to where it was (the input, mostly). A
  // question whose page went away closes as "keep going"; checked a tick
  // later, so a remount (StrictMode, a re-render of the page) keeps it.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    mounted.set(id, (mounted.get(id) ?? 0) + 1);
    ref.current?.focus();
    return () => {
      mounted.set(id, (mounted.get(id) ?? 1) - 1);
      setTimeout(() => {
        if (!mounted.get(id)) {
          mounted.delete(id);
          answer(false);
        }
      }, 0);
      if (previous?.isConnected) previous.focus();
    };
  }, [answer, id]);

  // The reply ended (or the work did) while the question was open
  useEffect(() => {
    if (!stillNeeded) answer(false);
  }, [stillNeeded, answer]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        answer(false);
        return;
      }
      if (event.key !== "Enter") return;
      // Enter answers only from inside the question: in the input it sends
      const inside = !!ref.current?.contains(document.activeElement);
      if (!inside) return;
      // The Keep button's own Enter clicks it
      if (document.activeElement === keepRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const tooSoon = Date.now() - openedAt.current < INTERRUPT_CONFIRM_ARM_MS;
      const modified =
        event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;
      if (event.repeat || tooSoon || modified) return;
      answer(true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [answer]);

  const placement = floating
    ? "fixed inset-x-2 bottom-2 z-50 shadow-lg"
    : "mx-1 mb-1";

  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      tabIndex={-1}
      data-testid="interrupt-confirm"
      data-action={action}
      className={`${placement} rounded border border-solid border-warning bg-editor px-2 py-1.5 text-xs outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-border`}
    >
      <div id={titleId} className="font-semibold text-foreground">
        {copy.title}
      </div>
      <div id={detailId} className="mt-0.5 text-description">
        {detailFor(action, work)}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          data-testid="interrupt-confirm-yes"
          aria-keyshortcuts="Enter"
          onClick={() => answer(true)}
          className="min-h-6 cursor-pointer rounded border border-solid border-warning bg-transparent px-2 text-xs text-foreground hover:brightness-125"
        >
          {copy.confirm}
        </button>
        <button
          ref={keepRef}
          type="button"
          data-testid="interrupt-confirm-keep"
          aria-keyshortcuts="Escape"
          onClick={() => answer(false)}
          className="min-h-6 cursor-pointer rounded border border-solid border-border bg-transparent px-2 text-xs text-foreground hover:brightness-125"
        >
          {copy.keep}
        </button>
        <span className="text-description" aria-hidden="true">
          Enter to {copy.verb} · Esc to keep going
        </span>
      </div>
    </div>
  );
}
