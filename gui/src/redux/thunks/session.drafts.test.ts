import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_UNKNOWN_SESSION_GRACE_MS,
  listDrafts,
  MAIN_DRAFT_INPUT,
  saveDraft,
} from "../../util/drafts";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { deleteSession, refreshSessionMetadata } from "./session";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const meta = (sessionId: string) => ({
  sessionId,
  title: sessionId,
  dateCreated: "1",
  workspaceDirectory: "",
});

function store(currentId = "current") {
  const base = getEmptyRootState();
  return createMockStore({ session: { ...base.session, id: currentId } });
}

beforeEach(() => localStorage.clear());

describe("drafts of deleted sessions", () => {
  it("go when the session is deleted", async () => {
    saveDraft("gone", MAIN_DRAFT_INPUT, doc("a"));
    saveDraft("gone", "msg-1", doc("b"));
    saveDraft("other", MAIN_DRAFT_INPUT, doc("c"));
    const s = store();
    s.mockIdeMessenger.responses["history/delete"] = undefined;
    s.mockIdeMessenger.responses["history/list"] = [meta("other")];
    await s.dispatch(deleteSession("gone") as any);
    expect(listDrafts().map((d) => d.sessionId)).toEqual(["other"]);
  });

  it("go when the full history list no longer holds the session", async () => {
    const old = Date.now() - DRAFT_UNKNOWN_SESSION_GRACE_MS - 1;
    saveDraft("listed", MAIN_DRAFT_INPUT, doc("a"), undefined, old);
    saveDraft("deletedElsewhere", MAIN_DRAFT_INPUT, doc("b"), undefined, old);
    saveDraft("current", MAIN_DRAFT_INPUT, doc("c"), undefined, old);
    const s = store("current");
    s.mockIdeMessenger.responses["history/list"] = [meta("listed")];
    await s.dispatch(refreshSessionMetadata({}) as any);
    expect(
      listDrafts()
        .map((d) => d.sessionId)
        .sort(),
    ).toEqual(["current", "listed"]);
  });

  it("stay when only a page of the list was read", async () => {
    const old = Date.now() - DRAFT_UNKNOWN_SESSION_GRACE_MS - 1;
    saveDraft("older", MAIN_DRAFT_INPUT, doc("a"), undefined, old);
    const s = store();
    s.mockIdeMessenger.responses["history/list"] = [meta("listed")];
    await s.dispatch(refreshSessionMetadata({ limit: 1 }) as any);
    // A full list at core's cap may be cut off as well
    s.mockIdeMessenger.responses["history/list"] = Array.from(
      { length: 100 },
      (_, i) => meta(`s${i}`),
    );
    await s.dispatch(refreshSessionMetadata({}) as any);
    expect(listDrafts().map((d) => d.sessionId)).toEqual(["older"]);
  });
});
