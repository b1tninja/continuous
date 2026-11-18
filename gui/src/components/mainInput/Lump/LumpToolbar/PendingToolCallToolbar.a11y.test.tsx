import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import {
  EMPTY_CONFIG,
  updateConfig,
} from "../../../../redux/slices/configSlice";
import { newSession } from "../../../../redux/slices/sessionSlice";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { isUserTyping } from "../../../a11y/useApprovalFocus";
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

async function setup(ids: string[], before?: () => void) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<PendingToolCallToolbar />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  before?.();
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
}

describe("PendingToolCallToolbar: assistive technology", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is a labelled group", async () => {
    await setup(["a"]);
    const group = screen.getByRole("group", { name: "Approval needed" });
    expect(group).toBeTruthy();
  });

  it("names the number of commands when there are several", async () => {
    await setup(["a", "b"]);
    expect(
      screen.getByRole("group", { name: "Approval needed for 2 commands" }),
    ).toBeTruthy();
  });

  it("moves focus to the first Accept button when nobody is typing", async () => {
    await setup(["a", "b"]);
    expect(document.activeElement).toBe(
      screen.getByTestId("accept-tool-call-button-a"),
    );
  });

  it("does not take focus from a field that holds text", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    await setup(["a"], () => {
      input.value = "half a sentence";
      input.focus();
    });
    expect(document.activeElement).toBe(input);
  });

  it("documents the shortcuts on the buttons", async () => {
    await setup(["a"]);
    expect(
      screen
        .getByTestId("accept-tool-call-button-a")
        .getAttribute("aria-keyshortcuts"),
    ).toMatch(/\+Enter$/);
    expect(
      screen
        .getByTestId("reject-tool-call-button-a")
        .getAttribute("aria-keyshortcuts"),
    ).toBeNull(); // Backspace deletes a word, so it is not a shortcut
  });
});

describe("isUserTyping", () => {
  it("is true for a keystroke a moment ago and false for an old one", () => {
    expect(isUserTyping(document, 10_000, 9_500)).toBe(true);
    expect(isUserTyping(document, 10_000, 1_000)).toBe(false);
  });

  it("treats an empty focused field as not typing", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(isUserTyping(document, 10_000, 0)).toBe(false);
    input.value = "x";
    expect(isUserTyping(document, 10_000, 0)).toBe(true);
    input.remove();
  });
});
