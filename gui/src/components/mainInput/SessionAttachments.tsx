import { sessionAttachments } from "core/util/contextReferences";
import { useContext, useMemo, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppSelector } from "../../redux/hooks";
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
  const ideMessenger = useContext(IdeMessengerContext);
  const [expanded, setExpanded] = useState(false);
  const list = useMemo(() => sessionAttachments(history), [history]);
  if (list.length === 0) return null;

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
