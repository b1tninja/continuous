import {
  Description,
  Dialog,
  DialogPanel,
  DialogTitle,
} from "@headlessui/react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { formatTokens } from "core/llm/utils/sessionUsage";
import { useEffect, useMemo, useRef, useState } from "react";
import { useContextBreakdown } from "../../hooks/useContextBreakdown";
import { useNow } from "../../hooks/useNow";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectCacheSetting } from "../../redux/selectors/selectCacheSetting";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { applyContextRemovals } from "../../redux/slices/sessionSlice";
import { saveCurrentSession } from "../../redux/thunks/session";
import { formatRereadCost } from "../../util/cacheNotices";
import {
  editCacheLoss,
  groupItems,
  groupState,
  inRemovedTurn,
  initialSelection,
  KEEP_GROUPS,
  keepTotals,
  listRemovable,
  marksFor,
  setGroupKept,
  setKept,
  type KeepGroupKey,
  type KeepModel,
  type RemovableItem,
  type Selection,
} from "../../util/selectiveCompaction";

/** Items shown per group before "Show N more". */
export const KEEP_GROUP_VISIBLE = 5;

const FIXED_KEYS = new Set(["system", "tools", "rules", "summary"]);

const percent = (tokens: number, window?: number) =>
  window ? ` (${Math.round((tokens / window) * 100)}%)` : "";

/** A checkbox that can show "mixed" (some of a group kept). */
function GroupCheckbox({
  state,
  onChange,
  id,
  testId,
}: {
  state: "all" | "none" | "some";
  onChange: (keep: boolean) => void;
  id: string;
  testId: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      data-testid={testId}
      checked={state === "all"}
      aria-checked={state === "some" ? "mixed" : state === "all"}
      onChange={() => onChange(state !== "all")}
      className="m-0 h-3.5 w-3.5 flex-none cursor-pointer"
    />
  );
}

