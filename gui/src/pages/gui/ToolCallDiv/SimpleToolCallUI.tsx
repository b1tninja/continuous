import { Tool, ToolCallState } from "core";
import { ComponentType, useContext, useMemo, useState } from "react";
import {
  ContextItemsPeekItem,
  openContextItem,
} from "../../../components/mainInput/belowMainInput/ContextItemsPeek";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ToggleWithIcon } from "./ToggleWithIcon";
import { ToolCallStatusMessage } from "./ToolCallStatusMessage";
import { ToolTruncateHistoryIcon } from "./ToolTruncateHistoryIcon";
import { toolCallStateToContextItems } from "./utils";

interface SimpleToolCallUIProps {
  toolCallState: ToolCallState;
  tool: Tool | undefined;
  icon?: ComponentType<React.SVGProps<SVGSVGElement>>;
  historyIndex: number;
}

export function SimpleToolCallUI({
  icon: Icon,
  toolCallState,
  tool,
  historyIndex,
}: SimpleToolCallUIProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const shownContextItems = useMemo(() => {
    const contextItems = toolCallStateToContextItems(toolCallState);
    return contextItems.filter((item) => !item.hidden);
  }, [toolCallState]);

  const [open, setOpen] = useState(false);

  const isToggleable = shownContextItems.length > 1;
  const isSingleItem = shownContextItems.length === 1;
  const shouldShowContent = isToggleable ? open : false;
  const isClickable = isToggleable || isSingleItem;

  function handleClick() {
    if (isToggleable) {
      setOpen((prev) => !prev);
    } else if (isSingleItem) {
      openContextItem(shownContextItems[0], ideMessenger);
    }
  }

  const rowClass =
    "flex min-w-0 flex-row items-center justify-between gap-1.5 text-xs text-description transition-colors duration-200 ease-in-out";
  const row = (
    <>
      <ToggleWithIcon
        icon={Icon}
        isToggleable={isToggleable}
        open={shouldShowContent}
        isClickable={isSingleItem}
      />
      <ToolCallStatusMessage tool={tool} toolCallState={toolCallState} />
    </>
  );

  return (
    <div className="mt-1 flex flex-col px-4">
      <div className="flex min-w-0 flex-row items-center justify-between gap-2">
        {isClickable ? (
          // A row that opens its results is a button; one with nothing to
          // open stays plain text
          <button
            type="button"
            aria-expanded={isToggleable ? open : undefined}
            className={`${rowClass} cursor-pointer border-none bg-transparent p-0 text-left [font-family:inherit] hover:brightness-125`}
            onClick={handleClick}
            data-testid="context-items-peek"
          >
            {row}
          </button>
        ) : (
          <div className={rowClass} data-testid="context-items-peek">
            {row}
          </div>
        )}

        {!!toolCallState.output?.length && (
          <ToolTruncateHistoryIcon historyIndex={historyIndex} />
        )}
      </div>

      {isToggleable && (
        <div
          className={`mt-2 overflow-y-auto transition-all duration-300 ease-in-out ${
            shouldShowContent ? "max-h-[50vh] opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          {shownContextItems.length > 0 ? (
            shownContextItems.map((contextItem, idx) => (
              <ContextItemsPeekItem key={idx} contextItem={contextItem} />
            ))
          ) : (
            <div className="pl-5 text-xs text-description italic">
              No tool call output
            </div>
          )}
        </div>
      )}
    </div>
  );
}
