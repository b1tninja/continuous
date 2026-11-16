import type { JSONContent } from "@tiptap/core";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CompactionPlan } from "core/util/compactionPlan";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import type { RootState } from "../redux/store";
import {
  currentCompactionPlan,
  forceAtTokens,
  preparedAppliesAtTurn,
  usablePreparedCompaction,
} from "../redux/thunks/prepareCompaction";

/**
 * The forced-path hold (plans/research/cache-friendly-context-trimming.md
 * section 6.5, row C108). A message that would take the prompt past the force
 * threshold (decision D3: 85% of the window on a local server, of the window
 * less core's 5% calibration headroom, see forceAtTokens; 90% on cloud)
 * makes C101's block drop cut the oldest turns, and everything after the head
 * is read again: about 390k tokens, 85 s on the owner's Strata. Unless the
 * next turn applies a prepared summary on its own (pre-warmed, or cloud),
 * the message waits and the person chooses:
 *
 *  - Compact now, with the estimate: a prepared summary is saved at once
 *    (or one is made), then the message is sent on the compacted
 *    conversation. The default: Enter chooses it.
 *  - Continue anyway: the message is sent and the drop happens. Not on a
 *    key repeat and not the default, so holding Enter cannot choose it; the
 *    plan's later turns are not held again.
 *
 * A message is also held when the last request was already pruned (the
 * GUI's estimate can sit under the threshold while core cuts: images,
 * context items and the token ratio are counted differently there).
 *
 * Only with planned compaction on (D6), and only for the person's own
 * messages from the chat input, never for a loop or a resumed turn: those,
 * and the agent's requests between tool rounds, compact with nobody asked
 * (thunks/compactAtToolRound.ts, C117).
 */
export interface CompactionHoldDecision {
  plan: CompactionPlan;
  /** Tokens after the head the forced drop would read again */
  rereadTokens: number;
  /** The prompt with the new message */
  totalTokens: number;
  forceAtTokens: number;
  /** A summary is ready, so Compact now needs no summary request */
  prepared: boolean;
  /**
   * The last request was already pruned: the conversation is past the drop
   * even if the estimate here says it is under the threshold
   */
  pruned: boolean;
}

/** Rough tokens of a draft: four characters each, as the meter estimates. */
export function draftTokens(editorState: JSONContent | undefined): number {
  if (!editorState) return 0;
  let chars = 0;
  const walk = (node: JSONContent) => {
    if (typeof node.text === "string") chars += node.text.length;
    node.content?.forEach(walk);
  };
  walk(editorState);
  return Math.ceil(chars / 4);
}

/** Whether sending a message of `newTokens` now should hold first. */
export function compactionHoldFor(
  state: RootState,
  newTokens: number,
): CompactionHoldDecision | undefined {
  if (state.session.isStreaming) return undefined;
  const model = selectSelectedChatModel(state);
  if (!model) return undefined;
  const plan = currentCompactionPlan(state);
  if (!plan) return undefined;
  if (state.session.compactionHoldContinued === plan.id) return undefined;
  // A ready summary is applied at this turn instead (applyPreparedCompactionForTurn)
  if (preparedAppliesAtTurn(state)) return undefined;
  const forceAt = forceAtTokens(plan, model);
  const totalTokens = plan.tokens.total + Math.max(0, newTokens);
  // Core already dropped the oldest block for the last request: the next
  // one is cut as well, whatever this estimate says (C117, decision D9)
  const pruned = !!state.session.isPruned;
  if (totalTokens < forceAt && !pruned) return undefined;
  return {
    plan,
    rereadTokens: plan.tokens.span + plan.tokens.tail + Math.max(0, newTokens),
    totalTokens,
    forceAtTokens: forceAt,
    prepared: !!usablePreparedCompaction(
      state,
      state.session.history.length - 1,
    ),
    pruned,
  };
}

/**
 * The hold's keys: a repeated key press (a held Enter carried over from the
 * send) chooses nothing. Native buttons then do the rest: Enter on the
 * focused Compact now, a click or Tab and Enter for Continue anyway.
 */
export function swallowKeyRepeat(e: ReactKeyboardEvent): void {
  if (e.repeat) {
    e.preventDefault();
    e.stopPropagation();
  }
}
