import { ReactNode, useState, useSyncExternalStore } from "react";
import { Button } from "../../components/ui";
import {
  chatDebugKindLabel,
  clearChatDebug,
  getChatDebugEvents,
  subscribeChatDebug,
} from "../../util/chatDebugLog";

function formatTime(at: number): string {
  const date = new Date(at);
  const parts = [date.getHours(), date.getMinutes(), date.getSeconds()].map(
    (n) => String(n).padStart(2, "0"),
  );
  return parts.join(":");
}

/**
 * A small control that opens a diagnostic log. The event list is not in the
 * layout until the person opens it, and it is closed by default.
 */
export function ChatDebugLog({ leading }: { leading?: ReactNode }) {
  const events = useSyncExternalStore(
    subscribeChatDebug,
    getChatDebugEvents,
    getChatDebugEvents,
  );
  const [open, setOpen] = useState(false);
  const count = events.length;
  return (
    <>
      {open && (
        <div
          id="chat-debug-log"
          data-testid="chat-debug-log"
          aria-label="Diagnostic log"
          className="mx-2 mb-1 max-h-40 overflow-y-auto rounded border border-solid border-zinc-700 bg-vsc-background px-2 py-1 text-xs"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span>Diagnostic log</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => clearChatDebug()}
            >
              Clear
            </Button>
          </div>
          {count === 0 ? (
            <p className="m-0 text-description-muted">Nothing recorded yet.</p>
          ) : (
            <ol className="m-0 list-none p-0">
              {events.map((event) => (
                <li
                  key={event.id}
                  data-testid="chat-debug-event"
                  className="border-0 border-b border-solid border-zinc-800 py-0.5"
                >
                  <span className="text-description-muted">
                    {formatTime(event.at)} {chatDebugKindLabel(event.kind)}
                  </span>
                  <div className="break-words">{event.summary}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <div className="flex flex-row items-center justify-between pr-2 pb-1 pl-0.5">
        <div className="hidden xs:inline">{leading}</div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          data-testid="chat-debug-log-toggle"
          aria-expanded={open}
          aria-controls={open ? "chat-debug-log" : undefined}
          aria-label={
            count > 0 ? `Diagnostic log, ${count} events` : "Diagnostic log"
          }
          onClick={() => setOpen((value) => !value)}
        >
          Log{count > 0 ? ` ${count}` : ""}
        </Button>
      </div>
    </>
  );
}
