import { Editor, type JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadDraft,
  MAIN_DRAFT_INPUT,
  resetShownDrafts,
  saveDraft,
} from "../../../util/drafts";
import {
  DRAFT_SAVE_DEBOUNCE_MS,
  useDraftPersistence,
} from "./useDraftPersistence";

const editors: Editor[] = [];
function makeEditor(content?: JSONContent) {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text],
    content,
  });
  editors.push(editor);
  return editor;
}
const docOf = (t: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});

type Props = Parameters<typeof useDraftPersistence>[0];
function mount(props: Props) {
  return renderHook((p: Props) => useDraftPersistence(p), {
    initialProps: props,
  });
}
function type(editor: Editor, t: string) {
  act(() => {
    editor.chain().focus("end").insertContent(t).run();
  });
}
function settle() {
  act(() => {
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
  });
}

beforeEach(() => {
  localStorage.clear();
  resetShownDrafts();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  editors.splice(0).forEach((e) => e.destroy());
});

describe("useDraftPersistence", () => {
  const main = (editor: Editor, sessionId: string, empty = false): Props => ({
    editor,
    sessionId,
    inputId: MAIN_DRAFT_INPUT,
    enabled: true,
    isSessionEmpty: empty,
  });

  it("type, reload, and the text is back with a notice", () => {
    const first = makeEditor();
    const view = mount(main(first, "s1"));
    type(first, "a long prompt");
    settle();
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)).toBeDefined();
    view.unmount();

    // The webview reloads: a new page, a new editor, the same session
    resetShownDrafts();
    const second = makeEditor();
    const reloaded = mount(main(second, "s1"));
    expect(second.getText()).toBe("a long prompt");
    expect(reloaded.result.current.notice).toBe(
      "Restored your unsent message.",
    );
    act(() => reloaded.result.current.dismissNotice());
    expect(reloaded.result.current.notice).toBeUndefined();
  });

  it("brings the text back without a notice when the input only remounts (Settings and back)", () => {
    const first = makeEditor();
    const view = mount(main(first, "s1"));
    type(first, "half a thought");
    view.unmount();

    const second = makeEditor();
    const back = mount(main(second, "s1"));
    expect(second.getText()).toBe("half a thought");
    expect(back.result.current.notice).toBeUndefined();
  });

  it("keeps the notice of a restored draft from coming back on a remount", () => {
    saveDraft("s1", MAIN_DRAFT_INPUT, docOf("from before the reload"));
    const first = makeEditor();
    const view = mount(main(first, "s1"));
    expect(view.result.current.notice).toBe("Restored your unsent message.");
    view.unmount();

    const second = makeEditor();
    const back = mount(main(second, "s1"));
    expect(second.getText()).toBe("from before the reload");
    expect(back.result.current.notice).toBeUndefined();
  });

  it("announces a draft met again after switching to another session", () => {
    const editor = makeEditor();
    const view = mount(main(editor, "s1"));
    type(editor, "s1's draft");
    view.rerender(main(editor, "s2"));
    expect(view.result.current.notice).toBeUndefined();

    view.rerender(main(editor, "s1"));
    expect(editor.getText()).toBe("s1's draft");
    expect(view.result.current.notice).toBe("Restored your unsent message.");
  });

  it("announces a draft after a switch even when the input remounts with the session", () => {
    const first = makeEditor();
    const a = mount(main(first, "s1"));
    type(first, "s1's draft");
    a.unmount();
    const other = mount(main(makeEditor(), "s2"));
    other.unmount();

    const again = makeEditor();
    const back = mount(main(again, "s1"));
    expect(again.getText()).toBe("s1's draft");
    expect(back.result.current.notice).toBe("Restored your unsent message.");
  });

  it("saves at once when the page goes away, before the debounce", () => {
    const editor = makeEditor();
    mount(main(editor, "s1"));
    type(editor, "unsaved");
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)).toBeUndefined();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)).toBeDefined();
  });

  it("clears the draft on send", () => {
    const editor = makeEditor();
    const view = mount(main(editor, "s1"));
    type(editor, "send me");
    settle();
    type(editor, "!");
    act(() => view.result.current.clearNow());
    settle();
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)).toBeUndefined();
  });

  it("keeps each session's draft when switching between sessions", () => {
    saveDraft("s2", MAIN_DRAFT_INPUT, docOf("s2's draft"));
    const editor = makeEditor();
    const view = mount(main(editor, "s1"));
    type(editor, "s1's draft");

    view.rerender(main(editor, "s2"));
    expect(editor.getText()).toBe("s2's draft");
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)?.content).toEqual(
      docOf("s1's draft"),
    );

    // A session with messages and no draft opens with an empty input
    view.rerender(main(editor, "s3"));
    expect(editor.getText()).toBe("");
    expect(view.result.current.notice).toBeUndefined();

    view.rerender(main(editor, "s1"));
    expect(editor.getText()).toBe("s1's draft");
  });

  it("takes the text into a new, empty session, and the draft moves", () => {
    const editor = makeEditor();
    const view = mount(main(editor, "s1"));
    type(editor, "actually a new chat");
    view.rerender(main(editor, "new", true));
    expect(editor.getText()).toBe("actually a new chat");
    expect(loadDraft("new", MAIN_DRAFT_INPUT)).toBeDefined();
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)).toBeUndefined();
  });

  it("does not restore over the input when only re-enabled (edit mode ended)", () => {
    saveDraft("s1", MAIN_DRAFT_INPUT, docOf("saved"));
    const editor = makeEditor();
    const view = mount(main(editor, "s1"));
    expect(editor.getText()).toBe("saved");
    view.rerender({ ...main(editor, "s1"), enabled: false });
    act(() => {
      editor.commands.setContent(docOf("edit mode text"));
    });
    settle();
    // Not saved while disabled
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)?.content).toEqual(docOf("saved"));
    act(() => {
      editor.commands.setContent(docOf("back in chat"), { emitUpdate: false });
    });
    view.rerender(main(editor, "s1"));
    expect(editor.getText()).toBe("back in chat");
  });

  it("keeps an edit of an earlier message while it differs from the message", () => {
    const props = (editor: Editor): Props => ({
      editor,
      sessionId: "s1",
      inputId: "msg-1",
      enabled: true,
      isSessionEmpty: false,
    });
    const editor = makeEditor(docOf("original"));
    const view = mount(props(editor));
    type(editor, " plus more");
    settle();
    expect(loadDraft("s1", "msg-1")).toBeDefined();
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)).toBeUndefined();
    view.unmount();

    // Reload: the message renders its own content, and the edit comes back
    resetShownDrafts();
    const again = makeEditor(docOf("original"));
    const reloaded = mount(props(again));
    expect(again.getText()).toBe("original plus more");
    expect(reloaded.result.current.notice).toBeDefined();

    // Back to the message's own text: no draft
    act(() => {
      again.commands.setContent(docOf("original"));
    });
    settle();
    expect(loadDraft("s1", "msg-1")).toBeUndefined();
  });
});
