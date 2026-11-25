import { ShieldCheckIcon } from "@heroicons/react/24/outline";
import { BUILTIN_RULES, builtinIsOn } from "core/tools/permissions/policy";
import {
  builtinForDegree,
  safetyLabel,
  safetyStateOf,
} from "core/tools/permissions/safetyDegrees";
import { useEffect, useId, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { changePolicyExtras } from "../../redux/thunks/policySettings";
import ToggleSwitch from "../gui/Switch";

/**
 * The safety checks. A preset sets them together with the levels (IDGAF
 * leaves none on); each check is still its own switch, and the two buttons set
 * all of them at once. The badge says how many are on.
 */
export function SafetyShield() {
  const dispatch = useAppDispatch();
  const extras = useAppSelector((s) => s.ui.policyExtras);
  const state = safetyStateOf(extras.builtin);
  const label = safetyLabel(extras.builtin);
  const anyOn = state.on > 0;
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

  const setAll = (degree: "all" | "none") =>
    void dispatch(changePolicyExtras({ builtin: builtinForDegree(degree) }));
  const summary = `Safety checks: ${label}`;

  return (
    <div ref={root} data-testid="safety-shield" className="text-2xs">
      <button
        ref={badge}
        type="button"
        data-testid="safety-shield-toggle"
        data-roving=""
        data-on={anyOn ? "true" : "false"}
        data-degree={state.degree}
        aria-label={summary}
        aria-expanded={open}
        aria-controls={listId}
        title={summary}
        className={`hover:bg-list-item-hover flex min-h-6 min-w-6 flex-none cursor-pointer items-center justify-center rounded-full border-none bg-transparent px-1 ${
          anyOn ? "text-success" : "text-description"
        }`}
        onClick={() => setOpen(!open)}
      >
        <ShieldCheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={listId}
          role="region"
          aria-label="Safety checks"
          data-testid="safety-shield-panel"
          className="absolute inset-x-0 bottom-full z-10 flex max-h-72 flex-col gap-1 overflow-y-auto rounded-t-default border border-solid border-command-border bg-input px-2 py-1 shadow-lg"
        >
          <div className="font-semibold text-foreground">
            Safety checks:{" "}
            <span data-testid="safety-shield-label">{label}</span>
          </div>
          <p className="mt-0 mb-1 text-description-muted">
            A preset sets these along with the levels: IDGAF leaves none on.
            Each one can be switched on its own.
          </p>
          <div className="flex gap-1" data-testid="safety-shield-master">
            <button
              type="button"
              data-testid="safety-shield-all"
              className="hover:bg-list-item-hover cursor-pointer rounded-default border border-solid border-command-border bg-transparent px-2 py-0.5 text-foreground"
              onClick={() => setAll("all")}
            >
              All on
            </button>
            <button
              type="button"
              data-testid="safety-shield-none"
              className="hover:bg-list-item-hover cursor-pointer rounded-default border border-solid border-command-border bg-transparent px-2 py-0.5 text-foreground"
              onClick={() => setAll("none")}
            >
              None on
            </button>
          </div>
          {BUILTIN_RULES.map((rule) => (
            <div key={rule.id} data-testid={`shield-${rule.id}`}>
              <ToggleSwitch
                isToggled={builtinIsOn(extras.builtin, rule.id)}
                text={rule.label}
                tooltip={rule.description}
                onToggle={() =>
                  void dispatch(
                    changePolicyExtras({
                      builtin: {
                        ...extras.builtin,
                        [rule.id]: !builtinIsOn(extras.builtin, rule.id),
                      },
                    }),
                  )
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
