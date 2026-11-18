import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import { newSession } from "../../../redux/slices/sessionSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { Chat } from "../Chat";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat window in the conversation", () => {
  it("unmounts turns that are far from the viewport and keeps them in the session", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "region" ? 250 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.chatIndex !== undefined ? 120 : 0;
      },
    );

    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    const history = Array.from({ length: 40 }, (_, i) => ({
      message: {
        role: "assistant" as const,
        id: `a${i}`,
        content: `turn-text-${i}`,
      },
      contextItems: [],
    }));
    await renderWithProviders(<Chat />, {
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
          history,
        } as any),
      );
    });

    expect(store.getState().session.history).toHaveLength(40);
    const rows = screen.getAllByTestId("chat-transcript-row");
    expect(rows.length).toBeLessThan(40);
    expect(screen.getByText(/turn-text-39/)).toBeTruthy();
    expect(screen.queryByText(/turn-text-0/)).toBeNull();

    const region = screen.getByRole("region", { name: "Conversation" });
    Object.defineProperty(region, "scrollHeight", {
      configurable: true,
      get: () => 20000,
    });
    await act(async () => {
      region.scrollTop = 4000;
      region.dispatchEvent(new Event("scroll"));
    });
    await act(async () => {
      region.scrollTop = 0;
      region.dispatchEvent(new Event("scroll"));
    });

    expect(store.getState().session.history).toHaveLength(40);
    expect(screen.getByText(/turn-text-0/)).toBeTruthy();
    expect(screen.getAllByTestId("chat-transcript-row").length).toBeLessThan(
      40,
    );
  });
});
