import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { OpenAICompatConnectionTester } from "./OpenAICompatConnectionTester";

const found = async (data: any) =>
  data.checkModel
    ? {
        ok: true,
        models: ["qwen"],
        listedLimits: {
          contextLength: 131072,
          kind: "max",
          note: "The server reports a window of 131,072 tokens for this model.",
        },
      }
    : {
        ok: true,
        models: ["qwen"],
        probe: {
          ok: true,
          label: "Tool calls: written as text (qwen-xml)",
          kind: "text",
          recoveryDialect: "qwen-xml",
        },
      };

function setup(current: object, onApply = vi.fn()) {
  const messenger = new MockIdeMessenger();
  messenger.responseHandlers["openaiCompat/testConnection"] = found as any;
  render(
    <IdeMessengerContext.Provider value={messenger}>
      <OpenAICompatConnectionTester
        provider="openai"
        apiBase="http://localhost:8000/v1"
        model="qwen"
        canTest
        current={{ tools: "auto", ...current }}
        onApplySuggestions={onApply}
      />
    </IdeMessengerContext.Provider>,
  );
  return onApply;
}

describe("OpenAICompatConnectionTester: Apply all", () => {
  it("lists what the test suggests and applies it together", async () => {
    const onApply = setup({});
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const box = await screen.findByTestId("suggestions");
    expect(box).toHaveTextContent("Context length: 131,072 tokens");
    expect(box).toHaveTextContent("Tool dialect: qwen-xml");
    await user.click(screen.getByTestId("apply-all-suggestions"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].map((s: any) => s.key)).toEqual([
      "contextLength",
      "toolDialect",
    ]);
    expect(screen.getByTestId("suggestions-applied")).toBeTruthy();
    expect(screen.queryByTestId("apply-all-suggestions")).toBeNull();
  });

  it("suggests only what would change the model", async () => {
    setup({ contextLength: 131072 });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Test connection" }));
    const box = await screen.findByTestId("suggestions");
    expect(box).not.toHaveTextContent("Context length");
    expect(box).toHaveTextContent("Tool dialect: qwen-xml");
  });

  it("shows no suggestions when the model already has them", async () => {
    setup({ contextLength: 131072, toolDialect: "qwen-xml" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByText(/Connected\./)).toBeTruthy());
    expect(screen.queryByTestId("suggestions")).toBeNull();
  });

  it("offers it again after a new test", async () => {
    setup({});
    const user = userEvent.setup();
    const test = () =>
      user.click(screen.getByRole("button", { name: "Test connection" }));
    await test();
    await user.click(await screen.findByTestId("apply-all-suggestions"));
    await test();
    expect(await screen.findByTestId("apply-all-suggestions")).toBeTruthy();
  });
});
