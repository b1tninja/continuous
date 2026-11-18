import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanReadUrl,
  FetchedPageInput,
  PROCESS_CAP_BYTES,
  SESSION_CAP_BYTES,
  sha256Hex,
  subagentStoreId,
  WebContentStore,
} from "./contentStore";
import { preparePage } from "./window";

const count = (text: string) => Math.ceil(text.length / 4);
const allow: CanReadUrl = () => true;
const MD = "text/markdown, text/html;q=0.9";

function page(text: string) {
  return preparePage(text, { windowTokens: 2_000, count });
}

function input(
  over: Partial<FetchedPageInput> & { text?: string } = {},
): FetchedPageInput {
  const text = over.text ?? "# Title\n\nBody of the page.";
  return {
    sessionId: "s1",
    finalUrl: "https://docs.example.com/guide",
    acceptVariant: MD,
    page: page(text),
    ...over,
    text,
  };
}

function stored(store: WebContentStore, over: Partial<FetchedPageInput> = {}) {
  const result = store.recordFetchedPage(input(over));
  if (!result.stored) throw new Error("not stored");
  return result.entry;
}

/** Text of exactly `bytes` UTF-8 bytes. */
function textOf(bytes: number, fill = "a"): string {
  return fill.repeat(bytes);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebContentStore", () => {
  it("has the caps of the design: 16 MiB a session, 64 MiB a process", () => {
    expect(SESSION_CAP_BYTES).toBe(16 * 1024 * 1024);
    expect(PROCESS_CAP_BYTES).toBe(64 * 1024 * 1024);
  });

  it("stores the prepared page and reads it back by id", async () => {
    const store = new WebContentStore();
    const prepared = page("# A\n\ntext");
    const result = store.recordFetchedPage(
      input({ text: "# A\n\ntext", page: prepared, now: 1_000 }),
    );
    expect(result).toMatchObject({ stored: true, reused: false });
    if (!result.stored) return;
    expect(result.entry.id).toBe("web-1");
    expect(result.entry.sha256).toBe(sha256Hex("# A\n\ntext"));
    const read = await store.session("s1").read("web-1", allow);
    expect(read.status).toBe("ok");
    // The same object: a read does not prepare the page again
    if (read.status === "ok") expect(read.entry.page).toBe(prepared);
  });

  describe("keys: final URL, Accept variant and SHA-256", () => {
    it("keeps the id for the same URL, variant and text", () => {
      const store = new WebContentStore();
      const a = stored(store, { now: 1 });
      const again = store.recordFetchedPage(input({ now: 2 }));
      expect(again).toMatchObject({ stored: true, reused: true });
      if (again.stored) expect(again.entry.id).toBe(a.id);
      expect(store.usage("s1").entries).toBe(1);
    });

    it("gives a changed page a new id and keeps the old one readable", async () => {
      const store = new WebContentStore();
      const a = stored(store, { text: "version one" });
      const b = stored(store, { text: "version two" });
      expect(b.id).not.toBe(a.id);
      expect(b.sha256).not.toBe(a.sha256);
      expect((await store.session("s1").read(a.id, allow)).status).toBe("ok");
      // A new fetch is answered from the newest
      expect(
        store.session("s1").findForFetch("https://docs.example.com/guide", MD)
          ?.id,
      ).toBe(b.id);
    });

    it("keeps Accept variants apart (RFC 9110 §12.5.5)", () => {
      const store = new WebContentStore();
      const md = stored(store, { acceptVariant: MD });
      const html = stored(store, { acceptVariant: "text/html" });
      expect(html.id).not.toBe(md.id);
      const view = store.session("s1");
      expect(view.findForFetch(md.finalUrl, "text/html")?.id).toBe(html.id);
      expect(view.findForFetch(md.finalUrl, MD)?.id).toBe(md.id);
      expect(view.findForFetch(md.finalUrl, "application/json")).toBe(
        undefined,
      );
    });

    it("answers a start URL that redirected to the final URL, and ignores the fragment", () => {
      const store = new WebContentStore();
      const e = stored(store, {
        requestedUrl: "https://example.com/docs",
        finalUrl: "https://docs.example.com/guide#intro",
      });
      expect(e.finalUrl).toBe("https://docs.example.com/guide");
      const view = store.session("s1");
      expect(view.findForFetch("https://example.com/docs", MD)?.id).toBe(e.id);
      expect(
        view.findForFetch("https://docs.example.com/guide#other", MD)?.id,
      ).toBe(e.id);
      expect(view.findForFetch("https://docs.example.com/other", MD)).toBe(
        undefined,
      );
    });
  });

  describe("caps and eviction", () => {
    it("evicts the least recently read page over the session cap", async () => {
      const store = new WebContentStore({
        sessionBytes: 300,
        processBytes: 10_000,
      });
      const view = store.session("s1");
      const a = stored(store, {
        finalUrl: "https://a.example/",
        text: textOf(100, "a"),
        now: 1,
      });
      const b = stored(store, {
        finalUrl: "https://b.example/",
        text: textOf(100, "b"),
        now: 2,
      });
      const c = stored(store, {
        finalUrl: "https://c.example/",
        text: textOf(100, "c"),
        now: 3,
      });
      // Reading a makes b the least recently read
      expect((await view.read(a.id, allow, 4)).status).toBe("ok");
      const d = stored(store, {
        finalUrl: "https://d.example/",
        text: textOf(100, "d"),
        now: 5,
      });
      expect(store.usage("s1")).toEqual({ bytes: 300, entries: 3 });
      expect((await view.read(b.id, allow)).status).toBe("expired");
      for (const kept of [a, c, d]) {
        expect((await view.read(kept.id, allow)).status).toBe("ok");
      }
    });

    it("evicts across sessions over the process cap, oldest read first", async () => {
      const store = new WebContentStore({
        sessionBytes: 1_000,
        processBytes: 250,
      });
      const s1 = stored(store, { sessionId: "s1", text: textOf(100), now: 1 });
      const s2 = stored(store, { sessionId: "s2", text: textOf(100), now: 2 });
      stored(store, { sessionId: "s3", text: textOf(100), now: 3 });
      expect(store.usage()).toEqual({ bytes: 200, entries: 2 });
      expect((await store.session("s1").read(s1.id, allow)).status).toBe(
        "expired",
      );
      expect((await store.session("s2").read(s2.id, allow)).status).toBe("ok");
    });

    it("counts UTF-8 bytes of the converted text", () => {
      const store = new WebContentStore();
      const e = stored(store, { text: "é".repeat(10) });
      expect(e.bytes).toBe(20);
    });

    it("refuses a page larger than a whole session's share", () => {
      const store = new WebContentStore({
        sessionBytes: 50,
        processBytes: 500,
      });
      expect(store.recordFetchedPage(input({ text: textOf(51) }))).toEqual({
        stored: false,
        reason: "too-large",
      });
      expect(store.usage()).toEqual({ bytes: 0, entries: 0 });
    });

    it("never evicts the page it is storing", () => {
      const store = new WebContentStore({
        sessionBytes: 100,
        processBytes: 100,
      });
      stored(store, { finalUrl: "https://a.example/", text: textOf(60) });
      const b = stored(store, {
        finalUrl: "https://b.example/",
        text: textOf(60),
      });
      expect(
        store
          .session("s1")
          .list()
          .map((e) => e.id),
      ).toEqual([b.id]);
    });
  });

  describe("isolation", () => {
    it("gives two sessions fetching the same URL separate entries", async () => {
      const store = new WebContentStore();
      const a = stored(store, { sessionId: "s1" });
      const b = stored(store, { sessionId: "s2" });
      expect(a).not.toBe(b);
      expect(a.id).toBe("web-1");
      expect(b.id).toBe("web-1");
      expect(store.usage("s1").entries).toBe(1);
      expect(store.usage("s2").entries).toBe(1);
    });

    it("does not find another session's id", async () => {
      const store = new WebContentStore();
      stored(store, { sessionId: "s1" });
      expect((await store.session("s2").read("web-1", allow)).status).toBe(
        "not-found",
      );
      expect(
        store.session("s2").findForFetch("https://docs.example.com/guide", MD),
      ).toBe(undefined);
    });

    it("keeps a subagent's pages from its parent, and its parent's from it", async () => {
      const store = new WebContentStore();
      const child = subagentStoreId("s1", "call-7");
      stored(store, { sessionId: "s1", finalUrl: "https://parent.example/" });
      stored(store, { sessionId: child, finalUrl: "https://child.example/" });
      expect(
        store
          .session("s1")
          .list()
          .map((e) => e.finalUrl),
      ).toEqual(["https://parent.example/"]);
      expect(
        store
          .session(child)
          .list()
          .map((e) => e.finalUrl),
      ).toEqual(["https://child.example/"]);
      expect(
        store.session(child).findForFetch("https://parent.example/", MD),
      ).toBe(undefined);
    });

    it("starts a fork empty: it has a new session id", () => {
      const store = new WebContentStore();
      stored(store, { sessionId: "parent" });
      expect(store.session("fork-of-parent").list()).toEqual([]);
      expect(store.session("fork-of-parent").newest()).toBe(undefined);
    });

    it("says not found for an id it never gave", async () => {
      const store = new WebContentStore();
      stored(store);
      for (const id of ["web-9", "cmd-1", "nonsense"]) {
        expect((await store.session("s1").read(id, allow)).status).toBe(
          "not-found",
        );
      }
    });
  });

  describe("turn-scoped pages: no-store, credentialed, non-public", () => {
    it.each([
      ["no-store", { noStore: true }],
      ["credentialed", { credentialed: true }],
      ["non-public", { nonPublic: true }],
    ] as const)(
      "%s: readable until the turn ends, never answers a fetch",
      async (reason, flags) => {
        const store = new WebContentStore();
        const view = store.session("s1");
        const e = stored(store, flags);
        expect(e.turnScoped).toBe(reason);
        expect((await view.read(e.id, allow)).status).toBe("ok");
        // Not even in the same turn (RFC 9111 §5.2.2.5)
        expect(view.findForFetch(e.finalUrl, MD)).toBe(undefined);
        store.endTurn("s1");
        expect((await view.read(e.id, allow)).status).toBe("expired");
        expect(store.usage()).toEqual({ bytes: 0, entries: 0 });
      },
    );

    it("gives a turn-scoped page a new id each time, and does not reuse its id later", () => {
      const store = new WebContentStore();
      const a = stored(store, { noStore: true });
      const b = stored(store, { noStore: true });
      expect(b.id).not.toBe(a.id);
      store.endTurn("s1");
      const c = stored(store);
      expect([a.id, b.id]).not.toContain(c.id);
    });

    it("leaves the session's other pages at the end of a turn", async () => {
      const store = new WebContentStore();
      const kept = stored(store, { finalUrl: "https://public.example/" });
      stored(store, { finalUrl: "https://intranet.local/", nonPublic: true });
      store.endTurn("s1");
      expect(
        store
          .session("s1")
          .list()
          .map((e) => e.id),
      ).toEqual([kept.id]);
      expect(
        store.session("s1").findForFetch("https://public.example/", MD)?.id,
      ).toBe(kept.id);
    });

    it("a no-store response does not reuse the id of a stored copy", () => {
      const store = new WebContentStore();
      const normal = stored(store);
      const noStore = stored(store, { noStore: true });
      expect(noStore.id).not.toBe(normal.id);
      expect(store.session("s1").findForFetch(normal.finalUrl, MD)?.id).toBe(
        normal.id,
      );
    });

    it("ends a subagent's turn-scoped pages with its parent's turn", () => {
      const store = new WebContentStore();
      const child = subagentStoreId("s1", "call-1");
      stored(store, { sessionId: child, noStore: true });
      store.endTurn("s1");
      expect(store.usage(child).entries).toBe(0);
    });
  });

  describe("deletion with the session", () => {
    it("deletes the session's pages and its subagents', and no other session's", () => {
      const store = new WebContentStore();
      stored(store, { sessionId: "s1" });
      stored(store, { sessionId: subagentStoreId("s1", "c1") });
      stored(store, { sessionId: "s10" });
      store.deleteSession("s1");
      expect(store.usage("s1").entries).toBe(0);
      expect(store.usage(subagentStoreId("s1", "c1")).entries).toBe(0);
      expect(store.usage("s10").entries).toBe(1);
      expect(store.usage().bytes).toBe(store.usage("s10").bytes);
    });

    it("clears everything", () => {
      const store = new WebContentStore();
      stored(store, { sessionId: "s1" });
      stored(store, { sessionId: "s2" });
      store.clearAll();
      expect(store.usage()).toEqual({ bytes: 0, entries: 0 });
    });
  });

  describe("canRead: host rules and the Web level on every read", () => {
    it("refuses a read once the host is blocked, and allows it again after", async () => {
      const store = new WebContentStore();
      const e = stored(store);
      let blocked = false;
      const canRead: CanReadUrl = (url) =>
        !(blocked && new URL(url).hostname === "docs.example.com");
      const view = store.session("s1");
      expect((await view.read(e.id, canRead)).status).toBe("ok");
      blocked = true;
      expect(await view.read(e.id, canRead)).toEqual({
        status: "blocked",
        id: e.id,
        url: "https://docs.example.com/guide",
      });
      blocked = false;
      expect((await view.read(e.id, canRead)).status).toBe("ok");
    });

    it("asks about the start URL of a redirect as well", async () => {
      const store = new WebContentStore();
      const e = stored(store, { requestedUrl: "https://short.example/x" });
      const asked: string[] = [];
      const result = await store.session("s1").read(e.id, async (url) => {
        asked.push(url);
        return !url.startsWith("https://short.example");
      });
      expect(asked).toEqual([
        "https://docs.example.com/guide",
        "https://short.example/x",
      ]);
      expect(result.status).toBe("blocked");
    });

    it("does not count a refused read for eviction", async () => {
      const store = new WebContentStore({
        sessionBytes: 200,
        processBytes: 1_000,
      });
      const a = stored(store, {
        finalUrl: "https://a.example/",
        text: textOf(100),
        now: 1,
      });
      const b = stored(store, {
        finalUrl: "https://b.example/",
        text: textOf(100),
        now: 2,
      });
      await store.session("s1").read(a.id, () => false, 3);
      stored(store, {
        finalUrl: "https://c.example/",
        text: textOf(100),
        now: 4,
      });
      expect((await store.session("s1").read(a.id, allow)).status).toBe(
        "expired",
      );
      expect((await store.session("s1").read(b.id, allow)).status).toBe("ok");
    });

    it("says expired when the page went while canRead was deciding", async () => {
      const store = new WebContentStore();
      const e = stored(store, { noStore: true });
      const result = await store.session("s1").read(e.id, async () => {
        store.endTurn("s1");
        return true;
      });
      expect(result.status).toBe("expired");
    });
  });

  it("writes nothing to disk", () => {
    const spies = [
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "appendFileSync"),
      vi.spyOn(fs, "createWriteStream"),
      vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs.promises, "writeFile"),
    ];
    const store = new WebContentStore();
    stored(store, { text: textOf(10_000) });
    stored(store, { noStore: true });
    store.endTurn("s1");
    store.deleteSession("s1");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("gives tools no way to write: the session view only reads", () => {
    const view = new WebContentStore().session("s1");
    expect(Object.keys(view).sort()).toEqual(
      ["findForFetch", "list", "newest", "read", "sessionId"].sort(),
    );
  });
});
