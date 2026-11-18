import type { LoopQuestion } from "core";
import { questionsNeverAsk } from "core/tools/permissions/policy";
import {
  answeredDecisions,
  parsePlanFile,
  validatePlanArgs,
  type PlanDecision,
} from "core/util/planFile";
import {
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppSelector } from "../../redux/hooks";
import { selectEffectiveLevels } from "../../redux/selectors/selectAutoApproval";
import { selectPlanCallToDecide } from "../../redux/selectors/selectPlanDecisions";

export interface OpenQuestions {
  /** Questions the loop's items hold that nobody answered yet */
  open: LoopQuestion[];
  /** Decisions of the plan on the table that its file does not answer yet */
  decisions: PlanDecision[];
  fileUri?: string;
  /** The plan file's decisions, once read */
  fileDecisions?: PlanDecision[];
  /** Keeps the plan file's decisions in step after one is recorded */
  setFileDecisions: Dispatch<SetStateAction<PlanDecision[] | undefined>>;
  /** The Questions level in effect, and whether it is IDGAF: nothing asks */
  level: ReturnType<typeof selectEffectiveLevels>["questions"];
  neverAsk: boolean;
  itemText: (id?: string) => string | undefined;
  count: number;
}

/**
 * Everything waiting on the person as a question: the loop items' open
 * questions and the plan's undecided decisions. The plan file is the source of
 * truth for which decisions are answered. Shared by the Questions panel and
 * the loop's Needs you tray, so both read the same set.
 */
export function useOpenQuestions(): OpenQuestions {
  const loop = useAppSelector((s) => s.session.loop);
  const taskPlan = useAppSelector((s) => s.session.taskPlan);
  const planCall = useAppSelector(selectPlanCallToDecide);
  const ideMessenger = useContext(IdeMessengerContext);
  const [fileDecisions, setFileDecisions] = useState<PlanDecision[]>();

  const args = planCall
    ? validatePlanArgs(planCall.parsedArgs ?? {})
    : undefined;
  const fileUri =
    planCall?.output?.[0]?.uri?.type === "file"
      ? planCall.output[0].uri.value
      : undefined;
  const callId = planCall?.toolCallId;
  const level = useAppSelector((s) => selectEffectiveLevels(s).questions);
  const neverAsk = questionsNeverAsk(level);

  useEffect(() => {
    setFileDecisions(undefined);
    if (!fileUri) return;
    let cancelled = false;
    void ideMessenger.ide
      .readFile(fileUri)
      .then((text) => {
        if (!cancelled) setFileDecisions(parsePlanFile(text).decisions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fileUri, callId, ideMessenger]);

  const open = (loop?.questions ?? []).filter(
    (q) => !q.answerId && !q.decidedAlone,
  );
  const decisions =
    args?.ok && fileUri && !neverAsk
      ? answeredDecisions(
          args.decisions,
          (fileDecisions ?? []).flatMap((d) =>
            d.answer ? [{ question: d.question, answer: d.answer }] : [],
          ),
        ).filter((d) => !d.answer)
      : [];
  return {
    open,
    decisions,
    fileUri,
    fileDecisions,
    setFileDecisions,
    level,
    neverAsk,
    itemText: (id) => taskPlan?.items.find((i) => i.id === id)?.text,
    count: open.length + decisions.length,
  };
}
