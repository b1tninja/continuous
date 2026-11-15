import { BaseSessionMetadata } from "core";
import MiniSearch from "minisearch";
import React, {
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Shortcut from "../gui/Shortcut";

import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { XMarkIcon } from "@heroicons/react/24/solid";
import { useNavigate } from "react-router-dom";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  newSession,
  setAllSessionMetadata,
} from "../../redux/slices/sessionSlice";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { refreshSessionMetadata } from "../../redux/thunks/session";
import { getFontSize, getPlatform } from "../../util";
import { clearDraftsExcept } from "../../util/drafts";
import { ROUTES } from "../../util/navigation";
import {
  currentWorkspaceDirs,
  groupHistoryByWorkspace,
} from "../../util/sessionWorkspace";
import ConfirmationDialog from "../dialogs/ConfirmationDialog";
import { Button } from "../ui";
import { HistoryTableRow } from "./HistoryTableRow";
import { groupSessionsByDate, parseDate, splitArchivedSessions } from "./util";

export function History() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const ideMessenger = useContext(IdeMessengerContext);

  const [searchTerm, setSearchTerm] = useState("");

  const minisearch = useRef<MiniSearch>(
    new MiniSearch({
      fields: ["title"],
      storeFields: ["title", "sessionId", "id"],
    }),
  ).current;

  const allSessionMetadata = useAppSelector(
    (state) => state.session.allSessionMetadata,
  );
  const isSessionMetadataLoading = useAppSelector(
    (state) => state.session.isSessionMetadataLoading,
  );

  useEffect(() => {
    try {
      minisearch.removeAll();
      minisearch.addAll(
        allSessionMetadata.map((session) => ({
          title: session.title,
          sessionId: session.sessionId,
          id: session.sessionId,
        })),
      );
    } catch (e) {
      console.log("error adding sessions to minisearch", e);
    }
  }, [allSessionMetadata]);

  const platform = useMemo(() => getPlatform(), []);

  const filteredAndSortedSessions: BaseSessionMetadata[] = useMemo(() => {
    // 1. Exact phrase matching
    const exactResults = minisearch.search(searchTerm, {
      fuzzy: false,
    });

    // 2. Fuzzy matching with higher tolerance
    const fuzzyResults = minisearch.search(searchTerm, {
      fuzzy: 0.3,
    });

    // 3. Prefix matching for partial words
    const prefixResults = minisearch.search(searchTerm, {
      prefix: true,
      fuzzy: 0.2,
    });

    // Combine results, with exact matches having higher priority
    const allResults = [
      ...exactResults.map((r) => ({ ...r, priority: 3 })),
      ...fuzzyResults.map((r) => ({ ...r, priority: 2 })),
      ...prefixResults.map((r) => ({ ...r, priority: 1 })),
    ];

    // Remove duplicates while preserving highest priority
    const uniqueResultsMap = new Map<string, any>();
    allResults.forEach((result) => {
      const existing = uniqueResultsMap.get(result.id);
      if (!existing || existing.priority < result.priority) {
        uniqueResultsMap.set(result.id, result);
      }
    });
    const uniqueResults = Array.from(uniqueResultsMap.values());

    const sessionIds = uniqueResults
      .sort((a, b) => b.priority - a.priority || b.score - a.score)
      .map((result) => result.id);

    return allSessionMetadata
      .filter((session) => {
        return searchTerm === "" || sessionIds.includes(session.sessionId);
      })
      .sort(
        (a, b) =>
          parseDate(b.dateCreated).getTime() -
          parseDate(a.dateCreated).getTime(),
      );
  }, [allSessionMetadata, searchTerm, minisearch]);

  // Archived sessions leave the date groups for a group of their own,
  // collapsed until opened; a search looks through both
  const archivedIds = useAppSelector((state) => state.ui.archivedSessions);
  const [showArchived, setShowArchived] = useState(false);
  const { active, archived } = useMemo(
    () => splitArchivedSessions(filteredAndSortedSessions, archivedIds),
    [filteredAndSortedSessions, archivedIds],
  );

  const sessionGroups = useMemo(() => {
    return groupSessionsByDate(active);
  }, [active]);

  // The default view: one group per workspace folder, this window's first
  // with its newest session on top (util/sessionWorkspace.ts). By date is
  // the list as it was before.
  const [groupBy, setGroupBy] = useState<"workspace" | "date">("workspace");
  const workspaceGroups = useMemo(
    () => groupHistoryByWorkspace(active, currentWorkspaceDirs()),
    [active],
  );
  // This workspace's group starts open, the others closed (the first one
  // open when this window has no session of its own); a search opens all
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const hasCurrentGroup = workspaceGroups[0]?.isCurrent ?? false;
  const isGroupOpen = (key: string, isCurrent: boolean, index: number) =>
    searchTerm !== "" ||
    (openGroups[key] ?? (isCurrent || (!hasCurrentGroup && index === 0)));

  const showClearSessionsDialog = () => {
    dispatch(
      setDialogMessage(
        <ConfirmationDialog
          title={`Clear sessions`}
          text={`Are you sure you want to permanently delete all chat sessions, including the current chat session?`}
          onConfirm={async () => {
            // optimistic update
            dispatch(setAllSessionMetadata([]));

            // actual update + refresh
            await ideMessenger.request("history/clear", undefined);
            // The sessions' unsent drafts go with them
            clearDraftsExcept([]);
            void dispatch(refreshSessionMetadata({}));

            // start a new session
            dispatch(newSession());
            navigate(ROUTES.HOME);
          }}
        />,
      ),
    );
    dispatch(setShowDialog(true));
  };

  return (
    <div
      style={{ fontSize: getFontSize() }}
      className="flex flex-1 flex-col overflow-auto overflow-x-hidden px-1"
    >
      <div className="relative my-2 mt-4 flex justify-center space-x-2">
        <input
          className="flex-1 rounded-md border border-none bg-vsc-input-background py-1 pr-8 pl-2 text-sm text-vsc-foreground outline-hidden focus:outline-hidden"
          ref={searchInputRef}
          placeholder="Search past sessions"
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        {searchTerm && (
          <XMarkIcon
            className="absolute top-1/2 right-3 h-5 w-5 -translate-y-1/2 transform cursor-pointer rounded-full p-0.5 text-vsc-foreground transition-colors duration-50 hover:bg-vsc-background"
            onClick={() => {
              setSearchTerm("");
              if (searchInputRef.current) {
                searchInputRef.current.focus();
              }
            }}
          />
        )}
      </div>

      <div className="thin-scrollbar flex w-full flex-1 flex-col overflow-y-auto">
        {active.length === 0 && archived.length === 0 && (
          <div className="m-3 text-center">
            {isSessionMetadataLoading ? (
              "Loading Sessions..."
            ) : (
              <>
                No past sessions found. To start a new session, either click the
                "+" button or use the keyboard shortcut:{" "}
                <Shortcut>meta L</Shortcut>
              </>
            )}
          </div>
        )}

        {active.length > 0 && (
          <div
            className="mt-1 ml-2 flex items-center gap-2 text-xs text-description"
            role="group"
            aria-label="Group sessions"
          >
            <span>Group by</span>
            {(["workspace", "date"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={groupBy === mode}
                data-testid={`history-group-by-${mode}`}
                onClick={() => setGroupBy(mode)}
                className={`cursor-pointer rounded border-none px-1.5 py-0.5 text-xs ${
                  groupBy === mode
                    ? "bg-input text-foreground"
                    : "bg-transparent text-description"
                }`}
              >
                {mode === "workspace" ? "Folder" : "Date"}
              </button>
            ))}
          </div>
        )}

        <table className="flex w-full flex-1 flex-col">
          <tbody className="">
            {groupBy === "date" &&
              sessionGroups.map((group, groupIndex) => (
                <Fragment key={group.label}>
                  <tr
                    className={`user-select-none sticky mb-3 ml-2 flex h-6 justify-start text-left text-base font-bold opacity-75 ${
                      groupIndex === 0 ? "mt-2" : "mt-8"
                    }`}
                  >
                    <td colSpan={3}>{group.label}</td>
                  </tr>
                  {group.sessions.map((session, sessionIndex) => (
                    <HistoryTableRow
                      key={session.sessionId}
                      sessionMetadata={session}
                      index={sessionIndex}
                    />
                  ))}
                </Fragment>
              ))}
            {groupBy === "workspace" &&
              (() => {
                let rowIndex = 0;
                return workspaceGroups.map((group, groupIndex) => {
                  const open = isGroupOpen(
                    group.key,
                    group.isCurrent,
                    groupIndex,
                  );
                  const first = rowIndex;
                  rowIndex += group.sessions.length;
                  return (
                    <Fragment key={`workspace-${group.key}`}>
                      <tr
                        className={`user-select-none sticky mb-3 ml-2 flex h-6 justify-start text-left text-base font-bold ${
                          groupIndex === 0 ? "mt-2" : "mt-6"
                        }`}
                        data-testid="history-workspace-group"
                      >
                        <td colSpan={3} className="min-w-0 flex-1">
                          <button
                            type="button"
                            aria-expanded={open}
                            title={
                              group.path || "Sessions saved without a folder"
                            }
                            data-testid={`history-workspace-toggle-${groupIndex}`}
                            onClick={() =>
                              setOpenGroups((groups) => ({
                                ...groups,
                                [group.key]: !open,
                              }))
                            }
                            className="flex max-w-full cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-left text-base font-bold text-foreground opacity-75"
                          >
                            {open ? (
                              <ChevronDownIcon className="h-3 w-3 flex-shrink-0" />
                            ) : (
                              <ChevronRightIcon className="h-3 w-3 flex-shrink-0" />
                            )}
                            <span className="truncate">{group.label}</span>
                            {group.isCurrent && (
                              <span className="flex-shrink-0 text-xs font-normal text-description">
                                this workspace
                              </span>
                            )}
                            <span className="flex-shrink-0 text-xs font-normal text-description">
                              ({group.sessions.length})
                            </span>
                          </button>
                        </td>
                      </tr>
                      {open &&
                        group.sessions.map((session, i) => (
                          <HistoryTableRow
                            key={session.sessionId}
                            sessionMetadata={session}
                            index={first + i}
                          />
                        ))}
                    </Fragment>
                  );
                });
              })()}
          </tbody>
        </table>
        {archived.length > 0 && (
          <div className="mt-6 flex flex-col" data-testid="history-archived">
            <button
              type="button"
              className="mb-2 ml-2 flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-left text-base font-bold text-foreground opacity-75"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((open) => !open)}
              data-testid="history-archived-toggle"
            >
              Archived ({archived.length})
            </button>
            {showArchived && (
              <table className="flex w-full flex-col">
                <tbody>
                  {archived.map((session, i) => (
                    <HistoryTableRow
                      key={session.sessionId}
                      sessionMetadata={session}
                      index={active.length + i}
                      archived
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col items-end justify-center border-0 border-t border-solid border-border px-2 py-3 text-xs">
        <Button variant="secondary" size="sm" onClick={showClearSessionsDialog}>
          Clear chats
        </Button>
        <span
          className="text-2xs text-description"
          data-testid="history-sessions-note"
        >
          Chat history is saved to{" "}
          <span className="italic">
            {platform === "windows"
              ? "%USERPROFILE%/.continuous"
              : "~/.continuous/sessions"}
          </span>
        </span>
      </div>
    </div>
  );
}
