import type { ReactNode } from "react";

/** The name a screen reader gives a message: who said it. */
export function messageAuthorLabel(role: string): string | undefined {
  if (role === "user") return "You";
  if (role === "assistant") return "Assistant";
  return undefined;
}

interface TranscriptMessageProps {
  role: string;
  minHeight: number | string;
  children: ReactNode;
}

/**
 * One entry of the conversation. A person's message and the assistant's reply
 * are articles named by author, so a screen reader moving by landmark or by
 * article can tell who spoke without reading the text. Tool calls render
 * inside the assistant's article and keep their own names. It is deliberately
 * not role="log" and carries no aria-live: the announcer is the only live path.
 */
export function TranscriptMessage({
  role,
  minHeight,
  children,
}: TranscriptMessageProps) {
  const label = messageAuthorLabel(role);
  if (!label) return <div style={{ minHeight }}>{children}</div>;
  return (
    <article aria-label={label} style={{ minHeight }}>
      {children}
    </article>
  );
}
