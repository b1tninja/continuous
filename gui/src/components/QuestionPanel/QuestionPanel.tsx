import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import { QuestionMarkCircleIcon } from "@heroicons/react/24/outline";
import type { LoopQuestion } from "core";
import { LOOP_LIMITS } from "core/util/loopMode";
import { answeredDecisions, type PlanDecision } from "core/util/planFile";
import { createContext, useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  answerLoopQuestion,
  type LoopAnswerInput,
} from "../../redux/thunks/loop";
import { answerLimitQuestionThunk } from "../../redux/thunks/loopBudget";
import { autoAnswerPlanFile, recordPlanAnswer } from "../../util/planDecisions";
import { policyLevelLabel } from "core/tools/permissions/policy";
import { autoAnsweredLine } from "core/util/autoAnswer";
import { AnswerChoices } from "./AnswerChoices";
import { useOpenQuestions } from "./useOpenQuestions";

/**
 * True below the Questions panel's provider: the plan card then leaves its
 * decisions to the panel instead of showing them a second time.
 */
export const QuestionPanelContext = createContext(false);

const KIND_LABEL: Record<LoopQuestion["kind"], string> = {
  blocking: "Waiting on you",
  assumption: "Going on with a default",
  approval: "Needs your approval",
};

const buttonClass =
  "cursor-pointer rounded border border-solid border-border bg-transparent px-1.5 text-xs text-foreground hover:bg-input disabled:cursor-default disabled:opacity-50";

/** One question a loop item holds: choices and Other, or a free answer. */
export function LoopQuestionRow({
  question,
  itemText,
}: {
  question: LoopQuestion;
  itemText?: string;
}) {
  const dispatch = useAppDispatch();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const answer = async (input: Omit<LoopAnswerInput, "questionId">) => {
    const result = await dispatch(
      answerLoopQuestion({ ...input, questionId: question.id }),
    ).unwrap();
    setError(result.ok ? undefined : result.error);
    if (result.ok) setText("");
  };
  // An item out of its own budget: the choice is applied by the limit policy
  const answerLimit = async (choice: string) => {
    const result = await dispatch(
      answerLimitQuestionThunk({ questionId: question.id, choice }),
    ).unwrap();
    setError(result.ok ? undefined : result.error);
  };
  const hasOptions =
    question.kind !== "approval" && (question.options?.length ?? 0) > 1;

  return (
    <li
      data-testid={`loop-question-${question.id}`}
      className="mt-1 rounded border border-solid border-border px-1.5 py-1"
    >
      <div className="text-2xs text-description-muted">
        {question.id} · {KIND_LABEL[question.kind]}
        {itemText ? ` · ${itemText}` : ""}
      </div>
      <div className="break-words text-foreground">
        {maskCommandForDisplay(question.question)}
      </div>
      {question.assumption && (
        <div className="break-words text-description">
          Assumed: {question.assumption}
        </div>
      )}
      {question.kind === "approval" ? (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
          <button
            type="button"
            data-testid="loop-approve"
            className={buttonClass}
            onClick={() => void answer({ text: "", approve: true })}
          >
            Allow once
          </button>
          <button
            type="button"
            data-testid="loop-deny"
            className={buttonClass}
            onClick={() => void answer({ text, approve: false })}
          >
            Don't allow
          </button>
        </div>
      ) : (
        <>
          {hasOptions ? (
            <AnswerChoices
              options={question.options!}
              pick={question.assumption}
              testIdPrefix="loop-choice"
              maxLength={LOOP_LIMITS.maxAnswerLength}
              onChoose={(choice) =>
                question.overBudget
                  ? answerLimit(choice)
                  : answer({ text: choice })
              }
            />
          ) : (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              <input
                data-testid="loop-answer-input"
                value={text}
                maxLength={LOOP_LIMITS.maxAnswerLength}
                placeholder={
                  question.kind === "assumption"
                    ? "Overrule with your answer"
                    : "Your answer"
                }
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && text.trim()) {
                    e.preventDefault();
                    void answer({ text });
                  }
                }}
                className="min-w-0 flex-1 basis-32 rounded border border-solid border-border bg-input px-1 text-xs text-foreground placeholder:text-description-muted"
              />
              <button
                type="button"
                data-testid="loop-answer-send"
                disabled={!text.trim()}
                className={buttonClass}
                onClick={() => void answer({ text })}
              >
                Answer
              </button>
            </div>
          )}
          {question.kind === "assumption" && (
            <div className="mt-1">
              <button
                type="button"
                data-testid="loop-confirm"
                className={buttonClass}
                onClick={() => void answer({ text: "", confirm: true })}
              >
                Keep the default
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <div role="alert" className="mt-0.5 break-words text-error">
          {error}
        </div>
      )}
    </li>
  );
}

