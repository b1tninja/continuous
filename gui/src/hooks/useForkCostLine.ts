import { useAppSelector } from "../redux/hooks";
import { selectCacheSetting } from "../redux/selectors/selectCacheSetting";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import { forkCost, formatForkCost } from "../util/forkCost";
import { INITIAL_PROMPT_CACHE_STATE } from "../util/promptCache";
import { useNow } from "./useNow";

/**
 * The one-line cost preview for forking the open session at history item
 * `forkIndex` (the last item when undefined): "Fork re-reads 200k tokens ≈
 * $1.00; within the cache window (4 min left) ≈ $0.04". Undefined while
 * `enabled` is false, so the line is only worked out for the action the
 * person is pointing at, and when there is nothing to fork.
 */
export function useForkCostLine(
  forkIndex: number | undefined,
  enabled: boolean,
): string | undefined {
  const now = useNow();
  const model = useAppSelector(selectSelectedChatModel);
  const setting = useAppSelector(selectCacheSetting);
  const state = useAppSelector((s) =>
    enabled ? s.session.promptCache : undefined,
  );
  const history = useAppSelector((s) =>
    enabled ? s.session.history : undefined,
  );
  const mode = useAppSelector((s) => s.session.mode);
  if (!enabled || !model || !history?.length) return undefined;
  const cost = forkCost({
    model,
    setting,
    state: state ?? INITIAL_PROMPT_CACHE_STATE,
    history,
    forkIndex: forkIndex ?? history.length - 1,
    mode,
    now,
  });
  return cost ? formatForkCost(cost, now) : undefined;
}
