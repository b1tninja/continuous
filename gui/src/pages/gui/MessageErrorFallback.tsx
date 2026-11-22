import { ChatHistoryItem } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { useState } from "react";

const ROLE_WORDS: Record<string, string> = {
  user: "your message",
  assistant: "a reply from the model",
  thinking: "the model's thinking",
  tool: "a tool result",
  system: "a system message",
};

/** "Message 3 (a reply from the model) could not be drawn." */
export function messageErrorLine(role: string, position: number): string {
  const what = ROLE_WORDS[role];
  return `Message ${position}${what ? ` (${what})` : ""} could not be drawn.`;
}

/** The text of a message as it is stored, with its tool calls when it has no text. */
export function plainTextOfItem(item: ChatHistoryItem): string {
  let text = "";
  try {
    text = renderChatMessage(item.message);
  } catch {
    // Content of an unexpected shape: fall through to the JSON below
  }
  if (typeof text === "string" && text.trim()) return text;
  const message = item.message as { content?: unknown; toolCalls?: unknown };
  const rest = message.toolCalls ?? message.content;
  if (rest === undefined || rest === "") return "";
  try {
    return typeof rest === "string" ? rest : JSON.stringify(rest, null, 2);
  } catch {
    return "";
  }
}

const ACTION_CLASS =
  "min-h-6 cursor-pointer border-none bg-transparent px-0 text-xs text-link underline hover:brightness-125";

/**
 * Shown in place of one message whose render threw. The other messages still
 * render, so nothing here leaves or resets the conversation: the message can
 * be read as plain text, and the error copied for a report.
 */
export function MessageErrorFallback(props: {
  error: unknown;
  item: ChatHistoryItem;
  /** Place of the message among the shown rows, counted from 1. */
  position: number;
}) {
  const [showText, setShowText] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = showText ? plainTextOfItem(props.item) : "";

  const copyDetails = () => {
    const e = props.error as { message?: unknown; stack?: unknown } | null;
    const message = typeof e?.message === "string" ? e.message : String(e);
    const stack = typeof e?.stack === "string" ? e.stack : "";
    // A stack usually starts with the message; do not paste it twice
    const details = stack.includes(message)
      ? stack
      : [message, stack].filter(Boolean).join("\n");
    void navigator.clipboard
      ?.writeText(details)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <div
      role="alert"
      data-testid="message-error-fallback"
      className="flex min-w-0 flex-col gap-1 px-2 py-1 text-xs"
    >
      <p className="m-0 break-words text-description">
        {messageErrorLine(props.item.message.role, props.position)} The rest of
        the conversation is not affected.
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-0">
        <button
          type="button"
          className={ACTION_CLASS}
          aria-expanded={showText}
          onClick={() => setShowText((shown) => !shown)}
        >
          {showText ? "Hide plain text" : "Show as plain text"}
        </button>
        <button type="button" className={ACTION_CLASS} onClick={copyDetails}>
          {copied ? "Details copied" : "Copy details"}
        </button>
      </div>
      {showText && (
        <pre
          data-testid="message-error-plain-text"
          className="m-0 max-w-full font-sans break-words whitespace-pre-wrap text-foreground select-text"
        >
          {text || "This message has no text."}
        </pre>
      )}
    </div>
  );
}
