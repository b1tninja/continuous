import { useCallback, useContext, useEffect, useState } from "react";
import { ModelInfoFreshness } from "../../../components/ModelInfoFreshness";
import Alert from "../../../components/gui/Alert";
import { Card } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import type { CatalogPolicy } from "../../AddNewModel/configs/fetchProviderModels";
import { ConfigHeader } from "../components/ConfigHeader";

type Mode = "automatic" | "manual" | "off";

const OPTIONS: { mode: Mode; label: string; effect: string }[] = [
  {
    mode: "manual",
    label: "Only when I ask (default)",
    effect:
      "openrouter.ai is contacted only when you choose Pull now or Refresh now, or run `continuous models refresh`. A copy already on this computer is still used.",
  },
  {
    mode: "automatic",
    label: "Automatic (loosens the default)",
    effect:
      "Loosens the default: one GET to openrouter.ai, with no key or account, when the copy on this computer is older than the refresh interval, at start-up and while running. Also looks up the selected Anthropic or OpenAI model at its own API.",
  },
  {
    mode: "off",
    label: "Off",
    effect:
      "openrouter.ai is never contacted, and the bundled model data is used instead of a downloaded list.",
  },
];

const modeOf = (p: CatalogPolicy): Mode =>
  p === "automatic" ? "automatic" : p === "off" ? "off" : "manual";

/** "Model information updates" on the Models settings page. */
export function ModelInformationControl() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [policy, setPolicy] = useState<CatalogPolicy>();
  const [hours, setHours] = useState<number>();
  const [community, setCommunity] = useState(false);
  const [priceList, setPriceList] = useState(false);
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await ideMessenger.request("modelCatalog/status", undefined);
      if (res.status !== "success") return;
      setPolicy(res.content.policy);
      setHours(res.content.refreshHours);
      setCommunity(res.content.communityOptIn === true);
      setPriceList(res.content.priceListOptIn === true);
    } catch {
      // not shown
    }
  }, [ideMessenger]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: {
    policy?: CatalogPolicy;
    refreshHours?: number;
    community?: boolean;
    priceList?: boolean;
  }) => {
    setError(undefined);
    try {
      const res = await ideMessenger.request("modelCatalog/setPolicy", next);
      if (res.status !== "success" || !res.content.saved) {
        setError("Not saved: config.yaml could not be written.");
      }
    } catch {
      setError("Not saved: config.yaml could not be written.");
    }
    await load();
    setVersion((v) => v + 1);
  };

  if (!policy) return null;
  const mode = modeOf(policy);

  return (
    <Card>
      <section data-testid="model-info-updates">
        <ConfigHeader
          title="Model information updates"
          variant="sm"
          subtext="OpenRouter's public model list, used for model names, context sizes, tool support and cost estimates"
          showAddButton={false}
          className="mb-2"
        />
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="sr-only">Model information updates</legend>
          {OPTIONS.map((o) => (
            <label
              key={o.mode}
              className="flex cursor-pointer items-start gap-2 text-xs"
            >
              <input
                type="radio"
                name="model-info-updates"
                value={o.mode}
                checked={mode === o.mode}
                onChange={() =>
                  void save({
                    // Keep a "don't ask again" answer when staying manual
                    policy:
                      o.mode === "manual"
                        ? policy === "never"
                          ? "never"
                          : "ask"
                        : o.mode,
                  })
                }
                className="mt-0.5"
              />
              <span>
                <span className="font-semibold">{o.label}</span>
                <span className="block opacity-75">{o.effect}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={community}
            onChange={() => void save({ community: !community })}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">
              Community catalogue (models.dev)
            </span>
            <span className="block opacity-75">
              Opt-in, labelled community. Off unless you turn this on. Refresh
              now then requests models.dev only for a model with no other price.
              That price is not used for --max-budget-usd unless you also pass
              --budget-allow-unpriced.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={priceList}
            onChange={() => void save({ priceList: !priceList })}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">AWS Price List</span>
            <span className="block opacity-75">
              Opt-in. Off unless you turn this on. Downloads the bulk Price List
              for a Bedrock model's region and keeps it for 7 days. A copy
              already on this computer is still used.
            </span>
          </span>
        </label>
        {mode === "automatic" && hours !== undefined && (
          <label className="mt-2 flex items-center gap-2 text-xs">
            Refresh when older than
            <input
              type="number"
              min={1}
              max={720}
              aria-label="Refresh interval in hours"
              className="w-16 rounded-sm border border-solid border-border bg-input px-1 text-xs text-foreground"
              defaultValue={hours}
              key={hours}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0 && n !== hours) {
                  void save({ refreshHours: n });
                }
              }}
            />
            hours
          </label>
        )}
        <ModelInfoFreshness key={version} className="mt-2" />
        {error && (
          <div className="mt-2">
            <Alert type="error" size="sm">
              <span className="text-2xs">{error}</span>
            </Alert>
          </div>
        )}
      </section>
    </Card>
  );
}
