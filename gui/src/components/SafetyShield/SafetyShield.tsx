import { ShieldCheckIcon } from "@heroicons/react/24/outline";
import { BUILTIN_RULES } from "core/tools/permissions/policy";
import { useEffect, useId, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectIdgafAreas } from "../../redux/selectors/selectAutoApproval";
import { changePolicyExtras } from "../../redux/thunks/policySettings";
import ToggleSwitch from "../gui/Switch";
import { safetyShieldOn } from "./safetyChecks";

/**
 * The safety-check shield. It is the person's choice: on, the checks ask
 * (and refuse at IDGAF); off, they do not. Left unset, they are off at IDGAF
 * and on at every other level. The list under it switches one check at a time.
 */
export function SafetyShield() {
  const dispatch = useAppDispatch();
  const extras = useAppSelector((s) => s.ui.policyExtras);
  const idgaf = useAppSelector((s) => selectIdgafAreas(s).length > 0);
  const on = safetyShieldOn(extras.safetyChecks, idgaf);
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

  const label = on
    ? extras.safetyChecks === true
      ? "Safety checks on"
      : "Safety checks on, off at IDGAF until you choose"
    : extras.safetyChecks === false
      ? "Safety checks off"
      : "Safety checks off at IDGAF";

  return (
    <div ref={root} data-testid="safety-shield" className="text-2xs">
      <button
        ref={badge}
        type="button"
        data-testid="safety-shield-toggle"
        data-roving=""
        data-on={on ? "true" : "false"}
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        title={label}
        className={`hover:bg-list-item-hover flex min-h-6 min-w-6 flex-none cursor-pointer items-center justify-center rounded-full border-none bg-transparent px-1 ${
          on ? "text-success" : "text-description"
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
          <div className="font-semibold text-foreground">Safety checks</div>
          <p className="mt-0 mb-1 text-description-muted">
            Your choice. Off, these checks do not block. On, they ask, and at
            IDGAF they refuse. Left unset, they are off at IDGAF and on
            otherwise.
          </p>
          <div data-testid="safety-shield-master">
            <ToggleSwitch
              isToggled={on}
              text={on ? "Safety checks on" : "Safety checks off"}
              onToggle={() =>
                void dispatch(changePolicyExtras({ safetyChecks: !on }))
              }
            />
          </div>
          <div className="mt-1 font-semibold text-foreground">
            Individual checks
          </div>
          <p className="mt-0 mb-1 text-description-muted">
            {on
              ? "These apply when safety checks are on."
              : "Safety checks are off, so none of these apply. Turn them on to choose one at a time."}
          </p>
          {BUILTIN_RULES.map((rule) => (
            <div key={rule.id} data-testid={`shield-${rule.id}`}>
              <ToggleSwitch
                isToggled={on && extras.builtin?.[rule.id] !== false}
                disabled={!on}
                text={rule.label}
                tooltip={rule.description}
                onToggle={() =>
                  void dispatch(
                    changePolicyExtras({
                      builtin: {
                        ...extras.builtin,
                        [rule.id]: extras.builtin?.[rule.id] === false,
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
