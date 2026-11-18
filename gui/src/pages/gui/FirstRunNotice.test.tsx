import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { updateConfig } from "../../redux/slices/configSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { FirstRunNotice } from "./FirstRunNotice";

async function setup(dismissed: boolean) {
  const ideMessenger = new MockIdeMessenger();
  const post = vi.spyOn(ideMessenger, "post");
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<FirstRunNotice />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {});
  if (dismissed) {
    await act(async () => {
      store.dispatch(
        updateConfig({
          ...store.getState().config.config,
          ui: { permissionsIntroDismissed: true },
        }),
      );
    });
  }
  return { post, store };
}

describe("First-run chat notice", () => {
  it("shows one line in the new vocabulary with a link and a 24 px dismiss", async () => {
    await setup(false);
    const note = screen.getByTestId("first-run-notice");
    expect(note.textContent).toContain("locked rules apply first");
    expect(note.textContent).toContain("preset");
    expect(
      screen.getByTestId("first-run-notice-link").getAttribute("href"),
    ).toBe("/config?tab=permissions");
    const dismiss = screen.getByRole("button", {
      name: "Dismiss the first-run tip",
    });
    expect(dismiss.className).toContain("h-6");
    expect(dismiss.className).toContain("min-w-6");
  });

  it("dismissing saves the shared flag and hides the line", async () => {
    const { post, store } = await setup(false);
    fireEvent.click(screen.getByTestId("first-run-notice-dismiss"));
    await act(async () => {});
    expect(post).toHaveBeenCalledWith("config/updateSharedConfig", {
      permissionsIntroDismissed: true,
    });
    expect(store.getState().config.config.ui?.permissionsIntroDismissed).toBe(
      true,
    );
    expect(screen.queryByTestId("first-run-notice")).toBeNull();
  });

  it("never shows once the flag is set", async () => {
    await setup(true);
    expect(screen.queryByTestId("first-run-notice")).toBeNull();
  });
});
