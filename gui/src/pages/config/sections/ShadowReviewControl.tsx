import { useCallback, useContext, useEffect, useState } from "react";
import type { ShadowSettingsView } from "core/tools/permissions/audit/shadowSettingsHandlers";
import {
  DEFAULT_SHADOW_TIMEOUT_MS,
  MAX_SHADOW_BUDGET_USD,
  MAX_SHADOW_TIMEOUT_MS,
  MIN_SHADOW_TIMEOUT_MS,
} from "core/tools/permissions/audit/shadowLimits";
import Alert from "../../../components/gui/Alert";
import {
  CHIP,
  LEVEL_GLYPHS,
  LEVEL_TONES,
} from "../../../components/PolicyControls/levelStyle";
import { Button, Card } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { cn } from "../../../util/cn";

/** Dollars, to the hundredth, or the ten-thousandth when the amount is small */
function money(n: number): string {
  let s = n.toFixed(4);
  while (s.endsWith("0") && /\.\d{3,}$/.test(s)) s = s.slice(0, -1);
  return `$${s}`;
}

const INPUT =
  "min-h-6 w-24 rounded-sm border border-solid border-border bg-input px-1 text-sm text-foreground";

type Parsed = { value: number } | { error: string };

function parseBudget(text: string): Parsed {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(n) || n <= 0) {
    return { error: "Enter an amount in dollars above 0." };
  }
  if (n > MAX_SHADOW_BUDGET_USD) {
    return {
      error: `The most you can set is ${money(MAX_SHADOW_BUDGET_USD)}.`,
    };
  }
  return { value: n };
}

function parseTimeout(text: string): Parsed {
  const n = Number(text.trim());
  if (
    !Number.isInteger(n) ||
    n < MIN_SHADOW_TIMEOUT_MS ||
    n > MAX_SHADOW_TIMEOUT_MS
  ) {
    return {
      error: `Use whole milliseconds from ${MIN_SHADOW_TIMEOUT_MS} to ${MAX_SHADOW_TIMEOUT_MS}.`,
    };
  }
  return { value: n };
}

/**
 * Settings > Tools: shadow review. A second opinion from the reviewer model on
 * calls you or your rules settled, written to the audit trail beside the real
 * answer. It never changes an answer. The switch lives in your own config.yaml
 * and nowhere else; turning it on is confirmed in the editor's own dialog,
 * because it sends tool-call text to a model.
 */
