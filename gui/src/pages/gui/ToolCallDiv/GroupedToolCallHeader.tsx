import { FolderIcon } from "@heroicons/react/24/outline";
import { ToolCallState } from "core";
import { ToggleWithIcon } from "./ToggleWithIcon";
import { getGroupActionVerb } from "./utils";

interface GroupedToolCallHeaderProps {
  toolCallStates: ToolCallState[];
  activeCalls: ToolCallState[];
  open: boolean;
  onToggle: () => void;
}

export function GroupedToolCallHeader({
  toolCallStates,
  activeCalls,
  open,
  onToggle,
}: GroupedToolCallHeaderProps) {
  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-left text-description transition-colors duration-200 ease-in-out [font:inherit] hover:brightness-125"
        data-testid="performing-actions"
        onClick={onToggle}
      >
        {/* The button takes the click, so the icon needs no handler */}
        <ToggleWithIcon isToggleable icon={FolderIcon} open={open} />
        {getGroupActionVerb(toolCallStates)} {activeCalls.length}{" "}
        {activeCalls.length === 1 ? "action" : "actions"}
      </button>
    </div>
  );
}
