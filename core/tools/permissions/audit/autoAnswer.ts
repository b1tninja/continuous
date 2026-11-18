import type { AuditTrail } from "./trail";

/**
 * A question the system answered for the person, where Questions is IDGAF:
 * one `decision` line, `by: system`, whose source names the setting. The
 * question and the answer are masked like any other argument. Never throws.
 */
export function recordAutoAnswer(
  trail: AuditTrail,
  input: {
    callId: string;
    question: string;
    answer: string;
    source: string;
    session?: string;
  },
): void {
  try {
    trail.decision({
      callId: input.callId,
      tool: "question",
      args: JSON.stringify({ question: input.question, answer: input.answer }),
      policy: "allow",
      by: "system",
      source: input.source,
      reason: "Answered for the person; nobody was asked.",
      ...(input.session ? { session: input.session } : {}),
    });
  } catch {
    // the audit never blocks a question
  }
}
