import type { RetirementNotice } from "core/util/modelRetirement";
import { useContext, useEffect, useMemo, useState } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useWebviewListener } from "./useWebviewListener";

export interface ListedModel {
  provider?: string;
  model?: string;
}

/** Only these providers have notices (core/util/modelRetirement.ts). */
const NOTICE_PROVIDERS = new Set(["anthropic", "openai"]);

export function retirementKey(provider?: string, model?: string): string {
  return `${provider ?? ""}\u0000${model ?? ""}`;
}

/** The short words beside a model name: "retired", "retires 2026-11-30"... */
export function retirementLabel(n: RetirementNotice): string {
  switch (n.severity) {
    case "retired":
      return "retired";
    case "retiring":
      return `retires ${n.retiresAt}`;
    case "possible":
      return `may retire ${n.retiresAt}`;
    default:
      return "deprecated";
  }
}

/** The full sentence with where it comes from, for a tooltip. */
export function retirementDetail(n: RetirementNotice): string {
  const source =
    n.from === "live"
      ? "From the provider's own model list."
      : `From Anthropic's deprecations page, read ${n.fetchedOn}: ${n.sourceUrl}`;
  return `${n.message} ${source}`;
}

/**
 * The retirement notices of the listed models, keyed by `retirementKey`, from
 * one `model/retirementNotices` request (the checked-in table plus the
 * lifecycle the provider's own model list last returned; no network call).
 * Asks again when the list changes or a background refresh brought newer
 * facts for one of the models. An empty map until the answer arrives, and
 * on any failure: a notice never blocks the list.
 */
export function useRetirementNotices(
  models: ListedModel[],
): Map<string, RetirementNotice> {
  const ideMessenger = useContext(IdeMessengerContext);
  const [notices, setNotices] = useState<Map<string, RetirementNotice>>(
    () => new Map(),
  );
  const [refreshed, setRefreshed] = useState(0);

  const wanted = useMemo(() => {
    const seen = new Map<string, { provider: string; model: string }>();
    for (const m of models) {
      if (!m.provider || !m.model || !NOTICE_PROVIDERS.has(m.provider)) {
        continue;
      }
      seen.set(retirementKey(m.provider, m.model), {
        provider: m.provider,
        model: m.model,
      });
    }
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models]);
  const wantedKey = wanted.map(([k]) => k).join("\u0001");

  useWebviewListener(
    "model/infoUpdated",
    async (data) => {
      if (
        wanted.some(([k]) => k === retirementKey(data.provider, data.model))
      ) {
        setRefreshed((n) => n + 1);
      }
    },
    [wantedKey],
  );

  useEffect(() => {
    if (wanted.length === 0) {
      setNotices(new Map());
      return;
    }
    let live = true;
    ideMessenger
      .request("model/retirementNotices", {
        models: wanted.map(([, m]) => m),
      })
      .then((res) => {
        if (!live || res?.status !== "success") return;
        setNotices(
          new Map(
            (res.content?.notices ?? []).map((n) => [
              retirementKey(n.provider, n.model),
              n.notice,
            ]),
          ),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wantedKey, refreshed]);

  return notices;
}