function KeepGroup({
  group,
  label,
  model,
  selection,
  factor,
  onChange,
}: {
  group: KeepGroupKey;
  label: string;
  model: KeepModel;
  selection: Selection;
  factor: number;
  onChange: (next: Set<string>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = groupItems(model, group);
  if (items.length === 0) return null;
  const size = (i: RemovableItem) => Math.round(i.tokens * factor);
  const total = items.reduce((s, i) => s + size(i), 0);
  const shown = expanded ? items : items.slice(0, KEEP_GROUP_VISIBLE);
  const hiddenCount = items.length - shown.length;
  const groupId = `keep-group-${group}`;
  const listId = `${groupId}-items`;

  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0"
      data-testid={groupId}
    >
      <legend className="sr-only">{label}</legend>
      <label
        htmlFor={groupId}
        className="flex cursor-pointer items-center gap-1.5 font-semibold"
      >
        <GroupCheckbox
          id={groupId}
          testId={`${groupId}-checkbox`}
          state={groupState(model, selection, group)}
          onChange={(keep) =>
            onChange(setGroupKept(model, selection, group, keep))
          }
        />
        <span className="min-w-0 flex-1 truncate">
          Keep {label.toLowerCase()} ({items.length})
        </span>
        <span className="flex-none tabular-nums">{formatTokens(total)}</span>
      </label>
      <ul id={listId} className="m-0 flex list-none flex-col gap-0.5 p-0 pl-5">
        {shown.map((item) => {
          const inTurn =
            group !== "turns" && inRemovedTurn(model, selection, item);
          const kept = !selection.has(item.key) && !inTurn;
          const id = `keep-${item.key}`;
          return (
            <li key={item.key}>
              <label
                htmlFor={id}
                className={`flex items-center gap-1.5 ${inTurn ? "opacity-60" : "cursor-pointer"}`}
              >
                <input
                  id={id}
                  type="checkbox"
                  data-testid={`keep-item-${item.key}`}
                  checked={kept}
                  disabled={inTurn}
                  onChange={() =>
                    onChange(setKept(model, selection, item.key, !kept))
                  }
                  className="m-0 h-3.5 w-3.5 flex-none cursor-pointer"
                />
                <span className="min-w-0 flex-1 truncate" title={item.label}>
                  {item.label}
                  {item.removed && (
                    <span className="text-description-muted">
                      {" "}
                      (removed now)
                    </span>
                  )}
                  {inTurn && (
                    <span className="sr-only">, in a turn being removed</span>
                  )}
                </span>
                <span className="flex-none tabular-nums">
                  {formatTokens(size(item))}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          aria-expanded={false}
          aria-controls={listId}
          data-testid={`${groupId}-more`}
          className="ml-5 cursor-pointer self-start border-none bg-transparent p-0 text-xs text-link underline"
          onClick={() => setExpanded(true)}
        >
          Show {hiddenCount} more
        </button>
      )}
    </fieldset>
  );
}

/**
 * "Choose what to keep": the context by category and by item, with a
 * checkbox each, a live total after the change, and what the change costs the
 * prompt cache, before anything is applied. Unticked items are sent as a
 * one-line stub; nothing is deleted from the session. Opened from the context
 * panel beside Compact now; nothing changes unless the person applies it.
 * Headless UI's Dialog traps focus while it is open and closes on Escape.
 */
export function SelectiveCompactDialog({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch();
  const { segments, breakdown, history } = useContextBreakdown();
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const model = useAppSelector(selectSelectedChatModel);
  const cacheSetting = useAppSelector(selectCacheSetting);
  const cacheState = useAppSelector((s) => s.session.promptCache);
  const now = useNow();

  const keepModel = useMemo(() => listRemovable(history), [history]);
  const [selection, setSelection] = useState<Set<string>>(() =>
    initialSelection(keepModel),
  );
  const changes = useMemo(
    () => marksFor(history, keepModel, selection),
    [history, keepModel, selection],
  );
  const totals = useMemo(
    () => keepTotals({ history, segments, now: breakdown, changes }),
    [history, segments, breakdown, changes],
  );
  const changed = changes.firstChanged !== undefined;
  const loss =
    model && cacheState && changed
      ? editCacheLoss(model, cacheSetting, cacheState, now, totals.rereadTokens)
      : undefined;
  const warmUpfront =
    model && cacheState
      ? editCacheLoss(
          model,
          cacheSetting,
          cacheState,
          now,
          cacheState.lastInputTokens ?? 0,
        )
      : undefined;

  const fixedTokens = breakdown.categories
    .filter((c) => FIXED_KEYS.has(c.key))
    .reduce((s, c) => s + c.tokens, 0);
  const empty = keepModel.items.length === 0 && keepModel.turns.length === 0;

  const apply = () => {
    dispatch(
      applyContextRemovals({
        marks: changes.marks,
        removedTokens: totals.removedTokens,
      }),
    );
    void dispatch(
      saveCurrentSession({ openNewSession: false, generateTitle: false }),
    );
    onClose();
  };

  const applyLabel =
    totals.removedTokens > 0
      ? `Remove ${formatTokens(totals.removedTokens)}`
      : "Apply";

  return (
    <Dialog open onClose={onClose} className="relative z-[200001]">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-start justify-center overflow-y-auto p-2">
        <DialogPanel
          data-testid="keep-dialog"
          className="flex w-full max-w-md min-w-0 flex-col gap-2 rounded border border-solid border-border bg-background p-3 text-xs text-foreground shadow-lg"
        >
          <div className="flex items-center gap-1">
            <DialogTitle className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
              Choose what to keep
            </DialogTitle>
            <button
              type="button"
              data-testid="keep-close"
              aria-label="Close without changes"
              className="hover:bg-list-item-hover flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-description"
              onClick={onClose}
            >
              <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <Description className="m-0 text-description">
            Untick what the model no longer needs. Each removed item is sent as
            a one-line note in its place; nothing is deleted from the session.
            Nothing changes until you apply.
          </Description>

          <p
            className="m-0 flex flex-wrap justify-between gap-x-3 font-semibold"
            data-testid="keep-totals"
            aria-live="polite"
            aria-atomic="true"
          >
            <span>
              Context now: {formatTokens(totals.nowTokens)}
              {totals.window ? ` of ${formatTokens(totals.window)}` : ""}
              {percent(totals.nowTokens, totals.window)}
            </span>
            <span data-testid="keep-after">
              After: {formatTokens(totals.afterTokens)} tokens
              {percent(totals.afterTokens, totals.window)}
            </span>
          </p>

          {warmUpfront && (
            <p className="m-0 text-warning" data-testid="keep-cache-upfront">
              The prompt cache holds this conversation now. Any change here
              makes the next request re-read the conversation from the first
              changed message on.
            </p>
          )}

          <p className="m-0 flex justify-between gap-2 text-description">
            <span>System prompt, tools and rules (always kept)</span>
            <span className="tabular-nums">{formatTokens(fixedTokens)}</span>
          </p>

          {empty ? (
            <p className="m-0 text-description" data-testid="keep-empty">
              Nothing to choose yet: tool results, terminal output, attached
              context, images and older turns appear here as the conversation
              grows.
            </p>
          ) : (
            KEEP_GROUPS.map((g) => (
              <KeepGroup
                key={g.key}
                group={g.key}
                label={g.label}
                model={keepModel}
                selection={selection}
                factor={totals.factor}
                onChange={setSelection}
              />
            ))
          )}
          {keepModel.turns.length > 0 && (
            <p className="m-0 text-description-muted">
              Turns are removed from the start of the conversation only, and the
              latest turn is always kept.
            </p>
          )}

          {changed && (
            <p
              className={`m-0 ${loss ? "text-warning" : ""}`}
              data-testid="keep-cost"
            >
              {loss
                ? `This edits the conversation from turn ${totals.fromTurn} on: the next request re-reads ${formatRereadCost(loss)} instead of reading it from the cache.`
                : `This edits the conversation from turn ${totals.fromTurn} on. No warm prompt cache holds it now, so the next request costs nothing extra.`}{" "}
              Until you send the next message, Undo in the context panel puts
              everything back at no cost.
            </p>
          )}
          {isStreaming && (
            <p className="m-0 text-description" data-testid="keep-streaming">
              Wait for the reply to finish before applying.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-testid="keep-cancel"
              className="cursor-pointer rounded border border-solid border-border bg-secondary px-2 py-0.5 text-xs text-secondary-foreground hover:bg-secondary-hover"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="keep-apply"
              disabled={!changed || isStreaming}
              className="cursor-pointer rounded border border-solid border-border bg-primary px-2 py-0.5 text-xs text-primary-foreground hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={apply}
            >
              {applyLabel}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
