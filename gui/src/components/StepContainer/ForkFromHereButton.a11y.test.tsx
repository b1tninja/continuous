import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyForkState,
  history,
  setupForkStore,
} from "../../redux/thunks/forkSession.fixture";
import { renderWithProviders } from "../../util/test/render";
import ResponseActions from "./ResponseActions";

async function setup() {
  const { store, ideMessenger } = setupForkStore();
  const view = await renderWithProviders(
    <ResponseActions
      index={2}
      item={history[2]}
      isLast={false}
      isTruncated={false}
      onDelete={() => {}}
      onContinueGeneration={() => {}}
    />,
    { store, mockIdeMessenger: ideMessenger },
  );
  // The render loads its own config; put the fixture's back
  await act(async () => applyForkState(store));
  return { store, view };
}

describe("Fork from here: assistive technology", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is a button named for what it does", async () => {
    await setup();
    expect(screen.getByRole("button", { name: "Fork from here" })).toBeTruthy();
  });

  it("can be reached with the keyboard", async () => {
    await setup();
    const button = screen.getByRole("button", { name: "Fork from here" });
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute("type")).toBe("button");
  });

  it("describes the cost once focused, as the tooltip does", async () => {
    await setup();
    const button = screen.getByRole("button", { name: "Fork from here" });
    act(() => button.focus());
    await waitFor(() =>
      expect(button.getAttribute("aria-describedby")).toBeTruthy(),
    );
    const description = document.getElementById(
      button.getAttribute("aria-describedby")!,
    );
    // Auto is on the 1-hour lifetime here (escalated), so writes are $8/M
    expect(description?.textContent).toMatch(
      /^Fork re-reads 61k tokens ≈ \$0\.49; within the cache window \(\d+ min left\) ≈ \$0\.01 \(estimate/,
    );
    // The name stays short: the cost is a description, not part of the name
    expect(button.getAttribute("aria-label")).toBe("Fork from here");
  });

  it("forks when activated from the keyboard", async () => {
    const { store, view } = await setup();
    const button = screen.getByRole("button", { name: "Fork from here" });
    act(() => button.focus());
    await view.user.keyboard("{Enter}");
    await waitFor(() =>
      expect(store.getState().session.forkedFrom).toEqual({
        sessionId: "parent",
        index: 2,
      }),
    );
  });

  it("is disabled while a response is streaming", async () => {
    const { store } = await setup();
    act(() => {
      store.dispatch({ type: "session/setActive" });
    });
    const button = screen.getByRole("button", { name: "Fork from here" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(store.getState().session.id).toBe("parent");
  });
});
