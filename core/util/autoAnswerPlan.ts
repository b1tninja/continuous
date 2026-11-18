import { autoAnswerFor } from "./autoAnswer.js";
import {
  answeredDecisions,
  parsePlanFile,
  serializePlanFile,
} from "./planFile.js";
import { buildTaskPlan } from "./taskPlan.js";

/**
 * The answers for a plan's open decisions (present_plan `decisions`): each
 * takes its labelled option, else the model's pick, else its first option.
 * Decisions already answered are left alone.
 */
export function autoAnswerDecisions(
  decisions: readonly {
    question: string;
    options?: string[];
    pick?: string;
    answer?: string;
  }[],
): { question: string; answer: string }[] {
  return decisions
    .filter((d) => !d.answer?.trim())
    .map((d) => ({
      question: d.question,
      answer: autoAnswerFor(d.options, d.pick).text,
    }));
}

/**
 * A plan file with its open decisions answered (autoAnswerDecisions), the way
 * the IDE and the CLI write a person's answers back. `answers` is empty, and
 * `text` the file as given, when nothing was open. A file whose to-dos cannot
 * be read is an error: it is left as it is.
 */
export function autoAnswerPlanText(
  markdown: string,
):
  | { ok: true; text: string; answers: { question: string; answer: string }[] }
  | { ok: false; error: string } {
  const doc = parsePlanFile(markdown);
  const answers = autoAnswerDecisions(doc.decisions);
  if (answers.length === 0) return { ok: true, text: markdown, answers };
  const built = buildTaskPlan(doc.items, { reset: true, updatedBy: "user" });
  if (!built.ok) {
    return {
      ok: false,
      error: `The plan file's to-dos could not be read: ${built.error}`,
    };
  }
  return {
    ok: true,
    answers,
    text: serializePlanFile({
      title: doc.title,
      body: doc.body,
      items: built.plan.items,
      decisions: answeredDecisions(doc.decisions, answers),
    }),
  };
}
