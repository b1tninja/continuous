import { contextUsage } from "core/llm/utils/sessionUsage";
import { useMemo } from "react";
import { useAppSelector } from "../redux/hooks";

/**
 * The context window use the provider reported for the session's latest
 * request: its input and reply tokens against the window of the model that
 * answered. Undefined before the first request reports usage, or when that
 * model's window is unknown. Shared by the context meter and the cost readout
 * in the row under the prompt, so both say the same number.
 */
export function useLastRequestContext() {
  const usage = useAppSelector((s) => s.session.usage);
  const chatModels = useAppSelector(
    (s) => s.config.config.modelsByRole?.chat ?? [],
  );
  const selected = useAppSelector(
    (s) => s.config.config.selectedModelByRole.chat,
  );
  const last = usage?.lastRequest;
  const contextLength = useMemo(() => {
    if (!last) return undefined;
    const match =
      chatModels.find(
        (m) => m.provider === last.provider && m.model === last.model,
      ) ??
      (selected?.model === last.model && selected.provider === last.provider
        ? selected
        : undefined) ??
      // A model with routes: the last request may have used another
      // route's id for it; the window is the model's
      (selected?.routes?.length ? selected : undefined);
    return match?.contextLength;
  }, [last, chatModels, selected]);
  return { usage, contextLength, context: contextUsage(usage, contextLength) };
}