/** One decision a plan leaves to the person. The answer goes in the plan file. */
export function PlanDecisionRow({
  decision,
  fileUri,
  onRecorded,
}: {
  decision: PlanDecision;
  fileUri: string;
  onRecorded: (decisions: PlanDecision[]) => void;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [error, setError] = useState<string>();
  const choose = async (answer: string) => {
    try {
      onRecorded(
        await recordPlanAnswer(
          ideMessenger.ide,
          fileUri,
          decision.question,
          answer,
        ),
      );
      setError(undefined);
    } catch (e) {
      setError(
        `Could not record the answer in the plan file: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  const options = decision.options ?? [];
  return (
    <li
      data-testid="plan-decision"
      className="mt-1 rounded border border-solid border-border px-1.5 py-1"
    >
      <div className="text-2xs text-description-muted">
        Plan decision{decision.type ? ` · ${decision.type}` : ""}
        {decision.todos?.length
          ? ` · to-dos ${decision.todos.join(", ")} wait on it`
          : ""}
      </div>
      <div className="break-words text-foreground">{decision.question}</div>
      <AnswerChoices
        options={options}
        pick={decision.pick}
        testIdPrefix="plan-decision"
        onChoose={(answer) => choose(answer)}
      />
      {error && (
        <div role="alert" className="mt-0.5 break-words text-error">
          {error}
        </div>
      )}
    </li>
  );
}

/**
 * Every question waiting on the person, in one place above the input: what a
 * loop's items hold and the decisions of the plan on the table. Each offers
 * the agent's choices and "Other". Without a question it renders nothing.
 */
export function QuestionPanel() {
  const {
    open,
    decisions,
    fileUri,
    fileDecisions,
    setFileDecisions,
    itemText,
    count,
    level,
    neverAsk,
  } = useOpenQuestions();
  const ideMessenger = useContext(IdeMessengerContext);

  // Questions is IDGAF: a plan's open decisions are answered from what it
  // offered, so the person is shown a line and nothing waits (a plan made
  // earlier or opened later is covered here; present_plan covers a new one)
  const [autoLines, setAutoLines] = useState<string[]>([]);
  useEffect(() => {
    if (!neverAsk || !fileUri || !fileDecisions) return;
    if (fileDecisions.every((d) => d.answer)) return;
    let cancelled = false;
    void autoAnswerPlanFile(ideMessenger.ide, fileUri)
      .then((answers) => {
        if (cancelled || answers.length === 0) return;
        const source = `Questions: ${policyLevelLabel("questions", level)}`;
        setFileDecisions((previous) =>
          answeredDecisions(previous ?? [], answers),
        );
        setAutoLines((lines) => [
          ...lines,
          ...answers.map((a) => autoAnsweredLine(a.question, a.answer)),
        ]);
        answers.forEach((a, i) => {
          void ideMessenger.request("audit/autoAnswer", {
            callId: `plan-decision-${Date.now()}-${i}`,
            question: a.question,
            answer: a.answer,
            source,
          });
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [neverAsk, fileUri, fileDecisions, ideMessenger, level]);

  const autoNotice = autoLines.length > 0 && (
    <div
      data-testid="auto-answered"
      className="mx-1 mb-1 px-2 text-2xs text-description-muted"
    >
      {autoLines.map((line) => (
        <div key={line} className="break-words">
          {line}
        </div>
      ))}
    </div>
  );
  if (count === 0) return autoNotice || null;

  return (
    <>
      {autoNotice}
      <div
        data-testid="question-panel"
        role="region"
        aria-label="Questions for you"
        className="mx-1 mb-1 rounded border border-solid border-link px-2 py-1 text-xs"
      >
        <div className="flex items-center gap-1 text-description">
          <QuestionMarkCircleIcon className="h-3 w-3 shrink-0" />
          <span className="font-medium text-foreground">
            {count} question{count === 1 ? "" : "s"} for you
          </span>
        </div>
        <ul className="m-0 max-h-72 list-none overflow-y-auto p-0">
          {decisions.map((d) => (
            <PlanDecisionRow
              key={d.question}
              decision={d}
              fileUri={fileUri!}
              onRecorded={setFileDecisions}
            />
          ))}
          {open.map((q) => (
            <LoopQuestionRow
              key={q.id}
              question={q}
              itemText={itemText(q.itemId)}
            />
          ))}
        </ul>
      </div>
    </>
  );
}
