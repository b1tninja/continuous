import type { JSONContent } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraft,
  clearDraftsExcept,
  clearSessionDrafts,
  DRAFT_KEY_PREFIX,
  DRAFT_MAX_AGE_MS,
  DRAFT_MAX_CHARS,
  DRAFT_MAX_COUNT,
  DRAFT_UNKNOWN_SESSION_GRACE_MS,
  draftKey,
  listDrafts,
  loadDraft,
  MAIN_DRAFT_INPUT,
  prepareDraft,
  pruneDrafts,
  restoredDraftNotice,
  saveDraft,
} from "./drafts";

function doc(...paragraphs: JSONContent[][]): JSONContent {
  return {
    type: "doc",
    content: paragraphs.map((content) => ({ type: "paragraph", content })),
  };
}
const text = (t: string): JSONContent => ({ type: "text", text: t });
const mention = (label: string): JSONContent => ({
  type: "mention",
  attrs: { id: label, label, itemType: "file", query: `/repo/${label}` },
});
const image = (): JSONContent => ({
  type: "image",
  attrs: { src: `data:image/png;base64,${"A".repeat(5000)}` },
});

beforeEach(() => localStorage.clear());

describe("unsent drafts", () => {
  it("saves the TipTap JSON per session and input, chips included", () => {
    const content = doc([text("Look at "), mention("a.ts")]);
    saveDraft("s1", MAIN_DRAFT_INPUT, content);
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)?.content).toEqual(content);
    expect(loadDraft("s2", MAIN_DRAFT_INPUT)).toBeUndefined();
    expect(loadDraft("s1", "msg-1")).toBeUndefined();
  });

  it("keeps each session's draft apart, and writes only its own key", () => {
    saveDraft("s1", MAIN_DRAFT_INPUT, doc([text("one")]));
    saveDraft("s2", MAIN_DRAFT_INPUT, doc([text("two")]));
    saveDraft("s1", "msg-1", doc([text("edit of an earlier message")]));
    // Another window writing s2 leaves s1 alone
    saveDraft("s2", MAIN_DRAFT_INPUT, doc([text("two, again")]));
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)?.content).toEqual(
      doc([text("one")]),
    );
    expect(loadDraft("s2", MAIN_DRAFT_INPUT)?.content).toEqual(
      doc([text("two, again")]),
    );
    expect(loadDraft("s1", "msg-1")).toBeDefined();
    expect(localStorage.getItem(draftKey("s1", MAIN_DRAFT_INPUT))).toContain(
      "one",
    );
  });

  it("removes the draft when the input is emptied, and on clear", () => {
    saveDraft("s1", MAIN_DRAFT_INPUT, doc([text("hello")]));
    saveDraft("s1", MAIN_DRAFT_INPUT, doc([text("   ")]));
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)).toBeUndefined();

    saveDraft("s1", MAIN_DRAFT_INPUT, doc([text("hello")]));
    clearDraft("s1", MAIN_DRAFT_INPUT);
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)).toBeUndefined();
  });

  it("never stores a pasted image, and says so", () => {
    const saved = saveDraft(
      "s1",
      MAIN_DRAFT_INPUT,
      doc([text("what is this?"), image()]),
    );
    expect(saved?.droppedImages).toBe(1);
    const raw = localStorage.getItem(draftKey("s1", MAIN_DRAFT_INPUT))!;
    expect(raw).not.toContain("base64");
    expect(restoredDraftNotice(saved!)).toBe(
      "Restored your unsent message. An image in it was not kept; add it again.",
    );
    // An image alone is no draft
    expect(saveDraft("s2", MAIN_DRAFT_INPUT, doc([image()]))).toBeUndefined();
  });

  it("keeps only the text of a draft over the size cap", () => {
    const big = doc(
      [text("Question first")],
      [
        {
          type: "mention",
          attrs: { id: "x", label: "x", content: "y".repeat(DRAFT_MAX_CHARS) },
        },
      ],
    );
    const prepared = prepareDraft(big)!;
    expect(prepared.textOnly).toBe(true);
    expect(JSON.stringify(prepared.content).length).toBeLessThanOrEqual(
      DRAFT_MAX_CHARS,
    );
    expect(JSON.stringify(prepared.content)).toContain("Question first");
    expect(restoredDraftNotice(prepared)).toContain("only its text");
  });

  it("keeps at most DRAFT_MAX_COUNT drafts, dropping the oldest", () => {
    for (let i = 0; i < DRAFT_MAX_COUNT + 3; i++) {
      saveDraft(
        `s${i}`,
        MAIN_DRAFT_INPUT,
        doc([text(`draft ${i}`)]),
        undefined,
        1000 + i,
      );
    }
    const kept = listDrafts().map((d) => d.sessionId);
    expect(kept).toHaveLength(DRAFT_MAX_COUNT);
    expect(kept).not.toContain("s0");
    expect(kept).toContain(`s${DRAFT_MAX_COUNT + 2}`);
  });

  it("drops a draft past its age", () => {
    const now = 10 * DRAFT_MAX_AGE_MS;
    saveDraft(
      "old",
      MAIN_DRAFT_INPUT,
      doc([text("old")]),
      undefined,
      now - DRAFT_MAX_AGE_MS - 1,
    );
    expect(loadDraft("old", MAIN_DRAFT_INPUT, undefined, now)).toBeUndefined();
    pruneDrafts({ now });
    expect(listDrafts()).toHaveLength(0);
  });

  it("drops drafts of deleted sessions", () => {
    saveDraft("gone", MAIN_DRAFT_INPUT, doc([text("a")]));
    saveDraft("gone", "msg-1", doc([text("b")]));
    saveDraft("kept", MAIN_DRAFT_INPUT, doc([text("c")]));
    clearSessionDrafts("gone");
    expect(listDrafts().map((d) => d.sessionId)).toEqual(["kept"]);

    clearDraftsExcept([]);
    expect(listDrafts()).toHaveLength(0);
  });

  it("drops drafts of sessions the history list no longer holds, after a grace period", () => {
    const now = 100 * DRAFT_UNKNOWN_SESSION_GRACE_MS;
    const old = now - DRAFT_UNKNOWN_SESSION_GRACE_MS - 1;
    saveDraft("listed", MAIN_DRAFT_INPUT, doc([text("a")]), undefined, old);
    saveDraft("deleted", MAIN_DRAFT_INPUT, doc([text("b")]), undefined, old);
    // A new session in another window, not saved yet
    saveDraft(
      "fresh",
      MAIN_DRAFT_INPUT,
      doc([text("c")]),
      undefined,
      now - 1000,
    );
    // This window's own new session
    saveDraft("current", MAIN_DRAFT_INPUT, doc([text("d")]), undefined, old);
    pruneDrafts({
      knownSessionIds: ["listed"],
      keepSessionIds: ["current"],
      now,
    });
    expect(
      listDrafts()
        .map((d) => d.sessionId)
        .sort(),
    ).toEqual(["current", "fresh", "listed"]);
  });

  it("drops an unreadable entry and leaves other keys alone", () => {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}bad:main`, "{not json");
    localStorage.setItem("inputHistory_chat", "[]");
    pruneDrafts();
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}bad:main`)).toBeNull();
    expect(localStorage.getItem("inputHistory_chat")).toBe("[]");
  });

  it("makes room when the storage is full", () => {
    saveDraft("a", MAIN_DRAFT_INPUT, doc([text("older")]), undefined, 1);
    const real = Storage.prototype.setItem;
    let failures = 1;
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, k: string, v: string) {
        if (failures-- > 0)
          throw new DOMException("full", "QuotaExceededError");
        return real.call(this, k, v);
      });
    try {
      expect(
        saveDraft("b", MAIN_DRAFT_INPUT, doc([text("newer")]), undefined, 2),
      ).toBeDefined();
    } finally {
      spy.mockRestore();
    }
    expect(listDrafts().map((d) => d.sessionId)).toEqual(["b"]);
  });
});
