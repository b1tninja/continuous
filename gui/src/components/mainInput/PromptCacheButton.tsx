import {
  selectCacheSetting,
  selectChosenCacheSetting,
} from "../../redux/selectors/selectCacheSetting";
import { CircleStackIcon as CircleStackIconOutline } from "@heroicons/react/24/outline";
import { CircleStackIcon as CircleStackIconSolid } from "@heroicons/react/24/solid";
import { useCountdownNow } from "../../hooks/useCountdownNow";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { formatCacheSummary, summarizeLedger } from "../../util/cacheLedger";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import {
  restoreCacheTipsForModel,
  setApplyToolChangesAtOnce,
  setPromptCacheSetting,
} from "../../redux/slices/uiSlice";
import { cacheExportText } from "../../util/cacheExport";
import { dismissedTipCount } from "../../util/cacheTips";
import {
  modelHasFixedCacheLifetime,
  modelSupportsOneHourCache,
  cachingIsDefaulted,
  modelSupportsPromptCacheControl,
  PROMPT_CACHE_SETTING_LABELS,
  promptCacheSettingDetail,
  promptCacheStatus,
  promptCacheTooltip,
  type PromptCacheSetting,
} from "../../util/promptCache";
import {
  COUNTDOWN_WARN_MS,
  formatCountdown,
  ringFraction,
} from "../../util/promptCacheCountdown";
import { ToolTip } from "../gui/Tooltip";
import { useToolbarWidthTier } from "./InputToolbar/widthTier";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "../ui";

const CHOICES: (PromptCacheSetting | "config")[] = [
  "auto",
  "5m",
  "1h",
  "off",
  "config",
];

/** Not a setting: a menu entry that brings dismissed tips back. */
const RESTORE_TIPS = "restore-tips";
/** Not a setting either: copies the session's cache record to the clipboard. */
const COPY_RECORD = "copy-record";
/** Switches whether a tool list change waits for a cold cache (C80). */
const TOOL_CHANGES = "tool-changes";

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * A ring that drains as the cache entry ages; `fraction` 1 is full. Drawn at
 * the size of the other toolbar icons (16px).
 */
function CountdownRing({
  fraction,
  warn,
}: {
  fraction: number;
  warn: boolean;
}) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`h-4 w-4 flex-none -rotate-90 ${warn ? "text-warning" : "brightness-200"}`}
      data-testid="prompt-cache-ring"
      aria-hidden="true"
    >
      <circle
        cx="6"
        cy="6"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.5"
      />
      <circle
        cx="6"
        cy="6"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={`${RING_CIRCUMFERENCE * fraction} ${RING_CIRCUMFERENCE}`}
      />
    </svg>
  );
}

function tooltipText(
  status: ReturnType<typeof promptCacheStatus>,
  setting: PromptCacheSetting | undefined,
  reason?: "gap" | "requests",
  summary?: string,
  defaulted?: boolean,
): string {
  const text = promptCacheTooltip(status, setting, reason);
  // Caching is on only because nothing said otherwise. Say so, and how to stop it.
  const why = defaulted
    ? "\n\nOn by default in this mode, because config.yaml does not say. Choose Off here, or set promptCaching: false in config.yaml, to turn it off."
    : "";
  return summary ? `${text}${why}\n\nThis session: ${summary}` : text + why;
}

/**
 * The state of the cache in a word or two, for the button's name and, when
 * there is room, beside its icon. Nothing here is new state: it is
 * `promptCacheStatus` read aloud.
 */
export function promptCacheStateWords(
  status: ReturnType<typeof promptCacheStatus>,
  isStreaming: boolean,
): { short: string; long: string } {
  if (!status.on) return { short: "off", long: "off" };
  if (status.belowMinimum)
    return { short: "on", long: "on, nothing cached yet" };
  if (status.warm) {
    if (isStreaming) return { short: "warm", long: "warm" };
    const left = formatCountdown(status.msLeft ?? 0);
    return { short: left, long: `${left} left` };
  }
  return { short: "cold", long: "cold" };
}

/**
 * Control for prompt caching in the row under the prompt, next to the
 * reasoning light bulb. While the cache is warm it shows a ring that drains
 * toward expiry. Otherwise it is the database icon, filled when requests carry
 * cache breakpoints and outlined when they do not. Beside the icon, when the
 * row has room, the state: time left, "cold", "on" or "off" (a "Cache" label
 * too when wide). The state is always in the button's name. Shown only for
 * models whose provider honours it.
 */
