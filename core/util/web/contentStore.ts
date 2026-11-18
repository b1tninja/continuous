import { createHash } from "node:crypto";

import { SUBAGENT_SEPARATOR } from "./contentStoreIds";
import type { WebPage } from "./window";

export { subagentStoreId } from "./contentStoreIds";

/**
 * The pages fetched in a session, so the model can read more of a page that
 * did not fit in one result without fetching it again
 * (plans/research/web-fetch-large-pages-and-policy.md, section 5). Modelled
 * on commandOutputStore.ts: short ids, a record per entry, lookup by id, the
 * newest entry as the default.
 *
 * This is session history, not an HTTP cache: reading more of a page already
 * fetched is redisplaying a representation "retrieved earlier in a session",
 * which RFC 9111 §6 leaves outside the caching requirements, while a history
 * mechanism "might honor cache directives (e.g., Cache-Control: no-store)".
 * We do: a `no-store`, credentialed or non-public page is turn-scoped, read
 * by id until the turn ends and never used to answer another fetch
 * (RFC 9111 §5.2.2.5).
 *
 * - Memory only. Nothing here touches the disk (unlike the command store:
 *   a web page may be an intranet page reached through an ask).
 * - One map per session id. Ids (`web-1`, `web-2`, ...) are per session, so
 *   an id from another session is not found. A subagent gets its own id
 *   (`subagentStoreId`); a fork has a new session id and starts empty.
 * - Keyed by final URL, Accept variant and SHA-256 of the converted text: the
 *   same page keeps its id, a changed page gets a new one.
 * - 16 MiB of converted text per session and 64 MiB per process, evicting
 *   the least recently read entry. An evicted id reads as `expired`.
 * - Every read re-checks the host rules and the Web level through `canRead`,
 *   so a host blocked mid-session can no longer be read from here.
 * - Only the fetch pipeline writes (`recordFetchedPage`); tools read through
 *   `webPagesOf`, which has no write.
 */

export const SESSION_CAP_BYTES = 16 * 1024 * 1024;
export const PROCESS_CAP_BYTES = 64 * 1024 * 1024;

export interface WebStoreLimits {
  sessionBytes: number;
  processBytes: number;
}

/** Why an entry lives only until the end of its turn. */
export type TurnScopedReason = "no-store" | "credentialed" | "non-public";

export interface StoredWebPage {
  /** Short id the model passes to read_web_content, unique within the session. */
  id: string;
  sessionId: string;
  /** The URL the content came from, after redirects, without its fragment. */
  finalUrl: string;
  /** Start URLs of fetches that redirected here in this session. */
  requestedUrls: string[];
  /** The `Accept` header the page was requested with (RFC 9110 §12.5.5: `Vary`). */
  acceptVariant: string;
  /** SHA-256 (hex) of the converted text. */
  sha256: string;
  /** UTF-8 bytes of the converted text, counted against the caps. */
  bytes: number;
  page: WebPage;
  contentType?: string;
  title?: string;
  fetchedAt: number;
  lastReadAt: number;
  /** Set when the entry is read only until the turn ends and never reused by a fetch. */
  turnScoped?: TurnScopedReason;
}

/** What the fetch pipeline hands over for a response it received. */
export interface FetchedPageInput {
  sessionId: string;
  finalUrl: string;
  /** The URL the fetch started from, when it redirected. */
  requestedUrl?: string;
  acceptVariant: string;
  /** The converted (and already masked) text the page was prepared from. */
  text: string;
  /** `preparePage(text, ...)` (window.ts), kept so reads do not redo it. */
  page: WebPage;
  contentType?: string;
  title?: string;
  /** `Cache-Control: no-store` on the response. */
  noStore?: boolean;
  /** The request carried credentials (cookies, Authorization). */
  credentialed?: boolean;
  /** The host is non-public (private, loopback, link-local), reached through an ask. */
  nonPublic?: boolean;
  now?: number;
}

export type RecordResult =
  | { stored: true; entry: StoredWebPage; reused: boolean }
  | { stored: false; reason: "too-large" };

/**
 * Host rules and the Web level, asked on every read. A hook until the Web
 * policy area (WB45) lands; false refuses the read.
 */
export type CanReadUrl = (url: string) => boolean | Promise<boolean>;

export type ReadResult =
  | { status: "ok"; entry: StoredWebPage }
  /** Evicted, or a turn-scoped entry whose turn has ended. */
  | { status: "expired"; id: string }
  | { status: "not-found"; id: string }
  /** The host rules or the Web level no longer let this URL be read. */
  | { status: "blocked"; id: string; url: string };

