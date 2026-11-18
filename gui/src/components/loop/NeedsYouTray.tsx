import { QuestionMarkCircleIcon } from "@heroicons/react/24/outline";
import type { LoopQuestion } from "core";
import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import { openLoopItems, replanDiff } from "core/util/loopMode";
import type { PlanDecision } from "core/util/planFile";
import { useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  acceptLoopPlan,
  answerLoopQuestion,
  endLoopThunk,
  startFreshThunk,
} from "../../redux/thunks/loop";
import { answerLimitQuestionThunk } from "../../redux/thunks/loopBudget";
import { recordPlanAnswer } from "../../util/planDecisions";
import {
  LoopQuestionRow,
  PlanDecisionRow,
} from "../QuestionPanel/QuestionPanel";
import { announce } from "../a11y/announcer";
import { useOpenQuestions } from "../QuestionPanel/useOpenQuestions";
import { useMainEditor } from "../mainInput/TipTapEditor";
import { jumpToPlan } from "./LoopStatusLine";
import { useLoopAnnouncements } from "./useLoopAnnouncements";
import { getLoopVisualState } from "./loopVisualState";

const BUTTON =
  "cursor-pointer rounded border border-solid border-border bg-transparent px-2 py-0.5 text-xs text-foreground hover:bg-input disabled:cursor-default disabled:opacity-50";
const PRIMARY =
  "cursor-pointer rounded border border-solid border-button bg-button px-2 py-0.5 text-xs text-button-foreground hover:bg-button-hover disabled:cursor-default disabled:opacity-50";

/** What the agent recommends for one waiting question, if it says. */
export type Waiting =
  | { kind: "decision"; decision: PlanDecision; recommended?: string }
  | { kind: "question"; question: LoopQuestion; recommended?: string };

const RECOMMENDED = /\(recommended\)/i;

/** The choice an agent marked "(recommended)" among a question's options. */
function labelled(options: string[] | undefined): string | undefined {
  return options?.find((o) => RECOMMENDED.test(o));
}

/**
 * The recommended choice of a loop question: its assumption when that is one
 * of the options, else the option the agent labelled "(recommended)".
 */
export function recommendedFor(question: LoopQuestion): string | undefined {
  if (question.kind === "approval") return undefined;
  const pick = question.assumption;
  return pick && question.options?.includes(pick)
    ? pick
    : labelled(question.options);
}

/** The same for a plan's decision: its pick, else a choice labelled "(recommended)". */
export function recommendedForDecision(
  decision: PlanDecision,
): string | undefined {
  return decision.pick && decision.options?.includes(decision.pick)
    ? decision.pick
    : labelled(decision.options);
}

/**
 * The one place above the input where the loop asks something of the person:
 * the re-plan to accept, or the questions its items hold, one at a time
 * ("1 of 3"). When nothing waits it is a single grey line saying so. The
 * decisions are the Questions panel's own rows (LoopQuestionRow and
 * PlanDecisionRow), so answering means the same thing in both. It feeds the
 * webview's live regions through useLoopAnnouncements and has none of its own.
 */
