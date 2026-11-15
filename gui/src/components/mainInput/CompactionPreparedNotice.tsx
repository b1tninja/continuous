import type { ChatHistoryItem } from "core";
import { useStore } from "react-redux";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { dismissPreparedCompaction } from "../../redux/slices/sessionSlice";
import type { RootState } from "../../redux/store";
import { usablePreparedCompaction } from "../../redux/thunks/prepareCompaction";
import { useCompactConversation } from "../../util/compactConversation";
import { NoticeAction, NoticeBar } from "./NoticeBar";

/**
 * The person's turns a span `[spanStart, spanEnd)` covers, numbered from 1 as
 * the chat shows them (each user message starts a turn).
 */
export function spanTurns(
  history: readonly ChatHistoryItem[],
  spanStart: number,
  spanEnd: number,
): { first: number; last: number } {
  let before = 0;
  for (let i = 0; i < spanStart && i < history.length; i++) {
    if (history[i].message.role === "user") before++;
  }
  let within = 0;
  for (let i = spanStart; i < spanEnd && i < history.length; i++) {
    if (history[i].message.role === "user") within++;
  }
  return { first: before + 1, last: Math.max(before + 1, before + within) };
}

/**
 * The quiet line of section 6.5 (C108): a summary is ready for the current
 * plan and will be saved at the start of the next turn. "Pre-warmed" once the
 * local server has read the compacted prompt (C106), so applying it reads
 * nothing again. Compact now applies it at once; Not now keeps the
 * conversation as it is (the summary stays ready for Compact now).
 */
export function CompactionPreparedNotice() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const prepared = useAppSelector((s) => s.session.preparedCompaction);
  const history = useAppSelector((s) => s.session.history);
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const hold = useAppSelector((s) => s.session.compactionHold);
  const compact = useCompactConversation();

  if (!prepared || prepared.status !== "ready" || prepared.dismissed) {
    return null;
  }
  if (isStreaming || hold) return null;
  if (!usablePreparedCompaction(store.getState(), history.length - 1)) {
    return null;
  }

  const { first, last } = spanTurns(
    history,
    prepared.spanStart,
    prepared.spanEnd,
  );
  const turns = first === last ? `turn ${first}` : `turns ${first}–${last}`;
  const prewarm = prepared.prewarm;
  const pre = prewarm?.status === "done";

  return (
    <NoticeBar
      testId="compaction-prepared-notice"
      dismissLabel="Not now"
      onDismiss={() => dispatch(dismissPreparedCompaction())}
    >
      <span>
        {`Compaction prepared${pre ? " and pre-warmed" : ""} (summary of ${turns} ready); it applies at the next turn without re-reading.`}
        {prewarm?.status === "running" && " Pre-warming it on the server."}
        {prewarm?.status === "skipped" &&
          prewarm.detail &&
          ` Not pre-warmed: ${prewarm.detail}.`}
      </span>
      <NoticeAction
        testId="compaction-prepared-compact-now"
        onClick={() => void compact(history.length - 1)}
      >
        Compact now
      </NoticeAction>
    </NoticeBar>
  );
}
