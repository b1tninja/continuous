import type { SubagentRunState } from "core";
import { useId, useState, useSyncExternalStore } from "react";
import {
  cancelInboxMessage,
  isSubagentRunLive,
  peekInbox,
  sendToSubagent,
  steerInboxMessage,
  subscribeSubagentRuns,
} from "../../util/subagents/registry";
import { announce } from "../a11y/announcer";

const TEXT_BUTTON =
  "flex min-h-5 flex-shrink-0 cursor-pointer items-center gap-1 rounded border border-solid border-border bg-transparent px-1.5 text-2xs text-foreground hover:bg-input disabled:cursor-default disabled:opacity-50";
const LINK_BUTTON =
  "flex-shrink-0 cursor-pointer border-none bg-transparent p-0 text-2xs text-link hover:underline";

/** Marks a message another subagent sent, not the person. */
function FromAgent({ name }: { name: string }) {
  return (
    <span
      className="mr-1 text-2xs text-description"
      data-testid="agent-message-from"
    >
      from {name}:
    </span>
  );
}

/**
 * Messages to a running subagent, under its record: an input while the run
 * is live, the messages queued for it (each can be cancelled, or sent now,
 * until it is delivered), and the ones already delivered or left unread when
 * it ended. Send waits until the run would finish; Send now goes in after its
 * current tool calls. A message another subagent sent it (send_message) is
 * shown with that agent's name, so the person sees what the agents told each
 * other; the person can cancel one before it is delivered.
 */
export function SubagentMessages({
  runId,
  name,
  run,
}: {
  runId: string;
  name: string;
  run?: SubagentRunState;
}) {
  const live = useSyncExternalStore(subscribeSubagentRuns, () =>
    isSubagentRunLive(runId),
  );
  const queued = useSyncExternalStore(subscribeSubagentRuns, () =>
    peekInbox(runId),
  );
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const hintId = useId();
  const sent = run?.messages ?? [];
  if (!live && sent.length === 0 && queued.length === 0) return null;

  const send = (steer: boolean) => {
    const outcome = sendToSubagent(runId, draft, { steer });
    if (outcome === "queued") {
      setDraft("");
      announce(
        steer
          ? `Sent to ${name}. It reads it after its current tool calls.`
          : `Queued for ${name}. It reads it before it finishes.`,
      );
    } else if (outcome === "not-live") {
      announce(`${name} has ended. The message was not sent.`);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="agent-messages">
      {sent.length > 0 && (
        <ul
          aria-label={`Messages to ${name}`}
          className="m-0 flex list-none flex-col gap-0.5 p-0"
          data-testid="agent-messages-sent"
        >
          {sent.map((m, i) => (
            <li
              key={`${m.at}-${i}`}
              className="flex min-w-0 items-baseline gap-1.5"
            >
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                {m.from && <FromAgent name={m.from} />}
                {m.text}
              </span>
              <span
                className={`flex-shrink-0 text-2xs ${
                  m.delivered ? "text-description-muted" : "text-warning"
                }`}
              >
                {m.delivered ? "delivered" : "not delivered"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {queued.length > 0 && (
        <ul
          aria-label={`Queued for ${name}`}
          className="m-0 flex list-none flex-col gap-0.5 p-0"
          data-testid="agent-messages-queued"
        >
          {queued.map((m) => (
            <li
              key={m.id}
              className="flex min-w-0 items-baseline gap-1.5"
              data-testid="agent-message-queued"
            >
              <span className="line-clamp-2 min-w-0 flex-1 break-words">
                {m.from?.kind === "agent" && <FromAgent name={m.from.name} />}
                {m.text}
              </span>
              <span className="flex-shrink-0 text-2xs text-description-muted">
                {m.steer ? "after its tool calls" : "before it finishes"}
              </span>
              {!m.steer && (
                <button
                  type="button"
                  className={LINK_BUTTON}
                  aria-label={`Send now: ${m.text}`}
                  onClick={() => {
                    if (steerInboxMessage(runId, m.id)) {
                      announce("It goes in after its current tool calls.");
                    }
                  }}
                >
                  Send now
                </button>
              )}
              <button
                type="button"
                className={LINK_BUTTON}
                aria-label={`Cancel: ${m.text}`}
                onClick={() =>
                  announce(
                    cancelInboxMessage(runId, m.id)
                      ? "Cancelled. It was not sent."
                      : "It was already delivered.",
                  )
                }
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
      {live && (
        <form
          className="flex min-w-0 flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            send(false);
          }}
        >
          <label htmlFor={inputId} className="text-2xs text-description">
            Message {name}
          </label>
          <textarea
            id={inputId}
            rows={2}
            value={draft}
            aria-describedby={hintId}
            className="min-w-0 resize-y rounded border border-solid border-border bg-input p-1 text-xs text-foreground"
            data-testid="agent-message-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter that ends an IME composition is not a send
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send(e.ctrlKey || e.metaKey);
              } else if (e.key === "Escape" && draft) {
                // Escape leaves the record; with a draft it keeps the draft
                e.stopPropagation();
              }
            }}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <button
              type="submit"
              className={TEXT_BUTTON}
              disabled={!draft.trim()}
              data-testid="agent-message-send"
            >
              Send
            </button>
            <button
              type="button"
              className={TEXT_BUTTON}
              disabled={!draft.trim()}
              onClick={() => send(true)}
              data-testid="agent-message-send-now"
            >
              Send now
            </button>
            <span id={hintId} className="text-2xs text-description-muted">
              Send: it reads it before it finishes (Enter). Send now: after its
              current tool calls (Ctrl+Enter).
            </span>
          </div>
        </form>
      )}
    </div>
  );
}
