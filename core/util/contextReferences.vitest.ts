import { describe, expect, it } from "vitest";
import type { ChatHistoryItem, ContextItemWithId } from "..";
import {
  attachmentKey,
  contentHash,
  repeatedAttachmentStub,
  sendAttachmentsOnce,
  sessionAttachments,
} from "./contextReferences";

function file(
  path: string,
  content: string,
  name = path.split("/").pop()!,
): ContextItemWithId {
  return {
    id: { providerTitle: "file", itemId: path },
    name,
    description: path,
    content,
    uri: { type: "file", value: `file:///w/${path}` },
  };
}

const user = (
  text: string,
  contextItems: ContextItemWithId[] = [],
): ChatHistoryItem => ({
  message: { role: "user", content: text },
  contextItems,
});
const assistant = (text: string): ChatHistoryItem => ({
  message: { role: "assistant", content: text },
  contextItems: [],
});

const sent = (history: ChatHistoryItem[]) =>
  history.flatMap((h) => h.contextItems.map((c) => c.content));

describe("sendAttachmentsOnce", () => {
  it("sends a file attached twice once, with a stub the second time", () => {
    const readme = file("README.md", "# Title\nbody");
    const out = sendAttachmentsOnce([
      user("look", [readme]),
      assistant("ok"),
      user("and again", [readme]),
    ]);
    expect(sent(out)).toEqual([
      "# Title\nbody",
      repeatedAttachmentStub(readme),
    ]);
    expect(repeatedAttachmentStub(readme)).toBe(
      "[README.md: the same content as attached earlier in this conversation]",
    );
  });

  it("leaves the first copy as the same object, so the cached prefix is unchanged", () => {
    const first = user("look", [file("a.ts", "x")]);
    const out = sendAttachmentsOnce([
      first,
      user("again", [file("a.ts", "x")]),
    ]);
    expect(out[0]).toBe(first);
  });

  it("sends a changed file in full: a new version", () => {
    const out = sendAttachmentsOnce([
      user("v1", [file("a.ts", "const a = 1;")]),
      user("v2", [file("a.ts", "const a = 2;")]),
    ]);
    expect(sent(out)).toEqual(["const a = 1;", "const a = 2;"]);
  });

  it("goes back to a version sent earlier as a stub", () => {
    const out = sendAttachmentsOnce([
      user("1", [file("a.ts", "one")]),
      user("2", [file("a.ts", "two")]),
      user("3", [file("a.ts", "one")]),
    ]);
    expect(sent(out)[2]).toContain("the same content as attached earlier");
  });

  it("keeps two different files with the same content", () => {
    const out = sendAttachmentsOnce([
      user("both", [
        file("a/index.ts", "export {}"),
        file("b/index.ts", "export {}"),
      ]),
    ]);
    expect(sent(out)).toEqual(["export {}", "export {}"]);
  });

  it("dedupes within one message too", () => {
    const out = sendAttachmentsOnce([
      user("twice", [file("a.ts", "x"), file("a.ts", "x")]),
    ]);
    expect(sent(out)[1]).toContain("the same content");
  });

  it("does not count a removed copy: the next one is sent in full", () => {
    // withRemovedParts runs first and stubs a removed copy's content
    const removed = {
      ...file("a.ts", "x"),
      content: "[attached a.ts removed by you]",
    };
    const out = sendAttachmentsOnce([
      user("1", [removed]),
      user("2", [file("a.ts", "x")]),
    ]);
    expect(sent(out)).toEqual(["[attached a.ts removed by you]", "x"]);
  });

  it("ignores empty attachments and other roles", () => {
    const empty = file("e.ts", "   ");
    const history = [user("1", [empty]), assistant("a"), user("2", [empty])];
    expect(sendAttachmentsOnce(history)).toBe(history);
  });

  it("returns the same array when nothing repeats", () => {
    const history = [
      user("1", [file("a.ts", "x")]),
      user("2", [file("b.ts", "y")]),
    ];
    expect(sendAttachmentsOnce(history)).toBe(history);
    expect(sendAttachmentsOnce([])).toEqual([]);
  });

  it("keeps the uri and name on a stub, for rules that match by file", () => {
    const out = sendAttachmentsOnce([
      user("1", [file("a.ts", "x")]),
      user("2", [file("a.ts", "x")]),
    ]);
    expect(out[1].contextItems[0]).toMatchObject({
      name: "a.ts",
      uri: { type: "file", value: "file:///w/a.ts" },
    });
  });
});

describe("sessionAttachments", () => {
  it("lists each source once, newest first, with its counts", () => {
    const list = sessionAttachments([
      user("1", [file("a.ts", "one"), file("README.md", "r")]),
      assistant("ok"),
      user("2", [file("a.ts", "one")]),
      user("3", [file("a.ts", "two!")]),
    ]);
    expect(list.map((a) => a.name)).toEqual(["a.ts", "README.md"]);
    expect(list[0]).toMatchObject({
      versions: 2,
      timesAttached: 3,
      timesSentInFull: 2,
      chars: 4,
      lastAttachedAt: 3,
      uri: { type: "file", value: "file:///w/a.ts" },
    });
    expect(list[1]).toMatchObject({
      versions: 1,
      timesAttached: 1,
      timesSentInFull: 1,
      lastAttachedAt: 0,
    });
  });

  it("agrees with sendAttachmentsOnce on what was sent in full", () => {
    const history = [
      user("1", [file("a.ts", "x")]),
      user("2", [file("a.ts", "x"), file("a.ts", "x")]),
    ];
    const fullCopies = sendAttachmentsOnce(history)
      .flatMap((h) => h.contextItems)
      .filter((c) => c.content === "x").length;
    expect(sessionAttachments(history)[0].timesSentInFull).toBe(fullCopies);
  });

  it("is empty for a history without attachments", () => {
    expect(sessionAttachments([user("hi"), assistant("ok")])).toEqual([]);
    expect(sessionAttachments([])).toEqual([]);
  });

  it("skips empty attachments", () => {
    expect(sessionAttachments([user("1", [file("e.ts", "  ")])])).toEqual([]);
  });
});

describe("attachmentKey and contentHash", () => {
  it("is the same for the same source and content, and differs otherwise", () => {
    expect(attachmentKey(file("a.ts", "x"))).toBe(
      attachmentKey(file("a.ts", "x")),
    );
    expect(attachmentKey(file("a.ts", "x"))).not.toBe(
      attachmentKey(file("a.ts", "y")),
    );
    expect(attachmentKey(file("a.ts", "x"))).not.toBe(
      attachmentKey(file("b.ts", "x")),
    );
  });

  it("is undefined for empty content", () => {
    expect(attachmentKey(file("a.ts", ""))).toBeUndefined();
  });

  it("hashes to 8 hex digits, stable across calls", () => {
    expect(contentHash("hello")).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("hellp"));
    expect(contentHash("")).toBe("811c9dc5");
  });
});
