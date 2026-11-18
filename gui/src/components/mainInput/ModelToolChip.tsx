import type { ProbeStatus } from "core/util/measuredFacts";
import { openAICompatDefaultBase } from "core/util/openaiCompatBases";
import { providerRecoversText } from "core/util/toolDialectLeak";
import { useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";

/** The chip's words for a local Test connection result and the model's own setting. */
export function chipText(
  status: ProbeStatus | undefined,
  recoveryOn: boolean,
): string {
  switch (status?.kind) {
    case "native":
      return "tool calls: native";
    case "text":
      return recoveryOn ? "as text: recovery on" : "as text: recovery off";
    case "none":
      return "tool calls: none";
    default:
      return "unknown";
  }
}

/**
 * One short chip on the model line: what the last Test connection on this
 * machine saw for the selected model (core/util/measuredFacts.ts), and
 * whether recovery is on for it. "unknown" until a test has run. Shown only
 * for providers Test connection covers. Hover for the date and probe count.
 */
export function ModelToolChip() {
  const ideMessenger = useContext(IdeMessengerContext);
  const model = useAppSelector(selectSelectedChatModel);
  const [status, setStatus] = useState<ProbeStatus>();
  const provider = model?.provider;
  const covered =
    !!provider &&
    (!!openAICompatDefaultBase(provider) || providerRecoversText(provider));

  useEffect(() => {
    setStatus(undefined);
    if (!covered || !provider || !model?.model) return;
    let live = true;
    ideMessenger
      .request("openaiCompat/probeStatus", {
        provider,
        apiBase: model.apiBase,
        model: model.model,
      })
      .then((res) => {
        if (live && res.status === "success") setStatus(res.content);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [covered, provider, model?.model, model?.apiBase]);

  if (!covered) return null;
  const dialect = model?.toolDialect;
  const recoveryOn = !!dialect && !["auto", "off", "native"].includes(dialect);
  const title = status?.readOn
    ? `Last Test connection on this computer: ${status.readOn}, ${status.n} probe${status.n === 1 ? "" : "s"}${status.stale ? " (stale)" : ""}. One probe does not change any default.`
    : "Not tested on this computer. Test connection in the model's settings checks how it answers a tool call.";
  return (
    <span
      className="ml-1 hidden shrink-0 rounded border border-solid border-border px-1 text-[10px] text-description-muted md:inline"
      data-testid="model-tool-chip"
      title={title}
    >
      {chipText(status, recoveryOn)}
    </span>
  );
}
