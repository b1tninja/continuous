import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import { ClipboardDocumentListIcon } from "@heroicons/react/24/outline";
import { ToolCallState } from "core";
import {
  autonomyForPolicy,
  LOOP_AUTONOMY,
  replanDiff,
  type ReplanDiffItem,
} from "core/util/loopMode";
import {
  budgetFromInput,
  NO_PLAN_BUDGET,
  type PlanBudgetSetup,
} from "core/util/planBudget";
import {
  planCheckSummary,
  validatePlanArgs,
  type PlanDecision,
} from "core/util/planFile";
import { useContext, useState } from "react";
import { QuestionPanelContext } from "../../../components/QuestionPanel";
import { useMainEditor } from "../../../components/mainInput/TipTapEditor";
import StyledMarkdownPreview from "../../../components/StyledMarkdownPreview";
import { Button } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { setMode } from "../../../redux/slices/sessionSlice";
import { buildPlan } from "../../../redux/thunks/buildPlan";
import { startLoopFromPlan } from "../../../redux/thunks/loop";
import { selectLoopPolicy } from "../../../redux/selectors/selectAutoApproval";
import { recordPlanAnswer } from "../../../util/planDecisions";
import { PlanTree } from "../../../components/loop/PlanTree";
import { treeSummary } from "../../../components/loop/planTreeModel";
import { PlanBudgetStep } from "./PlanBudgetStep";

/** The mark of a to-do in a re-plan: what the loop already did with it. */
function todoMark(text: string, kept: ReplanDiffItem[] | undefined): string {
  const status = kept?.find((k) => k.text === text)?.status;
  switch (status) {
    case "done":
      return "[x]";
    case "failed":
      return "[!]";
    case "waiting":
      return "[?]";
    default:
      return "[ ]";
  }
}

interface PlanCardProps {
  toolCallState: ToolCallState;
  historyIndex: number;
}

/**
 * The plan a present_plan call proposed: the plan text, its to-dos, a link
 * to the file (where the person can edit it), and Build / Keep planning while
 * nothing has been sent since.
 */
