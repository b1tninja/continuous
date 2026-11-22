import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import ContinueInputBox from "../ContinueInputBox";

async function setup(isMainInput: boolean) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  return renderWithProviders(
    <ContinueInputBox
      isMainInput={isMainInput}
      isLastUserInput={false}
      onEnter={() => {}}
      editorState={{
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "why does the test fail?" }],
          },
        ],
      }}
      inputId="earlier-message"
    />,
    { store, mockIdeMessenger: ideMessenger },
  );
}

/**
 * An earlier message in the transcript is an editor too. Its toolbar is not
 * mounted until the person goes to edit it: a hidden one in every row was
 * most of what scrolling a row into view cost.
 */
describe("the toolbar of an earlier message", () => {
  it("is not mounted while the message is only shown", async () => {
    const { container } = await setup(false);
    expect(container.textContent).toContain("why does the test fail?");
    expect(screen.queryByTestId("input-toolbar")).toBeNull();
    expect(screen.queryByTestId("submit-input-button")).toBeNull();
  });

  it("is mounted when the message takes focus, and goes when it loses it", async () => {
    const { container } = await setup(false);
    const editor = container.querySelector(".ProseMirror") as HTMLElement;
    await act(async () => {
      fireEvent.focus(editor);
    });
    expect(screen.getByTestId("input-toolbar")).toBeTruthy();
    expect(screen.getByTestId("submit-input-button")).toBeTruthy();
    await act(async () => {
      fireEvent.blur(editor);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.queryByTestId("input-toolbar")).toBeNull();
  });

  it("is always mounted for the main input", async () => {
    await setup(true);
    expect(screen.getByTestId("input-toolbar")).toBeTruthy();
  });
});
