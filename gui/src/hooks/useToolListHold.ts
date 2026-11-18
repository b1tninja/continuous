import { useMemo } from "react";
import { useAppSelector } from "../redux/hooks";
import { selectActiveTools } from "../redux/selectors/selectActiveTools";
import { selectCacheSetting } from "../redux/selectors/selectCacheSetting";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import {
  toolListHoldStatus,
  toolListKey,
  type ToolListHoldStatus,
} from "../util/toolListHold";
import { useNow } from "./useNow";

/**
 * Whether a change to the tool list waits for the prompt cache to go cold,
 * what it would re-read if applied now, and what is waiting
 * (util/toolListHold.ts). The same function decides the request's list.
 */
export function useToolListHold(): ToolListHoldStatus {
  const live = useAppSelector(selectActiveTools);
  const sent = useAppSelector((s) => s.session.sentToolList);
  const key = useAppSelector(toolListKey);
  const model = useAppSelector(selectSelectedChatModel);
  const setting = useAppSelector(selectCacheSetting);
  const cache = useAppSelector((s) => s.session.promptCache);
  const applyAtOnce = useAppSelector((s) => s.ui.applyToolChangesAtOnce);
  const applyNext = useAppSelector((s) => s.session.applyToolChangesNext);
  const now = useNow();
  return useMemo(
    () =>
      toolListHoldStatus({
        live,
        sent,
        key,
        model,
        setting,
        cache,
        applyAtOnce,
        applyNext,
        now,
      }),
    [live, sent, key, model, setting, cache, applyAtOnce, applyNext, now],
  );
}
