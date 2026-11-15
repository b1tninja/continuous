import { useMemo } from "react";
import { useStore } from "react-redux";
import { useAppSelector } from "../redux/hooks";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import type { RootState } from "../redux/store";
import { describeChatRequest } from "../redux/util/describeChatRequest";
import { currentBreakdown } from "../util/selectiveCompaction";
import { useLastRequestContext } from "./useLastRequestContext";

/**
 * What the context holds now, for the context panel and "Choose what to
 * keep": the request's segments and the split of the context by category,
 * scaled to the provider's count for the last request. Changes made with
 * "Choose what to keep" and not sent yet are counted as estimated.
 */
export function useContextBreakdown() {
  const store = useStore<RootState>();
  const history = useAppSelector((s) => s.session.history);
  const undo = useAppSelector((s) => s.session.contextRemovalUndo);
  const model = useAppSelector(selectSelectedChatModel);
  const { usage, contextLength } = useLastRequestContext();

  return useMemo(() => {
    const state = store.getState();
    let segments: ReturnType<typeof describeChatRequest> = [];
    try {
      segments = describeChatRequest(state);
    } catch {
      // No chat model selected: the conversation is still counted
    }
    const last = usage?.lastRequest;
    const breakdown = currentBreakdown({
      segments,
      history,
      previousMarks: undo?.previous,
      contextLength: contextLength ?? model?.contextLength,
      maxTokens: model?.completionOptions?.maxTokens,
      reportedTokens: last ? last.inputTokens + last.outputTokens : undefined,
    });
    return { segments, breakdown, history };
  }, [store, history, undo, usage, contextLength, model]);
}
