import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { INTERRUPT_CONFIRM_ARM_MS } from "../../../components/InterruptConfirm";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import {
  getMainEditor,
  sendInputWithMockedResponse,
} from "../../../util/test/utils";
import { Chat } from "../Chat";

/*
 * No single key stops a running turn or starts a new chat over running work
 * (NI1, NI8, the owner's rule): the key opens a question, Enter answers it,
 * and the opening key pressed again or held never does.
 */

async function streaming() {
  const rendered = await renderWithProviders(<Chat />);
  const { store, ideMessenger } = rendered;
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });
  ideMessenger.responses["context/getSymbolsForFiles"] = {};
  const release = ideMessenger.holdStream();
  await sendInputWithMockedResponse(ideMessenger, "explain", [
    { role: "assistant", content: "The build starts" },
    { role: "assistant", content: " with the config" },
  ]);
  await waitFor(() =>
    expect(store.getState().session.history.at(-1)?.message.content).toBe(
      "The build starts",
    ),
  );
  expect(store.getState().session.isStreaming).toBe(true);
  const editor = await getMainEditor();
  return { ...rendered, release, editor };
}

const question = () => screen.queryByTestId("interrupt-confirm");

async function pressInEditor(
  editor: Awaited<ReturnType<typeof getMainEditor>>,
  key: string,
  init: KeyboardEventInit = {},
) {
  await act(async () => {
    editor.commands.focus();
    fireEvent.keyDown(editor.view.dom, { key, ...init });
  });
}

async function pressInQuestion(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key,
      ...init,
    });
  });
}

/** Past the moment a key that was already down could still answer. */
async function waitArmed() {
  await act(
    () =>
      new Promise((resolve) =>
        setTimeout(resolve, INTERRUPT_CONFIRM_ARM_MS + 30),
      ),
  );
}

describe("Esc on an empty input while streaming (NI8)", () => {
  it("asks and does not stop; Esc again keeps it going", async () => {
    const { store, editor, release } = await streaming();
    await pressInEditor(editor, "Escape");

    expect(question()).toBeInTheDocument();
    expect(question()).toHaveAttribute("role", "alertdialog");
    expect(question()?.textContent).toContain("Stop the response?");
    // Focus is in the question, so Enter cannot send the input
    expect(question()?.contains(document.activeElement)).toBe(true);
    expect(store.getState().session.isStreaming).toBe(true);

    await pressInQuestion("Escape");
    expect(question()).toBeNull();
    expect(store.getState().session.isStreaming).toBe(true);
    release();
  });

  it("held or pressed again, Esc never stops", async () => {
    const { store, editor, release } = await streaming();
    for (let i = 0; i < 6; i++) {
      await pressInEditor(editor, "Escape", { repeat: i > 0 });
      if (question()) await pressInQuestion("Escape", { repeat: true });
    }
    expect(store.getState().session.isStreaming).toBe(true);
    release();
  });

  it("Enter right away, held or with a modifier does not answer", async () => {
    const { store, editor, release } = await streaming();
    await pressInEditor(editor, "Escape");
    await pressInQuestion("Enter");
    expect(question()).toBeInTheDocument();
    await waitArmed();
    await pressInQuestion("Enter", { repeat: true });
    await pressInQuestion("Enter", { shiftKey: true });
    expect(question()).toBeInTheDocument();
    expect(store.getState().session.isStreaming).toBe(true);
    release();
  });

  it("Enter stops, keeping the partial reply marked stopped, and saves it", async () => {
    const { store, editor, release, ideMessenger } = await streaming();
    const request = vi.spyOn(ideMessenger, "request");
    await pressInEditor(editor, "Escape");
    await waitArmed();
    await pressInQuestion("Enter");
    release();

    await waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(false),
    );
    expect(question()).toBeNull();
    const last = store.getState().session.history.at(-1)!;
    expect(last.message.content).toBe("The build starts");
    expect(last.interrupted).toBe("stopped");
    // On disk too (NI2): a reload reopens it with Resume
    await waitFor(() => {
      const saved = request.mock.calls
        .filter(([type]) => type === "history/save")
        .at(-1)?.[1] as any;
      expect(saved?.history.at(-1)?.interrupted).toBe("stopped");
    });
  });

  it("with text typed, Esc does not ask", async () => {
    const { store, editor, release } = await streaming();
    await act(async () => {
      editor.commands.insertContent("next question");
    });
    await pressInEditor(editor, "Escape");
    expect(question()).toBeNull();
    expect(store.getState().session.isStreaming).toBe(true);
    release();
  });

  it("closes as keep going when the reply ends meanwhile", async () => {
    const { store, editor, release } = await streaming();
    await pressInEditor(editor, "Escape");
    expect(question()).toBeInTheDocument();
    release();
    await waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(false),
    );
    await waitFor(() => expect(question()).toBeNull());
    expect(store.getState().session.history.at(-1)?.interrupted).toBe(
      undefined,
    );
  });
});

