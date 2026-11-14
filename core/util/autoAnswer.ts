/**
 * Answers the system gives when nobody is available to: a loop whose
 * Questions area is permissive (Automatic, Permissive or IDGAF) never waits
 * for the person, so a question the agent asks is answered from what it
 * offered. One rule for the IDE extension, the CLI and `continuous serve`.
 */

/** Said to the agent when a question has no option to pick. */
export const NO_ONE_AVAILABLE =
  "No one is available to answer; use your best judgment and state the assumption";

const RECOMMENDED = /\s*\(\s*recommended\s*\)\s*/i;

export interface AutoAnswer {
  text: string;
  /** Which rule chose it: the labelled option, the first, or neither */
  basis: "recommended" | "first" | "none";
}

/**
 * The option labelled "(recommended)" when one is, otherwise the first, and
 * otherwise the best-judgment line. The label itself is not part of the
 * answer.
 */
export function autoAnswerFor(
  options: readonly string[] | undefined,
  pick?: string,
): AutoAnswer {
  const usable = (options ?? []).map((o) => o.trim()).filter(Boolean);
  const labelled = usable.find((o) => RECOMMENDED.test(o));
  const picked = pick?.trim() || undefined;
  const chosen = labelled ?? picked ?? usable[0];
  if (!chosen) return { text: NO_ONE_AVAILABLE, basis: "none" };
  const text = chosen.replace(RECOMMENDED, " ").trim() || chosen;
  return {
    text,
    basis: labelled || picked ? "recommended" : "first",
  };
}

/**
 * The compact line for a closed question: "Auto-answered: <question> -> <answer>".
 * One line: the question and the answer are both the model's text, so a line
 * break in either would let it write further lines of the record itself.
 */
export function autoAnsweredLine(question: string, answer: string): string {
  const clip = (t: string, n: number) => {
    const flat = t.replace(/\s+/g, " ");
    return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
  };
  return `Auto-answered: ${clip(question, 100)} -> ${clip(answer, 100)}`;
}

/** What a person at Questions: IDGAF is shown instead of a question. */
export interface QuestionAnsweredForYou {
  text: string;
  basis: AutoAnswer["basis"];
  /** The setting that decided, for the audit trail: "Questions: IDGAF" */
  source: string;
  /** The compact line: "Auto-answered: <question> -> <answer>" */
  line: string;
}

/**
 * Answers a question without asking anyone, the way every surface does when
 * the Questions area is IDGAF: the option labelled "(recommended)",
 * else the model's pick, else the first option, else the best-judgment line.
 * One function, so the IDE extension, the terminal, headless runs and
 * `continuous serve` cannot give different answers.
 */
export function answerWithoutAsking(input: {
  question: string;
  options?: readonly string[];
  pick?: string;
  source: string;
}): QuestionAnsweredForYou {
  const answer = autoAnswerFor(input.options, input.pick);
  return {
    text: answer.text,
    basis: answer.basis,
    source: input.source,
    line: autoAnsweredLine(input.question, answer.text),
  };
}
