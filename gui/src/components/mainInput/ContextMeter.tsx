import { formatTokens } from "core/llm/utils/sessionUsage";
import {
  formatFileSize,
  isOverSessionBudget,
  SESSION_FILE_BUDGET_BYTES,
} from "core/util/sessionFile";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCompactionCacheNote } from "../../hooks/useCompactionCacheNote";
import { useContextBreakdown } from "../../hooks/useContextBreakdown";
import { useLastRequestContext } from "../../hooks/useLastRequestContext";
import { useNow } from "../../hooks/useNow";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectCacheSetting } from "../../redux/selectors/selectCacheSetting";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { undoContextRemovals } from "../../redux/slices/sessionSlice";
import { saveCurrentSession } from "../../redux/thunks/session";
import {
  contextMeterTokens,
  formatUsd,
  longContextNote,
  perMessageCost,
  QUALITY_NOTE,
} from "../../util/cacheNotices";
import { useCompactConversation } from "../../util/compactConversation";
import {
  type ContextBreakdown,
  type ContextCategoryKey,
} from "core/llm/contextBreakdown";
import { contextLevel, type ContextLevel } from "../../util/contextLevel";
import { CONFIG_ROUTES } from "../../util/navigation";
import {
  modelSupportsPromptCacheControl,
  promptCacheStatus,
  promptCacheTooltip,
} from "../../util/promptCache";
import { Popover, PopoverButton, PopoverPanel } from "../ui";
import { HoverButton } from "./InputToolbar/HoverItem";
import { useToolbarWidthTier } from "./InputToolbar/widthTier";
import { SelectiveCompactDialog } from "./SelectiveCompactDialog";

/** Hovering this long opens the details; leaving for this long closes them. */
export const HOVER_OPEN_MS = 300;
export const HOVER_CLOSE_MS = 250;

/**
 * Category colours: the theme's chart colours, which VS Code and the
 * JetBrains bridge both define, with a fallback. Colour is never the only
 * carrier: the legend table names every segment with its tokens and share.
 */
const chart = (name: string, fallback: string) =>
  `var(--vscode-charts-${name}, ${fallback})`;
const CATEGORY_COLOR: Record<ContextCategoryKey, string> = {
  system: chart("blue", "#3794ff"),
  tools: chart("purple", "#b180d7"),
  rules: chart("yellow", "#cca700"),
  summary: chart("foreground", "#cccccc"),
  context: chart("green", "#89d185"),
  user: chart("foreground", "#cccccc"),
  assistant: chart("blue", "#3794ff"),
  toolCalls: chart("orange", "#d18616"),
  toolResults: chart("orange", "#d18616"),
  terminal: chart("red", "#f14c4c"),
  images: chart("green", "#89d185"),
  reasoning: chart("purple", "#b180d7"),
  other: "var(--vscode-descriptionForeground, #9d9d9d)",
};
/** Conversation categories that share a hue with a setup one are drawn lighter. */
const CATEGORY_OPACITY: Partial<Record<ContextCategoryKey, number>> = {
  summary: 0.5,
  assistant: 0.55,
  toolCalls: 0.55,
  images: 0.55,
  reasoning: 0.55,
  other: 0.4,
};

const LEVEL_BAR: Record<ContextLevel, string> = {
  ok: "bg-description",
  warn: "bg-warning",
  high: "bg-error",
};

const percentOf = (share: number) => {
  const p = share * 100;
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
};

