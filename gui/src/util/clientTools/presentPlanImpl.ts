import { ContinueError, ContinueErrorReason } from "core/util/errors";
import {
  choosePlanFileName,
  planProposedResult,
  PLANS_DIR,
  serializePlanFile,
  taskPlanForProposal,
  validatePlanArgs,
} from "core/util/planFile";
import {
  policyLevelLabel,
  questionsNeverAsk,
} from "core/tools/permissions/policy";
import { autoAnsweredLine } from "core/util/autoAnswer";
import { joinPathsToUri } from "core/util/uri";
import { selectPolicySettings } from "../../redux/selectors/selectAutoApproval";
import { autoAnswerPlanFile } from "../planDecisions";
import { setPlanFile, setTaskPlan } from "../../redux/slices/sessionSlice";
import { startLoopIfRequested } from "../../redux/thunks/loop";
import { ClientToolImpl } from "./callClientTool";

/**
 * The present_plan tool (Plan mode only): writes the plan to
 * `.continue/plans/<slug>.md` in the first workspace folder, makes its to-dos
 * the task list, records the file on the session and ends the turn. The plan
 * card (PlanCard) then offers Build and Keep planning. In Loop (the mode
 * picker's entry, session.loopRequested) the plan starts the loop instead.
 *
 * Presenting again with the same title replaces this session's file; a file
 * of that name that belongs to something else gets a numbered name instead.
 */
export const presentPlanImpl: ClientToolImpl = async (
  args,
  _toolCallId,
  extras,
) => {
  const parsed = validatePlanArgs(args ?? {});
  if (!parsed.ok) {
    throw new ContinueError(ContinueErrorReason.Unspecified, parsed.error);
  }
  const { session } = extras.getState();
  const result = taskPlanForProposal(parsed.items, session.taskPlan);
  if (!result.ok) {
    throw new ContinueError(ContinueErrorReason.Unspecified, result.error);
  }

  const ide = extras.ideMessenger.ide;
  const [workspaceDir] = await ide.getWorkspaceDirs();
  if (!workspaceDir) {
    throw new ContinueError(
      ContinueErrorReason.Unspecified,
      "No workspace folder is open, so the plan file cannot be saved. Give the plan in your reply instead.",
    );
  }
  const plansDir = joinPathsToUri(workspaceDir, ...PLANS_DIR.split("/"));
  const fileName = await choosePlanFileName(parsed.title, async (name) => {
    const uri = joinPathsToUri(plansDir, name);
    return uri !== session.planFile && (await ide.fileExists(uri));
  });
  const fileUri = joinPathsToUri(plansDir, fileName);
  const relativePath = `${PLANS_DIR}/${fileName}`;

  await ide.writeFile(
    fileUri,
    serializePlanFile({
      title: parsed.title,
      body: parsed.body,
      items: result.plan.items,
      decisions: parsed.decisions,
    }),
  );

  // Questions is IDGAF: the plan's open decisions are answered from what it
  // offered, in the file, before the plan card or the loop sees them
  const autoLines = parsed.decisions.length
    ? await autoAnswerOpenDecisions(extras, fileUri)
    : [];

  extras.dispatch(setTaskPlan(result.plan));
  extras.dispatch(setPlanFile(fileUri));
  // Loop: the person chose to build in a loop before the plan existed
  const loopStarted =
    !!session.loopRequested &&
    (await extras
      .dispatch(startLoopIfRequested({ planFile: fileUri }))
      .unwrap());

  return {
    respondImmediately: true,
    endTurn: true,
    output: [
      {
        name: parsed.title,
        description: relativePath,
        content: loopStarted
          ? `Plan saved to ${relativePath}. The loop started building it, one to-do per turn: stop here.`
          : planProposedResult(relativePath, result.plan, parsed.decisions) +
            (autoLines.length ? `\n\n${autoLines.join("\n")}` : ""),
        uri: { type: "file", value: fileUri },
        hidden: false,
      },
    ],
  };
};

/**
 * Where Questions is IDGAF, answers the plan file's open decisions for the
 * person (core/util/autoAnswer.ts), tells the audit trail, and returns the
 * compact lines. Nothing at any other level.
 */
export async function autoAnswerOpenDecisions(
  extras: Parameters<ClientToolImpl>[2],
  fileUri: string,
): Promise<string[]> {
  const level = selectPolicySettings(extras.getState()).levels.questions;
  if (!questionsNeverAsk(level)) return [];
  const source = `Questions: ${policyLevelLabel("questions", level)}`;
  try {
    const answers = await autoAnswerPlanFile(extras.ideMessenger.ide, fileUri);
    answers.forEach(
      (a, i) =>
        void extras.ideMessenger.request("audit/autoAnswer", {
          callId: `plan-decision-${Date.now()}-${i}`,
          question: a.question,
          answer: a.answer,
          source,
        }),
    );
    return answers.map((a) => autoAnsweredLine(a.question, a.answer));
  } catch (e) {
    console.warn("Could not answer the plan's decisions", e);
    return [];
  }
}
