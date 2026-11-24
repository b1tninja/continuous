import {
  BUILTIN_RULES,
  LOCKED_FLOOR_RULES,
  builtinIsOn,
} from "core/tools/permissions/policy";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { changePolicyExtras } from "../../redux/thunks/policySettings";
import ToggleSwitch from "../gui/Switch";
import { Card } from "../ui";

/**
 * Settings > Permissions > Protections: the built-in rules, each with its
 * switch, and the locked rule that has none. A rule is on until it is
 * switched off; IDGAF ignores them all.
 */
export function BuiltinRulesCard() {
  const dispatch = useAppDispatch();
  const extras = useAppSelector((s) => s.ui.policyExtras);
  return (
    <div data-testid="builtin-rules">
      <p className="mt-0 mb-1 text-2xs text-description">
        Protections you can see and switch off. IDGAF ignores them. Not set, a
        rule is on, except Check shell commands, which runs only when you turn
        it on.
      </p>
      <Card>
        <div className="flex flex-col gap-2 py-1">
          {BUILTIN_RULES.map((rule) => (
            <div key={rule.id} data-testid={`builtin-${rule.id}`}>
              <ToggleSwitch
                isToggled={builtinIsOn(extras.builtin, rule.id)}
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
                text={rule.label}
              />
              <div className="text-2xs text-description">
                {rule.description}
              </div>
            </div>
          ))}
          {LOCKED_FLOOR_RULES.map((rule) => (
            <div key={rule.id} data-testid={`locked-${rule.id}`}>
              <div className="text-xs">{rule.label} (locked)</div>
              <div className="text-2xs text-description">
                {rule.description} No setting turns this off; at IDGAF it is
                recorded, not applied.
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
