import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ChatHistoryItem } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { newSession } from "../../../redux/slices/sessionSlice";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import { getElementByTestId } from "../../../util/test/utils";
import { Chat } from "../Chat";

/*
 * A session file is loaded as it is, so its history can hold a `system` item
 * (nothing in the GUI writes one). The transcript leaves it out, and the rows
 * after it must still act on their own place in the history.
 */

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const item = (
  id: string,
  role: "user" | "assistant" | "system" | "thinking",
  content: string,
): ChatHistoryItem => ({
  message: { id, role, content } as ChatHistoryItem["message"],
  contextItems: [],
  ...(role === "user" && { editorState: doc(content) }),
});

const ids = (history: { message: { id?: string } }[]) =>
  history.map((h) => h.message.id);

async function setup(history: ChatHistoryItem[]) {
  const rendered = await renderWithProviders(<Chat />);
  const { store, ideMessenger } = rendered;
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });
  ideMessenger.responses["context/getSymbolsForFiles"] = {};
  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "with-system",
        title: "t",
        workspaceDirectory: "",
        history,
      }),
    );
  });
  return rendered;
}

/** The Delete button of the row that shows `text`. */
async function deleteButtonOf(text: string) {
  const shown = await screen.findByText(text);
  const row = shown.closest(".thread-message") as HTMLElement;
  const button = row.querySelector('[data-testid^="delete-button-"]');
  expect(button).not.toBeNull();
  return button as HTMLElement;
}

test("a loaded session keeps its system item in the history and out of the transcript", async () => {
  const { store } = await setup([
    item("u1", "user", "question 1"),
    item("sys", "system", "a system note"),
    item("a1", "assistant", "answer 1."),
  ]);
  expect(ids(store.getState().session.history)).toEqual(["u1", "sys", "a1"]);
  await screen.findByText("answer 1.");
  expect(screen.queryByText("a system note")).toBeNull();
});

test("Delete on the third shown row removes that reply, with a system item at position 1", async () => {
  const { store } = await setup([
    item("u1", "user", "question 1"),
    item("sys", "system", "a system note"),
    item("t1", "thinking", "some thinking."),
    item("a1", "assistant", "answer 1."),
  ]);

  await act(async () => {
    (await deleteButtonOf("answer 1.")).click();
  });

  // The reply goes with the item before it, as Delete always does
  expect(ids(store.getState().session.history)).toEqual(["u1", "sys"]);
});

test("Delete on a later reply removes that exchange, not the one before it", async () => {
  const { store } = await setup([
    item("u1", "user", "question 1"),
    item("sys", "system", "a system note"),
    item("a1", "assistant", "answer 1."),
    item("u2", "user", "question 2"),
    item("a2", "assistant", "answer 2."),
  ]);

  await act(async () => {
    (await deleteButtonOf("answer 2.")).click();
  });

  expect(ids(store.getState().session.history)).toEqual(["u1", "sys", "a1"]);
});

test("the last row is still the last one when a system item comes before it", async () => {
  await setup([
    item("u1", "user", "question 1"),
    item("sys", "system", "a system note"),
    item("a1", "assistant", "answer 1."),
  ]);
  const last = (await screen.findByText("answer 1.")).closest("article")!;
  expect(last.style.minHeight).toBe("200px");
});

test("editing a message after a system item replaces that message", async () => {
  const { store, ideMessenger } = await setup([
    item("u1", "user", "question 1"),
    item("sys", "system", "a system note"),
    item("a1", "assistant", "answer 1."),
    item("u2", "user", "question 2"),
    item("a2", "assistant", "answer 2."),
  ]);
  ideMessenger.chatResponse = [{ role: "assistant", content: "new answer." }];

  const element = await getElementByTestId("editor-input-u2");
  const editor = (element as any).editor;
  await act(async () => {
    editor.commands.setContent(doc("question 2, rephrased"));
    editor.commands.focus();
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
  });

  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  const history = store.getState().session.history;
  expect(history.map((h) => renderChatMessage(h.message))).toEqual([
    "question 1",
    "a system note",
    "answer 1.",
    "question 2, rephrased",
    "new answer.",
  ]);
});
