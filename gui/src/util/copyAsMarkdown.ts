import type { ChatMessage } from "core";
import { renderChatMessage } from "core/util/messageContent";

/**
 * One history item, as far as a copy needs to see it. `reasoning` is accepted
 * so a caller can pass a real history item; it is never written out.
 */
export interface CopySource {
  message: ChatMessage;
  reasoning?: { text?: string };
}

export interface CopyMarkdownOptions {
  /** Chat title. A blank title is written as "New Session". */
  title: string;
  /** Calendar day in the local timezone, under the title. */
  date: Date;
}

const HEADING: Partial<Record<ChatMessage["role"], string>> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/** The row a shortcut uses to find the message whose actions are focused. */
export const MESSAGE_ACTIONS = "[data-message-actions]";

let lastFocusedKey: string | undefined;
let copyInFlight = false;
let lastCopiedAt = 0;

function titleLine(title: string): string {
  const line = title.replace(/\s*\n\s*/g, " ").trim();
  return line.length > 0 ? line : "New Session";
}

/** Local calendar day, `YYYY-MM-DD`. Copies use `\n`, never `\r\n`. */
export function formatCopyDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `\n` everywhere. A carriage return is not part of the copied text. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * A conversation as Markdown. The text starts with the title and the date.
 * Thinking messages and `reasoning` are left out. Message text, including
 * newlines and links, is copied as written (newlines as `\n`).
 */
export function conversationAsMarkdown(
  history: readonly CopySource[],
  options: CopyMarkdownOptions,
): string {
  const sections: string[] = [];
  for (const item of history) {
    const heading = HEADING[item.message.role];
    if (!heading) continue;
    const body = normalizeNewlines(renderChatMessage(item.message));
    if (body.trim() === "") continue;
    sections.push(`## ${heading}\n\n${body}`);
  }
  const header = `# ${titleLine(options.title)}\n\n${formatCopyDate(options.date)}`;
  const markdown = [header, ...sections].join("\n\n");
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

/** One reply, with the same title-and-date header as a conversation. */
export function messageAsMarkdown(
  item: CopySource,
  options: CopyMarkdownOptions,
): string {
  return conversationAsMarkdown([item], options);
}

/**
 * Plain text for the menu. Links become `text (url)`. Fenced code keeps its
 * body. The title and the date stay; heading marks are removed.
 */
export function markdownToPlainText(markdown: string): string {
  const fences: string[] = [];
  const parked = normalizeNewlines(markdown).replace(
    /```[^\n]*\n[\s\S]*?```/g,
    (block) => {
      const body = block.replace(/^```[^\n]*\n/, "").replace(/```$/, "");
      fences.push(body);
      return `\u0000FENCE${fences.length - 1}\u0000`;
    },
  );
  const plain = parked
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_match, alt: string, url: string) =>
        alt.trim() ? `${alt} (${url})` : url,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/^>[ \t]?/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(
      /\u0000FENCE(\d+)\u0000/g,
      (_match, index: string) => fences[Number(index)] ?? "",
    );
  return plain;
}

/** Stable id for a message, or `index:N` when the message has none. */
export function copyKeyOf(message: object, index: number): string {
  if ("id" in message && typeof message.id === "string" && message.id) {
    return message.id;
  }
  return `index:${index}`;
}

export function findMessageToCopy<T extends { message: { id?: string } }>(
  history: readonly T[],
  key: string,
): T | undefined {
  if (key.startsWith("index:")) {
    const index = Number(key.slice("index:".length));
    if (!Number.isInteger(index) || index < 0 || index >= history.length) {
      return undefined;
    }
    return history[index];
  }
  return history.find((item) => item.message.id === key);
}

export function rememberFocusedMessage(key: string) {
  lastFocusedKey = key;
}

/** The message whose actions currently hold focus, if any. */
export function messageKeyFromFocus(): string | undefined {
  const active = document.activeElement;
  if (!(active instanceof Element)) return undefined;
  const row = active.closest(MESSAGE_ACTIONS);
  const key = row?.getAttribute("data-copy-key");
  return key || undefined;
}

/**
 * The focused message, or the last message whose actions were focused.
 * The Command Palette moves focus away before the command runs.
 */
export function messageKeyForCommand(): string | undefined {
  return messageKeyFromFocus() ?? lastFocusedKey;
}

/**
 * Starts a clipboard write. `"recent"` means the key and the command both
 * saw the same shortcut, so the second caller should not write again.
 */
export function beginCopy(): "ok" | "recent" {
  const now = Date.now();
  if (copyInFlight || now - lastCopiedAt < 400) return "recent";
  copyInFlight = true;
  return "ok";
}

export function finishCopy(wrote: boolean) {
  copyInFlight = false;
  if (wrote) lastCopiedAt = Date.now();
}

export async function writeClipboardText(
  text: string,
  sink: { jetBrains: boolean; post: (text: string) => void },
): Promise<boolean> {
  try {
    if (sink.jetBrains) {
      sink.post(text);
      return true;
    }
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
