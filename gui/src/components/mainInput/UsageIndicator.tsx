import {
  formatCost,
  formatTokens,
  summarizeSessionUsage,
} from "core/llm/utils/sessionUsage";
import { useMemo } from "react";
import { useLastRequestContext } from "../../hooks/useLastRequestContext";
import { useAppSelector } from "../../redux/hooks";
import { Popover, PopoverButton, PopoverPanel } from "../ui";
import { formatUpdatedAt } from "../ModelInfoFreshness";
import { HoverButton } from "./InputToolbar/HoverItem";
import { useToolbarWidthTier } from "./InputToolbar/widthTier";

/**
 * Cost readout in the row under the prompt: the session's estimated cost, or
 * its tokens when no price is known. The context window has its own meter
 * beside it (`ContextMeter`). It is never moved into a menu; as the row
 * narrows it drops the route note (which stays in its name). Pressing it
 * opens the breakdown of tokens and cost per model, so the details do not
 * depend on hovering. Hidden until the first request reports usage, since
 * before that there is nothing to show.
 */
export function UsageIndicator() {
  const tier = useToolbarWidthTier();
  const { usage, context } = useLastRequestContext();
  const selected = useAppSelector(
    (s) => s.config.config.selectedModelByRole.chat,
  );
  const answered = useAppSelector((s) => s.session.answeredRoute);
  // For a model with routes: the account that answered, and whether it is
  // a fallback rather than the model's first route
  const route =
    answered && selected?.routes && answered.model === selected.title
      ? {
          name: answered.route,
          fallback: answered.route !== selected.routes[0],
        }
      : undefined;

  const summary = useMemo(() => summarizeSessionUsage(usage), [usage]);
  if (!usage || summary.requests === 0) return null;

  const percent = context ? Math.round(context.fraction * 100) : undefined;
  const models = Object.values(usage.byModel ?? {});

  const content = (
    <div
      className="flex flex-col gap-1 text-left text-xs"
      data-testid="usage-tooltip"
    >
      {route && (
        <span data-testid="usage-route">
          Answered through {route.name}
          {route.fallback
            ? ` (a fallback: ${selected?.routes?.[0]} did not answer)`
            : ""}
        </span>
      )}
      {context ? (
        <span>
          Context: {formatTokens(context.tokens)} of{" "}
          {formatTokens(context.limit)} tokens ({percent}%)
        </span>
      ) : (
        <span>Context window unknown for this model.</span>
      )}
      <span>
        Session: {formatTokens(summary.inputTokens)} in,{" "}
        {formatTokens(summary.outputTokens)} out
        {summary.cacheReadTokens > 0 || summary.cacheWriteTokens > 0
          ? `, ${formatTokens(summary.cacheReadTokens)} cache read, ${formatTokens(summary.cacheWriteTokens)} cache write`
          : ""}
      </span>
      <span>
        {summary.cost === undefined
          ? "Cost: no price known for these models, tokens only."
          : `Estimated cost: ${summary.costIsPartial ? "at least " : ""}${formatCost(summary.cost)}${summary.costIsPartial ? " (some models have no known price)" : ""}`}
      </span>
      {summary.cost !== undefined && summary.priceListDate && (
        <span className="text-description-muted" data-testid="usage-price-date">
          Estimate: OpenRouter prices, last updated{" "}
          {formatUpdatedAt(summary.priceListDate)}. Refresh now from the Models
          settings.
        </span>
      )}
      {models.length > 1 &&
        models.map((m) => (
          <span
            key={`${m.provider}/${m.model}`}
            className="text-description-muted"
          >
            {m.model}: {formatTokens(m.inputTokens)} in,{" "}
            {formatTokens(m.outputTokens)} out
            {m.pricedRequests > 0 ? `, ${formatCost(m.cost)}` : ""}
          </span>
        ))}
    </div>
  );

  const costText =
    summary.cost !== undefined
      ? `${summary.costIsPartial ? "at least " : ""}${formatCost(summary.cost)}`
      : undefined;
  const showRoute = !!route?.fallback && tier !== "narrow";
  // What the row shows; the name starts with it, so speech and sight agree.
  // The context share is the meter's, beside this readout.
  const visible =
    (summary.cost !== undefined
      ? formatCost(summary.cost)
      : `${formatTokens(summary.inputTokens + summary.outputTokens)}${tier === "narrow" ? "" : " tokens"}`) +
    (showRoute ? ` · via ${route?.name}` : "");
  const meaning = [
    costText
      ? `estimated cost ${costText}`
      : "tokens this session, no price known",
    route?.fallback ? `answered via ${route.name}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Popover className="relative flex flex-none">
      <PopoverButton
        as={HoverButton}
        aria-label={`${visible}: ${meaning}. Show usage details`}
        data-testid="usage-indicator"
        className="flex-none gap-1 px-0.5 [font-size:inherit] tabular-nums"
      >
        <span aria-hidden="true">{visible}</span>
      </PopoverButton>
      <PopoverPanel
        anchor="top end"
        data-testid="usage-panel"
        className="z-[200000] max-w-[90vw] rounded border border-solid border-border bg-vsc-input-background p-2 text-xs text-foreground shadow-md"
      >
        {content}
      </PopoverPanel>
    </Popover>
  );
}
