import type { ChatHistoryItem, ContextItemWithId } from "..";

/**
 * Attached context is sent once per version: plans/context-references.md
 * section 3.2.
 *
 * Each message keeps its own attachments (`ChatHistoryItem.contextItems`), and
 * the request prepends them to their message. A file attached to three
 * messages was sent three times, and every later request carried all three.
 * Here a later attachment of the same source with the same content is sent as
 * a one-line stub. The first copy is unchanged and stays where it was, so the
 * prompt cache keeps it: the stub is in the newer message, which the request
 * adds anyway. A changed file is a new version and is sent in full.
 *
 * Pure, with no node imports, so the GUI can use it.
 */

/** "[README.md: the same content as attached earlier in this conversation]". */
export function repeatedAttachmentStub(item: ContextItemWithId): string {
  const name = (item.name || item.description || "attachment").trim();
  return `[${name}: the same content as attached earlier in this conversation]`;
}

/** FNV-1a over the UTF-16 code units, as 8 hex digits. Not cryptographic. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * What makes two attachments the same: their source (the file or URL, else
 * the name) and their content. Undefined for an item with no content, which
 * is never sent.
 */
export function attachmentKey(item: ContextItemWithId): string | undefined {
  const content = item.content ?? "";
  if (!content.trim()) return undefined;
  const source = item.uri?.value || item.name || item.description || "";
  return `${source}\u0000${content.length}:${contentHash(content)}`;
}

/**
 * One attached source in the session: a file, URL or selection, with every
 * version of it that was attached.
 */
export interface SessionAttachment {
  /** The file or URL (or the name, for an attachment without one). */
  source: string;
  name: string;
  description: string;
  uri?: ContextItemWithId["uri"];
  /** Distinct contents attached, oldest first. */
  versions: number;
  /** Messages that attached it (a message attaching it twice counts twice). */
  timesAttached: number;
  /** How many of those were sent in full; the rest went as a stub. */
  timesSentInFull: number;
  /** Characters of the newest version. */
  chars: number;
  /** History index of the last message that attached it. */
  lastAttachedAt: number;
}

function sourceOf(item: ContextItemWithId): string {
  return item.uri?.value || item.name || item.description || "";
}

/**
 * Every attached source in the history, newest attachment first, with the
 * counts the session's attachment list shows. Pass the full history; the
 * counts follow the same rule as `sendAttachmentsOnce` (a repeat of an
 * attached version is not sent in full).
 */
export function sessionAttachments(
  history: ChatHistoryItem[],
): SessionAttachment[] {
  const bySource = new Map<string, SessionAttachment & { keys: Set<string> }>();
  const sentVersions = new Set<string>();
  history.forEach((item, index) => {
    if (item.message.role !== "user") return;
    for (const ctx of item.contextItems ?? []) {
      const key = attachmentKey(ctx);
      if (key === undefined) continue;
      const source = sourceOf(ctx);
      let entry = bySource.get(source);
      if (!entry) {
        entry = {
          source,
          name: ctx.name,
          description: ctx.description,
          uri: ctx.uri,
          versions: 0,
          timesAttached: 0,
          timesSentInFull: 0,
          chars: 0,
          lastAttachedAt: index,
          keys: new Set(),
        };
        bySource.set(source, entry);
      }
      if (!entry.keys.has(key)) {
        entry.keys.add(key);
        entry.versions++;
      }
      entry.timesAttached++;
      if (!sentVersions.has(key)) {
        sentVersions.add(key);
        entry.timesSentInFull++;
      }
      entry.chars = ctx.content.length;
      entry.lastAttachedAt = index;
      entry.name = ctx.name;
      entry.description = ctx.description;
    }
  });
  return [...bySource.values()]
    .map(({ keys: _keys, ...rest }) => rest)
    .sort((a, b) => b.lastAttachedAt - a.lastAttachedAt);
}

/**
 * The history with each repeated attachment (the same source and content as
 * one sent earlier in these items) replaced by a stub. Give it the items that
 * are sent: after the newest summary, with removed parts already stubbed, so
 * a copy that is no longer sent does not stand in for a later one. Items and
 * arrays that need no change are returned as they were.
 */
export function sendAttachmentsOnce(
  history: ChatHistoryItem[],
): ChatHistoryItem[] {
  const seen = new Set<string>();
  let changed = false;
  const out = history.map((item) => {
    if (item.message.role !== "user" || !item.contextItems?.length) {
      return item;
    }
    let itemChanged = false;
    const contextItems = item.contextItems.map((ctx) => {
      const key = attachmentKey(ctx);
      if (key === undefined) return ctx;
      if (!seen.has(key)) {
        seen.add(key);
        return ctx;
      }
      itemChanged = true;
      return { ...ctx, content: repeatedAttachmentStub(ctx) };
    });
    if (!itemChanged) return item;
    changed = true;
    return { ...item, contextItems };
  });
  return changed ? out : history;
}
