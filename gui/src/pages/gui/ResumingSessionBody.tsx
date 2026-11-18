import { PlusIcon } from "@heroicons/react/24/outline";
import { getUriPathBasename } from "core/util/uri";
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import Spinner from "../../components/gui/Spinner";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { newSession } from "../../redux/slices/sessionSlice";
import {
  loadSession,
  refreshSessionMetadata,
} from "../../redux/thunks/session";
import { getResumingTitle, selectRecentSessions } from "./resumingSession";

/**
 * Shown instead of the empty chat while a saved session is still loading, so a
 * large session doesn't flash the conversation starters first. The user can
 * wait, start a new session, or open another one; either choice drops the
 * pending load.
 */
export function ResumingSessionBody({
  loadingSessionId,
}: {
  loadingSessionId: string;
}) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const currentSessionId = useAppSelector((state) => state.session.id);
  const currentTitle = useAppSelector((state) => state.session.title);
  const allSessionMetadata = useAppSelector(
    (state) => state.session.allSessionMetadata,
  );
  const isSessionMetadataLoading = useAppSelector(
    (state) => state.session.isSessionMetadataLoading,
  );

  // The list is normally fetched once the config has loaded, which is the
  // same wait we are covering for here, so ask for it now.
  useEffect(() => {
    if (allSessionMetadata.length === 0) {
      void dispatch(refreshSessionMetadata({}));
    }
  }, []);

  const title = getResumingTitle(
    loadingSessionId,
    currentSessionId,
    currentTitle,
    allSessionMetadata,
  );
  const recentSessions = useMemo(
    () => selectRecentSessions(allSessionMetadata, loadingSessionId),
    [allSessionMetadata, loadingSessionId],
  );

  return (
    <div
      className="mx-2 mt-2 flex flex-col gap-3"
      data-testid="resuming-session"
    >
      <div className="flex items-center gap-2 px-1 text-xs text-description">
        <Spinner />
        <span className="line-clamp-1 break-all">
          {title ? `Loading "${title}"…` : "Loading previous session…"}
        </span>
      </div>

      <button
        type="button"
        className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-solid border-border bg-transparent px-2 py-1 text-xs text-foreground hover:bg-input"
        onClick={() => dispatch(newSession())}
      >
        <PlusIcon className="h-3 w-3" />
        Start a new session instead
      </button>

      {(recentSessions.length > 0 || isSessionMetadataLoading) && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-2xs text-description-muted uppercase">
              Recent sessions
            </span>
            <span
              className="cursor-pointer text-2xs text-description-muted hover:underline"
              onClick={() => navigate("/history")}
            >
              View all
            </span>
          </div>
          {recentSessions.length === 0 ? (
            <span className="px-1 text-xs text-description-muted">
              Loading sessions…
            </span>
          ) : (
            recentSessions.map((session) => (
              <div
                key={session.sessionId}
                className="cursor-pointer rounded-md px-2 py-1.5 hover:bg-input"
                onClick={() =>
                  dispatch(
                    loadSession({
                      sessionId: session.sessionId,
                      saveCurrentSession: false,
                    }),
                  )
                }
              >
                <div className="line-clamp-1 text-xs font-semibold break-all">
                  {session.title}
                </div>
                {session.workspaceDirectory && (
                  <div className="line-clamp-1 text-2xs break-all text-description-muted">
                    {getUriPathBasename(session.workspaceDirectory)}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
