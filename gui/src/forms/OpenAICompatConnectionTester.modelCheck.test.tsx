import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { OpenAICompatConnectionTester } from "./OpenAICompatConnectionTester";

function setup(handler: (data: any) => Promise<any>, provider: string) {
  const messenger = new MockIdeMessenger();
  messenger.responseHandlers["openaiCompat/testConnection"] = vi.fn(handler);
  render(
    <IdeMessengerContext.Provider value={messenger}>
      <OpenAICompatConnectionTester
        provider={provider}
        apiKey="sk-test"
        model="gpt-5.5-min"
        canTest
      />
    </IdeMessengerContext.Provider>,
  );
  return messenger.responseHandlers["openaiCompat/testConnection"] as any;
}

describe("OpenAICompatConnectionTester: the configured model id", () => {
  it("asks for the id check on the listing call and shows close matches", async () => {
    const handler = setup(async (data) => {
      if (data.checkModel) {
        return {
          ok: true,
          models: ["gpt-5.5", "gpt-5.5-mini"],
          modelCheck: {
            status: "not-found",
            model: "gpt-5.5-min",
            suggestions: ["gpt-5.5-mini"],
            message:
              'OpenAI does not know a model "gpt-5.5-min" for this key (HTTP 404). Did you mean gpt-5.5-mini?',
          },
        };
      }
      return {
        ok: true,
        models: ["gpt-5.5", "gpt-5.5-mini"],
        probe: { ok: true, label: "Native tool calls", kind: "native" },
      };
    }, "openai");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByTestId("model-check")).toHaveTextContent(
        "Did you mean gpt-5.5-mini?",
      ),
    );
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].checkModel).toBe("gpt-5.5-min");
    expect(handler.mock.calls[1][0].checkModel).toBeUndefined();
    // The connection itself still succeeded
    expect(screen.getByText(/Connected\./)).toBeTruthy();
  });

  it("says a model that could not be checked does not affect chat", async () => {
    setup(
      async () => ({
        ok: true,
        models: [],
        modelCheck: {
          status: "unverified",
          model: "gpt-5.5-min",
          reason: "unsupported",
          message:
            "This endpoint does not report single models (no /models/{id}), so the model id was not checked.",
        },
      }),
      "openai",
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByTestId("model-check")).toHaveTextContent(
        "Chat requests are not affected.",
      ),
    );
  });
});
