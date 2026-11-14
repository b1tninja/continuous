import {
  removalMarksForSource,
  sessionAttachments,
} from "core/util/contextReferences";
import { useContext, useMemo, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { applyContextRemovals } from "../../redux/slices/sessionSlice";
import { saveCurrentSession } from "../../redux/thunks/session";
import { formatTokens } from "../../util/cacheNotices";

/** Rows shown before "Show all". */
export const ATTACHMENTS_VISIBLE = 5;

/** Characters per token, as the context breakdown estimates. */
const CHARS_PER_TOKEN = 4;

/**
 * The session's attachments: every file and selection attached so far, once
 * each, with how often it was attached and sent in full
 * (plans/context-references.md section 3.4).
 */
export function SessionAttachments() {
  const history = useAppSelector((s) => s.session.history);
  const isStreaming = useAppSelector((s) => s.session.isStreaming);
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const [expanded, setExpanded] = useState(false);
  const list = useMemo(() => sessionAttachments(history), [history]);
  if (list.length === 0) return null;

  // Every copy of the source leaves what is sent, as Choose what to keep
  // does, so the context meter's Undo puts it back
  const remove = (source: string, chars: number, copies: number) => {
    const marks = removalMarksForSource(history, source);
    if (Object.keys(marks).length === 0) return;
    dispatch(
      applyContextRemovals({
        marks,
        removedTokens: Math.ceil((chars * copies) / CHARS_PER_TOKEN),
      }),
    );
    void dispatch(
      saveCurrentSession({ openNewSession: false, generateTitle: false }),
    );
  };

  const shown = expanded ? list : list.slice(0, ATTACHMENTS_VISIBLE);
  return (
    <div className="flex flex-col gap-0.5" data-testid="session-attachments">
      <span className="font-semibold">
        Attached in this session ({list.length})
      </span>
      {shown.map((a) => {
        const repeats = a.timesAttached - a.timesSentInFull;
        const details = [
          `~${formatTokens(Math.ceil(a.chars / CHARS_PER_TOKEN))} tokens`,
          a.timesAttached > 1 ? `attached ${a.timesAttached} times` : undefined,
          repeats > 0
            ? `${repeats} sent as a note, not again in full`
            : undefined,
          a.versions > 1 ? `${a.versions} versions` : undefined,
        ].filter(Boolean);
        const uri = a.uri?.type === "file" ? a.uri.value : undefined;
        const removable =
          Object.keys(removalMarksForSource(history, a.source)).length > 0;
        return (
          <div
            key={a.source}
            className="flex min-w-0 items-baseline gap-1"
            data-testid="session-attachment"
          >
            {uri ? (
              <button
                type="button"
                className="min-w-0 cursor-pointer truncate border-none bg-transparent p-0 text-left text-xs text-link hover:underline"
                title={a.description}
                onClick={() => void ideMessenger.ide.openFile(uri)}
              >
                {a.name}
              </button>
            ) : (
              <span className="min-w-0 truncate" title={a.description}>
                {a.name}
              </span>
            )}
            <span className="shrink-0 text-description-muted">
              {details.join(", ")}
            </span>
            {removable ? (
              <button
                type="button"
                data-testid="session-attachment-remove"
                className="ml-auto shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs text-link hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isStreaming}
                title="Stop sending it: every copy in this session (Undo in the context panel)"
                onClick={() => remove(a.source, a.chars, a.timesSentInFull)}
              >
                Remove
              </button>
            ) : (
              <span
                className="ml-auto shrink-0 text-description-muted"
                data-testid="session-attachment-removed"
              >
                removed
              </span>
            )}
          </div>
        );
      })}
      {list.length > ATTACHMENTS_VISIBLE && (
        <button
          type="button"
          data-testid="session-attachments-toggle"
          className="cursor-pointer self-start border-none bg-transparent p-0 text-xs text-link hover:underline"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
    </div>
  );
}
