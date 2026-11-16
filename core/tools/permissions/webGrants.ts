import { normalizeHost } from "./destinations";

/**
 * Session grants and blocks for the Web area
 * (plans/research/web-fetch-large-pages-and-policy.md, sections 8.2 and 8.5).
 *
 * - **Allow, Once** (the ask card's second button, the Browser panel later)
 *   adds a host to the session's grants: at Cautious and Automatic a fetch to
 *   it runs without asking for the rest of the session.
 * - **Block, Once** adds a session block: a fetch to it is refused at every
 *   level below IDGAF.
 *
 * Memory only, one store per session, gone when the session ends or the
 * process exits. Nothing here is written to disk: the lasting forms are
 * `allow: host:<h>` and `deny: host:<h>` in the person's permissions.yaml.
 * A grant is for the exact host: `docs.example.com` does not grant
 * `example.com` or `api.docs.example.com`.
 */

/** What the decision reads: the session's grants and blocks. */
export interface WebGrantView {
  isGranted(host: string): boolean;
  isBlocked(host: string): boolean;
}

export class WebGrantStore implements WebGrantView {
  private readonly granted = new Set<string>();
  private readonly blocked = new Set<string>();

  /** Allow, Once: a later block of the same host replaces it, and the other way round. */
  allowOnce(host: string): void {
    const h = key(host);
    if (!h) return;
    this.blocked.delete(h);
    this.granted.add(h);
  }

  /** Block, Once. */
  blockOnce(host: string): void {
    const h = key(host);
    if (!h) return;
    this.granted.delete(h);
    this.blocked.add(h);
  }

  /** The Remove button in Settings > Web > Policy. */
  remove(host: string): void {
    const h = key(host);
    this.granted.delete(h);
    this.blocked.delete(h);
  }

  isGranted(host: string): boolean {
    return this.granted.has(key(host));
  }

  isBlocked(host: string): boolean {
    return this.blocked.has(key(host));
  }

  list(): { granted: string[]; blocked: string[] } {
    return { granted: [...this.granted], blocked: [...this.blocked] };
  }

  clear(): void {
    this.granted.clear();
    this.blocked.clear();
  }
}

function key(host: string): string {
  return normalizeHost(host);
}

const stores = new Map<string, WebGrantStore>();

/** The session's store, made on first use. A session without an id shares one store. */
export function webGrantsFor(sessionId: string | undefined): WebGrantStore {
  const id = sessionId ?? "";
  let store = stores.get(id);
  if (!store) {
    store = new WebGrantStore();
    stores.set(id, store);
  }
  return store;
}

/** The session ended or was deleted: its grants and blocks go with it. */
export function forgetWebGrants(sessionId: string): void {
  stores.delete(sessionId);
}

/** For tests: forget every session's grants. */
export function resetWebGrantsForTests(): void {
  stores.clear();
}
