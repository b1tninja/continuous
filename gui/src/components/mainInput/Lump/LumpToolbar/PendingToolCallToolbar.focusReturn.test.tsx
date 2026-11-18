import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import {
  EMPTY_CONFIG,
  updateConfig,
} from "../../../../redux/slices/configSlice";
import {
  cancelToolCall,
  newSession,
} from "../../../../redux/slices/sessionSlice";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { MainEditorContext } from "../../TipTapEditor/MainEditorProvider";
import { PendingToolCallToolbar } from "./PendingToolCallToolbar";

const call = (id: string) =>
  ({
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name: "run_terminal_command", arguments: "{}" },
    },
    parsedArgs: { command: "npm test" },
    status: "generated",
  }) as any;

/** A stand-in for the chat input: a real focusable element. */
function Harness() {
  const fakeEditor = {
    commands: {
      focus: () => document.getElementById("chat-input")?.focus(),
    },
  } as any;
  return (
    <MainEditorContext.Provider
      value={{
        mainEditor: fakeEditor,
        setMainEditor: () => {},
        inputId: null,
        setInputId: () => {},
        onEnterRef: { current: () => {} },
      }}
    >
      <textarea id="chat-input" aria-label="Chat input" />
      <PendingToolCallToolbar />
    </MainEditorContext.Provider>
  );
}

async function setup(ids: string[]) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<Harness />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(updateConfig({ ...EMPTY_CONFIG }));
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: ids.map(call),
          },
        ],
      } as any),
    );
  });
  return store;
}

describe("PendingToolCallToolbar: focus after an approval resolves", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns focus to the chat input when the last action resolves", async () => {
    const store = await setup(["a"]);
    const accept = screen.getByTestId("accept-tool-call-button-a");
    expect(document.activeElement).toBe(accept);
    await act(async () => {
      store.dispatch(cancelToolCall({ toolCallId: "a" }));
    });
    expect(screen.queryByTestId("pending-tool-call-toolbar")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Chat input"));
  });

  it("moves to the next pending action when one of two resolves", async () => {
    const store = await setup(["a", "b"]);
    expect(document.activeElement).toBe(
      screen.getByTestId("accept-tool-call-button-a"),
    );
    await act(async () => {
      store.dispatch(cancelToolCall({ toolCallId: "a" }));
    });
    expect(document.activeElement).toBe(
      screen.getByTestId("accept-tool-call-button-b"),
    );
  });

  it("leaves focus alone when the person had already moved elsewhere", async () => {
    const store = await setup(["a"]);
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    await act(async () => {
      store.dispatch(cancelToolCall({ toolCallId: "a" }));
    });
    expect(document.activeElement).toBe(other);
  });

  it("does not take focus when it was never in the toolbar", async () => {
    const store = await setup(["a"]);
    fireEvent.blur(screen.getByTestId("accept-tool-call-button-a"));
    (document.activeElement as HTMLElement).blur();
    await act(async () => {
      store.dispatch(cancelToolCall({ toolCallId: "a" }));
    });
    expect(document.activeElement).toBe(document.body);
  });
});
