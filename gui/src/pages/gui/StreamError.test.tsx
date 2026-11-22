import { act, screen } from "@testing-library/react";
import type { ModelDescription } from "core";
import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { MissingSecretError } from "core/util/unresolvedSecrets";
import { setupStore } from "../../redux/store";
import { addAndSelectChatModel } from "../../util/test/config";
import { renderWithProviders } from "../../util/test/render";
import StreamErrorDialog from "./StreamError";

describe("stream error for a key that is not set on this machine", () => {
  it("names the secret and offers the fix, not a generic retry", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    await renderWithProviders(
      <StreamErrorDialog error={new MissingSecretError("Claude", ["AK"])} />,
      { store, mockIdeMessenger: ideMessenger },
    );

    expect(screen.getByTestId("missing-secret-error")).toBeTruthy();
    expect(screen.getByTestId("open-env-AK")).toBeTruthy();
    expect(screen.queryByText("Resubmit last message")).toBeNull();
  });

  it("shows the normal dialog for any other error", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    await renderWithProviders(
      <StreamErrorDialog error={new Error("something went wrong")} />,
      { store, mockIdeMessenger: ideMessenger },
    );
    expect(screen.queryByTestId("missing-secret-error")).toBeNull();
  });
});

describe("stream error for a failure that should pass", () => {
  async function render(error: Error) {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    return renderWithProviders(<StreamErrorDialog error={error} />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
  }

  it("says the message is kept and counts down to trying again, which can be cancelled", async () => {
    const { user } = await render(
      new Error(
        "The connection closed before the response arrived (tried 1 times). Check your network or proxy and resubmit. (Request timed out.)",
      ),
    );
    expect(screen.getByTestId("transient-failure").textContent).toContain(
      "Your message is kept",
    );
    expect(screen.getByTestId("retry-countdown").textContent).toContain(
      "Trying again in 15 s",
    );
    expect(screen.getByText("Try again now")).toBeTruthy();
    expect(screen.getByText("Change model")).toBeTruthy();
    await user.click(screen.getByText("Cancel"));
    expect(screen.getByTestId("retry-cancelled")).toBeTruthy();
    const opened = vi.fn();
    window.addEventListener("continuous:openModelSelect", opened);
    await user.click(screen.getByText("Change model"));
    await new Promise((r) => setTimeout(r, 10));
    expect(opened).toHaveBeenCalled();
    window.removeEventListener("continuous:openModelSelect", opened);
  });

  it("does not wait on its own for an hour; it says how long the server asked for", async () => {
    await render(
      new Error(
        "The server asked to wait 3600 s before trying again (rate limit or overload), longer than Continuous waits on its own.",
      ),
    );
    expect(screen.getByTestId("transient-failure").textContent).toContain(
      "asked to wait 1 h",
    );
    expect(screen.queryByTestId("retry-countdown")).toBeNull();
  });

  it("waits for the network when the computer is offline", async () => {
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      await render(new Error("fetch failed"));
      expect(screen.getByTestId("retry-countdown").textContent).toContain(
        "offline",
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("stream error for a local server that cannot be reached", () => {
  async function render(error: Error, model: ModelDescription) {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    const rendered = await renderWithProviders(
      <StreamErrorDialog error={error} />,
      { store, mockIdeMessenger: ideMessenger },
    );
    await act(async () => {
      addAndSelectChatModel(store, ideMessenger, model);
    });
    return rendered;
  }

  const cases: [string, ModelDescription, string][] = [
    [
      "Ollama on a LAN address",
      {
        title: "Qwen",
        model: "qwen3:8b",
        provider: "ollama",
        underlyingProviderName: "ollama",
        apiBase: "http://192.168.1.50:11434",
      },
      "Could not reach Ollama at 192.168.1.50:11434. The connection failed. Check that the server is running, that the port is right, and that it listens on this address.",
    ],
    [
      "llama.cpp on port 8080",
      {
        title: "Local",
        model: "qwen",
        provider: "llama.cpp",
        underlyingProviderName: "llama.cpp",
        apiBase: "http://127.0.0.1:8080/",
      },
      "Could not reach llama.cpp at 127.0.0.1:8080. The connection failed. Check that the server is running, that the port is right, and that it listens on this address.",
    ],
    [
      "LM Studio on port 1234",
      {
        title: "Studio",
        model: "qwen",
        provider: "lmstudio",
        underlyingProviderName: "lmstudio",
        apiBase: "http://localhost:1234/v1/",
      },
      "Could not reach LM Studio at localhost:1234. The connection failed. Check that the server is running, that the port is right, and that it listens on this address.",
    ],
  ];

  it.each(cases)(
    "%s: 'fetch failed' is shown with the host and port",
    async (_name, model, sentence) => {
      await render(new Error("fetch failed"), model);
      const shown = screen.getByTestId("transient-failure").textContent ?? "";
      expect(shown).toContain(sentence);
      expect(shown).toContain("Your message is kept");
      expect(screen.getByText("Try again now")).toBeTruthy();
    },
  );

  it("shows the sentence core wrote as it is", async () => {
    const sentence =
      "Could not reach Ollama at 192.168.1.50:11434. The connection was refused. Check that the server is running, that the port is right, and that it listens on this address. To start Ollama, run `ollama serve` on that machine.";
    await render(new Error(sentence), cases[0][1]);
    expect(screen.getByTestId("transient-failure").textContent).toContain(
      sentence,
    );
  });

  it("keeps the general sentence for a hosted model", async () => {
    await render(new Error("fetch failed"), {
      title: "GPT",
      model: "gpt-4o",
      provider: "openai",
      underlyingProviderName: "openai",
    });
    const shown = screen.getByTestId("transient-failure").textContent ?? "";
    expect(shown).toContain("The connection to GPT failed");
    expect(shown).not.toContain("Could not reach");
  });
});
