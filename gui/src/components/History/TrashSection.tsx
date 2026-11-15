import type { TrashedSession } from "core/util/sessionTrash";
import { useState } from "react";

/** "Nov 14", or "Nov 14, 2025" in another year. */
function shortDate(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The trash at the bottom of the History page (NI10): sessions deleted in
 * the last 7 days, each with Restore and Delete permanently. Collapsed until
 * opened; every control is a button, so it works from the keyboard.
 */
export function TrashSection({
  entries,
  onRestore,
  onDeletePermanently,
  onEmpty,
}: {
  entries: TrashedSession[];
  onRestore: (entry: TrashedSession) => void;
  onDeletePermanently: (entry: TrashedSession) => void;
  onEmpty: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <div className="mt-6 flex flex-col" data-testid="history-trash">
      <div className="mb-2 ml-2 flex items-center gap-2">
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-left text-base font-bold text-foreground opacity-75"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-testid="history-trash-toggle"
        >
          Trash ({entries.length})
        </button>
        <span className="text-xs text-description">
          kept 7 days after deletion
        </span>
      </div>
      {open && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {entries.map((entry, i) => (
            <li
              key={entry.sessionId}
              className="flex items-center gap-2 rounded-lg px-3 py-2"
              data-testid={`history-trash-row-${i}`}
            >
              <div className="min-w-0 flex-1">
                <div className="line-clamp-1 text-sm break-all">
                  {entry.metadata.title || "Untitled session"}
                </div>
                <div className="text-xs text-description-muted">
                  Deleted {shortDate(entry.deletedAt)}, removed after{" "}
                  {shortDate(entry.purgeAfter)}
                </div>
              </div>
              <button
                type="button"
                className="cursor-pointer rounded border-none bg-input px-2 py-0.5 text-xs text-foreground"
                onClick={() => onRestore(entry)}
                data-testid={`history-trash-restore-${i}`}
              >
                Restore
              </button>
              <button
                type="button"
                className="cursor-pointer rounded border-none bg-transparent px-2 py-0.5 text-xs text-error"
                onClick={() => onDeletePermanently(entry)}
                data-testid={`history-trash-delete-${i}`}
              >
                Delete permanently
              </button>
            </li>
          ))}
          <li className="flex justify-end px-3">
            <button
              type="button"
              className="cursor-pointer border-none bg-transparent p-0 text-xs text-description underline"
              onClick={onEmpty}
              data-testid="history-trash-empty"
            >
              Empty trash
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
