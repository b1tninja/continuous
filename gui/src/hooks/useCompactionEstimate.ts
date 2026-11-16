import { findModelPricing } from "core/llm/utils/calculateRequestCost";
import { formatCost, formatTokens } from "core/llm/utils/sessionUsage";
import {
  type CompactionEstimate,
  compactionPricesFrom,
  estimateCompaction,
  formatCompactionEstimate,
  type LocalSpeeds,
  speedsFromStrataMetrics,
} from "core/util/compactionEstimate";
import { useContext, useEffect, useMemo, useState } from "react";
import { useStore } from "react-redux";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppSelector } from "../redux/hooks";
import { selectCacheSetting } from "../redux/selectors/selectCacheSetting";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import type { RootState } from "../redux/store";
import {
  compactionSizes,
  isLocalModel,
  usablePreparedCompaction,
} from "../redux/thunks/prepareCompaction";
import { warmCacheLoss } from "../util/cacheSafeguards";
import { INITIAL_PROMPT_CACHE_STATE } from "../util/promptCache";
import { useNow } from "./useNow";

export interface CompactionEstimateView {
  estimate: CompactionEstimate;
  /** The one line for the Compact now menu and the hold */
  line: string;
  /** A summary is ready for the current plan */
  prepared: boolean;
}

/** Providers whose cache writes cost more than plain input. */
const WRITE_PREMIUM = new Set(["anthropic", "bedrock"]);

const secs = (s: number) =>
  s < 0.5
    ? "0 s"
    : s < 120
      ? `${Math.round(s)} s`
      : `${Math.round(s / 60)} min`;

/**
 * C107's estimate for Compact now on the session as it stands (C108): the
 * plan's sizes (or the whole conversation with no plan), the cache state,
 * and either the prices (cloud) or the server's speeds (local, from Strata's
 * `/metrics`; a server without it has no decode speed to go on). Undefined
 * when there is nothing to compact or no speeds or prices to estimate with.
 */
export function compactionEstimateFor(
  state: RootState,
  opts: { speeds?: LocalSpeeds; now: number },
): CompactionEstimateView | undefined {
  const model = selectSelectedChatModel(state);
  if (!model) return undefined;
  const sizes = compactionSizes(state);
  if (!sizes || sizes.span <= 0) return undefined;

  const cacheState = state.session.promptCache ?? INITIAL_PROMPT_CACHE_STATE;
  const warm = !!warmCacheLoss(
    model,
    selectCacheSetting(state),
    cacheState,
    opts.now,
  );
  const prepared = state.session.preparedCompaction;
  const ready = !!usablePreparedCompaction(
    state,
    state.session.history.length - 1,
  );
  const prewarmed = ready && prepared?.prewarm?.status === "done";
  const summaryTokens =
    ready && prepared?.summary
      ? Math.ceil(prepared.summary.length / 4)
      : undefined;

  const local = isLocalModel(model);
  let estimate: CompactionEstimate;
  if (local) {
    const speeds = opts.speeds;
    if (!speeds) return undefined;
    estimate = estimateCompaction({
      plan: sizes,
      cache: warm ? "warm" : "cold",
      speeds,
      prewarmed,
      ...(summaryTokens !== undefined && { summaryTokens }),
    });
  } else {
    const total = sizes.head + sizes.span + sizes.tail;
    const pricing = findModelPricing(model.model, total);
    if (!pricing) return undefined;
    estimate = estimateCompaction({
      plan: sizes,
      cache: warm ? "warm" : "cold",
      prices: compactionPricesFrom(pricing, {
        writePremium: WRITE_PREMIUM.has(model.underlyingProviderName),
      }),
      ...(summaryTokens !== undefined && { summaryTokens }),
    });
  }
  return {
    estimate,
    line: ready ? preparedLine(estimate) : formatCompactionEstimate(estimate),
    prepared: ready,
  };
}

/** The line once the summary is made: only the switch-over is left. */
function preparedLine(e: CompactionEstimate): string {
  if (e.unit === "seconds") {
    return e.prewarmed
      ? "Compact now (estimate): the summary is ready and pre-warmed, so it applies with nothing more to read."
      : `Compact now (estimate): the summary is ready; applying it reads about ${formatTokens(e.switchOver.freshTokens.low)} tokens once, about ${secs(e.switchOver.value.low)}.`;
  }
  return `Compact now (estimate): the summary is ready; applying it rewrites about ${formatTokens(e.switchOver.freshTokens.low)} tokens of cache, about ${formatCost(e.switchOver.value.low)}.`;
}

/**
 * The estimate for the current session, for the context meter's Compact now
 * and the forced-path hold. On a local Strata server its `/metrics` is read
 * once while the component is shown (one read-only GET), for the speeds.
 */
export function useCompactionEstimate(): CompactionEstimateView | undefined {
  const store = useStore<RootState>();
  const ideMessenger = useContext(IdeMessengerContext);
  const model = useAppSelector(selectSelectedChatModel);
  const history = useAppSelector((s) => s.session.history);
  const plan = useAppSelector((s) => s.session.compactionPlan);
  const prepared = useAppSelector((s) => s.session.preparedCompaction);
  const cache = useAppSelector((s) => s.session.promptCache);
  const now = useNow();
  const [metricsSpeeds, setMetricsSpeeds] = useState<LocalSpeeds>();

  const local = !!model && isLocalModel(model);
  useEffect(() => {
    if (!local) return;
    let live = true;
    void ideMessenger
      .request("llm/strataMetrics", undefined)
      .then((response) => {
        if (!live || response.status !== "success") return;
        setMetricsSpeeds(speedsFromStrataMetrics(response.content));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ideMessenger, local, model?.apiBase]);

  return useMemo(() => {
    return compactionEstimateFor(store.getState(), {
      speeds: metricsSpeeds,
      now,
    });
    // The selections above are what the estimate reads
  }, [store, model, history, plan, prepared, cache, metricsSpeeds, now]);
}
