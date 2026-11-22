import {
  DEFAULT_POLICY_LEVELS,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_PRESETS,
  policyLevelLabel,
} from "core/tools/permissions/policy";
import ToggleSwitch from "../gui/Switch";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { changePolicyExtras } from "../../redux/thunks/policySettings";
import { Card, Fold } from "../ui";
import { PlansAndQuestions } from "./PlansAndQuestions";
import { AreaLevelSelect } from "./PolicyControls";
import { plansAndQuestionsSummary, skipConfirmState } from "./policySummaries";
import { PresetSelect } from "./PresetSelect";

const AREA_HINTS = {
  context: "Reading files and searching. What the agent looks at.",
  tools: "Commands, MCP tools and the web. What the agent runs.",
  edits:
    "Changing files. At Permissive and IDGAF an edit is kept without a diff review.",
  plan: "Loop only. Whether a plan or re-plan goes on without you.",
  questions: "Loop only. Whether the agent answers its own questions.",
} as const;

/**
 * Settings > Permissions > Levels: the same five controls as the toolbar,
 * with their explanations, then the settings beside them. Deny rules, ask
 * rules and protected paths always win, except for an area set to IDGAF.
 */
export function PolicyCard() {
  const dispatch = useAppDispatch();
  const extras = useAppSelector((s) => s.ui.policyExtras);
  const levels = useAppSelector((s) => s.ui.policyLevels);
  const plans = plansAndQuestionsSummary(extras);

  return (
    <div data-testid="policy-card">
      <h3 className="my-0 mb-1 text-sm font-semibold">Approval</h3>
      <p className="mt-0 mb-2 text-xs text-description">
        One decision per area: who decides a call your rules do not decide.
        Fewer decisions reach you as you go from Manual to IDGAF. Saved in
        permissions.yaml, which the CLI reads too. IDGAF is never saved.
      </p>
      <Card>
        <div className="flex flex-col gap-2 py-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-sm">Preset</span>
              <span className="text-2xs text-description">
                Sets all five areas at once. A new install starts at{" "}
                {POLICY_PRESETS.careful.label}.
              </span>
            </div>
            <PresetSelect placement="settings" />
          </div>
          {POLICY_AREAS.map((area) => (
            <div
              key={area}
              data-testid={`policy-row-${area}`}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              {/* The select moves under the text when less than 80 px is left for it */}
              <div className="flex min-w-0 flex-1 basis-20 flex-col">
                <span className="text-sm">{POLICY_AREA_LABELS[area]}</span>
                <span className="text-2xs text-description">
                  {AREA_HINTS[area]}
                </span>
                {/* The file always holds five levels, so "set" means changed from the built-in one */}
                <span
                  className="text-2xs text-description"
                  data-testid={`policy-state-${area}`}
                >
                  {levels[area] === DEFAULT_POLICY_LEVELS[area]
                    ? `Not set: ${policyLevelLabel(area, levels[area])} is the built-in level.`
                    : `Set by you. The built-in level is ${policyLevelLabel(area, DEFAULT_POLICY_LEVELS[area])}.`}
                </span>
              </div>
              <AreaLevelSelect area={area} variant="row" />
            </div>
          ))}
          <Fold
            id="plans-questions"
            title="Plans and questions"
            summary={plans.text}
          >
            <PlansAndQuestions />
          </Fold>
          <div data-testid="skip-permission-confirm">
            <ToggleSwitch
              isToggled={extras.skipPermissionConfirm === true}
              onToggle={() =>
                void dispatch(
                  changePolicyExtras({
                    skipPermissionConfirm:
                      extras.skipPermissionConfirm !== true,
                  }),
                )
              }
              text="Skip the confirmation when permissions change"
            />
            <div className="text-2xs text-description">
              The dialog that asks before a permission change is saved.{" "}
              {skipConfirmState(extras)} Turning this on asks once. An ask
              before a command runs is unchanged.
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
