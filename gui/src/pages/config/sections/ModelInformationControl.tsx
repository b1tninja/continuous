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
    mode: "automatic",
    label: "Automatic (default)",
    effect:
      "Keeps OpenRouter's public model list (names, context sizes, prices, tool support) current: one GET to openrouter.ai, with no key or account, when the copy on this computer is older than the refresh interval, at start-up and while running.",
  },
  {
    mode: "manual",
    label: "Only when I ask",
    effect:
      "openrouter.ai is contacted only when you choose Pull now or Refresh now, or run `continuous models refresh`.",
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
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await ideMessenger.request("modelCatalog/status", undefined);
      if (res.status !== "success") return;
      setPolicy(res.content.policy);
      setHours(res.content.refreshHours);
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
