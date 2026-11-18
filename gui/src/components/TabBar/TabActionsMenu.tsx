import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import {
  EllipsisHorizontalIcon,
  Square2StackIcon,
} from "@heroicons/react/24/outline";
import { useId } from "react";
import { useForkCostLine } from "../../hooks/useForkCostLine";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { forkSessionThunk } from "../../redux/thunks/forkSession";

const ITEM_CLASS =
  "flex w-full cursor-pointer flex-col items-start gap-0.5 border-none bg-transparent px-2 py-1 text-left text-xs text-foreground data-[focus]:bg-list-active data-[focus]:text-list-active-foreground data-[disabled]:cursor-default data-[disabled]:opacity-50";

/** The menu's items, mounted only while it is open. */
function TabActionsItems({
  sessionId,
  isActive,
}: {
  sessionId?: string;
  isActive: boolean;
}) {
  const dispatch = useAppDispatch();
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const openHasHistory = useAppSelector((s) => s.session.history.length > 0);
  // The cost line needs the session's ledger, which only the open one has
  const line = useForkCostLine(undefined, isActive);
  const descriptionId = useId();
  const canFork = isActive ? openHasHistory && !isStreaming : !!sessionId;

  return (
    <MenuItems
      anchor="bottom start"
      data-testid="tab-actions-menu"
      className="z-[200000] flex w-max max-w-80 min-w-40 flex-col rounded border border-solid border-border bg-vsc-input-background py-1 shadow-md outline-none"
    >
      <MenuItem disabled={!canFork}>
        <button
          type="button"
          data-testid="fork-session-item"
          className={ITEM_CLASS}
          aria-label="Fork session"
          aria-describedby={line ? descriptionId : undefined}
          onClick={() =>
            void dispatch(
              forkSessionThunk(isActive ? {} : { sessionId: sessionId! }),
            )
          }
        >
          <span className="flex items-center gap-2">
            <Square2StackIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            Fork session
          </span>
          {line && (
            <span
              id={descriptionId}
              className="pl-6 text-[10px] whitespace-normal text-description-muted"
            >
              {line}
            </span>
          )}
        </button>
      </MenuItem>
    </MenuItems>
  );
}

/**
 * The "..." menu on a session tab: Fork session, which copies the tab's
 * session into a new one and opens it in a new tab. For the open session the
 * item says what the fork's first message re-reads and costs.
 */
export function TabActionsMenu({
  title,
  sessionId,
  isActive,
}: {
  title: string;
  sessionId?: string;
  isActive: boolean;
}) {
  return (
    <Menu>
      {({ open }) => (
        <>
          <MenuButton
            aria-label={`Actions for ${title}`}
            data-testid="tab-actions-button"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            className="ml-1 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0.5 text-inherit opacity-70 hover:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus"
          >
            <EllipsisHorizontalIcon width={12} height={12} aria-hidden="true" />
          </MenuButton>
          {open && (
            <TabActionsItems sessionId={sessionId} isActive={isActive} />
          )}
        </>
      )}
    </Menu>
  );
}
