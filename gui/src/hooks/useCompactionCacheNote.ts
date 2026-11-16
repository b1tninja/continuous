import { selectCacheSetting } from "../redux/selectors/selectCacheSetting";
import { useNow } from "./useNow";
import { useAppSelector } from "../redux/hooks";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import { formatTokens } from "../util/cacheNotices";
import { isSignificantLoss, warmCacheLoss } from "../util/cacheSafeguards";

/**
 * A sentence for the "Compact conversation" actions while the prompt cache
 * holds a conversation big enough to matter. A compaction sends a summary in
 * place of the older turns (they stay in this session, but the model no
 * longer sees them). The system prompt and tools stay cached (C104), but
 * everything after them is new, so the first message after it reads the
 * summary and the newest turns again, and going back to the full
 * conversation means reading all of it again. Empty otherwise.
 */
export function useCompactionCacheNote(): string {
  const model = useAppSelector(selectSelectedChatModel);
  const setting = useAppSelector(selectCacheSetting);
  const state = useAppSelector((s) => s.session.promptCache);
  const now = useNow();
  if (!model || !state) return "";
  const loss = warmCacheLoss(model, setting, state, now);
  if (!loss || !isSignificantLoss(loss)) return "";
  const where = loss.local ? "the model server's cache" : "the prompt cache";
  return `This conversation (${formatTokens(loss.tokens)} tokens) is in ${where}. Compacting sends a summary in place of the older turns: they stay in this session, but the model no longer sees them. The system prompt and tools stay cached; the summary and the newest turns are read again once, and going back to the full conversation means reading all of it again.`;
}
