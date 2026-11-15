import {
  ArchiveBoxIcon,
  ArrowDownOnSquareIcon,
  ArrowUturnLeftIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { BaseSessionMetadata } from "core";
import { getUriPathBasename } from "core/util/uri";
import React, { useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Input } from "..";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { archiveSessions, restoreSessions } from "../../redux/slices/uiSlice";
import { exitEdit } from "../../redux/thunks/edit";
import {
  getSession,
  loadSession,
  trashSession,
  updateSession,
} from "../../redux/thunks/session";
import { isShareSessionSupported } from "../../util";
import HeaderButtonWithToolTip from "../gui/HeaderButtonWithToolTip";
import { ToolTip } from "../gui/Tooltip";

const shareSessionSupported = isShareSessionSupported();

export function HistoryTableRow({
  sessionMetadata,
  index,
  archived = false,
  onDelete,
  match,
}: {
  sessionMetadata: BaseSessionMetadata;
  index: number;
  /** In the Archived group: Restore instead of Archive */
  archived?: boolean;
  /** Delete: the page moves it to the trash and offers Undo */
  onDelete?: (session: BaseSessionMetadata) => void;
  /** Text around a message that matched the search */
  match?: string;
}) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const ideMessenger = useContext(IdeMessengerContext);

  const [editing, setEditing] = useState(false);
  const [sessionTitleEditValue, setSessionTitleEditValue] = useState(
    sessionMetadata.title,
  );
  const currentSessionId = useAppSelector((state) => state.session.id);

  useEffect(() => {
    setSessionTitleEditValue(sessionMetadata.title);
  }, [sessionMetadata]);

  const shareSession = async (sessionId: string) => {
    // "session/share" is not supported in JetBrains yet
    if (shareSessionSupported) {
      await ideMessenger.request("session/share", {
        sessionId,
      });
    }
  };

  const handleKeyUp = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (sessionTitleEditValue !== sessionMetadata.title) {
        // imperfect solution of loading session just to update it
        // but fine for now, pretty low latency
        const currentSession = await getSession(
          ideMessenger,
          sessionMetadata.sessionId,
        );
        await dispatch(
          updateSession({
            ...currentSession,
            title: sessionTitleEditValue,
          }),
        );
      }
      setEditing(false);
    } else if (e.key === "Escape") {
      setSessionTitleEditValue(sessionMetadata.title);
      setEditing(false);
    }
  };

  const openSession = async () => {
    await dispatch(exitEdit({}));
    if (sessionMetadata.sessionId !== currentSessionId) {
      await dispatch(
        loadSession({
          sessionId: sessionMetadata.sessionId,
          saveCurrentSession: true,
        }),
      );
    }
    void navigate("/");
  };

  // The row and its buttons are reachable by keyboard: Tab to the row opens
  // it with Enter, Tab again reaches its actions, which show on hover and
  // while anything in the row has focus
  return (
    <tr
      data-testid={`history-row-${index}`}
      tabIndex={editing ? -1 : 0}
      aria-label={sessionMetadata.title}
      className="group relative mb-2 box-border flex w-full cursor-pointer overflow-hidden rounded-lg p-3 hover:bg-input focus-visible:bg-input focus-visible:outline focus-visible:outline-1 focus-visible:outline-border"
      onClick={openSession}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void openSession();
        } else if (e.key === "Delete" && !editing) {
          e.preventDefault();
          if (onDelete) onDelete(sessionMetadata);
          else void dispatch(trashSession({ id: sessionMetadata.sessionId }));
        }
      }}
    >
      <td className="flex-1 cursor-pointer space-y-1">
        {editing ? (
          <div>
            <Input
              type="text"
              className="w-full"
              ref={(titleInput) => {
                titleInput?.focus();
              }}
              value={sessionTitleEditValue}
              onChange={(e) => setSessionTitleEditValue(e.target.value)}
              onKeyUp={(e) => handleKeyUp(e)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => setEditing(false)}
            />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="line-clamp-1 text-sm font-semibold break-all">
              {sessionMetadata.title}
            </span>

            {sessionMetadata.messageCount !== undefined && (
              <ToolTip
                content={`${sessionMetadata.messageCount} message${
                  sessionMetadata.messageCount === 1 ? " is" : "s are"
                } present in this session`}
              >
                <span className="ml-auto inline-flex items-center rounded-full bg-vsc-background px-2 py-1 text-xs font-medium text-secondary-foreground">
                  {sessionMetadata.messageCount}
                </span>
              </ToolTip>
            )}
          </div>
        )}

        {match && (
          <div
            className="line-clamp-2 text-xs break-all text-description"
            data-testid={`history-row-match-${index}`}
          >
            {match}
          </div>
        )}

        <div className="flex text-description-muted">
          <span className="line-clamp-1 text-xs break-all">
            {getUriPathBasename(sessionMetadata.workspaceDirectory || "")}
          </span>
          {/* Uncomment to show the date */}
          {/* <span className="inline-block ml-auto">
                {date.toLocaleString("en-US", {
                  year: "2-digit",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                })}
              </span> */}
        </div>
      </td>

      {!editing && (
        <td
          className="absolute top-12 right-2 ml-auto flex -translate-y-1/2 transform items-center gap-x-1 rounded-full bg-input px-2 py-1 opacity-0 shadow-md group-focus-within:opacity-100 group-hover:opacity-100 focus-within:opacity-100"
          data-testid={`history-row-actions-${index}`}
        >
          {
            <>
              <HeaderButtonWithToolTip
                text="Edit"
                testId={`history-row-edit-${index}`}
                onClick={async (e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
              >
                <PencilSquareIcon width="1em" height="1em" />
              </HeaderButtonWithToolTip>
              {shareSessionSupported && (
                <HeaderButtonWithToolTip
                  text="Save Chat as Markdown"
                  onClick={async (e) => {
                    e.stopPropagation();
                    await shareSession(sessionMetadata.sessionId);
                  }}
                >
                  <ArrowDownOnSquareIcon width="1em" height="1em" />
                </HeaderButtonWithToolTip>
              )}
              {archived ? (
                <HeaderButtonWithToolTip
                  text="Restore"
                  testId={`history-row-restore-${index}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    dispatch(
                      restoreSessions({
                        sessionIds: [sessionMetadata.sessionId],
                      }),
                    );
                  }}
                >
                  <ArrowUturnLeftIcon width="1em" height="1em" />
                </HeaderButtonWithToolTip>
              ) : (
                <HeaderButtonWithToolTip
                  text="Archive"
                  testId={`history-row-archive-${index}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    dispatch(
                      archiveSessions({
                        sessionIds: [sessionMetadata.sessionId],
                      }),
                    );
                  }}
                >
                  <ArchiveBoxIcon width="1em" height="1em" />
                </HeaderButtonWithToolTip>
              )}
              <HeaderButtonWithToolTip
                text="Delete"
                testId={`history-row-delete-${index}`}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (onDelete) onDelete(sessionMetadata);
                  else
                    await dispatch(
                      trashSession({ id: sessionMetadata.sessionId }),
                    );
                }}
              >
                <TrashIcon width="1em" height="1em" />
              </HeaderButtonWithToolTip>
            </>
          }
        </td>
      )}
    </tr>
  );
}
