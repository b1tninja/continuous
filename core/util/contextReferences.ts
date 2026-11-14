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
