import { recordAutoAnswer } from "core/tools/permissions/audit/autoAnswer.js";
import {
  policyLevelLabel,
  questionsNeverAsk,
} from "core/tools/permissions/policy.js";
import {
  answerWithoutAsking,
  type QuestionAnsweredForYou,
} from "core/util/autoAnswer.js";

import { cliAuditSession, cliAuditTrail } from "../audit/cliAudit.js";
import { getPolicyLevels } from "../permissions/policyLevels.js";

/** Whether the Questions area is IDGAF for this process. */
export function questionsNeverAskHere(): boolean {
  return questionsNeverAsk(getPolicyLevels().questions);
}

/**
 * The one place the CLI answers a question for the person: the TUI, headless
 * runs and `continuous serve` all come through here, so what they answer and
 * what they record cannot differ. Returns undefined where the person is to be
 * asked (any level but IDGAF).
 */
export function answerIfIdgaf(input: {
  question: string;
  options?: readonly string[];
  pick?: string;
}): QuestionAnsweredForYou | undefined {
  const level = getPolicyLevels().questions;
  if (!questionsNeverAsk(level)) return undefined;
  const answered = answerWithoutAsking({
    ...input,
    source: `Questions: ${policyLevelLabel("questions", level)}`,
  });
  recordAutoAnswer(cliAuditTrail(), {
    callId: `question-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question: input.question,
    answer: answered.text,
    source: answered.source,
    session: cliAuditSession(),
  });
  return answered;
}
