import type { ChatHistoryItem } from "core";
import { prewarmSetting } from "core/llm/localPrewarm";
import { useEffect } from "react";
import { useStore } from "react-redux";
import {
  type CompactionEstimateView,
  useCompactionEstimate,
} from "../../hooks/useCompactionEstimate";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  dismissPreparedCompaction,
  notePrewarmOff,
} from "../../redux/slices/sessionSlice";
import type { RootState } from "../../redux/store";
import {
  isLocalModel,
  preparedAppliesAtTurn,
  usablePreparedCompaction,
} from "../../redux/thunks/prepareCompaction";
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

/** "about 12 s" for the switch-over, when the estimate has it. */
function switchSeconds(view: CompactionEstimateView | undefined) {
  if (view?.estimate.unit !== "seconds") return undefined;
  const s = view.estimate.switchOver.value.low;
  return s < 120
    ? `about ${Math.max(1, Math.round(s))} s`
    : `about ${Math.round(s / 60)} min`;
}

/**
 * The quiet line of section 6.5 (C108): a summary is ready for the current
 * plan. When the next turn saves it on its own (pre-warmed on a local
 * server, C106, or on cloud) the line says so. On a local server without a
 * pre-warm it waits for Compact now (or the forced-path hold at the force
 * threshold), and the line says what applying it costs, so nothing is
 * re-read unexpectedly. Not now puts it off (the summary stays ready for
 * Compact now). With pre-warm off, the line says so once a session.
 */
export function CompactionPreparedNotice() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const prepared = useAppSelector((s) => s.session.preparedCompaction);
  const history = useAppSelector((s) => s.session.history);
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const hold = useAppSelector((s) => s.session.compactionHold);
  const model = useAppSelector(selectSelectedChatModel);
  const offNoted = useAppSelector((s) => s.session.prewarmOffNoted);
  const compact = useCompactConversation();

  const visible =
    !!prepared &&
    prepared.status === "ready" &&
    !prepared.dismissed &&
    !isStreaming &&
    !hold &&
    !!usablePreparedCompaction(store.getState(), history.length - 1);
  // Always mounted, so the estimate is worked out only while the line shows
  const estimate = useCompactionEstimate({ enabled: visible });
  const local = !!model && isLocalModel(model);
  const prewarmOff = local && !!model && prewarmSetting(model) === "off";
  const sayOff =
    visible &&
    prewarmOff &&
    (offNoted === undefined || offNoted === prepared?.planId);
  useEffect(() => {
    if (sayOff && prepared) dispatch(notePrewarmOff(prepared.planId));
  }, [sayOff, prepared, dispatch]);

  if (!visible || !prepared) return null;

  const { first, last } = spanTurns(
    history,
    prepared.spanStart,
    prepared.spanEnd,
  );
  const turns = first === last ? `turn ${first}` : `turns ${first}–${last}`;
  const prewarm = prepared.prewarm;
  const pre = prewarm?.status === "done";
  const atTurn = !!preparedAppliesAtTurn(store.getState());
  const cost = switchSeconds(estimate);

  let line: string;
  if (atTurn) {
    line = pre
      ? `Compaction prepared and pre-warmed (summary of ${turns} ready); it applies at the next turn without re-reading.`
      : `Compaction prepared (summary of ${turns} ready); it applies at the next turn.`;
  } else {
    line = `Compaction prepared (summary of ${turns} ready); Compact now applies it${cost ? ` in ${cost}` : ""} (not pre-warmed).`;
  }

  return (
    <NoticeBar
      testId="compaction-prepared-notice"
      dismissLabel="Not now"
      onDismiss={() => dispatch(dismissPreparedCompaction())}
    >
      <span>
        {line}
        {prewarm?.status === "running" && " Pre-warming it on the server."}
        {prewarm?.status === "skipped" &&
          prewarm.detail &&
          ` Not pre-warmed: ${prewarm.detail}.`}
        {sayOff && " Pre-warm is off (contextManagement.prewarm)."}
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
