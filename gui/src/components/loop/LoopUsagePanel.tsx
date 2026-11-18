import type { LoopState } from "core";
import { formatCostAmount } from "core/util/costOf";
import { costMarkOf } from "core/util/loopCost";
import { loopTokensFromUsage } from "core/util/loopMode";
import {
  describeRoundUsage,
  describeTimeUsage,
  describeTokenUsage,
  loopUsage,
} from "core/util/loopUsage";
import { useEffect, useState } from "react";
import { useAppSelector } from "../../redux/hooks";

/** One limit as a label, a bar and what is left; the bar warns from 80%. */
function UsageMeter({
  label,
  testId,
  fraction,
  text,
}: {
  label: string;
  testId: string;
  fraction: number | undefined;
  text: string;
}) {
  const tone =
    fraction === undefined
      ? "bg-description-muted"
      : fraction >= 1
        ? "bg-error"
        : fraction >= 0.8
          ? "bg-warning"
          : "bg-link";
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 items-center gap-1 text-description"
    >
      <span className="w-12 shrink-0">{label}</span>
      <span className="h-1 w-16 shrink-0 overflow-hidden rounded bg-input">
        <span
          className={`block h-full ${tone}`}
          style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }}
        />
      </span>
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}

/**
 * What the loop has used and what is left of each limit, with the totals: runs
 * and items done. Shown once a budget has been set. The clock ticks while the
 * loop runs.
 */
export function LoopUsagePanel({ loop }: { loop: LoopState }) {
  const sessionUsage = useAppSelector((s) => s.session.usage);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (loop.status === "stopped") return;
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [loop.status]);
  const u = loopUsage(loop, {
    sessionTokens: sessionUsage ? loopTokensFromUsage(sessionUsage) : 0,
    costMark: costMarkOf(sessionUsage),
    now,
  });
  return (
    <div data-testid="loop-usage" className="mt-1 flex flex-col gap-0.5">
      <UsageMeter
        label="Rounds"
        testId="loop-usage-rounds"
        fraction={u.rounds.max > 0 ? u.rounds.used / u.rounds.max : undefined}
        text={describeRoundUsage(u.rounds)}
      />
      <UsageMeter
        label="Tokens"
        testId="loop-usage-tokens"
        fraction={u.tokens.fraction}
        text={describeTokenUsage(u.tokens)}
      />
      <UsageMeter
        label="Time"
        testId="loop-usage-time"
        fraction={u.time.fraction}
        text={describeTimeUsage(u.time)}
      />
      <div
        data-testid="loop-usage-cost"
        className="text-description"
        title="An estimate at list price, from the session's usage by model"
      >
        Cost: {formatCostAmount(u.cost)}
      </div>
      <div data-testid="loop-usage-totals" className="text-description">
        {u.items.done}/{u.items.total} done · {u.runs} run
        {u.runs === 1 ? "" : "s"}
      </div>
    </div>
  );
}
