import type { JSONContent } from "@tiptap/core";

/**
 * Unsent drafts, per session: the main input's text and an edit of an
 * earlier message that is in progress, kept in the webview's local storage so
 * a reload, an extension update or a crash does not lose them.
 *
 * Each draft is its own key (`continuous.draft.v1:<session>:<input>`), and a
 * write touches only that key. The webview's storage is probably shared by
 * every VS Code window (#880), so one window saving never rewrites another
 * window's drafts, as one blob for all of them would.
 *
 * The draft is the editor's TipTap JSON, so @-mention chips and code blocks
 * come back as chips. Pasted images are never kept: their base64 would fill
 * the storage, so they are dropped and the notice says so.
 */

export const DRAFT_KEY_PREFIX = "continuous.draft.v1:";
/** The input id of the main input's draft. Others are a message id. */
export const MAIN_DRAFT_INPUT = "main";
/** Largest draft kept as JSON, in characters; a larger one keeps its text only. */
export const DRAFT_MAX_CHARS = 40_000;
/** Drafts kept at most; the oldest go first. */
export const DRAFT_MAX_COUNT = 15;
/** A draft not touched for this long is dropped. */
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * A draft of a session the history list does not hold is dropped only after
 * this long: a new session is not in the list until its first message is
 * saved, and another window may be typing in one.
 */
export const DRAFT_UNKNOWN_SESSION_GRACE_MS = 24 * 60 * 60 * 1000;

export interface StoredDraft {
  v: 1;
  sessionId: string;
  inputId: string;
  savedAt: number;
  content: JSONContent;
  /** Images left out of the draft */
  droppedImages?: number;
  /** Too large as JSON: only the text was kept */
  textOnly?: boolean;
}

type DraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

