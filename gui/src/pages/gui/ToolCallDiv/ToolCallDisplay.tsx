import { Tool, ToolCallState } from "core";
import { useContext, useMemo } from "react";
import { openContextItem } from "../../../components/mainInput/belowMainInput/ContextItemsPeek";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ToolCallStatusMessage } from "./ToolCallStatusMessage";
import { toolCallStateToContextItems } from "./utils";
import { ToolTruncateHistoryIcon } from "./ToolTruncateHistoryIcon";

interface ToolCallDisplayProps {
  children: React.ReactNode;
  icon: React.ReactNode;
  tool: Tool | undefined;
  toolCallState: ToolCallState;
  historyIndex: number;
}

export function ToolCallDisplay({
  tool,
  toolCallState,
  children,
  icon,
  historyIndex,
}: ToolCallDisplayProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const shownContextItems = useMemo(() => {
    const contextItems = toolCallStateToContextItems(toolCallState);
    return contextItems.filter((item) => !item.hidden);
  }, [toolCallState]);

  const isClickable = shownContextItems.length > 0;

  function handleClick() {
    if (shownContextItems.length > 0) {
      openContextItem(shownContextItems[0], ideMessenger);
    }
  }
  const rowClass =
    "flex min-w-0 flex-row items-center gap-2 transition-colors duration-200 ease-in-out";
  const row = (
    <>
      <div className="mt-[1px] h-4 w-4 shrink-0 font-semibold">{icon}</div>
      {tool?.faviconUrl && (
        <img src={tool.faviconUrl} className="h-4 w-4 rounded-xs" />
      )}
      <ToolCallStatusMessage tool={tool} toolCallState={toolCallState} />
    </>
  );

  return (
    <div className="flex flex-col justify-center px-4">
      <div className="mb-2 flex flex-col">
        <div className="flex flex-row items-start justify-between gap-1.5">
          {isClickable ? (
            // A row that opens its result is a button; one with nothing to
            // open stays plain text
            <button
              type="button"
              className={`${rowClass} cursor-pointer border-none bg-transparent p-0 text-left text-inherit [font:inherit] hover:brightness-125`}
              onClick={handleClick}
            >
              {row}
            </button>
          ) : (
            <div className={rowClass}>{row}</div>
          )}
          {!!toolCallState.output?.length && (
            <ToolTruncateHistoryIcon historyIndex={historyIndex} />
          )}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
