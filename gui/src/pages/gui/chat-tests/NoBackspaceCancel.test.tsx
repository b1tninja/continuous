import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import { newSession, setActive } from "../../../redux/slices/sessionSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { getElementByTestId } from "../../../util/test/utils";
import { Chat } from "../Chat";

// Ctrl+Backspace (Cmd+Backspace on macOS, Alt+Backspace in JetBrains) deletes
// a word. It must never stop a response or reject a tool call.
const COMBOS = [
  { name: "Ctrl+Backspace", init: { ctrlKey: true } },
  { name: "Cmd+Backspace", init: { metaKey: true } },
  { name: "Alt+Backspace", init: { altKey: true } },
];

async function setup(withPendingToolCall: boolean) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<Chat />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  const input = await getElementByTestId(
    "continue-input-box-main-editor-input",
  );
  await act(async () => {
    store.dispatch(updateConfig({ ...EMPTY_CONFIG }));
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: withPendingToolCall
          ? [
              {
                message: { role: "assistant", content: "" },
                contextItems: [],
                toolCallStates: [
                  {
                    toolCallId: "a",
                    toolCall: {
                      id: "a",
                      type: "function",
                      function: { name: "read_file", arguments: "{}" },
                    },
                    parsedArgs: { filepath: "a.txt" },
                    status: "generated",
                  },
                ],
              },
            ]
          : [],
      } as any),
    );
    if (!withPendingToolCall) store.dispatch(setActive());
  });
  return { store, input };
}

describe("Backspace shortcuts do not cancel", () => {
  for (const { name, init } of COMBOS) {
    it(`${name} does not stop a streaming response and is left to the editor`, async () => {
      const { store, input } = await setup(false);
      expect(store.getState().session.isStreaming).toBe(true);

      let notPrevented = false;
      await act(async () => {
        // fireEvent returns false when preventDefault was called
        notPrevented = fireEvent.keyDown(input, { key: "Backspace", ...init });
        fireEvent.keyDown(window, { key: "Backspace", ...init });
        fireEvent.keyDown(document, { key: "Backspace", ...init });
      });

      expect(store.getState().session.isStreaming).toBe(true);
      // The editor no longer swallows the key while streaming
      expect(notPrevented).toBe(true);
    });

    it(`${name} does not reject a pending tool call`, async () => {
      const { store, input } = await setup(true);
      await act(async () => {
        fireEvent.keyDown(input, { key: "Backspace", ...init });
        fireEvent.keyDown(document, { key: "Backspace", ...init });
      });
      const status =
        store.getState().session.history[0].toolCallStates?.[0].status;
      expect(status).toBe("generated");
    });
  }
});