function StackedBar({ breakdown }: { breakdown: ContextBreakdown }) {
  const total = breakdown.window ?? Math.max(1, breakdown.usedTokens);
  const width = (tokens: number) => `${(tokens / total) * 100}%`;
  return (
    <div
      className="relative flex h-2.5 w-full overflow-hidden rounded-sm border border-solid border-border"
      aria-hidden="true"
      data-testid="context-stacked-bar"
    >
      {breakdown.categories.map((c) => (
        <span
          key={c.key}
          data-category={c.key}
          className="h-full flex-none"
          style={{
            width: width(c.tokens),
            backgroundColor: CATEGORY_COLOR[c.key],
            opacity: CATEGORY_OPACITY[c.key] ?? 1,
          }}
        />
      ))}
      {breakdown.freeTokens !== undefined && (
        <span
          className="h-full flex-none"
          style={{ width: width(breakdown.freeTokens) }}
        />
      )}
      {breakdown.reservedTokens !== undefined && (
        <span
          className="h-full flex-none"
          style={{
            width: width(breakdown.reservedTokens),
            backgroundImage:
              "repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 3px)",
            opacity: 0.5,
          }}
        />
      )}
      {breakdown.pruneAtTokens !== undefined && breakdown.window && (
        <span
          className="absolute top-0 h-full w-px bg-foreground"
          style={{ left: width(breakdown.pruneAtTokens) }}
          data-testid="context-prune-marker"
        />
      )}
    </div>
  );
}

function Swatch({ color, opacity }: { color?: string; opacity?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 flex-none rounded-xs border border-solid border-border"
      style={{ backgroundColor: color, opacity }}
    />
  );
}

