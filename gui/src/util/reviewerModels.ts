import type { ModelDescription } from "core";

/** The roles whose models can read a tool call and answer: not embeddings, reranking or autocomplete. */
const CHATTY_ROLES = [
  "chat",
  "edit",
  "apply",
  "summarize",
  "subagent",
  "reviewer",
] as const;

/**
 * The models the reviewer may be: every one the active config loaded that can
 * chat, whatever provider it comes from, each once. A reviewer is not limited
 * to models that list the `reviewer` role, so one config can mix providers: a
 * local model for the work and another provider's model as the reviewer. It is
 * never chosen for the person: a model is a candidate, and the reviewer is the
 * one they pick.
 */
export function reviewerCandidates(
  modelsByRole: Partial<Record<string, ModelDescription[]>> | undefined,
): ModelDescription[] {
  const seen = new Set<string>();
  const out: ModelDescription[] = [];
  for (const role of CHATTY_ROLES) {
    for (const model of modelsByRole?.[role] ?? []) {
      if (seen.has(model.title)) continue;
      seen.add(model.title);
      out.push(model);
    }
  }
  return out;
}
