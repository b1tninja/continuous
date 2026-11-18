import { useAppSelector } from "../../../redux/hooks";
import { ToolTip } from "../../gui/Tooltip";
import { ModeSelect } from "../../ModeSelect";
import { PolicyControls, IdgafChip } from "../../PolicyControls";
import { RovingToolbar } from "../../PolicyControls/RovingToolbar";
import { RecentlyBlocked } from "../../RecentlyBlocked";
import { SafetyShield } from "../../SafetyShield/SafetyShield";
import HoverItem from "../InputToolbar/HoverItem";

/**
 * The controls that set how the agent behaves for the whole session: the mode
 * (Chat, Plan, Agent, Loop) and the permission policy. They live in the row
 * above the input, apart from the controls tied to the message being written
 * (context, model, send) below it. Edit mode has no mode or policy to set, so
 * the group is absent there, as it was in the bottom row. The whole group is
 * one toolbar and one Tab stop: arrow keys move between the chips.
 */
export function SessionControls() {
  const isInEdit = useAppSelector((state) => state.session.isInEdit);
  if (isInEdit) return null;

  return (
    <RovingToolbar
      label="Session controls"
      testId="session-controls"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 select-none xs:gap-1.5"
    >
      <ToolTip place="bottom" content="Select Mode">
        <HoverItem className="!p-0">
          <ModeSelect />
        </HoverItem>
      </ToolTip>
      <IdgafChip />
      <PolicyControls />
      <SafetyShield />
      <RecentlyBlocked />
    </RovingToolbar>
  );
}
