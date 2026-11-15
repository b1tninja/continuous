import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import StreamErrorDialog from "./StreamError";

async function render(message: string) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const rendered = await renderWithProviders(
    <StreamErrorDialog error={new Error(message)} />,
    { store, mockIdeMessenger: ideMessenger },
  );
  return { ...rendered, store };
}

describe("stream error for a conversation longer than the model takes", () => {
  // Seen live on Bedrock with Claude Sonnet 5.5, 2026-11-14
  const BEDROCK =
    "The model returned the following errors: prompt is too long: 1067710 tokens > 1000000 maximum";

  it("says what happened in plain words, with the sizes", async () => {
    await render(BEDROCK);
    const box = screen.getByTestId("context-overflow");
    expect(box.textContent).toContain("The conversation is too long");
    expect(box.textContent).toContain((1067710).toLocaleString());
    expect(box.textContent).toContain((1000000).toLocaleString());
    expect(box.textContent).toContain("Your message is kept");
  });

  it("offers trying again and a new session, not compacting", async () => {
    await render(BEDROCK);
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.getByText("New session")).toBeTruthy();
    expect(screen.queryByText(/compact/i)).toBeNull();
  });

  it("starts a new session when asked", async () => {
    const { user, store } = await render(BEDROCK);
    const before = store.getState().session.id;
    await user.click(screen.getByText("New session"));
    expect(store.getState().session.id).not.toBe(before);
  });

  it("covers an overflow that gives no sizes", async () => {
    await render("ValidationException: Input is too long for requested model.");
    const box = screen.getByTestId("context-overflow");
    expect(box.textContent).toContain("The conversation is too long");
    expect(box.textContent).not.toContain("the limit is");
  });

  it("leaves other errors to the other branches", async () => {
    await render("something went wrong");
    expect(screen.queryByTestId("context-overflow")).toBeNull();
  });
});
