import { screen, waitFor, within } from "@testing-library/react";
import { OnboardingModes } from "core/protocol/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setOnboardingCard } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { OnboardingCard } from "./OnboardingCard";

function messengerWith(installed: string[] | undefined = ["llama3.1:8b"]) {
  const m = new MockIdeMessenger();
  const requested: string[] = [];
  m.responseHandlers["llm/listModels"] = async () => {
    requested.push("llm/listModels");
    return installed;
  };
  return { m, requested };
}

async function renderLocal(m: MockIdeMessenger) {
  const store = setupStore({ ideMessenger: m });
  store.dispatch(
    setOnboardingCard({ show: true, activeTab: OnboardingModes.LOCAL }),
  );
  const view = await renderWithProviders(<OnboardingCard />, {
    mockIdeMessenger: m,
    store,
  });
  return { ...view, store };
}

const completeCall = (post: { mock: { calls: unknown[][] } }) =>
  post.mock.calls.find(([t]) => t === "onboarding/complete");

describe("Onboarding Local tab: Configure model", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  it("keeps the default suggestion and shows both buttons, primary first", async () => {
    const { m } = messengerWith(undefined);
    await renderLocal(m);
    expect(screen.getByText("ollama pull llama3.1:8b")).toBeTruthy();
    expect(
      screen.getByText("ollama pull qwen2.5-coder:1.5b-base"),
    ).toBeTruthy();
    expect(
      screen.getByText("ollama pull nomic-embed-text:latest"),
    ).toBeTruthy();
    const buttons = screen
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => t === "Connect" || t === "Configure model");
    expect(buttons).toEqual(["Connect", "Configure model"]);
    expect(screen.queryByTestId("local-model-chooser")).toBeNull();
  });

  it("opens the chooser with provider and model controls, and makes no network call", async () => {
    const { m, requested } = messengerWith();
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));

    const chooser = screen.getByTestId("local-model-chooser");
    const provider = within(chooser).getByLabelText("Provider");
    expect(
      Array.from((provider as HTMLSelectElement).options).map(
        (o) => o.textContent,
      ),
    ).toEqual([
      "Ollama (default)",
      "LM Studio",
      "llama.cpp",
      "vLLM",
      "OpenAI-compatible server",
    ]);
    expect(within(chooser).getByLabelText("Or any other model")).toBeTruthy();
    expect(
      within(chooser).getByRole("button", {
        name: "Choose another provider (cloud or API key)",
      }),
    ).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(new Set(requested)).toEqual(new Set(["llm/listModels"]));
  });

  it("lists the models Ollama reports as installed", async () => {
    const { m } = messengerWith(["llama3.1:8b", "qwen3:8b"]);
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));
    const installed = (await screen.findByLabelText(
      "Installed model",
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(installed.options).map((o) => o.value)).toEqual([
        "",
        "llama3.1:8b",
        "qwen3:8b",
      ]),
    );
  });

  it("validates a free-text model name and announces the error", async () => {
    const { m } = messengerWith();
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByTestId("local-chooser-chatModel-error").textContent,
    ).toBe("Enter a model name.");
    expect(
      screen
        .getByTestId("local-chooser-chatModel")
        .getAttribute("aria-invalid"),
    ).toBe("true");

    await user.type(screen.getByTestId("local-chooser-chatModel"), "a b");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByTestId("local-chooser-chatModel-error").textContent,
    ).toBe("A model name has no spaces.");
  });

  it("shows the pull command for a model that is not installed", async () => {
    const { m } = messengerWith(["llama3.1:8b"]);
    const post = vi.spyOn(m, "post");
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));
    await user.type(screen.getByTestId("local-chooser-chatModel"), "qwen3:8b");
    const pull = screen.getByTestId("local-chooser-pull");
    expect(pull.textContent).toContain("ollama pull qwen3:8b");
    await user.click(
      within(pull).getByRole("button", { name: "Copy ollama pull qwen3:8b" }),
    );
    expect(post).toHaveBeenCalledWith("copyText", {
      text: "ollama pull qwen3:8b",
    });
  });

  it("writes an Ollama choice and shows it on the tab afterwards", async () => {
    const { m } = messengerWith(["llama3.1:8b", "qwen3:8b"]);
    const post = vi.spyOn(m, "post");
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));
    await user.selectOptions(
      await screen.findByLabelText("Installed model"),
      "qwen3:8b",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.queryByTestId("local-model-chooser")).toBeNull();
    // focus goes back to the button that opened it
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Configure model" }),
      ),
    );
    expect(screen.getByTestId("local-choice-summary").textContent).toContain(
      "qwen3:8b",
    );
    expect(
      screen.getByText("ollama pull qwen2.5-coder:1.5b-base"),
    ).toBeTruthy();

    // the suggested autocomplete and embeddings models are still to pull
    expect(
      screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends the choice with onboarding/complete for an OpenAI-compatible server", async () => {
    const { m } = messengerWith(undefined);
    const post = vi.spyOn(m, "post");
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "openai");
    await user.type(
      screen.getByTestId("local-chooser-apiBase"),
      "http://127.0.0.1:8080/v1/",
    );
    await user.type(screen.getByTestId("local-chooser-chatModel"), "my-model");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // another server is not checked for: Connect is available
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect.hasAttribute("disabled")).toBe(false);
    await user.click(connect);
    expect(completeCall(post)?.[1]).toEqual({
      mode: OnboardingModes.LOCAL,
      local: {
        provider: "openai",
        chatModel: "my-model",
        apiBase: "http://127.0.0.1:8080/v1/",
      },
    });
  });

  it("sends no choice for the default", async () => {
    const { m } = messengerWith([
      "llama3.1:8b",
      "qwen2.5-coder:1.5b-base",
      "nomic-embed-text:latest",
    ]);
    const post = vi.spyOn(m, "post");
    const { user } = await renderLocal(m);
    const connect = screen.getByRole("button", { name: "Connect" });
    await waitFor(() => expect(connect.hasAttribute("disabled")).toBe(false));
    await user.click(connect);
    expect(completeCall(post)?.[1]).toEqual({ mode: OnboardingModes.LOCAL });
  });

  it("asks for the server address of a non-Ollama provider", async () => {
    const { m } = messengerWith();
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "vllm");
    expect(
      (screen.getByTestId("local-chooser-apiBase") as HTMLInputElement).value,
    ).toBe("http://127.0.0.1:8000/v1/");
    await user.clear(screen.getByTestId("local-chooser-apiBase"));
    await user.type(screen.getByTestId("local-chooser-chatModel"), "m");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByTestId("local-chooser-apiBase-error").textContent).toBe(
      "Enter the server address.",
    );
  });

  it("closes on Escape and returns focus to Configure model", async () => {
    const { m } = messengerWith();
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Provider"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("local-model-chooser")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Configure model" }),
      ),
    );
  });

  it("switches to the provider setup tab from the other-provider link", async () => {
    const { m } = messengerWith();
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));
    await user.click(
      screen.getByRole("button", {
        name: "Choose another provider (cloud or API key)",
      }),
    );
    expect(await screen.findByTestId("provider-setup-flow")).toBeTruthy();
  });

  it("remembers the choice when coming back to the tab", async () => {
    const { m } = messengerWith();
    const { user } = await renderLocal(m);
    await user.click(screen.getByRole("button", { name: "Configure model" }));
    await user.type(screen.getByTestId("local-chooser-chatModel"), "qwen3:8b");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByTestId("onboarding-tab-API Key"));
    await user.click(screen.getByTestId("onboarding-tab-Local"));
    expect(screen.getByTestId("local-choice-summary").textContent).toContain(
      "qwen3:8b",
    );
  });
});