/** The legend: the text equivalent of the bar, as a table. */
function LegendTable({ breakdown }: { breakdown: ContextBreakdown }) {
  const rows: {
    key: string;
    label: string;
    tokens: number;
    share: number;
    color?: string;
    opacity?: number;
  }[] = breakdown.categories.map((c) => ({
    ...c,
    color: CATEGORY_COLOR[c.key],
    opacity: CATEGORY_OPACITY[c.key],
  }));
  if (breakdown.window) {
    rows.push({
      key: "free",
      label: "Free space",
      tokens: breakdown.freeTokens ?? 0,
      share: (breakdown.freeTokens ?? 0) / breakdown.window,
    });
    rows.push({
      key: "reserved",
      label: "Reserved for the reply",
      tokens: breakdown.reservedTokens ?? 0,
      share: (breakdown.reservedTokens ?? 0) / breakdown.window,
    });
  }
  return (
    <table className="w-full border-collapse" data-testid="context-legend">
      <caption className="sr-only">What the context holds</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Part</th>
          <th scope="col">Tokens</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} data-testid={`context-row-${r.key}`}>
            <th scope="row" className="py-0 pr-2 text-left font-normal">
              <span className="flex items-center gap-1.5">
                <Swatch color={r.color} opacity={r.opacity} />
                {r.label}
              </span>
            </th>
            <td className="py-0 pr-2 text-right tabular-nums">
              {formatTokens(r.tokens)}
            </td>
            <td className="py-0 text-right tabular-nums">
              {percentOf(r.share)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The session's size on disk and its item count (STOR8), and a warning past
 * the session budget. The size is what core recorded at the last save (or
 * read from the files when the session was listed), so it is known once the
 * session list has been fetched. A session saved as an append-only log
 * counts the log and the outputs stored beside it.
 */
function SessionFileNote() {
  const items = useAppSelector((s) => s.session.history.length);
  const listed = useAppSelector((s) =>
    s.session.allSessionMetadata.find((m) => m.sessionId === s.session.id),
  );
  const fileBytes = listed?.fileBytes;
  if (fileBytes === undefined) return null;
  const over = isOverSessionBudget(fileBytes);
  const log = listed?.storage === "log";
  const size = log
    ? `Session ${formatFileSize(fileBytes)} on disk (log and stored outputs)`
    : `Session file ${formatFileSize(fileBytes)}`;
  const why = log
    ? "opening it reads all of it, and this window holds all of it in memory"
    : "every save rewrites the whole file, so saving and opening it get slower";
  return (
    <span
      className={over ? "text-warning" : "text-description-muted"}
      data-testid="context-session-file"
      data-over-budget={over ? "true" : undefined}
    >
      {`${size}, ${items.toLocaleString("en-US")} ${items === 1 ? "item" : "items"}.`}
      {over &&
        ` Past the ${formatFileSize(SESSION_FILE_BUDGET_BYTES)} session budget: ${why}. A new session starts small.`}
    </span>
  );
}

const LINK_CLASS =
  "cursor-pointer border-none bg-transparent p-0 text-xs text-link underline hover:brightness-125 focus-visible:outline focus-visible:outline-1";

/**
 * The details: what the context holds (a stacked bar and its table), the
 * largest items, the cache, and what to do about it. Built only while open:
 * the split reads the same request description the cache tools use.
 */
function ContextPanel({
  close,
  chooseWhatToKeep,
}: {
  close: () => void;
  chooseWhatToKeep: () => void;
}) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const history = useAppSelector((s) => s.session.history);
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const isPruned = useAppSelector((s) => s.session.isPruned);
  const model = useAppSelector(selectSelectedChatModel);
  const cacheSetting = useAppSelector(selectCacheSetting);
  const cacheState = useAppSelector((s) => s.session.promptCache);
  const removalUndo = useAppSelector((s) => s.session.contextRemovalUndo);
  const compactConversation = useCompactConversation();
  const compactionNote = useCompactionCacheNote();
  const now = useNow();
  const { breakdown } = useContextBreakdown();

  const tokens = cacheState?.lastInputTokens ?? 0;
  const isLarge = !!model && tokens >= contextMeterTokens(model);
  const cacheStatus =
    model && modelSupportsPromptCacheControl(model)
      ? promptCacheStatus(
          model,
          cacheSetting,
          cacheState ?? { escalated: false },
          now,
        )
      : undefined;
  const cost =
    model && isLarge
      ? perMessageCost(model, tokens, cacheStatus?.ttl ?? "5m")
      : undefined;
  const longNote =
    model && isLarge ? longContextNote(model, tokens) : undefined;
  const percent =
    breakdown.fraction !== undefined
      ? Math.round(breakdown.fraction * 100)
      : undefined;

  const go = (route: string) => {
    close();
    void navigate(route);
  };

  return (
    <div
      className="flex w-72 max-w-full flex-col gap-2 text-left text-xs"
      data-testid="context-panel"
    >
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold" data-testid="context-panel-total">
          {breakdown.window
            ? `Context: ${formatTokens(breakdown.usedTokens)} of ${formatTokens(breakdown.window)} tokens (${percent}%)`
            : `Context: about ${formatTokens(breakdown.usedTokens)} tokens; window unknown for this model`}
        </span>
        <span
          className="text-description-muted"
          data-testid="context-split-note"
        >
          {!breakdown.scaled
            ? "Estimated at about four characters per token; no provider count yet."
            : breakdown.categories.some((c) => c.key === "other")
              ? "Estimated split: the total is the provider's count for the last request, well above the estimate of what the conversation holds now, so the difference is not itemised. It updates with the next request."
              : removalUndo
                ? "Estimated split: the provider's count for the last request, less the estimated size of what you removed since."
                : "Estimated split: the total is the provider's count for the last request, shared out by size."}
        </span>
      </div>

      <StackedBar breakdown={breakdown} />
      <LegendTable breakdown={breakdown} />

      {breakdown.pruneAtTokens !== undefined && (
        <span className="text-description-muted">
          Past {formatTokens(breakdown.pruneAtTokens)} tokens (the line on the
          bar) the oldest messages are left out of each request.
        </span>
      )}

      {breakdown.largest.length > 0 && (
        <div className="flex flex-col gap-0.5" data-testid="context-largest">
          <span className="font-semibold">Largest items</span>
          <ul className="m-0 list-none p-0">
            {breakdown.largest.map((item, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span className="min-w-0 truncate">{item.label}</span>
                <span className="flex-none tabular-nums">
                  {formatTokens(item.tokens)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {cacheStatus && (
        <span data-testid="context-cache-status">
          {promptCacheTooltip(
            cacheStatus,
            cacheSetting,
            cacheState?.escalatedBy,
          )}
        </span>
      )}
      {isLarge && (
        <span data-testid="context-size-note">
          {`${formatTokens(tokens)} tokens are sent with every message.`}
          {cost &&
            ` One more message costs about ${formatUsd(cost.warmUsd)} with the prompt cache warm and ${formatUsd(cost.coldUsd)} after it expires.`}
        </span>
      )}
      {isLarge && (
        <span data-testid="context-quality-note">{QUALITY_NOTE}</span>
      )}
      {longNote && <span data-testid="long-context-note">{longNote}</span>}
      {isPruned && (
        <span className="text-error" data-testid="context-pruned-note">
          Oldest messages are being left out of each request.
        </span>
      )}
      {history.length > 0 && compactionNote && (
        <span className="text-warning" data-testid="compaction-cache-note">
          {compactionNote}
        </span>
      )}

      {removalUndo && (
        <span data-testid="context-removal-undo-note">
          {removalUndo.removedTokens >= 0
            ? `You took about ${formatTokens(removalUndo.removedTokens)} tokens out of the context.`
            : `You put about ${formatTokens(-removalUndo.removedTokens)} tokens back into the context.`}{" "}
          Undo puts everything back as it was when the last message was sent, at
          no cost, until you send the next one.{" "}
          <button
            type="button"
            data-testid="context-removal-undo"
            className={LINK_CLASS}
            onClick={() => {
              dispatch(undoContextRemovals());
              void dispatch(
                saveCurrentSession({
                  openNewSession: false,
                  generateTitle: false,
                }),
              );
            }}
          >
            Undo
          </button>
        </span>
      )}

      <SessionFileNote />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="context-compact-now"
          className="cursor-pointer rounded border border-solid border-border bg-secondary px-2 py-0.5 text-xs text-secondary-foreground hover:bg-secondary-hover disabled:cursor-not-allowed disabled:opacity-50"
          disabled={history.length === 0 || isStreaming}
          onClick={() => {
            close();
            void compactConversation(history.length - 1);
          }}
        >
          Compact now
        </button>
        <button
          type="button"
          data-testid="context-choose-what-to-keep"
          aria-haspopup="dialog"
          className="cursor-pointer rounded border border-solid border-border bg-secondary px-2 py-0.5 text-xs text-secondary-foreground hover:bg-secondary-hover disabled:cursor-not-allowed disabled:opacity-50"
          disabled={history.length === 0 || isStreaming}
          onClick={() => {
            close();
            chooseWhatToKeep();
          }}
        >
          Choose what to keep…
        </button>
        <button
          type="button"
          data-testid="context-new-session"
          className="cursor-pointer rounded border border-solid border-border bg-secondary px-2 py-0.5 text-xs text-secondary-foreground hover:bg-secondary-hover"
          onClick={() => {
            close();
            void dispatch(
              saveCurrentSession({
                openNewSession: true,
                generateTitle: false,
              }),
            );
          }}
        >
          New session
        </button>
      </div>
      <div className="flex flex-wrap gap-x-2 text-description-muted">
        <span>Settings:</span>
        <button
          type="button"
          className={LINK_CLASS}
          onClick={() => go(CONFIG_ROUTES.RULES)}
        >
          Rules
        </button>
        <button
          type="button"
          className={LINK_CLASS}
          onClick={() => go(CONFIG_ROUTES.TOOLS)}
        >
          Tools
        </button>
        <button
          type="button"
          className={LINK_CLASS}
          onClick={() => go(CONFIG_ROUTES.MODELS)}
        >
          Models
        </button>
      </div>
    </div>
  );
}

/**
 * The context meter in the row under the prompt, beside the cost: a short
 * bar and the share of the window used, coloured by how full it is. Pressing
 * it (click, Enter or Space) or resting the pointer on it opens what the
 * context holds, with Compact now and New session. It replaces the battery
 * that used to appear from 60 percent (`ContextStatus`), so there is one
 * meter. Hidden until there is a number: a reported request, or core's
 * estimate from the last request it built.
 */
export function ContextMeter() {
  const tier = useToolbarWidthTier();
  const { context } = useLastRequestContext();
  const estimate = useAppSelector((s) => s.session.contextPercentage);
  const isPruned = useAppSelector((s) => s.session.isPruned);
  const model = useAppSelector(selectSelectedChatModel);
  const lastInput = useAppSelector(
    (s) => s.session.promptCache?.lastInputTokens ?? 0,
  );

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const openRef = useRef(false);
  const closeRef = useRef<() => void>(() => {});
  const hoverOpened = useRef(false);
  const programmatic = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [keepOpen, setKeepOpen] = useState(false);

  const fraction = context?.fraction ?? estimate;
  if (fraction === undefined) return null;

  const percent = Math.round(Math.min(fraction, 1) * 100);
  const large = !!model && lastInput >= contextMeterTokens(model);
  const level = contextLevel(fraction, { pruned: !!isPruned, large });

  const clearTimer = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const onEnter = () => {
    clearTimer();
    if (openRef.current) return;
    timer.current = setTimeout(() => {
      if (openRef.current) return;
      hoverOpened.current = true;
      programmatic.current = true;
      buttonRef.current?.click();
      programmatic.current = false;
    }, HOVER_OPEN_MS);
  };
  const onLeave = () => {
    clearTimer();
    if (!hoverOpened.current) return;
    timer.current = setTimeout(() => {
      if (!hoverOpened.current) return;
      hoverOpened.current = false;
      closeRef.current();
    }, HOVER_CLOSE_MS);
  };

  const visible = tier === "wide" ? `Context ${percent}%` : `${percent}%`;
  const name = `Context ${percent}% used${isPruned ? ", oldest messages left out" : ""}`;

  return (
    <>
      <Popover className="relative flex flex-none">
        {({ open, close }) => {
          openRef.current = open;
          closeRef.current = close;
          if (!open) hoverOpened.current = false;
          return (
            <>
              <PopoverButton
                as={HoverButton}
                ref={buttonRef}
                aria-label={name}
                data-testid="context-meter"
                data-level={level}
                className="flex-none gap-1 px-0.5 [font-size:inherit] tabular-nums"
                onMouseEnter={onEnter}
                onMouseLeave={onLeave}
                onClick={(e: React.MouseEvent) => {
                  if (programmatic.current) return;
                  clearTimer();
                  // A click on details the pointer opened keeps them open
                  if (hoverOpened.current && openRef.current) {
                    e.preventDefault();
                    hoverOpened.current = false;
                  }
                }}
              >
                <span
                  className={`relative h-[3px] ${tier === "narrow" ? "w-3" : "w-6"} overflow-hidden rounded-xs bg-command-border`}
                  aria-hidden="true"
                >
                  <span
                    className={`absolute top-0 left-0 h-full ${LEVEL_BAR[level]}`}
                    style={{ width: `${percent}%` }}
                    data-testid="context-meter-fill"
                  />
                </span>
                <span aria-hidden="true">{visible}</span>
              </PopoverButton>
              <PopoverPanel
                anchor="top end"
                data-testid="context-details"
                aria-label="What the context holds"
                onMouseEnter={onEnter}
                onMouseLeave={onLeave}
                className="z-[200000] max-w-[90vw] rounded border border-solid border-border bg-vsc-input-background p-2 text-xs text-foreground shadow-md"
              >
                <ContextPanel
                  close={close}
                  chooseWhatToKeep={() => setKeepOpen(true)}
                />
              </PopoverPanel>
            </>
          );
        }}
      </Popover>
      {keepOpen && (
        <SelectiveCompactDialog
          onClose={() => {
            setKeepOpen(false);
            buttonRef.current?.focus();
          }}
        />
      )}
    </>
  );
}
