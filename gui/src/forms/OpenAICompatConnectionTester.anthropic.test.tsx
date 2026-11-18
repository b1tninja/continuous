import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { OpenAICompatConnectionTester } from "./OpenAICompatConnectionTester";

describe("OpenAICompatConnectionTester with Anthropic", () => {
  it("makes one call with the typed model, enables the button with no base, and shows the retirement notice", async () => {
    const handler = vi.fn(async (_data: any): Promise<any> => ({
      ok: true,
      models: ["claude-sonnet-4-5-20250929"],
      retirement: [
        {
          model: "claude-sonnet-4-5-20250929",
          severity: "retiring",
          from: "live",
          message:
            "claude-sonnet-4-5-20250929 is deprecated and retires on 2026-11-30 (19 days). Suggested replacement: claude-sonnet-5-5.",
          key: "k",
        },
      ],
    }));
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["openaiCompat/testConnection"] = handler;
    const user = userEvent.setup();
    render(
      <IdeMessengerContext.Provider value={messenger}>
        <OpenAICompatConnectionTester
          provider="anthropic"
          apiKey="sk-ant-test"
          model="claude-sonnet-4-5-20250929"
          canTest
        />
      </IdeMessengerContext.Provider>,
    );
    const button = screen.getByRole("button", { name: "Test connection" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    await waitFor(() =>
      expect(screen.getByTestId("retirement-notice")).toHaveTextContent(
        "retires on 2026-11-30",
      ),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0] as any[])[0].model).toBe(
      "claude-sonnet-4-5-20250929",
    );
    expect(screen.queryByTestId("tool-calls-result")).toBeNull();
  });
});
