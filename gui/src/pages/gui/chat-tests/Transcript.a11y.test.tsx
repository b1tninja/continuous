import { act, screen } from "@testing-library/react";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import { newSession } from "../../../redux/slices/sessionSlice";
import { setupStore } from "../../../redux/store";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { renderWithProviders } from "../../../util/test/render";
import { Chat } from "../Chat";

test("the transcript is a labelled region of named articles, with no log role", async () => {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const { container } = await renderWithProviders(<Chat />, {
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
            message: { role: "user", id: "u1", content: "run the tests" },
            contextItems: [],
          },
          {
            message: { role: "assistant", id: "a1", content: "Running them." },
            contextItems: [],
          },
        ],
      } as any),
    );
  });

  const region = screen.getByRole("region", { name: "Conversation" });
  expect(region.querySelector("article[aria-label='You']")).not.toBeNull();
  expect(
    region.querySelector("article[aria-label='Assistant']"),
  ).not.toBeNull();
  expect(container.querySelector("[role=log]")).toBeNull();
  // Nothing in the transcript itself is a live region
  expect(region.querySelector("[aria-live]")).toBeNull();
});
