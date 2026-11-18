import fs from "fs";

import type { LoopState } from "core/index.js";
import {
  policyLevelLabel,
  questionsAutoAnswer,
} from "core/tools/permissions/policy.js";
import { autoAnsweredLine } from "core/util/autoAnswer.js";
import { autoAnswerPlanText } from "core/util/autoAnswerPlan.js";
import { addAutoDecision } from "core/util/loopMode.js";

import { reloadPlanFile } from "../util/planFileReload.js";

/**
 * Questions is permissive (Automatic, Permissive, IDGAF): the plan file's open
 * decisions are answered from the plan's own options (core/util/autoAnswer.ts)
 * and recorded on the loop as the system's. Shared by the terminal loop and
 * `continuous serve`, which both go through here.
 */
export function autoAnswerOpenDecisions(
  loop: LoopState,
  file: string | undefined,
): LoopState {
  if (!file || !loop.policy || !questionsAutoAnswer(loop.policy.questions)) {
    return loop;
  }
  try {
    const result = autoAnswerPlanText(fs.readFileSync(file, "utf8"));
    if (!result.ok || result.answers.length === 0) return loop;
    fs.writeFileSync(file, result.text);
    reloadPlanFile(file);
    const source = `Questions: ${policyLevelLabel("questions", loop.policy.questions)}`;
    return result.answers.reduce(
      (l, a) =>
        addAutoDecision(l, {
          kind: "question",
          source,
          text: autoAnsweredLine(a.question, a.answer),
        }),
      loop,
    );
  } catch {
    return loop;
  }
}
