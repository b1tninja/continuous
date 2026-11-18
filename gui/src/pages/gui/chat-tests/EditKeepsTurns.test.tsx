import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ChatHistoryItem, Session } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { newSession } from "../../../redux/slices/sessionSlice";
import {
  BEFORE_EDIT_SUFFIX,
  UNDONE_EDIT_SUFFIX,
} from "../../../redux/thunks/editCopy";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import { getElementByTestId } from "../../../util/test/utils";
import { Chat } from "../Chat";

/*
 * Editing an earlier message keeps what it replaces (NI7): the conversation
 * before the edit is saved as a session of its own, an undo line follows the
 * edit, and Undo brings the conversation back.
 */

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** Ten messages: five questions, each with its answer. */
function tenMessages(): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [];
  for (let i = 1; i <= 5; i++) {
    items.push({
      message: {
        id: `u${i}`,
        role: "user",
        content: `question ${i}`,
      } as ChatHistoryItem["message"],
      contextItems: [],
      editorState: doc(`question ${i}`),
    });
    items.push({
      message: {
        id: `a${i}`,
        role: "assistant",
        content: `answer ${i}`,
      } as ChatHistoryItem["message"],
      contextItems: [],
    });
  }
  return items;
}

/** The messages' text, whatever shape their content has. */
const texts = (items: ChatHistoryItem[]) =>
  items.map((h) => renderChatMessage(h.message));

const savesOf = (spy: ReturnType<typeof vi.spyOn>, sessionId: string) =>
  spy.mock.calls
    .filter(
      ([type, data]: unknown[]) =>
        type === "history/save" && (data as Session).sessionId === sessionId,
    )
    .map(([, data]: unknown[]) => data as Session);

async function setup() {
  const rendered = await renderWithProviders(<Chat />);
  const { store, ideMessenger } = rendered;
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });
  ideMessenger.responses["context/getSymbolsForFiles"] = {};
  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "original",
        title: "Build question",
        workspaceDirectory: "",
        history: tenMessages(),
      }),
    );
  });
  const request = vi.spyOn(ideMessenger, "request");
  return { ...rendered, request };
}

/** Edit message `n` (1-based) to `text` and send it, as Enter in its input does. */
async function editMessage(n: number, text: string) {
  const id = `u${(n + 1) / 2}`;
  const element = await getElementByTestId(`editor-input-${id}`);
  const editor = (element as any).editor;
  await act(async () => {
    editor.commands.setContent(doc(text));
    editor.commands.focus();
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
  });
}

test("editing message 3 of 10 keeps all ten in a copy and shows an undo line", async () => {
  const { store, ideMessenger, request } = await setup();
  ideMessenger.chatResponse = [{ role: "assistant", content: "new answer" }];

  await editMessage(3, "question 2, rephrased");

  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  // The open session is the edited conversation
  const history = store.getState().session.history;
  expect(texts(history)).toEqual([
    "question 1",
    "answer 1",
    "question 2, rephrased",
    "new answer",
  ]);

  // The copy: every message from before the edit, a fork of this session
  const undo = store.getState().session.editUndo!;
  expect(undo.replaced).toBe(8);
  expect(undo.copyTitle).toBe(`Build question${BEFORE_EDIT_SUFFIX}`);
  const copy = savesOf(request, undo.copySessionId)[0];
  expect(copy.title).toBe(`Build question${BEFORE_EDIT_SUFFIX}`);
  expect(copy.forkedFrom).toEqual({ sessionId: "original" });
  expect(texts(copy.history)).toEqual(texts(tenMessages()));
  // The 7 messages after the edited one are among them
  expect(copy.history.slice(3)).toHaveLength(7);

  const line = await screen.findByTestId("edit-undo-line");
  expect(line.textContent).toContain(
    `Edited. The 8 messages are kept in "Build question${BEFORE_EDIT_SUFFIX}".`,
  );
  expect(screen.getByTestId("edit-undo-view")).toBeInTheDocument();
});

test("Undo brings the conversation back, and the copy keeps the edited version", async () => {
  const { store, ideMessenger, request } = await setup();
  ideMessenger.chatResponse = [{ role: "assistant", content: "new answer" }];
  await editMessage(3, "question 2, rephrased");
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  const { copySessionId } = store.getState().session.editUndo!;

  await act(async () => {
    (await screen.findByTestId("edit-undo")).click();
  });

  await waitFor(() =>
    expect(texts(store.getState().session.history)).toEqual(
      texts(tenMessages()),
    ),
  );
  expect(store.getState().session.id).toBe("original");
  expect(store.getState().session.editUndo).toBeUndefined();
  expect(screen.queryByTestId("edit-undo-line")).toBeNull();

  // Nothing is lost either way: the copy now holds the edited conversation
  await waitFor(() => {
    const latest = savesOf(request, copySessionId).at(-1)!;
    expect(latest.title).toBe(`Build question${UNDONE_EDIT_SUFFIX}`);
    expect(texts(latest.history)).toEqual([
      "question 1",
      "answer 1",
      "question 2, rephrased",
      "new answer",
    ]);
  });
  // And the open session was saved restored
  await waitFor(() =>
    expect(savesOf(request, "original").at(-1)?.history).toHaveLength(10),
  );
});

test("the next message ends the undo line", async () => {
  const { store, ideMessenger } = await setup();
  ideMessenger.chatResponse = [{ role: "assistant", content: "new answer" }];
  await editMessage(3, "question 2, rephrased");
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  expect(await screen.findByTestId("edit-undo-line")).toBeInTheDocument();

  const main = await getElementByTestId("editor-input-main");
  const editor = (main as any).editor;
  await act(async () => {
    editor.commands.setContent(doc("and another thing"));
    editor.commands.focus();
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
  });
  await waitFor(() =>
    expect(screen.queryByTestId("edit-undo-line")).toBeNull(),
  );
  expect(store.getState().session.editUndo).toBeUndefined();
});

test("when the copy cannot be saved, the line says so and Undo still works", async () => {
  const { store, ideMessenger } = await setup();
  ideMessenger.chatResponse = [{ role: "assistant", content: "new answer" }];
  const original = ideMessenger.request.bind(ideMessenger);
  vi.spyOn(ideMessenger, "request").mockImplementation((async (
    type: string,
    data: any,
  ) => {
    if (type === "history/save" && data?.sessionId !== "original") {
      return { status: "error", error: "disk full", done: true };
    }
    return original(type as any, data);
  }) as any);

  await editMessage(3, "question 2, rephrased");
  const line = await screen.findByTestId("edit-undo-line");
  await waitFor(() =>
    expect(line.textContent).toContain(
      "could not be saved to History; Undo still brings them back",
    ),
  );
  expect(screen.queryByTestId("edit-undo-view")).toBeNull();
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  await act(async () => {
    screen.getByTestId("edit-undo").click();
  });
  await waitFor(() =>
    expect(store.getState().session.history).toHaveLength(10),
  );
});
