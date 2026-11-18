import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { acknowledgeCacheMisses } from "../../redux/slices/sessionSlice";
import { plannedCompactionEnabled } from "../../redux/thunks/prepareCompaction";
import { formatTokens } from "../../util/cacheNotices";
import {
  MISS_NOTICE_AFTER,
  MISS_NOTICE_AFTER_LOCAL,
  PRUNED_CAUSE,
} from "../../util/cacheSafeguards";
import { useCompactConversation } from "../../util/compactConversation";
import { modelUsesLocalPrefixCache } from "../../util/promptCache";
import { NoticeAction, NoticeBar } from "./NoticeBar";

/**
 * Shown after repeated requests that should have read the prompt cache and
 * mostly did not. In a healthy session this never appears, so it is also a
 * warning that something at the start of the prompt keeps changing.
 *
 * When the request was pruned to fit the window, the notice says what that
 * means and offers Compact now: one summary instead of a re-read at every
 * drop. A drop between an agent's tool rounds is named as such, since nobody
 * is asked there (C117).
 */
export function CacheMissNotice() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((s) => s.session.promptCache);
  const model = useAppSelector(selectSelectedChatModel);
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const historyLength = useAppSelector((s) => s.session.history.length);
  const compact = useCompactConversation();
  if (!state?.lastMiss) return null;
  // On a local server each miss costs minutes of reading, so say it at once
  const local = modelUsesLocalPrefixCache(model);
  const unseen = (state.misses ?? 0) - (state.missesAcknowledged ?? 0);
  if (unseen < (local ? MISS_NOTICE_AFTER_LOCAL : MISS_NOTICE_AFTER)) {
    return null;
  }

  const { readTokens, expectedTokens, causes, inToolRound } = state.lastMiss;
  const why =
    causes.length > 0
      ? `Likely cause: ${causes.join("; ")}.`
      : local
        ? "Nothing the app controls changed, so the server likely lost the conversation: it unloaded the model after being idle, or another conversation (a subagent, another session or another app) took its cache."
        : "Nothing the app controls changed, so the provider may not be caching this prompt, or something earlier in it keeps changing (tools, MCP servers or rules).";
  const pruned = causes.includes(PRUNED_CAUSE);
  const plannedOff = !!model && !plannedCompactionEnabled(model);
  const drop = !pruned
    ? undefined
    : `${
        inToolRound
          ? "The conversation no longer fits the context window, and the oldest messages were dropped between two of the agent's tool rounds, where nobody is asked first, so everything after the system prompt and tools was read again."
          : "The conversation no longer fits the context window, so everything after the system prompt and tools was read again."
      } Compact now summarises the conversation once, and later requests start from the summary instead of dropping more.${
        plannedOff
          ? " With planned compaction on (contextManagement.plannedCompaction), the agent compacts at the limit by itself."
          : ""
      }`;

  return (
    <NoticeBar
      testId="cache-miss-notice"
      onDismiss={() => dispatch(acknowledgeCacheMisses())}
    >
      <span>
        The prompt cache missed {unseen === 1 ? "once" : `${unseen} times`} in
        this session. The last request read {formatTokens(readTokens)} of{" "}
        {formatTokens(expectedTokens)} tokens. {why}
        {drop && ` ${drop}`}
      </span>
      {pruned && !isStreaming && historyLength > 0 && (
        <NoticeAction
          testId="cache-miss-compact-now"
          onClick={() => void compact(historyLength - 1)}
        >
          Compact now
        </NoticeAction>
      )}
    </NoticeBar>
  );
}
