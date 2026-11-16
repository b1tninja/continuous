import { covers, type PeerRule } from "./ruleAnalysis";
import { DECISION_WORDS, type DecisionKey } from "./ruleWords";

/** Who decided a sample call, as far as the editor can tell. */
export interface RefusalVerdict {
  decision: "allow" | "ask" | "deny";
  /** The evaluator's source: "protected-path", "floor", "safety-floor", "ask-rule" ... */
  source?: string;
  /** Where the deciding rule came from, when a rule decided */
  ruleSource?: string;
}

const HELD_BY: Record<string, string> = {
  "protected-path":
    "a protected path (a place such as your credentials or the files that hold these settings)",
  floor: "a locked rule",
  "safety-floor": "the safety floor",
};

/**
 * Why a new Always rule is refused: it would try to loosen something no rule
 * of yours can loosen (a locked rule, a protected path or a built-in rule
 * that asks), so it could never take effect. Pure. Returns a sentence in the
 * page's words (Never, Ask, Always, Built-in rule, Locked rule), or
 * undefined when the rule may be saved.
 *
 * Only Always rules loosen anything, and only the rules of the person's own
 * file are written, so nothing else can reach here.
 */
export function refusalFor(input: {
  decision: DecisionKey;
  rule: string;
  peers: PeerRule[];
  /** What the rule's own sample call gets with the rule in place */
  after?: RefusalVerdict;
}): string | undefined {
  if (input.decision !== "allow") return undefined;
  for (const p of input.peers) {
    if (p.decision === "allow") continue;
    const kind =
      p.owner === "a floor rule"
        ? "a locked rule"
        : p.owner === "a built-in rule"
          ? "a built-in rule"
          : undefined;
    if (!kind) continue;
    if (covers(p.raw, input.rule.trim()) === true) {
      return `${DECISION_WORDS[p.decision]} for ${p.raw} comes from ${kind}. Always cannot loosen ${kind}, so this rule would never take effect. Nothing was changed.`;
    }
  }
  const after = input.after;
  if (!after || after.decision === "allow") return undefined;
  const held = after.source ? HELD_BY[after.source] : undefined;
  if (held) {
    return `The calls this rule matches are held by ${held}, which Always cannot loosen. Nothing was changed.`;
  }
  if (after.ruleSource === "builtin" || after.ruleSource === "floor") {
    const kind =
      after.ruleSource === "floor" ? "a locked rule" : "a built-in rule";
    return `${DECISION_WORDS[after.decision === "deny" ? "deny" : "ask"]} from ${kind} still applies to the calls this rule matches, and Always cannot loosen ${kind}. Nothing was changed.`;
  }
  return undefined;
}
