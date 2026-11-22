import {
  DEFAULT_AGENT_DECIDES,
  DEFAULT_MAX_NEW_PLAN_ITEMS,
  DEFAULT_YOU_DECIDE,
  QUESTION_TYPE_DESCRIPTIONS,
  QUESTION_TYPES,
  type QuestionType,
} from "core/tools/permissions/policy";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { changePolicyExtras } from "../../redux/thunks/policySettings";
import { whoDecidesCounts } from "./policySummaries";

type WhoDecides = "you" | "agent" | "level";

/** Who decides questions of this type, from the two lists. */
function whoDecides(
  type: QuestionType,
  youDecide: readonly QuestionType[],
  agentDecides: readonly QuestionType[],
): WhoDecides {
  if (youDecide.includes(type)) return "you";
  if (agentDecides.includes(type)) return "agent";
  return "level";
}

/**
 * The settings beside the Plan edits and Questions levels: how many to-dos a
 * re-plan may add by itself, and who decides each kind of question.
 */
export function PlansAndQuestions() {
  const dispatch = useAppDispatch();
  const extras = useAppSelector((s) => s.ui.policyExtras);
  const youDecide = extras.questions?.youDecide ?? DEFAULT_YOU_DECIDE;
  const agentDecides = extras.questions?.agentDecides ?? DEFAULT_AGENT_DECIDES;
  const counts = whoDecidesCounts(extras);

  const setWho = (type: QuestionType, who: WhoDecides) => {
    const you = youDecide.filter((t) => t !== type);
    const agent = agentDecides.filter((t) => t !== type);
    if (who === "you") you.push(type);
    if (who === "agent") agent.push(type);
    void dispatch(
      changePolicyExtras({
        questions: { youDecide: you, agentDecides: agent },
      }),
    );
  };

  return (
    <div className="flex flex-col gap-2 py-1" data-testid="plans-and-questions">
      <label
        className="flex items-center justify-between gap-2 text-xs"
        data-testid="policy-max-new-items"
      >
        <span>
          New to-dos a re-plan may add by itself
          <span className="block text-2xs text-description">
            Plan edits at Permissive.{" "}
            {extras.maxNewPlanItems === undefined
              ? `Not set: ${DEFAULT_MAX_NEW_PLAN_ITEMS}.`
              : `Set by you: ${extras.maxNewPlanItems}.`}
          </span>
        </span>
        <input
          type="number"
          min={0}
          className="w-14 rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
          value={extras.maxNewPlanItems ?? DEFAULT_MAX_NEW_PLAN_ITEMS}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 0) {
              void dispatch(changePolicyExtras({ maxNewPlanItems: n }));
            }
          }}
        />
      </label>
      <p className="my-0 text-2xs text-description" data-testid="who-decides">
        Who decides each kind of question.{" "}
        {counts.set ? "Set by you" : "Not set"}: you decide {counts.you}, the
        agent may decide {counts.agent}, the Questions level decides{" "}
        {counts.level}.
      </p>
      {QUESTION_TYPES.map((type) => (
        <label
          key={type}
          className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs"
          data-testid={`question-type-${type}`}
        >
          {/* The select is about 150 px wide; in a narrow panel it goes under the text */}
          <span className="min-w-0 flex-1 basis-32">
            {type}
            <span className="block text-2xs text-description">
              {QUESTION_TYPE_DESCRIPTIONS[type]}
            </span>
          </span>
          <select
            value={whoDecides(type, youDecide, agentDecides)}
            onChange={(e) => setWho(type, e.target.value as WhoDecides)}
            className="box-border max-w-full shrink-0 cursor-pointer rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
          >
            <option value="you">You decide</option>
            <option value="agent">Agent may decide</option>
            <option value="level">Questions level decides</option>
          </select>
        </label>
      ))}
    </div>
  );
}
