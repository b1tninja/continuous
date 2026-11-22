import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ProviderSetupInfo } from "core/config/providerSetup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { resetCatalogueAnswers } from "../../pages/AddNewModel/configs/fetchProviderModels";
import { renderWithProviders } from "../../util/test/render";
import { ProviderSetupFlow } from "./ProviderSetupFlow";
import { toReview } from "./testSteps";
import { AUTO_TEST_AFTER_PASTE_MS, AUTO_TEST_PAUSE_MS } from "./useAutoTest";
import { LOOK_TIMEOUT_MS } from "./useLocalServerDetection";

const SETUP: ProviderSetupInfo = {
  connections: [],
  secureStorageAvailable: true,
  preferredKeyStorage: "secure",
  editable: true,
};

const OLLAMA = {
  title: "Ollama",
  apiBase: "http://127.0.0.1:11434/v1/",
  models: [
    {
      name: "qwen3:8b",
      modelId: "qwen3:8b",
      contextLength: 40960,
      supportsTools: true,
    },
    { name: "llama3.1:8b", modelId: "llama3.1:8b" },
  ],
};
const LM_STUDIO = {
  title: "LM Studio",
  apiBase: "http://127.0.0.1:1234/v1/",
  models: [{ name: "phi-4", modelId: "phi-4" }],
};

// A key long enough to look finished (20 characters or more, no space)
const KEY = "sk-ant-api03-abcdefghijklmnop";

function messengerWith(found: unknown[] | "never" = []) {
  const messenger = new MockIdeMessenger();
  const saves: any[] = [];
  const tests: any[] = [];
  const asked: string[] = [];
  const h = messenger.responseHandlers as any;
  h["config/getProviderSetup"] = async () => SETUP;
  h["config/saveProviderModels"] = async (req: any) => {
    saves.push(req);
    return { saved: true };
  };
  h["models/detectLocal"] = () => {
    asked.push("models/detectLocal");
    return found === "never" ? new Promise(() => {}) : Promise.resolve(found);
  };
  h["models/fetch"] = async () => [];
  h["openaiCompat/testConnection"] = async (req: any) => {
    tests.push(req);
    return { ok: true, models: ["claude-a", "claude-b"] };
  };
  return { messenger, saves, tests, asked };
}

const flow = (m: MockIdeMessenger, onDone = vi.fn()) =>
  renderWithProviders(<ProviderSetupFlow onDone={onDone} />, {
    mockIdeMessenger: m,
  });

/** Let the mock messenger's promises settle under fake timers. */
const settle = () => act(async () => void (await Promise.resolve()));
const advance = async (ms: number) => {
  await act(async () => void vi.advanceTimersByTime(ms));
  await settle();
};

describe("Add a model: the start screen", () => {
  beforeEach(() => resetCatalogueAnswers());
  afterEach(() => vi.useRealTimers());

  it("shows the four choices at once, as real buttons, while it is still looking", async () => {
    const { messenger } = messengerWith("never");
    await flow(messenger);
    expect(screen.getByText("What do you have?")).toBeTruthy();
    const doors = [
      "door-api-key",
      "door-this-computer",
      "door-network",
      "door-nothing",
    ].map((id) => screen.getByTestId(id));
    expect(doors.map((d) => d.tagName)).toEqual(Array(4).fill("BUTTON"));
    expect(doors.map((d) => d.textContent)).toEqual([
      expect.stringContaining("An API key"),
      expect.stringContaining("A server on this computer"),
      expect.stringContaining("A server on my network"),
      expect.stringContaining("Nothing yet"),
    ]);
    expect(screen.getByTestId("found-servers").textContent).toBe("Looking…");
    // No step is counted before the first question is answered
    expect(screen.queryByTestId("setup-step-count")).toBeNull();
  });

  it("fills in what was found, each with its address and model count", async () => {
    const { messenger, asked } = messengerWith([OLLAMA, LM_STUDIO]);
    await flow(messenger);
    expect((await screen.findByTestId("found-11434")).textContent).toBe(
      "Found: Ollama at 127.0.0.1:11434, 2 models",
    );
    expect(screen.getByTestId("found-1234").textContent).toBe(
      "Found: LM Studio at 127.0.0.1:1234, 1 model",
    );
    expect(screen.getByTestId("found-11434").tagName).toBe("BUTTON");
    // One question to core; it probes only the ports core already knows
    expect(asked).toEqual(["models/detectLocal"]);
  });

  it("says None found, and offers an address or Nothing yet", async () => {
    const { messenger } = messengerWith([]);
    const { user } = await flow(messenger);
    await waitFor(() =>
      expect(screen.getByTestId("found-servers").textContent).toContain(
        "None found.",
      ),
    );
    await user.click(screen.getByRole("button", { name: 'See "Nothing yet"' }));
    expect(screen.getByTestId("nothing-yet")).toBeTruthy();
  });

  it("stops saying Looking after its wait, and still takes a late answer", async () => {
    let answer: (servers: unknown[]) => void = () => {};
    const { messenger } = messengerWith();
    (messenger.responseHandlers as any)["models/detectLocal"] = () =>
      new Promise((resolve) => (answer = resolve));
    vi.useFakeTimers();
    await flow(messenger);
    await advance(LOOK_TIMEOUT_MS - 1);
    expect(screen.getByTestId("found-servers").textContent).toBe("Looking…");
    await advance(1);
    expect(screen.getByTestId("found-servers").textContent).toContain(
      "None found.",
    );
    await act(async () => answer([OLLAMA]));
    await settle();
    expect(screen.getByTestId("found-11434")).toBeTruthy();
  });
});