export function PlanCard({ toolCallState, historyIndex }: PlanCardProps) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const { mainEditor } = useMainEditor();
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  // The decisions' answers as the plan file has them after the last one
  // recorded here, by question; the file stays the source of truth.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // A typed answer for a decision without options, by its index.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  // Once the person sends anything after the plan, the choice has been made.
  const answered = useAppSelector((s) =>
    s.session.history
      .slice(historyIndex + 1)
      .some((item) => item.message.role === "user"),
  );

  // Loop mode: this card is the loop's re-plan, waiting to be accepted
  const loopStatus = useAppSelector((s) => s.session.loop?.status);
  const loop = useAppSelector((s) => s.session.loop);
  const taskPlan = useAppSelector((s) => s.session.taskPlan);
  // The budget step is out of sight until asked for; Skip leaves it at None
  const planLevel = useAppSelector((s) => selectLoopPolicy(s).plan);
  const questionsLevel = useAppSelector((s) => selectLoopPolicy(s).questions);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budgetDraft, setBudgetDraft] =
    useState<PlanBudgetSetup>(NO_PLAN_BUDGET);
  const [budgetApplied, setBudgetApplied] = useState<PlanBudgetSetup>();
  const isLatestPlanCard = useAppSelector((s) => {
    const later = s.session.history
      .slice(historyIndex + 1)
      .some((item) =>
        item.toolCallStates?.some(
          (tc) => tc.toolCall.function.name === "present_plan",
        ),
      );
    return !later;
  });
  const args = validatePlanArgs(toolCallState.parsedArgs ?? {});
  const output = toolCallState.output?.[0];
  const fileUri = output?.uri?.type === "file" ? output.uri.value : undefined;
  const relativePath = output?.description;
  const status = toolCallState.status;

  if (status === "generating" || status === "generated") {
    return (
      <div className="px-4 py-1 text-xs text-description">
        Writing the plan…
      </div>
    );
  }
  if (status !== "done" || !fileUri) {
    // Errors and cancels are shown by ToolCallDiv like any other tool call.
    return (
      <div className="px-4 py-1 text-xs text-description">
        The plan was not saved.
      </div>
    );
  }

  const awaitingLoop = loopStatus === "awaiting_plan" && isLatestPlanCard;
  const diff =
    awaitingLoop && loop && taskPlan ? replanDiff(loop, taskPlan) : undefined;
  const loopActive = !!loopStatus && loopStatus !== "stopped";
  // Loop mode: the to-dos are the plan tree, not the plain list. A loop that
  // has ended keeps its tree while this card is still its plan.
  const treeMode =
    !!loop &&
    !!taskPlan &&
    isLatestPlanCard &&
    (loopActive ||
      loop.items.some((i) => taskPlan.items.some((t) => t.id === i.id)));

  const showActions =
    (!answered && !isStreaming && !loopActive) || awaitingLoop;
  // The Questions panel above the input answers the latest plan's decisions
  const panelAnswers = useContext(QuestionPanelContext) && showActions;

  /** Writes the answer into the plan file's Decisions section and shows it. */
  const answerDecision = async (decision: PlanDecision, answer: string) => {
    if (!answer.trim()) return;
    try {
      const decisions = await recordPlanAnswer(
        ideMessenger.ide,
        fileUri,
        decision.question,
        answer,
      );
      const recorded: Record<string, string> = {};
      for (const d of decisions) {
        if (d.answer) recorded[d.question] = d.answer;
      }
      setAnswers(recorded);
    } catch (e) {
      console.warn("Could not record the decision in the plan file", e);
    }
  };

  return (
    <div
      data-testid="plan-card"
      className="mx-2 my-1 rounded border border-solid border-border px-3 py-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
        <ClipboardDocumentListIcon className="h-4 w-4 shrink-0 text-description" />
        <span className="min-w-0 flex-1 basis-32 font-medium break-words">
          {args.ok ? args.title : output?.name}
        </span>
        <button
          type="button"
          data-testid="plan-card-open"
          title="Open the plan file to edit it"
          onClick={() => void ideMessenger.ide.openFile(fileUri)}
          className="max-w-full min-w-0 cursor-pointer truncate border-none bg-transparent p-0 text-left text-xs text-link hover:underline"
        >
          {relativePath ?? "Open plan"}
        </button>
      </div>
      {treeMode && loop && (
        <div
          data-testid="plan-card-diff"
          className="mt-0.5 text-xs text-description"
        >
          {treeSummary(loop, diff)}
        </div>
      )}
      {treeMode && loop && taskPlan && (
        <div className="mt-1">
          <PlanTree loop={loop} plan={taskPlan} diff={diff} />
        </div>
      )}
      {args.ok && args.body && (
        <details
          open={!awaitingLoop && !treeMode}
          data-testid="plan-card-body"
          className="mt-1 text-sm"
        >
          {(awaitingLoop || treeMode) && (
            <summary className="cursor-pointer text-xs text-description">
              Full plan text
            </summary>
          )}
          <div className="max-h-96 overflow-y-auto">
            <StyledMarkdownPreview
              source={args.body}
              itemIndex={historyIndex}
              useParentBackgroundColor
            />
          </div>
        </details>
      )}
      {args.ok && args.decisions.length > 0 && !panelAnswers && (
        <div data-testid="plan-card-decisions" className="mt-1 text-xs">
          <div className="text-description">
            Decisions for you (answer here, in the plan file, or in your
            message):
          </div>
          <ol className="m-0 mt-0.5 pl-4 text-description">
            {args.decisions.map((decision, i) => {
              const answer = answers[decision.question];
              return (
                <li key={i} className="py-0.5 break-words">
                  {decision.question}
                  {decision.type && (
                    <span className="text-description-muted">
                      {" "}
                      ({decision.type})
                    </span>
                  )}
                  {decision.options && decision.options.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1">
                      {decision.options.map((option) => (
                        <Button
                          key={option}
                          size="sm"
                          variant={answer === option ? "primary" : "outline"}
                          data-testid="plan-card-decision-option"
                          disabled={!showActions}
                          title={
                            option === decision.pick
                              ? "The model's pick. Click to record it in the plan file"
                              : "Click to record this answer in the plan file"
                          }
                          className="my-0.5"
                          onClick={() => void answerDecision(decision, option)}
                        >
                          {option === decision.pick
                            ? `${option} (pick)`
                            : option}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <form
                      className="flex flex-wrap items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void answerDecision(decision, drafts[i] ?? "");
                      }}
                    >
                      <input
                        type="text"
                        data-testid="plan-card-decision-answer"
                        placeholder="Your answer"
                        disabled={!showActions}
                        value={drafts[i] ?? ""}
                        onChange={(e) =>
                          setDrafts({ ...drafts, [i]: e.target.value })
                        }
                        className="min-w-0 flex-1 basis-40 rounded border border-solid border-border bg-transparent px-1 text-xs text-foreground placeholder:text-description-muted"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        data-testid="plan-card-decision-submit"
                        disabled={!showActions || !drafts[i]?.trim()}
                        className="my-0.5"
                      >
                        Answer
                      </Button>
                    </form>
                  )}
                  {answer && (
                    <div
                      data-testid="plan-card-decision-answered"
                      className="text-description-muted"
                    >
                      Answer: {answer}
                    </div>
                  )}
                  {decision.todos && decision.todos.length > 0 && (
                    <div className="text-description-muted">
                      To-dos {decision.todos.join(", ")} wait on this.
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {args.ok && !treeMode && (
        <ul
          data-testid="plan-card-todos"
          className="m-0 mt-1 list-none p-0 text-xs text-description"
        >
          {args.items.map((item, i) => (
            <li key={i} className="py-0.5 break-words">
              <span className="font-mono text-description-muted">
                {todoMark(String(item.text), diff?.kept)}
              </span>{" "}
              {String(item.text)}
              {typeof item.check === "string" && item.check.trim() && (
                <div className="pl-5 font-mono text-description-muted">
                  check: {maskCommandForDisplay(item.check.trim())}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {args.ok && planCheckSummary(args.items) && (
        <div
          data-testid="plan-card-checks"
          className="mt-1 text-2xs whitespace-pre-wrap text-description-muted"
        >
          {planCheckSummary(args.items)}
        </div>
      )}
      {loopActive && !awaitingLoop && isLatestPlanCard && (
        <div
          data-testid="plan-card-loop-started"
          className="mt-2 text-2xs text-description-muted"
        >
          The loop is building this plan, one to-do at a time. Questions go to
          its inbox.
        </div>
      )}
      {showActions && !awaitingLoop && args.ok && budgetOpen && (
        <PlanBudgetStep
          items={args.items.map((item) => ({
            text: String(item.text),
            budget: budgetFromInput(item.budget),
          }))}
          level={planLevel}
          loopBudget={
            LOOP_AUTONOMY[
              autonomyForPolicy({ plan: planLevel, questions: questionsLevel })
            ].budget
          }
          history={(loop?.items ?? []).flatMap((i) =>
            i.status === "done" && i.usage ? [i.usage] : [],
          )}
          value={budgetDraft}
          onChange={setBudgetDraft}
          onApply={() => {
            setBudgetApplied(budgetDraft);
            setBudgetOpen(false);
          }}
          onSkip={() => {
            setBudgetApplied(undefined);
            setBudgetOpen(false);
          }}
        />
      )}
      {showActions && !awaitingLoop && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            data-testid="plan-card-build"
            title="Switch to Agent mode and implement the plan, reading the file again first"
            onClick={() => void dispatch(buildPlan({ planFile: fileUri }))}
          >
            Build
          </Button>
          <Button
            variant="outline"
            data-testid="plan-card-build-loop"
            title="Build the to-dos one at a time without driving each step: questions go to an inbox you can answer while it works"
            onClick={() =>
              void dispatch(
                startLoopFromPlan({
                  planFile: fileUri,
                  ...(budgetApplied ? { budget: budgetApplied } : {}),
                }),
              )
            }
          >
            Build in a loop
          </Button>
          <button
            type="button"
            data-testid="plan-card-budget-toggle"
            aria-expanded={budgetOpen}
            title="Divide the loop's budget among the to-dos before building"
            className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs text-link hover:underline"
            onClick={() => setBudgetOpen(!budgetOpen)}
          >
            {budgetOpen ? "Hide the budget" : "Set a budget…"}
          </button>
          {budgetApplied && !budgetOpen && (
            <span
              data-testid="plan-card-budget-summary"
              className="text-2xs text-description-muted"
            >
              Budget: {budgetApplied.strategy},{" "}
              {Math.round(budgetApplied.reserve * 100)}% reserve
            </span>
          )}
          <Button
            variant="outline"
            data-testid="plan-card-keep-planning"
            title="Stay in Plan mode and say what to change"
            onClick={() => {
              dispatch(setMode("plan"));
              mainEditor?.commands.focus();
            }}
          >
            Keep planning
          </Button>
          <span className="text-2xs text-description-muted">
            Edit the file first if you like; Build reads it again.
          </span>
        </div>
      )}
    </div>
  );
}