export function ShadowReviewControl() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [view, setView] = useState<ShadowSettingsView | undefined>();
  const [budget, setBudget] = useState("");
  const [timeout, setTimeoutText] = useState(String(DEFAULT_SHADOW_TIMEOUT_MS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const adopt = useCallback((v: ShadowSettingsView) => {
    setView(v);
    setBudget(v.form.budgetUsd === undefined ? "" : String(v.form.budgetUsd));
    setTimeoutText(String(v.form.timeoutMs));
  }, []);

  const load = useCallback(async () => {
    const res = await ideMessenger.request("audit/shadowSettings", undefined);
    if (res.status === "success") adopt(res.content);
  }, [ideMessenger, adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (change: {
    enabled?: boolean;
    budgetUsd?: number;
    timeoutMs?: number;
  }) => {
    setError(undefined);
    setBusy(true);
    try {
      const res = await ideMessenger.request("audit/setShadowSettings", change);
      if (res.status !== "success") {
        setError("Not saved: the request failed.");
      } else if (res.content.result === "refused") {
        setError(res.content.error);
      } else if (res.content.view) {
        adopt(res.content.view);
      } else {
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  if (!view) return null;
  const { form } = view;
  const budgetCheck = parseBudget(budget);
  const timeoutCheck = parseTimeout(timeout);
  const dirty =
    String(form.budgetUsd ?? "") !== budget.trim() ||
    String(form.timeoutMs) !== timeout.trim();
  const valid = !("error" in budgetCheck) && !("error" in timeoutCheck);

  const toggle = () => {
    if (form.enabled) return void send({ enabled: false });
    if ("error" in budgetCheck) return setError(budgetCheck.error);
    if ("error" in timeoutCheck) return setError(timeoutCheck.error);
    // The editor's own dialog asks before anything is written
    void send({
      enabled: true,
      budgetUsd: budgetCheck.value,
      timeoutMs: timeoutCheck.value,
    });
  };

  const save = () => {
    if ("error" in budgetCheck) return setError(budgetCheck.error);
    if ("error" in timeoutCheck) return setError(timeoutCheck.error);
    void send({ budgetUsd: budgetCheck.value, timeoutMs: timeoutCheck.value });
  };

  const cap = form.budgetUsd;
  const used = view.spentUsd + view.reservedUsd;
  const left = cap === undefined ? undefined : Math.max(0, cap - used);
  const reached = cap !== undefined && left !== undefined && left <= 0;
  const share = cap ? Math.min(1, used / cap) : 0;
  const Glyph = LEVEL_GLYPHS.automatic;
  const tone = LEVEL_TONES[reached ? "permissive" : "automatic"];

  return (
    <section data-testid="shadow-review" aria-labelledby="shadow-review-title">
      <h3 id="shadow-review-title" className="my-0 mb-1 text-sm font-semibold">
        Shadow review
      </h3>
      <p className="mt-0 mb-2 text-xs text-description">
        Ask the reviewer about calls you or your rules already settled, and keep
        its answer in the audit trail beside yours. It never changes a decision
        and nothing waits for it. Saved in your own config.yaml, nowhere else.
      </p>
      <Card>
        <div className="flex flex-col gap-3 py-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <span id="shadow-review-label" className="text-sm">
                Record the reviewer&apos;s answer
              </span>
              <span
                id="shadow-review-hint"
                className="text-2xs text-description"
              >
                {form.enabled
                  ? "On. Tool names, arguments and your recent messages go to your reviewer model a second time."
                  : "Off. Turning it on asks you in the editor and sends tool-call text to your reviewer model."}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span
                data-testid="shadow-review-state"
                className={cn(
                  CHIP,
                  "inline-flex items-center text-xs",
                  form.enabled ? tone.chip : "bg-input text-foreground",
                )}
              >
                <Glyph
                  className={cn("h-3 w-3", form.enabled ? tone.icon : "")}
                  aria-hidden="true"
                />
                {form.enabled ? "On" : "Off"}
              </span>
              <button
                type="button"
                id="shadow-review-switch"
                role="switch"
                aria-checked={form.enabled}
                aria-labelledby="shadow-review-label"
                aria-describedby="shadow-review-hint"
                disabled={busy}
                onClick={toggle}
                className="relative inline-flex h-6 w-11 flex-none cursor-pointer items-center rounded-full border border-solid border-command-border bg-input p-0 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-foreground transition-all",
                    form.enabled ? "left-6 bg-link" : "left-1 opacity-60",
                  )}
                />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-0.5">
              <label htmlFor="shadow-review-budget" className="text-xs">
                Budget (US dollars)
              </label>
              <input
                id="shadow-review-budget"
                type="text"
                inputMode="decimal"
                className={INPUT}
                value={budget}
                placeholder="0.25"
                aria-invalid={budget !== "" && "error" in budgetCheck}
                aria-describedby="shadow-review-budget-hint"
                onChange={(e) => setBudget(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && dirty && save()}
              />
              <span
                id="shadow-review-budget-hint"
                className="text-2xs text-description"
              >
                All shadow reviews kept in the trail, up to{" "}
                {money(MAX_SHADOW_BUDGET_USD)}.
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <label htmlFor="shadow-review-timeout" className="text-xs">
                Timeout (milliseconds)
              </label>
              <input
                id="shadow-review-timeout"
                type="text"
                inputMode="numeric"
                className={INPUT}
                value={timeout}
                aria-invalid={"error" in timeoutCheck}
                aria-describedby="shadow-review-timeout-hint"
                onChange={(e) => setTimeoutText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && dirty && save()}
              />
              <span
                id="shadow-review-timeout-hint"
                className="text-2xs text-description"
              >
                A slower review is dropped.
              </span>
            </div>
            <Button
              id="shadow-review-save"
              variant="secondary"
              size="sm"
              className="min-h-6 min-w-6"
              disabled={busy || !dirty || !valid}
              onClick={save}
            >
              Save
            </Button>
          </div>

          <div
            data-testid="shadow-review-cost"
            role="status"
            className="flex flex-col gap-1"
          >
            <span className="text-xs">
              {cap === undefined
                ? `${money(view.spentUsd)} spent on ${view.reviews} ${view.reviews === 1 ? "review" : "reviews"}. No budget is set.`
                : `${money(used)} of ${money(cap)} spent, ${money(left ?? 0)} left, on ${view.reviews} ${view.reviews === 1 ? "review" : "reviews"}.`}
              {reached ? " The budget is used up, so no more run." : ""}
            </span>
            {cap !== undefined && (
              <div
                aria-hidden="true"
                className="h-1 w-full overflow-hidden rounded-full bg-input"
              >
                <div
                  className={cn("h-full", reached ? "bg-warning" : "bg-link")}
                  style={{ width: `${Math.round(share * 100)}%` }}
                />
              </div>
            )}
            <span className="text-2xs text-description">
              Counted across the editor and the command line together.
              {view.reservedUsd > 0
                ? ` ${money(view.reservedUsd)} is held for reviews in progress.`
                : ""}
            </span>
          </div>
        </div>
      </Card>
      {!view.trailEnabled && (
        <div className="mt-2" data-testid="shadow-review-trail-off">
          <Alert type="warning" size="sm">
            <span className="text-2xs">
              The audit trail is off, and shadow reviews are written to it, so
              none will run.
            </span>
          </Alert>
        </div>
      )}
      {error && (
        <div className="mt-2" data-testid="shadow-review-error" role="alert">
          <Alert type="error" size="sm">
            <span className="text-2xs">{error}</span>
          </Alert>
        </div>
      )}
    </section>
  );
}