export function PromptCacheButton() {
  const dispatch = useAppDispatch();
  const tier = useToolbarWidthTier();
  const model = useAppSelector(selectSelectedChatModel);
  // What was picked in the menu, and what is in force (the default applies
  // when nothing was picked and config says nothing).
  const chosen = useAppSelector(selectChosenCacheSetting);
  const setting = useAppSelector(selectCacheSetting);
  const mode = useAppSelector((s) => s.session.mode);
  const defaulted = cachingIsDefaulted(model, chosen, mode);
  const sessionState = useAppSelector((s) => s.session.promptCache);
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const dismissedTips = useAppSelector((s) => s.ui.dismissedCacheTips);
  const toolChangesAtOnce = useAppSelector(
    (s) => !!s.ui.applyToolChangesAtOnce,
  );

  const state = sessionState ?? { escalated: false };
  // Asking at the moment of the last request always finds the entry alive (when
  // caching is on), which gives the expiry the countdown hook sleeps toward.
  const expiresAt =
    model && state.lastRequestAt !== undefined
      ? promptCacheStatus(model, setting, state, state.lastRequestAt).expiresAt
      : undefined;
  // While a response streams the entry is being read and refreshed, so a
  // countdown from the request's start would only mislead.
  const now = useCountdownNow(expiresAt, !isStreaming);

  if (!model || !modelSupportsPromptCacheControl(model)) return null;

  const status = promptCacheStatus(model, setting, state, now);
  const summaryLine = formatCacheSummary(
    summarizeLedger(state.ledger ?? []),
    now,
  );
  // No 1 hour where the provider would not apply it; no Auto either for a
  // model whose only lifetime is 5 minutes, since Auto could only sit there.
  const canOneHour = modelSupportsOneHourCache(model);
  const fixedLifetime = modelHasFixedCacheLifetime(model);
  const choices = CHOICES.filter(
    (c) => (canOneHour || c !== "1h") && (!fixedLifetime || c !== "auto"),
  );
  const dismissedCount = dismissedTipCount(dismissedTips, model.title);

  const showRing = status.on && status.warm;
  const msLeft = status.msLeft ?? 0;
  const fraction = isStreaming
    ? 1
    : ringFraction(msLeft, status.lifetimeMs ?? 0);
  const warn = !isStreaming && msLeft <= COUNTDOWN_WARN_MS;
  const words = promptCacheStateWords(status, isStreaming);

  return (
    <Listbox
      value={chosen ?? "config"}
      onChange={(
        choice:
          | PromptCacheSetting
          | "config"
          | typeof RESTORE_TIPS
          | typeof COPY_RECORD
          | typeof TOOL_CHANGES,
      ) => {
        if (choice === TOOL_CHANGES) {
          dispatch(setApplyToolChangesAtOnce(!toolChangesAtOnce));
          return;
        }
        if (choice === COPY_RECORD) {
          void navigator.clipboard
            .writeText(
              cacheExportText(state.ledger, state.failures, Date.now()),
            )
            .catch(() => {});
          return;
        }
        if (choice === RESTORE_TIPS) {
          dispatch(restoreCacheTipsForModel({ modelTitle: model.title }));
          return;
        }
        dispatch(
          setPromptCacheSetting({
            modelTitle: model.title,
            setting: choice === "config" ? undefined : choice,
          }),
        );
      }}
    >
      <div className="relative">
        <ToolTip
          place="top"
          content={tooltipText(
            status,
            setting,
            state.escalatedBy,
            summaryLine,
            defaulted,
          )}
        >
          <ListboxButton
            data-testid="prompt-cache-button"
            aria-label={`Prompt cache ${words.long}`}
            className={`m-0 flex min-h-6 min-w-6 flex-none cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 [font-size:inherit] text-description hover:brightness-150 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-border-focus ${tier === "narrow" ? "" : "px-0.5"}`}
          >
            <span className="flex items-center gap-1">
              {showRing ? (
                <CountdownRing fraction={fraction} warn={warn} />
              ) : status.on ? (
                <CircleStackIconSolid
                  className="h-4 w-4 opacity-60"
                  aria-hidden="true"
                />
              ) : (
                <CircleStackIconOutline
                  className="h-4 w-4"
                  aria-hidden="true"
                />
              )}
              {tier !== "narrow" && (
                <span
                  data-testid={
                    showRing && !isStreaming
                      ? "prompt-cache-countdown"
                      : "prompt-cache-state"
                  }
                  aria-hidden="true"
                  className={`tabular-nums ${showRing && warn ? "text-warning" : ""}`}
                >
                  {tier === "wide" ? `Cache ${words.short}` : words.short}
                </span>
              )}
            </span>
          </ListboxButton>
        </ToolTip>
        <ListboxOptions className="max-w-72 min-w-48">
          {choices.map((choice) => (
            <ListboxOption
              key={choice}
              value={choice}
              data-testid={`prompt-cache-option-${choice}`}
            >
              <div className="flex flex-col">
                <span>{PROMPT_CACHE_SETTING_LABELS[choice].label}</span>
                <span className="text-xs text-description-muted">
                  {promptCacheSettingDetail(choice, model)}
                </span>
              </div>
            </ListboxOption>
          ))}
          {(state.ledger?.length ?? 0) > 0 && (
            <ListboxOption
              value={COPY_RECORD}
              data-testid="prompt-cache-option-copy-record"
            >
              <div className="flex flex-col">
                <span>Copy cache record</span>
                <span className="text-xs text-description-muted">
                  Counts and timings of this conversation's requests, no message
                  text
                </span>
              </div>
            </ListboxOption>
          )}
          <ListboxOption
            value={TOOL_CHANGES}
            data-testid="prompt-cache-option-tool-changes"
          >
            <div className="flex flex-col">
              <span>
                {toolChangesAtOnce
                  ? "Let tool changes wait for a cold cache"
                  : "Apply tool changes at once"}
              </span>
              <span className="text-xs text-description-muted">
                {toolChangesAtOnce
                  ? "Now turning a tool or MCP server on or off re-reads the conversation at once"
                  : "Now a tool or MCP server change waits while the cache is warm and the conversation is large"}
              </span>
            </div>
          </ListboxOption>
          {dismissedCount > 0 && (
            <ListboxOption
              value={RESTORE_TIPS}
              data-testid="prompt-cache-option-restore-tips"
            >
              <div className="flex flex-col">
                <span>Show dismissed tips</span>
                <span className="text-xs text-description-muted">
                  {dismissedCount} hidden for this model
                </span>
              </div>
            </ListboxOption>
          )}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
