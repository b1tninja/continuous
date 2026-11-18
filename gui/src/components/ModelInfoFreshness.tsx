import { setOpenRouterCatalog } from "core/llm/utils/catalogPricing";
import { useCallback, useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";

type Status = {
  policy: "automatic" | "ask" | "never" | "off";
  refreshHours: number;
  lastAttempt?: { at: string; error?: string };
  openrouter?: { fetchedAt: string; count: number };
};

/** How often the line reads the status again (a file read in core). */
const STATUS_POLL_MS = 10 * 60 * 1000;

export function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

/**
 * "OpenRouter model information last updated <time> · Refresh now", for the
 * cost and model screens. Reading the status is local; Refresh now is the
 * person's own request to openrouter.ai and is not offered when model
 * information updates are off.
 */
export function ModelInfoFreshness({
  onRefresh,
  className,
}: {
  /** Replaces the default refresh (the setup screen also updates its list). */
  onRefresh?: () => Promise<{ ok: boolean; error?: string }>;
  className?: string;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [status, setStatus] = useState<Status>();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const res = await ideMessenger.request("modelCatalog/status", undefined);
      if (res.status === "success") setStatus(res.content);
    } catch {
      // nothing to show
    }
  }, [ideMessenger]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      if (onRefresh) {
        const r = await onRefresh();
        if (!r.ok) setError(r.error ?? "could not reach openrouter.ai");
      } else {
        const res = await ideMessenger.request("modelCatalog/pull", undefined);
        if (res.status !== "success") {
          setError("could not reach openrouter.ai");
        } else if (!res.content.ok) {
          setError(res.content.error);
        } else {
          setOpenRouterCatalog({
            schemaVersion: 1,
            source: "https://openrouter.ai/api/v1/models",
            fetchedAt: res.content.fetchedAt,
            models: res.content.models,
          });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
      await load();
    }
  };

  if (!status) return null;
  const off = status.policy === "off";
  const fetchedAt = status.openrouter?.fetchedAt;
  const automaticFailed =
    status.policy === "automatic" && status.lastAttempt?.error;

  return (
    <div
      className={`flex flex-col gap-0.5 text-xs text-description-muted ${className ?? ""}`}
      data-testid="model-info-freshness"
    >
      <span>
        {off
          ? "Model information updates are off: using the bundled model data"
          : fetchedAt
            ? `OpenRouter model information last updated ${formatUpdatedAt(fetchedAt)}`
            : "OpenRouter model information not downloaded yet"}
        {!off && (
          <>
            {" · "}
            <button
              type="button"
              className="cursor-pointer border-none bg-transparent p-0 text-xs text-link underline disabled:cursor-default disabled:opacity-60"
              onClick={() => void refresh()}
              disabled={refreshing}
              title="Contacts openrouter.ai for its public model list"
            >
              {refreshing ? "Refreshing…" : "Refresh now"}
            </button>
          </>
        )}
      </span>
      {error && (
        <span className="text-warning" role="status">
          Couldn't refresh: {error}. The list already on this computer stays in
          use.
        </span>
      )}
      {!error && automaticFailed && (
        <span>
          The last automatic update failed ({status.lastAttempt?.error}); it
          will be tried again later.
        </span>
      )}
    </div>
  );
}