describe("the Stop button", () => {
  it("a click stops at once", async () => {
    const { store, user, release } = await streaming();
    await user.click(screen.getByRole("button", { name: /^Stop/ }));
    release();
    await waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(false),
    );
    expect(question()).toBeNull();
  });

  it("from the keyboard asks, and the stop keeps the typed draft", async () => {
    const { store, user, editor, release } = await streaming();
    await act(async () => {
      editor.commands.insertContent("my long prompt");
    });
    const stop = screen.getByRole("button", { name: /^Stop/ });
    expect(stop).toHaveAttribute("aria-keyshortcuts", "Escape");
    stop.focus();
    await user.keyboard("{Enter}");
    expect(question()).toBeInTheDocument();
    expect(store.getState().session.isStreaming).toBe(true);

    await waitArmed();
    await pressInQuestion("Enter");
    release();
    await waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(false),
    );
    expect(editor.getText()).toBe("my long prompt");
    expect(store.getState().session.history.at(-1)?.message.content).toBe(
      "The build starts",
    );
  });
});

describe("Ctrl+L and the other session switches (NI1)", () => {
  it("Ctrl+L while streaming asks and does not abort until confirmed", async () => {
    const { store, ideMessenger, release } = await streaming();
    const sessionId = store.getState().session.id;
    const save = vi.spyOn(ideMessenger, "request");

    await act(async () => {
      ideMessenger.mockMessageToWebview(
        "focusContinueInputWithNewSession",
        undefined,
      );
    });
    await waitFor(() => expect(question()).toBeInTheDocument());
    expect(question()?.getAttribute("data-action")).toBe("newSession");
    expect(question()?.textContent).toContain(
      "The agent is still writing its reply.",
    );
    expect(store.getState().session.isStreaming).toBe(true);
    expect(store.getState().session.id).toBe(sessionId);

    // Ctrl+L again does not answer
    await act(async () => {
      ideMessenger.mockMessageToWebview(
        "focusContinueInputWithNewSession",
        undefined,
      );
    });
    expect(store.getState().session.id).toBe(sessionId);
    expect(store.getState().session.isStreaming).toBe(true);

    await waitArmed();
    await pressInQuestion("Enter");
    release();
    await waitFor(() =>
      expect(store.getState().session.id).not.toBe(sessionId),
    );
    expect(store.getState().session.history).toHaveLength(0);
    // The left session was saved with its reply marked stopped, for Resume
    await waitFor(() => {
      const saved = save.mock.calls
        .filter(
          ([type, data]) =>
            type === "history/save" && (data as any)?.sessionId === sessionId,
        )
        .at(-1)?.[1] as any;
      expect(saved?.history.at(-1)?.message.content).toBe("The build starts");
      expect(saved?.history.at(-1)?.interrupted).toBe("stopped");
    });
  });

  it("Keep working leaves the turn and the session alone", async () => {
    const { store, ideMessenger, release } = await streaming();
    const sessionId = store.getState().session.id;
    await act(async () => {
      ideMessenger.mockMessageToWebview("newSession", undefined);
      ideMessenger.mockMessageToWebview(
        "focusContinueInputWithNewSession",
        undefined,
      );
    });
    await waitFor(() => expect(question()).toBeInTheDocument());
    await act(async () => {
      screen.getByTestId("interrupt-confirm-keep").click();
    });
    expect(question()).toBeNull();
    expect(store.getState().session.id).toBe(sessionId);
    expect(store.getState().session.isStreaming).toBe(true);
    release();
  });

  it("idle with an empty input, Ctrl+L starts a new chat without asking", async () => {
    const { store, ideMessenger, release } = await streaming();
    release();
    await waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(false),
    );
    const sessionId = store.getState().session.id;
    await act(async () => {
      ideMessenger.mockMessageToWebview(
        "focusContinueInputWithNewSession",
        undefined,
      );
    });
    await waitFor(() =>
      expect(store.getState().session.id).not.toBe(sessionId),
    );
    expect(question()).toBeNull();
    // The listener focuses the input 20 ms later
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  it("idle with text typed, Ctrl+L starts a new chat and the text goes with it", async () => {
    const { store, ideMessenger, editor, release } = await streaming();
    release();
    await waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(false),
    );
    await act(async () => {
      editor.commands.insertContent("half a thought");
    });
    const sessionId = store.getState().session.id;
    await act(async () => {
      ideMessenger.mockMessageToWebview(
        "focusContinueInputWithNewSession",
        undefined,
      );
    });
    await waitFor(() =>
      expect(store.getState().session.id).not.toBe(sessionId),
    );
    expect(question()).toBeNull();
    // The listener focuses the input 20 ms later
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(editor.getText()).toBe("half a thought");
  });
});