describe("Add a model: where each choice leads", () => {
  beforeEach(() => resetCatalogueAnswers());

  it("An API key: the provider choice and the connection step", async () => {
    const { messenger } = messengerWith();
    const { user } = await flow(messenger);
    await user.click(screen.getByTestId("door-api-key"));
    expect(screen.getByTestId("setup-step-count").textContent).toBe(
      "Step 1 of 4",
    );
    expect(screen.getByText("Provider")).toBeTruthy();
    expect(
      (screen.getByLabelText("API key") as HTMLInputElement).placeholder,
    ).toBe("Enter your Anthropic API key");
    expect(screen.queryByTestId("local-server-picker")).toBeNull();
    // Back returns to the question
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("start-screen")).toBeTruthy();
  });

  it("a found server: straight to its models, with the connection filled in", async () => {
    const { messenger, saves } = messengerWith([OLLAMA, LM_STUDIO]);
    const { user } = await flow(messenger);
    await user.click(await screen.findByTestId("found-11434"));

    expect(screen.getByTestId("setup-step-count").textContent).toBe(
      "Step 2 of 4",
    );
    expect(screen.getByTestId("found-connection-line").textContent).toBe(
      "Connected to Ollama at 127.0.0.1:11434. 2 models. Tools: 1 of 2.",
    );
    expect(screen.getByLabelText("qwen3:8b")).toBeTruthy();
    expect(screen.getByLabelText("llama3.1:8b")).toBeTruthy();
    expect(saves).toEqual([]);

    await toReview(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].provider).toBe("openai");
    expect(saves[0].connection).toEqual({
      apiBase: "http://127.0.0.1:11434/v1/",
    });
    expect(saves[0].account).toEqual({ name: "Ollama" });
    expect(saves[0].key).toBeUndefined();
  });

  it("a found server that wants a key goes to the connection step first", async () => {
    const { messenger } = messengerWith([
      { ...LM_STUDIO, models: [], needsKey: true },
    ]);
    const { user } = await flow(messenger);
    const line = await screen.findByTestId("found-1234");
    expect(line.textContent).toBe(
      "Found: LM Studio at 127.0.0.1:1234, needs an API key",
    );
    await user.click(line);
    expect(screen.getByTestId("setup-step-count").textContent).toBe(
      "Step 1 of 4",
    );
    expect(
      (screen.getByLabelText("Server address") as HTMLInputElement).value,
    ).toBe("http://127.0.0.1:1234/v1/");
  });

  it("A server on this computer: the address entry with the usual addresses", async () => {
    const { messenger } = messengerWith([]);
    const { user } = await flow(messenger);
    await user.click(screen.getByTestId("door-this-computer"));
    expect(screen.getByTestId("local-server-picker")).toBeTruthy();
    expect(
      (screen.getByLabelText("Server address") as HTMLInputElement).value,
    ).toBe("http://127.0.0.1:8080/v1/");
  });

  it("A server on my network: an empty address, no search of this computer, never OpenAI's address", async () => {
    const { messenger, tests } = messengerWith([]);
    const { user } = await flow(messenger);
    await user.click(screen.getByTestId("door-network"));
    const address = screen.getByLabelText("Server address") as HTMLInputElement;
    expect(address.value).toBe("");
    expect(address.placeholder).toBe("e.g. http://192.168.1.50:8080/v1/");
    expect(screen.queryByTestId("local-server-picker")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // The provider is "openai" underneath; an empty address must not mean api.openai.com
    expect(screen.getByTestId("test-connection-base-help").textContent).toMatch(
      /no default address/,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Test connection",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(tests).toEqual([]);
  });

  it("Nothing yet: two ways, and nothing starts by itself", async () => {
    const { messenger } = messengerWith([]);
    const post = vi.spyOn(messenger, "post");
    const run = vi.spyOn(messenger.ide, "runCommand");
    const { user } = await flow(messenger);
    await user.click(screen.getByTestId("door-nothing"));

    expect(screen.getByText("Run a model on this computer")).toBeTruthy();
    expect(screen.getByText("Or get an API key")).toBeTruthy();
    // One model, and the button says what it runs
    expect(
      screen.getByRole("button", {
        name: "Run ollama pull llama3.1:8b in the terminal",
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("nothing-yet").textContent).toContain(
      "Nothing is downloaded until you press it.",
    );
    expect(run).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([t]) => t === "openUrl")).toBe(false);

    // A key page opens only when its button is pressed
    await user.click(
      screen.getByRole("button", { name: "Get a OpenRouter key" }),
    );
    expect(post).toHaveBeenCalledWith(
      "openUrl",
      "https://openrouter.ai/settings/keys",
    );
    expect(run).not.toHaveBeenCalled();

    // "I have it" goes on to that provider's connection step
    await user.click(
      screen
        .getByTestId("ny-key-openrouter")
        .querySelector("button:last-of-type")!,
    );
    expect(
      (screen.getByLabelText("API key") as HTMLInputElement).placeholder,
    ).toBe("Enter your OpenRouter API key");
  });

  it("Nothing yet: goes on with Ollama once it answers with a model", async () => {
    const { messenger } = messengerWith([OLLAMA]);
    const { user } = await flow(messenger);
    await screen.findByTestId("found-11434");
    await user.click(screen.getByTestId("door-nothing"));
    expect(screen.getByTestId("ny-ollama-running").textContent).toBe(
      "Ollama is running at 127.0.0.1:11434.",
    );
    await user.click(
      screen.getByRole("button", { name: "Use Ollama (2 models)" }),
    );
    expect(screen.getByTestId("model-checklist")).toBeTruthy();
  });
});

