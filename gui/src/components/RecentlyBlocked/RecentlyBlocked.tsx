import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import { ShieldExclamationIcon } from "@heroicons/react/24/outline";
import { useEffect, useId, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { changePolicyExtras } from "../../redux/thunks/policySettings";
import { builtinForBlockedCall } from "../SafetyShield/safetyChecks";
import {
  allowBlockedOnce,
  canAllowOnce,
  clearBlockedCalls,
} from "../../redux/slices/blockedCallsSlice";
import { PendingActionSummary } from "../mainInput/Lump/LumpToolbar/PendingActionSummary";
import { decisionLabel } from "../../pages/gui/ToolCallDiv/DecisionChip";

/**
 * Calls refused this session (kept in memory only), with who refused each and
 * why. A call that the Auto reviewer refused can be allowed once; the others
 * come from your rules, protected paths or the safety check, which a click
 * here does not override.
 *
 * It is a badge in the mode bar (a shield and the count) that opens the list
 * above the bar; Escape or a click elsewhere closes it, and focus goes back to
 * the badge. It positions against the nearest positioned ancestor, which is
 * the row above the input.
 */
export function RecentlyBlocked() {
  const dispatch = useAppDispatch();
  const items = useAppSelector((s) => s.blockedCalls.items);
  const builtin = useAppSelector((s) => s.ui.policyExtras.builtin);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        badge.current?.focus();
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  if (items.length === 0) return null;

  const label = `Recently blocked: ${items.length} call${items.length === 1 ? "" : "s"}`;
  return (
    <div ref={root} data-testid="recently-blocked" className="text-2xs">
      <button
        ref={badge}
        type="button"
        data-testid="recently-blocked-toggle"
        data-roving=""
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        title={`Recently blocked (${items.length})`}
        className="hover:bg-list-item-hover relative flex min-h-6 min-w-6 flex-none cursor-pointer items-center justify-center rounded-full border-none bg-transparent px-1 text-description"
        onClick={() => setOpen(!open)}
      >
        <ShieldExclamationIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {/* The count overhangs the button by 3 px on purpose */}
        <span
          aria-hidden="true"
          data-testid="recently-blocked-count"
          className="absolute -top-0.5 -right-[3px] min-w-[15px] rounded-lg bg-error px-0.5 text-center text-[10px] leading-[15px] font-semibold text-white"
        >
          {items.length}
        </span>
      </button>
      {open && (
        <div
          id={listId}
          role="region"
          aria-label="Recently blocked"
          data-testid="recently-blocked-list"
          className="absolute inset-x-0 bottom-full z-10 flex max-h-60 flex-col gap-1 overflow-y-auto rounded-t-default border border-solid border-command-border bg-input px-2 py-1 shadow-lg"
        >
          <div className="font-semibold text-foreground">
            Recently blocked ({items.length})
          </div>
          {items.map((item) => (
            <div
              key={item.id}
              data-testid={`blocked-${item.id}`}
              className="flex flex-col gap-0.5 rounded-sm border border-solid border-command-border px-1 py-0.5"
            >
              {/* The command keeps 64 px: when the verdict and its button do not fit beside that, they wrap below */}
              <div className="flex flex-wrap items-center gap-x-1">
                <code
                  className="min-w-12 flex-1 basis-16 truncate"
                  title={maskCommandForDisplay(item.summary)}
                >
                  {maskCommandForDisplay(item.summary)}
                </code>
                <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-x-1">
                  <span className="shrink-0 font-semibold text-foreground">
                    {decisionLabel({
                      outcome: "blocked",
                      source: item.source,
                      category: item.category,
                    })}
                  </span>
                  {canAllowOnce(item) &&
                    (item.allowedOnce ? (
                      <span className="min-w-0 text-description-muted">
                        Allowed once. Ask the agent to try again.
                      </span>
                    ) : (
                      <button
                        type="button"
                        data-testid={`allow-once-${item.id}`}
                        className="shrink-0 cursor-pointer rounded-sm border-none bg-lightgray/20 px-1 text-2xs text-foreground"
                        onClick={() => dispatch(allowBlockedOnce(item.id))}
                      >
                        Allow once
                      </button>
                    ))}
                </div>
              </div>
              <PendingActionSummary
                id={"blocked-action-" + item.id}
                testId={item.id}
                toolName={item.toolName}
                args={item.parsedArgs}
              />
              {item.reason && (
                <div className="whitespace-normal text-description-muted">
                  {maskCommandForDisplay(item.reason)}
                </div>
              )}
              {!canAllowOnce(item) &&
                (builtinForBlockedCall(item) ? (
                  builtin?.[builtinForBlockedCall(item)!] === false ? (
                    <div className="text-description-muted">
                      This check is off. Ask the agent to try again.
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid={`disable-rule-${item.id}`}
                      className="shrink-0 cursor-pointer self-start rounded-sm border-none bg-lightgray/20 px-1 text-2xs text-foreground"
                      onClick={() => {
                        const id = builtinForBlockedCall(item);
                        if (!id) return;
                        void dispatch(
                          changePolicyExtras({
                            builtin: { ...builtin, [id]: false },
                          }),
                        );
                      }}
                    >
                      Disable this rule
                    </button>
                  )
                ) : (
                  <div className="text-description-muted">
                    Set by your rules or settings. Change them in config.yaml or
                    Settings &gt; Tools to allow this.
                  </div>
                ))}
            </div>
          ))}
          <button
            type="button"
            className="cursor-pointer self-start border-none bg-transparent text-2xs text-description underline"
            onClick={() => dispatch(clearBlockedCalls())}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