export function NeedsYouTray() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const { mainEditor } = useMainEditor();
  const loop = useAppSelector((s) => s.session.loop);
  const taskPlan = useAppSelector((s) => s.session.taskPlan);
  const { open, decisions, fileUri, setFileDecisions, itemText, count } =
    useOpenQuestions();
  const [index, setIndex] = useState(0);
  const [bulkError, setBulkError] = useState<string>();
  // The error is shown in the tray; the existing announcer says it, so the tray
  // adds no live region of its own
  useEffect(() => {
    if (bulkError) announce(maskCommandForDisplay(bulkError), "assertive");
  }, [bulkError]);
  const [bulkBusy, setBulkBusy] = useState(false);

  useLoopAnnouncements(loop, count);

  // A question that was answered leaves the list: keep the pager in range
  useEffect(() => {
    if (index >= count && count > 0) setIndex(count - 1);
  }, [count, index]);

  if (!loop) return null;

  const awaitingPlan = loop.status === "awaiting_plan";
  const diff =
    awaitingPlan && taskPlan ? replanDiff(loop, taskPlan) : undefined;
  const waiting: Waiting[] = [
    ...decisions.map((decision): Waiting => ({
      kind: "decision",
      decision,
      recommended: recommendedForDecision(decision),
    })),
    ...open.map((question): Waiting => ({
      kind: "question",
      question,
      recommended: recommendedFor(question),
    })),
  ];
  const current = waiting[Math.min(index, waiting.length - 1)];
  const withRecommended = waiting.filter((w) => w.recommended);

  const useRecommended = async () => {
    setBulkBusy(true);
    setBulkError(undefined);
    try {
      for (const w of withRecommended) {
        if (w.kind === "decision") {
          setFileDecisions(
            await recordPlanAnswer(
              ideMessenger.ide,
              fileUri!,
              w.decision.question,
              w.recommended!,
            ),
          );
        } else {
          const result = w.question.overBudget
            ? await dispatch(
                answerLimitQuestionThunk({
                  questionId: w.question.id,
                  choice: w.recommended!,
                }),
              ).unwrap()
            : await dispatch(
                answerLoopQuestion({
                  questionId: w.question.id,
                  text: w.recommended!,
                }),
              ).unwrap();
          if (!result.ok) {
            setBulkError(result.error);
            break;
          }
        }
      }
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  if (!awaitingPlan && count === 0) {
    return <QuietLine />;
  }

  return (
    <section
      data-testid="needs-you-tray"
      aria-label="Needs you"
      className="mx-1 mb-1 rounded border border-solid border-warning px-2 py-1 text-xs"
    >
      <div className="flex items-center gap-1 text-description">
        <QuestionMarkCircleIcon
          className="h-3 w-3 shrink-0"
          aria-hidden="true"
        />
        <span className="font-medium text-foreground">Needs you</span>
        <span
          data-testid="needs-you-count"
          className="rounded-full bg-warning/20 px-1.5 text-2xs text-foreground"
        >
          {count + (awaitingPlan ? 1 : 0)}
        </span>
      </div>
      {awaitingPlan && (
        <div data-testid="needs-you-plan" className="mt-1">
          {loop.replanReason && (
            <div
              data-testid="needs-you-plan-reason"
              title={loop.replanReason}
              className="line-clamp-2 break-words"
            >
              <span className="text-description">Why you are asked: </span>
              {loop.replanReason}
            </div>
          )}
          {diff && (
            <div data-testid="needs-you-plan-diff" className="text-description">
              {diff.kept.length} kept, {diff.added.length} added,{" "}
              {diff.dropped.length} dropped
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <button
              type="button"
              data-testid="needs-you-review-diff"
              className={BUTTON}
              title="Show the plan and its changes in the transcript"
              onClick={() => void jumpToPlan()}
            >
              Review diff
            </button>
            <button
              type="button"
              data-testid="needs-you-keep-planning"
              className={BUTTON}
              title="Do not accept yet: say what to change"
              onClick={() => mainEditor?.commands.focus()}
            >
              Keep planning
            </button>
            <button
              type="button"
              data-testid="needs-you-accept-plan"
              className={PRIMARY}
              title="Accept this plan and start the loop's next round. Edit the file first if you like; the loop reads it again."
              onClick={() => void dispatch(acceptLoopPlan())}
            >
              Accept plan
            </button>
          </div>
        </div>
      )}
      {current && (
        <div data-testid="needs-you-question" className="mt-1">
          <div className="flex items-center gap-1 text-description">
            <span data-testid="needs-you-pager" aria-label="Question">
              {Math.min(index, waiting.length - 1) + 1} of {waiting.length}
            </span>
            {waiting.length > 1 && (
              <span className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  data-testid="needs-you-prev"
                  aria-label="Previous question"
                  disabled={index <= 0}
                  className={BUTTON}
                  onClick={() => setIndex(Math.max(0, index - 1))}
                >
                  ‹
                </button>
                <button
                  type="button"
                  data-testid="needs-you-next"
                  aria-label="Next question"
                  disabled={index >= waiting.length - 1}
                  className={BUTTON}
                  onClick={() =>
                    setIndex(Math.min(waiting.length - 1, index + 1))
                  }
                >
                  ›
                </button>
              </span>
            )}
          </div>
          <ul className="m-0 list-none p-0">
            {current.kind === "decision" ? (
              <PlanDecisionRow
                key={current.decision.question}
                decision={current.decision}
                fileUri={fileUri!}
                onRecorded={setFileDecisions}
              />
            ) : (
              <LoopQuestionRow
                key={current.question.id}
                question={current.question}
                itemText={itemText(current.question.itemId)}
              />
            )}
          </ul>
          {withRecommended.length >= 2 && (
            <div className="mt-1">
              <button
                type="button"
                data-testid="needs-you-use-recommended"
                disabled={bulkBusy}
                className={BUTTON}
                title="Answer every question that has a recommended choice with it"
                onClick={() => void useRecommended()}
              >
                {withRecommended.length === waiting.length
                  ? `Use recommended for all ${waiting.length}`
                  : `Use recommended for ${withRecommended.length} of ${waiting.length}`}
              </button>
            </div>
          )}
          {bulkError && (
            <div
              data-testid="needs-you-bulk-error"
              className="mt-0.5 break-words text-error"
            >
              {maskCommandForDisplay(bulkError)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The grey line when nothing waits, saying what the loop is doing instead. */
function QuietLine() {
  const dispatch = useAppDispatch();
  const loop = useAppSelector((s) => s.session.loop);
  if (!loop) return null;
  const state = getLoopVisualState(loop);
  const done = loop.items.filter((i) => i.status === "done" && !i.skipped);
  const left = openLoopItems(loop);
  const link =
    "cursor-pointer border-none bg-transparent p-0 text-xs text-link underline";

  let content: React.ReactNode;
  if (state === "finished") {
    content = (
      <>
        Loop finished: {done.length} of {loop.items.length} done in {loop.round}{" "}
        round{loop.round === 1 ? "" : "s"}.{" "}
        <button
          type="button"
          data-testid="needs-you-new-plan"
          className={link}
          onClick={() => void dispatch(endLoopThunk())}
        >
          Start a new plan
        </button>
      </>
    );
  } else if (state === "stopped" || state === "failed") {
    const failedStop = loop.status === "stopped";
    content = (
      <>
        {failedStop ? "Stopped" : "Nothing needs you"}.{" "}
        {failedStop
          ? `${left} to-do${left === 1 ? "" : "s"} left.`
          : `Repairing item ${loop.current?.itemId ?? ""} automatically.`}{" "}
        {failedStop && left > 0 && (
          <button
            type="button"
            data-testid="needs-you-start-fresh"
            className={link}
            onClick={() => void dispatch(startFreshThunk())}
          >
            Start fresh
          </button>
        )}
      </>
    );
  } else {
    content = (
      <>
        Nothing needs you
        {state === "running" ? ". The loop is running." : " right now."}
      </>
    );
  }
  return (
    <section
      data-testid="needs-you-tray"
      data-quiet="true"
      aria-label="Needs you"
      className="mx-1 mb-1 px-2 py-0.5 text-xs text-description"
    >
      {content}
    </section>
  );
}
