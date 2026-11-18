import type { RetirementNotice } from "core/util/modelRetirement";
import { useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { retirementLabel } from "../../hooks/useRetirementNotices";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";

/** The chip's words: short, with the date when there is one. */
export const retirementChipText = retirementLabel;

function tooltip(n: RetirementNotice): string {
  const source =
    n.from === "live"
      ? "From your key's model list."
      : `From Anthropic's deprecations page, read ${n.fetchedOn}: ${n.sourceUrl}`;
  return `${n.message} ${source} Click to hide.`;
}

/**
 * A warning chip beside the model picker when the selected Anthropic model is
 * deprecated, retired or retiring within 60 days, or the selected OpenAI model
 * has a shutdown date (core/util/modelRetirement.ts). The checked-in table and
 * the lifecycle your key last returned (Test connection, or the background
 * refresh of the selected model under "Model information updates:
 * Automatic"). Click hides it for that notice; it never blocks anything.
 */
export function ModelRetirementChip() {
  const ideMessenger = useContext(IdeMessengerContext);
  const model = useAppSelector(selectSelectedChatModel);
  const [notice, setNotice] = useState<RetirementNotice>();
  // Bumped when the background refresh brought newer facts for this model
  const [refreshed, setRefreshed] = useState(0);
  const provider = model?.provider;
  const id = model?.model;

  useWebviewListener(
    "model/infoUpdated",
    async (data) => {
      if (data.provider === provider && data.model === id) {
        setRefreshed((n) => n + 1);
      }
    },
    [provider, id],
  );

  useEffect(() => {
    setNotice(undefined);
    if ((provider !== "anthropic" && provider !== "openai") || !id) return;
    let live = true;
    ideMessenger
      .request("model/retirementNotice", { provider, model: id })
      .then((res) => {
        if (live && res.status === "success") setNotice(res.content.notice);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [provider, id, refreshed]);

  if (!notice || !provider || !id) return null;
  return (
    <button
      type="button"
      className="ml-1 hidden shrink-0 cursor-pointer rounded border border-solid border-warning bg-transparent px-1 text-[10px] text-warning md:inline"
      data-testid="model-retirement-chip"
      title={tooltip(notice)}
      onClick={() => {
        setNotice(undefined);
        void ideMessenger.request("model/dismissRetirementNotice", {
          provider,
          model: id,
        });
      }}
    >
      {retirementChipText(notice)}
    </button>
  );
}