function defaultStorage(): DraftStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function draftKey(sessionId: string, inputId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}:${inputId}`;
}

const IMAGE_NODE = "image";
/** Nodes that hold no content of their own when they hold no text. */
const PLAIN_NODES = new Set(["doc", "paragraph", "text", "hardBreak"]);

/** True when the document has nothing worth keeping. */
export function isEmptyDraft(content: JSONContent | undefined): boolean {
  if (!content) return true;
  const visit = (node: JSONContent): boolean => {
    if (node.type && !PLAIN_NODES.has(node.type)) return false;
    if (node.type === "text" && (node.text ?? "").trim() !== "") return false;
    return (node.content ?? []).every(visit);
  };
  return visit(content);
}

function stripImages(node: JSONContent): {
  node: JSONContent;
  dropped: number;
} {
  if (!node.content) return { node, dropped: 0 };
  let dropped = 0;
  const content: JSONContent[] = [];
  for (const child of node.content) {
    if (child.type === IMAGE_NODE) {
      dropped++;
      continue;
    }
    const inner = stripImages(child);
    dropped += inner.dropped;
    content.push(inner.node);
  }
  return { node: { ...node, content }, dropped };
}

/** The text of a document, a line per block, mentions as `@label`. */
export function draftText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") {
    const label = node.attrs?.label ?? node.attrs?.id;
    return label ? `@${label}` : "";
  }
  const parts = (node.content ?? []).map(draftText);
  return node.type === "doc" ? parts.join("\n") : parts.join("");
}

function textDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: text
      .split("\n")
      .map((line) =>
        line
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" },
      ),
  };
}

/**
 * What would be stored for `content`: images left out, and over the size cap
 * only its text, cut to the cap. Undefined when nothing is left to keep.
 */
export function prepareDraft(
  content: JSONContent | undefined,
): Pick<StoredDraft, "content" | "droppedImages" | "textOnly"> | undefined {
  if (!content) return undefined;
  const { node, dropped } = stripImages(content);
  const droppedImages = dropped > 0 ? dropped : undefined;
  if (isEmptyDraft(node)) return undefined;
  if (JSON.stringify(node).length <= DRAFT_MAX_CHARS) {
    return { content: node, droppedImages };
  }
  // Leave room for the JSON around the text
  const text = draftText(node).slice(0, Math.floor(DRAFT_MAX_CHARS / 2));
  if (text.trim() === "") return undefined;
  return { content: textDoc(text), droppedImages, textOnly: true };
}

function parse(raw: string | null): StoredDraft | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (
      value?.v === 1 &&
      typeof value.sessionId === "string" &&
      typeof value.inputId === "string" &&
      typeof value.savedAt === "number" &&
      value.content &&
      typeof value.content === "object"
    ) {
      return value as StoredDraft;
    }
  } catch {
    // A corrupt entry is dropped by pruneDrafts
  }
  return undefined;
}

/** Every stored draft key, with its draft when it can be read. */
function entries(
  storage: DraftStorage,
): { key: string; draft?: StoredDraft }[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(DRAFT_KEY_PREFIX)) keys.push(key);
  }
  return keys.map((key) => ({ key, draft: parse(storage.getItem(key)) }));
}

export function listDrafts(
  storage: DraftStorage | undefined = defaultStorage(),
): StoredDraft[] {
  if (!storage) return [];
  try {
    return entries(storage)
      .map((e) => e.draft)
      .filter((d): d is StoredDraft => !!d);
  } catch {
    return [];
  }
}

export function loadDraft(
  sessionId: string,
  inputId: string,
  storage: DraftStorage | undefined = defaultStorage(),
  now = Date.now(),
): StoredDraft | undefined {
  if (!storage || !sessionId) return undefined;
  try {
    const draft = parse(storage.getItem(draftKey(sessionId, inputId)));
    if (!draft || now - draft.savedAt > DRAFT_MAX_AGE_MS) return undefined;
    return draft;
  } catch {
    return undefined;
  }
}

export function clearDraft(
  sessionId: string,
  inputId: string,
  storage: DraftStorage | undefined = defaultStorage(),
): void {
  if (!storage || !sessionId) return;
  try {
    storage.removeItem(draftKey(sessionId, inputId));
  } catch {
    // Nothing to do: the draft stays until it expires
  }
}

/** Drops every draft of one session (it was deleted). */
export function clearSessionDrafts(
  sessionId: string,
  storage: DraftStorage | undefined = defaultStorage(),
): void {
  if (!storage || !sessionId) return;
  try {
    const prefix = draftKey(sessionId, "");
    for (const { key } of entries(storage)) {
      if (key.startsWith(prefix)) storage.removeItem(key);
    }
  } catch {
    // As above
  }
}

/** Drops every draft except those of `keepSessionIds` (history cleared). */
export function clearDraftsExcept(
  keepSessionIds: string[],
  storage: DraftStorage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    for (const { key, draft } of entries(storage)) {
      if (!draft || !keepSessionIds.includes(draft.sessionId)) {
        storage.removeItem(key);
      }
    }
  } catch {
    // As above
  }
}

/**
 * Drops expired and unreadable drafts and, when the full history list is
 * known, drafts of sessions it no longer holds (after a grace period: see
 * DRAFT_UNKNOWN_SESSION_GRACE_MS). Then keeps at most DRAFT_MAX_COUNT, the
 * newest. Drafts of `keepSessionIds` are never dropped for being unknown.
 */
export function pruneDrafts(
  options: {
    knownSessionIds?: Iterable<string>;
    keepSessionIds?: string[];
    now?: number;
  } = {},
  storage: DraftStorage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  const now = options.now ?? Date.now();
  const known = options.knownSessionIds
    ? new Set(options.knownSessionIds)
    : undefined;
  const keep = new Set(options.keepSessionIds ?? []);
  try {
    const kept: { key: string; draft: StoredDraft }[] = [];
    for (const { key, draft } of entries(storage)) {
      const unknownSession =
        !!draft &&
        !!known &&
        !known.has(draft.sessionId) &&
        !keep.has(draft.sessionId) &&
        now - draft.savedAt > DRAFT_UNKNOWN_SESSION_GRACE_MS;
      if (!draft || now - draft.savedAt > DRAFT_MAX_AGE_MS || unknownSession) {
        storage.removeItem(key);
      } else {
        kept.push({ key, draft });
      }
    }
    kept
      .sort((a, b) => b.draft.savedAt - a.draft.savedAt)
      .slice(DRAFT_MAX_COUNT)
      .forEach(({ key }) => storage.removeItem(key));
  } catch {
    // As above
  }
}

/**
 * Saves the draft of one input of one session, or removes it when nothing is
 * left to keep. Answers what was stored.
 */
export function saveDraft(
  sessionId: string,
  inputId: string,
  content: JSONContent | undefined,
  storage: DraftStorage | undefined = defaultStorage(),
  now = Date.now(),
): StoredDraft | undefined {
  if (!storage || !sessionId) return undefined;
  const prepared = prepareDraft(content);
  if (!prepared) {
    clearDraft(sessionId, inputId, storage);
    return undefined;
  }
  const draft: StoredDraft = {
    v: 1,
    sessionId,
    inputId,
    savedAt: now,
    ...prepared,
  };
  const key = draftKey(sessionId, inputId);
  const raw = JSON.stringify(draft);
  try {
    storage.setItem(key, raw);
  } catch {
    // Storage full: drop the oldest other drafts one at a time until it fits
    const older = listDrafts(storage)
      .filter((d) => d.sessionId !== sessionId || d.inputId !== inputId)
      .sort((a, b) => a.savedAt - b.savedAt);
    let saved = false;
    for (const old of older) {
      try {
        storage.removeItem(draftKey(old.sessionId, old.inputId));
        storage.setItem(key, raw);
        saved = true;
        break;
      } catch {
        // Still full: drop the next one
      }
    }
    if (!saved) return undefined;
  }
  pruneDrafts({ now, keepSessionIds: [sessionId] }, storage);
  return draft;
}

/** The notice shown when a draft comes back. */
export function restoredDraftNotice(
  draft: Pick<StoredDraft, "droppedImages" | "textOnly">,
): string {
  const parts = ["Restored your unsent message."];
  if (draft.textOnly) {
    parts.push("It was too large to keep whole, so only its text came back.");
  }
  if (draft.droppedImages) {
    parts.push(
      draft.droppedImages === 1
        ? "An image in it was not kept; add it again."
        : `${draft.droppedImages} images in it were not kept; add them again.`,
    );
  }
  return parts.join(" ");
}
