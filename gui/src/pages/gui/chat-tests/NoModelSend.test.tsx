import { act, fireEvent, screen } from "@testing-library/react";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import { getMainEditor } from "../../../util/test/utils";
import { Chat } from "../Chat";

/*
 * Sending with no chat model: nothing can be sent, so a line above the input
 * says so and offers to add a model, and the typed message stays in the box.
 */

async function typeAndPressEnter(text: string) {
  const editor = await getMainEditor();
  await act(async () => {
    editor.commands.insertContent(text);
    editor.commands.focus();
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
  });
  return editor;
}

test("Enter with no model says so, offers Add a model, and keeps the text", async () => {
  const { store } = await renderWithProviders(<Chat />);
  expect(store.getState().config.config.selectedModelByRole.chat).toBeNull();
  expect(screen.queryByTestId("no-model-notice")).toBeNull();

  const editor = await typeAndPressEnter("why is the build red");

  const notice = await screen.findByTestId("no-model-notice");
  expect(notice.textContent).toContain(
    "No chat model is selected, so nothing was sent.",
  );
  const add = screen.getByTestId("no-model-notice-add");
  expect(add.tagName).toBe("BUTTON");
  expect(add.textContent).toBe("Add a model");

  expect(editor.getText()).toBe("why is the build red");
  expect(store.getState().session.history).toHaveLength(0);
  expect(store.getState().session.isStreaming).toBe(false);
});

test("Add a model opens the provider setup", async () => {
  const { store } = await renderWithProviders(<Chat />);
  await typeAndPressEnter("hello");
  expect(store.getState().ui.showDialog).toBe(false);

  await act(async () => {
    (await screen.findByTestId("no-model-notice-add")).click();
  });

  expect(store.getState().ui.showDialog).toBe(true);
  expect(store.getState().ui.dialogMessage).toBeTruthy();
});

test("the line goes once a model is selected, and Dismiss hides it", async () => {
  const { store, ideMessenger } = await renderWithProviders(<Chat />);
  await typeAndPressEnter("hello");
  await act(async () => {
    (await screen.findByTestId("no-model-notice-dismiss")).click();
  });
  expect(screen.queryByTestId("no-model-notice")).toBeNull();

  const editor = await getMainEditor();
  await act(async () => {
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
  });
  await screen.findByTestId("no-model-notice");

  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });
  expect(screen.queryByTestId("no-model-notice")).toBeNull();
});

test("with a model, Enter sends and no line appears", async () => {
  const { store, ideMessenger } = await renderWithProviders(<Chat />);
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });
  ideMessenger.chatResponse = [{ role: "assistant", content: "ok." }];
  await typeAndPressEnter("hello");
  await screen.findByText("ok.");
  expect(screen.queryByTestId("no-model-notice")).toBeNull();
});