describe("Add a model: the test that runs by itself", () => {
  beforeEach(() => resetCatalogueAnswers());
  afterEach(() => vi.useRealTimers());

  async function atConnection(found: unknown[] = []) {
    const made = messengerWith(found);
    const view = await flow(made.messenger);
    await view.user.click(screen.getByTestId("door-api-key"));
    vi.useFakeTimers();
    return { ...made, ...view, key: screen.getByLabelText("API key") };
  }
  const type = (el: HTMLElement, value: string) =>
    act(() => void fireEvent.input(el, { target: { value } }));
  const paste = (el: HTMLElement, value: string) =>
    act(() => {
      fireEvent.paste(el);
      fireEvent.input(el, { target: { value } });
    });

  it("runs once after a paste, lists only, and sends the key to the chosen provider", async () => {
    const { tests, key } = await atConnection();
    paste(key, KEY);
    expect(tests).toEqual([]);
    await advance(AUTO_TEST_AFTER_PASTE_MS);
    expect(tests).toEqual([
      // No `model`: the listing only, no request that is billed
      {
        provider: "anthropic",
        apiBase: undefined,
        apiKey: KEY,
        model: undefined,
      },
    ]);
    expect(screen.getByTestId("test-connection-line").textContent).toBe(
      "Connected. 2 models. Tools: yes.",
    );
    // Nothing more happens by itself
    await advance(10 * AUTO_TEST_PAUSE_MS);
    expect(tests).toHaveLength(1);
  });

  it("does not run on keystrokes, only after a pause with a key that looks complete", async () => {
    const { tests, key } = await atConnection();
    for (let n = 1; n <= KEY.length; n++) {
      type(key, KEY.slice(0, n));
      await advance(AUTO_TEST_PAUSE_MS - 100);
    }
    expect(tests).toEqual([]);
    await advance(100);
    expect(tests).toHaveLength(1);
    expect(tests[0].apiKey).toBe(KEY);
  });

  it("does not run for a short key, however long the pause", async () => {
    const { tests, key } = await atConnection();
    type(key, "sk-short");
    await advance(20 * AUTO_TEST_PAUSE_MS);
    expect(tests).toEqual([]);
  });

  it("a change while it waits cancels it; a change while it runs drops its answer", async () => {
    const { tests, key, messenger } = await atConnection();
    paste(key, KEY);
    await advance(AUTO_TEST_AFTER_PASTE_MS - 50);
    type(key, `${KEY}x`);
    await advance(AUTO_TEST_AFTER_PASTE_MS);
    // The pasted key was never sent; the typed one waits out its pause
    expect(tests).toEqual([]);
    await advance(AUTO_TEST_PAUSE_MS);
    expect(tests.map((t) => t.apiKey)).toEqual([`${KEY}x`]);

    // A slow answer for a key that is then changed is not shown
    let answer: (v: unknown) => void = () => {};
    (messenger.responseHandlers as any)["openaiCompat/testConnection"] = (
      req: any,
    ) => {
      tests.push(req);
      return new Promise((resolve) => (answer = resolve));
    };
    paste(key, `${KEY}y`);
    await advance(AUTO_TEST_AFTER_PASTE_MS);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    type(key, "sk-short");
    await act(async () => answer({ ok: true, models: ["late"] }));
    await settle();
    expect(screen.queryByTestId("test-connection-line")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("can be stopped, and run again by hand", async () => {
    const { tests, key, messenger } = await atConnection();
    let answer: (v: unknown) => void = () => {};
    const slow = (req: any) => {
      tests.push(req);
      return new Promise((resolve) => (answer = resolve));
    };
    (messenger.responseHandlers as any)["openaiCompat/testConnection"] = slow;
    paste(key, KEY);
    await advance(AUTO_TEST_AFTER_PASTE_MS);
    act(
      () => void fireEvent.click(screen.getByRole("button", { name: "Stop" })),
    );
    await act(async () => answer({ ok: true, models: ["stopped"] }));
    await settle();
    expect(screen.queryByTestId("test-connection-line")).toBeNull();

    (messenger.responseHandlers as any)["openaiCompat/testConnection"] = async (
      req: any,
    ) => {
      tests.push(req);
      return { ok: true, models: ["claude-a"] };
    };
    act(
      () =>
        void fireEvent.click(
          screen.getByRole("button", { name: "Test connection" }),
        ),
    );
    await settle();
    expect(screen.getByTestId("test-connection-line").textContent).toBe(
      "Connected. 1 model. Tools: yes.",
    );
    act(
      () =>
        void fireEvent.click(
          screen.getByRole("button", { name: "Test again" }),
        ),
    );
    await settle();
    expect(tests).toHaveLength(3);
    // By hand or by itself, the test in the flow only lists
    expect(tests.every((t) => t.model === undefined)).toBe(true);
  });

  it("runs when a server is picked, and says a failure in plain words", async () => {
    const { messenger, tests } = messengerWith([]);
    (messenger.responseHandlers as any)["openaiCompat/testConnection"] = async (
      req: any,
    ) => {
      tests.push(req);
      return {
        ok: false,
        error:
          "Could not reach http://127.0.0.1:1234/v1/models: connect ECONNREFUSED 127.0.0.1:1234.",
      };
    };
    const { user } = await flow(messenger);
    await user.click(screen.getByTestId("door-this-computer"));
    // Opening the step tests nothing: the address shown is only a suggestion
    expect(tests).toEqual([]);
    vi.useFakeTimers();
    act(
      () =>
        void fireEvent.click(screen.getByRole("button", { name: /LM Studio/ })),
    );
    await advance(1);
    expect(tests).toEqual([
      {
        provider: "openai",
        apiBase: "http://127.0.0.1:1234/v1/",
        apiKey: undefined,
        model: undefined,
      },
    ]);
    expect(screen.getByTestId("test-connection-error").textContent).toBe(
      "Could not reach the model server at 127.0.0.1:1234. The connection was refused. Check that the server is running, that the port is right, and that it listens on this address.",
    );
  });
});

describe("Add a model: Use for, More and the review", () => {
  beforeEach(() => resetCatalogueAnswers());

  /** The config core sends has "Claude Sonnet" as the chat model, so the step can say what changes. */
  function withChatModel(messenger: MockIdeMessenger) {
    const info: any = structuredClone(
      messenger.responses["config/getSerializedProfileInfo"],
    );
    const chat = { title: "Claude Sonnet", provider: "anthropic", model: "x" };
    info.result.config.modelsByRole.chat = [chat];
    info.result.config.selectedModelByRole.chat = chat;
    messenger.responses["config/getSerializedProfileInfo"] = info;
  }

  async function atUseFor() {
    const made = messengerWith([OLLAMA]);
    withChatModel(made.messenger);
    const view = await flow(made.messenger);
    await waitFor(() =>
      expect(
        view.store.getState().config.config.selectedModelByRole.chat?.title,
      ).toBe("Claude Sonnet"),
    );
    await view.user.click(await screen.findByTestId("found-11434"));
    await view.user.click(screen.getByRole("button", { name: "Next" }));
    return { ...made, ...view };
  }

  it("ticks Chat, Edit and Apply, leaves Autocomplete with a note, and says what changes", async () => {
    await atUseFor();
    expect(screen.getByTestId("setup-step-count").textContent).toBe(
      "Step 3 of 4",
    );
    const ticked = (label: string) =>
      (screen.getByLabelText(label) as HTMLInputElement).checked;
    expect(["Chat", "Edit", "Apply", "Autocomplete"].map(ticked)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(screen.getByTestId("use-for-line-chat").textContent).toBe(
      // The first model in the list is the one put to use
      "Chat: currently Claude Sonnet → will be llama3.1:8b",
    );
    expect(screen.getByTestId("use-for-line-edit").textContent).toBe(
      "Edit: nothing chosen yet → will be llama3.1:8b",
    );
    expect(screen.getByTestId("use-for-line-autocomplete").textContent).toBe(
      "Autocomplete: nothing chosen, and stays so",
    );
    expect(screen.getByTestId("use-for-autocomplete-note").textContent).toMatch(
      /does not list llama3.1:8b as a completion model/,
    );
  });

  it("writes no roles when the ticks are left alone, and still picks the model for them", async () => {
    const { user, saves } = await atUseFor();
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByTestId("review-use-for").textContent).toContain(
      "No roles are written: a model without them does chat, edit, apply and summarize.",
    );
    expect(saves).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).not.toHaveProperty("roles");
    expect(saves[0]).not.toHaveProperty("requestOptions");
    expect(saves[0].selectFor).toEqual(["chat", "edit", "apply"]);
    expect(saves[0].add.map((m: any) => m.model)).toEqual([
      "llama3.1:8b",
      "qwen3:8b",
    ]);
  });

  it("writes exactly the roles that were chosen, and nothing before Save", async () => {
    const { user, saves } = await atUseFor();
    await user.click(screen.getByLabelText("Edit"));
    await user.click(screen.getByLabelText("Autocomplete"));
    expect(screen.queryByTestId("use-for-autocomplete-note")).toBeNull();
    expect(screen.getByTestId("use-for-line-edit").textContent).toBe(
      "Edit: nothing chosen, and stays so",
    );
    await user.click(screen.getByRole("button", { name: "Review" }));

    const review = screen.getByTestId("review-use-for").textContent;
    expect(review).toContain(
      "Chat: currently Claude Sonnet → will be llama3.1:8b",
    );
    expect(review).toContain(
      "Written with each new model as roles: chat, apply, autocomplete, summarize.",
    );
    expect(saves).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].roles).toEqual([
      "chat",
      "apply",
      "autocomplete",
      "summarize",
    ]);
    expect(saves[0].selectFor).toEqual(["chat", "apply", "autocomplete"]);
  });

  it("ticks Autocomplete for a model the catalogue recommends for it", async () => {
    const made = messengerWith();
    (made.messenger.responseHandlers as any)["models/fetch"] = async () => [
      { name: "codestral-latest", modelId: "codestral-latest" },
    ];
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="mistral" onDone={vi.fn()} />,
      { mockIdeMessenger: made.messenger },
    );
    await user.type(screen.getByLabelText("API key"), "k");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByTestId("model-checklist");
    // Only Codestral stays ticked
    for (const box of screen.getAllByRole("checkbox") as HTMLInputElement[]) {
      const codestral = box.getAttribute("aria-label") === "Codestral";
      if (box.checked !== codestral) await user.click(box);
    }
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      (screen.getByLabelText("Autocomplete") as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByTestId("use-for-autocomplete-note")).toBeNull();
  });

  it("More is folded, and each field says what is in use when it is not set", async () => {
    const { messenger, saves } = messengerWith();
    const { user } = await flow(messenger);
    await user.click(screen.getByTestId("door-api-key"));

    const more = screen.getByTestId("connection-more") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    // The header carries the values in use
    expect(screen.getByTestId("connection-more-summary").textContent).toBe(
      "API base https://api.anthropic.com/v1 · key name CONTINUOUS_ANTHROPIC_API_KEY · request timeout 7,200 s · connect timeout 10 s · proxy from the environment · certificates checked",
    );
    await user.click(screen.getByText("More"));
    const state = (id: string) =>
      screen.getByTestId(`more-state-${id}`).textContent;
    expect(state("moreApiBase")).toBe("Not set: https://api.anthropic.com/v1");
    expect(state("secretName")).toBe(
      "Not set: CONTINUOUS_ANTHROPIC_API_KEY (built from the provider's name)",
    );
    expect(state("moreTimeout")).toBe("Not set: 7,200 s for the whole reply");
    expect(state("moreConnectTimeout")).toBe(
      "Not set: 10 s to reach the server",
    );
    expect(state("moreProxy")).toBe(
      "Not set: HTTPS_PROXY or HTTP_PROXY from the environment, else no proxy",
    );
    expect(state("moreVerifySsl")).toBe("Not set: on");
    expect(state("moreUseSystemCa")).toBe(
      "Not set: on for Windows and macOS, off for Linux",
    );
    expect(state("moreCaBundle")).toBe("Not set: none");
    expect(more.textContent).not.toMatch(/\bDefault\b/);

    // Setting one, and taking it back
    await user.type(screen.getByLabelText("Connect timeout (seconds)"), "3");
    expect(state("moreConnectTimeout")).toBe("Set by you: 3 sReset");
    await user.click(
      screen.getByRole("button", { name: "Reset moreConnectTimeout" }),
    );
    expect(state("moreConnectTimeout")).toBe(
      "Not set: 10 s to reach the server",
    );

    await user.type(screen.getByLabelText("Request timeout (seconds)"), "600");
    await user.type(screen.getByLabelText("API key"), "k");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await toReview(user);
    expect(screen.getByTestId("review-more").textContent).toContain(
      "Request timeout 600 s",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    // Only what was set is sent
    expect(saves[0].requestOptions).toEqual({ timeout: 600 });
  });

  it("an API base under More is where the models are saved and tested", async () => {
    const { messenger, saves } = messengerWith();
    const { user } = await flow(messenger);
    await user.click(screen.getByTestId("door-api-key"));
    await user.click(screen.getByText("More"));
    await user.type(
      screen.getByLabelText("API base"),
      "https://gateway.example/v1",
    );
    expect(screen.getByTestId("more-state-moreApiBase").textContent).toBe(
      "Set by you: https://gateway.example/v1Reset",
    );
    await user.type(screen.getByLabelText("API key"), "k");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await toReview(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].connection).toEqual({
      apiBase: "https://gateway.example/v1",
    });
    expect(
      saves[0].add.every(
        (m: any) => m.apiBase === "https://gateway.example/v1",
      ),
    ).toBe(true);
  });

  it("a timeout that is not a number above 0 stops at the connection step", async () => {
    const { messenger } = messengerWith();
    const { user } = await flow(messenger);
    await user.click(screen.getByTestId("door-api-key"));
    await user.type(screen.getByLabelText("API key"), "k");
    await user.click(screen.getByText("More"));
    await user.type(screen.getByLabelText("Request timeout (seconds)"), "0");
    expect(screen.getByText("Enter a number of seconds above 0")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("Add a model: the checklist's three columns", () => {
  beforeEach(() => resetCatalogueAnswers());

  it("says context, price and tools for each model, and says so when one is not known", async () => {
    const { messenger } = messengerWith([OLLAMA]);
    const { user } = await flow(messenger);
    await user.click(await screen.findByTestId("found-11434"));

    expect(screen.getByTestId("model-columns").textContent).toBe(
      "ModelContext, tokensPrice in / out per 1M tokensTools",
    );
    expect(screen.getByTestId("model-row-facts-qwen3:8b").textContent).toBe(
      "Context: 40,960 tokens · Price: not billed per token · Tools: yes",
    );
    // The server said nothing about this one: words, not a blank and not $0
    const unknown = screen.getByTestId("model-row-facts-llama3.1:8b");
    expect(unknown.textContent).toBe(
      "Context: not published · Price: not billed per token · Tools: not reported",
    );
    expect(screen.getByTestId("model-checklist").textContent).not.toContain(
      "$0",
    );
  });
});