/** Read-only view of one session's pages, for the tools. */
export interface SessionWebPages {
  readonly sessionId: string;
  /** By id; re-checks `canRead` and counts as a read for eviction. */
  read(id: string, canRead: CanReadUrl, now?: number): Promise<ReadResult>;
  /** The newest entry, for a read that names no id. */
  newest(): StoredWebPage | undefined;
  /**
   * The entry a new fetch of `url` may be answered from: the newest one for
   * that final URL (or a start URL that redirected there) and Accept
   * variant. Never a turn-scoped entry. Freshness is the caller's (WB39).
   */
  findForFetch(url: string, acceptVariant: string): StoredWebPage | undefined;
  list(): StoredWebPage[];
}

interface SessionState {
  entries: Map<string, StoredWebPage>;
  /** `finalUrl \n variant \n sha256` to id, for non-turn-scoped entries. */
  byKey: Map<string, string>;
  bytes: number;
  nextId: number;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function normalizeVariant(accept: string): string {
  return accept.trim().toLowerCase();
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function idNumber(id: string): number | undefined {
  const match = /^web-(\d+)$/.exec(id.trim());
  return match ? Number(match[1]) : undefined;
}

export class WebContentStore {
  private readonly sessions = new Map<string, SessionState>();
  private totalBytes = 0;

  constructor(
    private readonly limits: WebStoreLimits = {
      sessionBytes: SESSION_CAP_BYTES,
      processBytes: PROCESS_CAP_BYTES,
    },
  ) {}

  /**
   * Stores a page the fetch pipeline received. The same final URL, variant
   * and text keep their id (the entry is refreshed); anything else gets a
   * new id. A turn-scoped page always gets a new id and is never indexed
   * for reuse. Evicts the least recently read entries over the caps.
   */
  recordFetchedPage(input: FetchedPageInput): RecordResult {
    const now = input.now ?? Date.now();
    const bytes = Buffer.byteLength(input.text, "utf8");
    if (bytes > this.limits.sessionBytes || bytes > this.limits.processBytes) {
      return { stored: false, reason: "too-large" };
    }
    const finalUrl = normalizeUrl(input.finalUrl);
    const acceptVariant = normalizeVariant(input.acceptVariant);
    const sha256 = sha256Hex(input.text);
    const turnScoped: TurnScopedReason | undefined = input.noStore
      ? "no-store"
      : input.credentialed
        ? "credentialed"
        : input.nonPublic
          ? "non-public"
          : undefined;
    const requested = input.requestedUrl
      ? normalizeUrl(input.requestedUrl)
      : undefined;
    const session = this.sessionState(input.sessionId);
    const key = `${finalUrl}\n${acceptVariant}\n${sha256}`;

    if (!turnScoped) {
      const existing = session.entries.get(session.byKey.get(key) ?? "");
      if (existing) {
        existing.fetchedAt = now;
        existing.lastReadAt = now;
        existing.page = input.page;
        if (input.contentType) existing.contentType = input.contentType;
        if (input.title) existing.title = input.title;
        if (
          requested &&
          requested !== finalUrl &&
          !existing.requestedUrls.includes(requested)
        ) {
          existing.requestedUrls.push(requested);
        }
        // Re-inserted, so it is the newest
        session.entries.delete(existing.id);
        session.entries.set(existing.id, existing);
        return { stored: true, entry: existing, reused: true };
      }
    }

    const entry: StoredWebPage = {
      id: `web-${session.nextId++}`,
      sessionId: input.sessionId,
      finalUrl,
      requestedUrls: requested && requested !== finalUrl ? [requested] : [],
      acceptVariant,
      sha256,
      bytes,
      page: input.page,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(input.title ? { title: input.title } : {}),
      fetchedAt: now,
      lastReadAt: now,
      ...(turnScoped ? { turnScoped } : {}),
    };
    session.entries.set(entry.id, entry);
    if (!turnScoped) session.byKey.set(key, entry.id);
    session.bytes += bytes;
    this.totalBytes += bytes;
    this.evict(session, entry);
    return { stored: true, entry, reused: false };
  }

  /** The session's pages, read-only: what a tool gets from `extras.sessionId`. */
  session(sessionId: string): SessionWebPages {
    return {
      sessionId,
      read: (id, canRead, now) => this.read(sessionId, id, canRead, now),
      newest: () => {
        const entries = [
          ...(this.sessions.get(sessionId)?.entries.values() ?? []),
        ];
        return entries[entries.length - 1];
      },
      findForFetch: (url, acceptVariant) =>
        this.findForFetch(sessionId, url, acceptVariant),
      list: () => [...(this.sessions.get(sessionId)?.entries.values() ?? [])],
    };
  }

  /** The turn is over: its `no-store`, credentialed and non-public pages go. */
  endTurn(sessionId: string): void {
    // The session's state stays, so its next id is not handed out again
    for (const [, session] of this.sessionsOf(sessionId)) {
      for (const entry of [...session.entries.values()]) {
        if (entry.turnScoped) this.remove(session, entry);
      }
    }
  }

  /**
   * The session was deleted, trashed, cleared or closed (a new session
   * started): its pages go, with those of its subagents.
   */
  deleteSession(sessionId: string): void {
    for (const [id, session] of this.sessionsOf(sessionId)) {
      this.totalBytes -= session.bytes;
      this.sessions.delete(id);
    }
  }

  clearAll(): void {
    this.sessions.clear();
    this.totalBytes = 0;
  }

  /** Bytes held, for the Browser panel and `/web`. */
  usage(sessionId?: string): { bytes: number; entries: number } {
    if (sessionId === undefined) {
      let entries = 0;
      for (const s of this.sessions.values()) entries += s.entries.size;
      return { bytes: this.totalBytes, entries };
    }
    const session = this.sessions.get(sessionId);
    return {
      bytes: session?.bytes ?? 0,
      entries: session?.entries.size ?? 0,
    };
  }

  private async read(
    sessionId: string,
    id: string,
    canRead: CanReadUrl,
    now: number = Date.now(),
  ): Promise<ReadResult> {
    const session = this.sessions.get(sessionId);
    const entry = session?.entries.get(id.trim());
    if (!session || !entry) {
      const n = idNumber(id);
      // Ids are handed out in order, so a lower number was ours and is gone
      return n !== undefined && session && n < session.nextId
        ? { status: "expired", id }
        : { status: "not-found", id };
    }
    for (const url of [entry.finalUrl, ...entry.requestedUrls]) {
      if (!(await canRead(url))) return { status: "blocked", id, url };
    }
    // The entry can have gone while canRead ran (the turn ended, the session closed)
    if (this.sessions.get(sessionId)?.entries.get(entry.id) !== entry) {
      return { status: "expired", id };
    }
    entry.lastReadAt = now;
    return { status: "ok", entry };
  }

  private findForFetch(
    sessionId: string,
    url: string,
    acceptVariant: string,
  ): StoredWebPage | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const wanted = normalizeUrl(url);
    const variant = normalizeVariant(acceptVariant);
    const entries = [...session.entries.values()].reverse();
    return entries.find(
      (e) =>
        !e.turnScoped &&
        e.acceptVariant === variant &&
        (e.finalUrl === wanted || e.requestedUrls.includes(wanted)),
    );
  }

  private sessionState(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { entries: new Map(), byKey: new Map(), bytes: 0, nextId: 1 };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** The session and its subagents' stores. */
  private sessionsOf(sessionId: string): [string, SessionState][] {
    const prefix = `${sessionId}${SUBAGENT_SEPARATOR}`;
    return [...this.sessions].filter(
      ([id]) => id === sessionId || id.startsWith(prefix),
    );
  }

  private remove(session: SessionState, entry: StoredWebPage): void {
    session.entries.delete(entry.id);
    const key = `${entry.finalUrl}\n${entry.acceptVariant}\n${entry.sha256}`;
    if (session.byKey.get(key) === entry.id) session.byKey.delete(key);
    session.bytes -= entry.bytes;
    this.totalBytes -= entry.bytes;
  }

  private evict(session: SessionState, keep: StoredWebPage): void {
    while (session.bytes > this.limits.sessionBytes) {
      const victim = leastRecentlyRead(session.entries.values(), keep);
      if (!victim) break;
      this.remove(session, victim);
    }
    while (this.totalBytes > this.limits.processBytes) {
      let victim: StoredWebPage | undefined;
      let owner: SessionState | undefined;
      for (const s of this.sessions.values()) {
        const candidate = leastRecentlyRead(s.entries.values(), keep);
        if (
          candidate &&
          (!victim || candidate.lastReadAt < victim.lastReadAt)
        ) {
          victim = candidate;
          owner = s;
        }
      }
      if (!victim || !owner) break;
      this.remove(owner, victim);
    }
  }
}

function leastRecentlyRead(
  entries: Iterable<StoredWebPage>,
  keep: StoredWebPage,
): StoredWebPage | undefined {
  let oldest: StoredWebPage | undefined;
  for (const e of entries) {
    if (e === keep) continue;
    // Ties go to the older entry (the map keeps insertion order)
    if (!oldest || e.lastReadAt < oldest.lastReadAt) oldest = e;
  }
  return oldest;
}

/** The process's store: the IDE's core and the CLI each have one. */
export const webContentStore = new WebContentStore();

/** What a tool reads: the pages of the session its call belongs to. */
export function webPagesOf(sessionId: string): SessionWebPages {
  return webContentStore.session(sessionId);
}
