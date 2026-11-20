import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { OpenAICompatConnectionTester } from "./OpenAICompatConnectionTester";

function setup(
  handler: (data: any) => Promise<any>,
  onUseContextLength?: (n: number) => void,
) {
  const messenger = new MockIdeMessenger();
  messenger.responseHandlers["openaiCompat/testConnection"] = vi.fn(handler);
  render(
    <IdeMessengerContext.Provider value={messenger}>
      <OpenAICompatConnectionTester
        provider="openai"
        apiBase="http://localhost:8000/v1"
        model="qwen"
        canTest
        onUseContextLength={onUseContextLength}
      />
    </IdeMessengerContext.Provider>,
  );
}

const listing = (limits?: object) => async (data: any) =>
  data.checkModel
    ? {
        ok: true,
        models: ["qwen"],
        ...(limits ? { listedLimits: limits } : {}),
      }
    : {
        ok: true,
        models: ["qwen"],
        probe: { ok: true, label: "Native tool calls", kind: "native" },
      };

describe("OpenAICompatConnectionTester: the window the server reports", () => {
  it("shows the server's sentence and fills the context length on request", async () => {
    const use = vi.fn();
    setup(
      listing({
        contextLength: 131072,
        kind: "max",
        note: "The server reports a window of 131,072 tokens for this model.",
      }),
      use,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByTestId("listed-limits")).toHaveTextContent(
        "131,072 tokens",
      ),
    );
    await user.click(screen.getByTestId("use-listed-context"));
    expect(use).toHaveBeenCalledWith(131072);
  });

  it("shows nothing when the server reports no window", async () => {
    setup(listing(), vi.fn());
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByText(/Connected\./)).toBeTruthy());
    expect(screen.queryByTestId("listed-limits")).toBeNull();
  });

  it("offers no button without a place to put the number", async () => {
    setup(
      listing({
        contextLength: 8192,
        kind: "loaded",
        note: "Runs with 8,192.",
      }),
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByTestId("listed-limits")).toBeTruthy(),
    );
    expect(screen.queryByTestId("use-listed-context")).toBeNull();
  });
});
