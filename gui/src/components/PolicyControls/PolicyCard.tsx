import {
  BUILTIN_RULES,
  LOCKED_FLOOR_RULES,
  DEFAULT_AGENT_DECIDES,
  DEFAULT_MAX_NEW_PLAN_ITEMS,
  DEFAULT_YOU_DECIDE,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  QUESTION_TYPE_DESCRIPTIONS,
  QUESTION_TYPES,
  type QuestionType,
} from "core/tools/permissions/policy";
import ToggleSwitch from "../gui/Switch";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { changePolicyExtras } from "../../redux/thunks/policySettings";
import { Card } from "../ui";
import { AreaLevelSelect } from "./PolicyControls";
import { PresetSelect } from "./PresetSelect";

const AREA_HINTS = {
  context: "Reading files and searching. What the agent looks at.",
  tools: "Commands, MCP tools and the web. What the agent runs.",
  edits:
    "Changing files. At Permissive and IDGAF an edit is kept without a diff review.",
  plan: "Loop only. Whether a plan or re-plan goes on without you.",
  questions: "Loop only. Whether the agent answers its own questions.",
} as const;

type WhoDecides = "you" | "agent" | "level";

/** Who decides questions of this type, from the two lists. */
function whoDecides(
  type: QuestionType,
  youDecide: readonly QuestionType[],
  agentDecides: readonly QuestionType[],
): WhoDecides {
  if (youDecide.includes(type)) return "you";
  if (agentDecides.includes(type)) return "agent";
  return "level";
}

/**
 * Settings > Tools: the same five controls as the toolbar, with their
 * explanations, then the settings beside them. Deny rules, ask rules and
 * protected paths always win, except for an area set to IDGAF.
 */
export function PolicyCard() {
  const dispatch = useAppDispatch();
  const extras = useAppSelector((s) => s.ui.policyExtras);
  const youDecide = extras.questions?.youDecide ?? DEFAULT_YOU_DECIDE;
  const agentDecides = extras.questions?.agentDecides ?? DEFAULT_AGENT_DECIDES;
  const floor = extras.floor ?? [];

  const setWho = (type: QuestionType, who: WhoDecides) => {
    const you = youDecide.filter((t) => t !== type);
    const agent = agentDecides.filter((t) => t !== type);
    if (who === "you") you.push(type);
    if (who === "agent") agent.push(type);
    void dispatch(
      changePolicyExtras({
        questions: { youDecide: you, agentDecides: agent },
      }),
    );
  };

  return (
    <div data-testid="policy-card">
      <h3 className="my-0 mb-1 text-sm font-semibold">Approval</h3>
      <p className="mt-0 mb-2 text-xs text-description">
        One decision per area: who decides a call your rules leave open. Fewer
        decisions reach you as you go from Manual to IDGAF. Saved in
        permissions.yaml, which the CLI reads too. IDGAF is never saved.
      </p>
      <Card>
        <div className="flex flex-col gap-2 py-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-sm">Preset</span>
              <span className="text-2xs text-description">
                Sets all five areas at once.
              </span>
            </div>
            <PresetSelect placement="settings" />
          </div>
          {POLICY_AREAS.map((area) => (
            <div
              key={area}
              data-testid={`policy-row-${area}`}
              className="flex items-center justify-between gap-2"
            >
              <div className="flex flex-col">
                <span className="text-sm">{POLICY_AREA_LABELS[area]}</span>
                <span className="text-2xs text-description">
                  {AREA_HINTS[area]}
                </span>
              </div>
              <AreaLevelSelect area={area} variant="row" />
            </div>
          ))}
        </div>
      </Card>

      <h4 className="mt-3 mb-1 text-xs font-semibold">Built-in rules</h4>
      <p className="mt-0 mb-1 text-2xs text-description">
        Protections you can see and switch off. IDGAF ignores them.
      </p>
      <Card>
        <div className="flex flex-col gap-2 py-1">
          {BUILTIN_RULES.map((rule) => (
            <div key={rule.id} data-testid={`builtin-${rule.id}`}>
              <ToggleSwitch
                isToggled={extras.builtin?.[rule.id] !== false}
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
                {rule.description} No setting, including IDGAF, turns this off.
              </div>
            </div>
          ))}
        </div>
      </Card>

      <h4 className="mt-3 mb-1 text-xs font-semibold">Plans and questions</h4>
      <Card>
        <div className="flex flex-col gap-2 py-1">
          <label
            className="flex items-center justify-between gap-2 text-xs"
            data-testid="policy-max-new-items"
          >
            <span>
              New to-dos a re-plan may add by itself
              <span className="block text-2xs text-description">
                Plan edits at Permissive. Default {DEFAULT_MAX_NEW_PLAN_ITEMS}.
              </span>
            </span>
            <input
              type="number"
              min={0}
              className="w-14 rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
              value={extras.maxNewPlanItems ?? DEFAULT_MAX_NEW_PLAN_ITEMS}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0) {
                  void dispatch(changePolicyExtras({ maxNewPlanItems: n }));
                }
              }}
            />
          </label>
          {QUESTION_TYPES.map((type) => (
            <label
              key={type}
              className="flex items-center justify-between gap-2 text-xs"
              data-testid={`question-type-${type}`}
            >
              <span>
                {type}
                <span className="block text-2xs text-description">
                  {QUESTION_TYPE_DESCRIPTIONS[type]}
                </span>
              </span>
              <select
                value={whoDecides(type, youDecide, agentDecides)}
                onChange={(e) => setWho(type, e.target.value as WhoDecides)}
                className="shrink-0 cursor-pointer rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
              >
                <option value="you">You decide</option>
                <option value="agent">Agent may decide</option>
                <option value="level">Questions level decides</option>
              </select>
            </label>
          ))}
        </div>
      </Card>

      {floor.length > 0 && (
        <p
          className="mt-2 mb-0 text-2xs text-description"
          data-testid="policy-floor"
        >
          {floor.length} floor rule{floor.length === 1 ? "" : "s"} in
          permissions.yaml block these calls at every level below IDGAF. At
          IDGAF they are recorded, not applied. Edit the file to change them.
        </p>
      )}
    </div>
  );
}
