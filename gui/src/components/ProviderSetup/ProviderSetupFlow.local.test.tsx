import { screen, waitFor } from "@testing-library/react";
import type { ProviderSetupInfo } from "core/config/providerSetup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCatalogueAnswers } from "../../pages/AddNewModel/configs/fetchProviderModels";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { ProviderSetupFlow } from "./ProviderSetupFlow";
import { toReview } from "./testSteps";

const EMPTY_SETUP: ProviderSetupInfo = {
  connections: [],
  secureStorageAvailable: true,
  preferredKeyStorage: "secure",
  editable: true,
};

const STRATA_MODEL = {
  name: "qwen3.8-flash-next-nvfp4-nvfp4",
  modelId: "qwen3.8-flash-next-nvfp4-nvfp4",
  contextLength: 524288,
  supportsTools: true,
  supportsImages: true,
};

function messengerWith(setup: ProviderSetupInfo = EMPTY_SETUP) {
  const messenger = new MockIdeMessenger();
  const saves: any[] = [];
  const fetches: any[] = [];
  messenger.responseHandlers["config/getProviderSetup"] = async () => setup;
  messenger.responseHandlers["config/saveProviderModels"] = async (req) => {
    saves.push(req);
    return { saved: true };
  };
  messenger.responseHandlers["models/fetch"] = async (req) => {
    fetches.push(req);
    return [STRATA_MODEL];
  };
  messenger.responseHandlers["models/detectLocal"] = async () => [
    {
      title: "Strata",
      apiBase: "http://127.0.0.1:8083/v1/",
      models: [STRATA_MODEL],
    },
  ];
  return { messenger, saves, fetches };
}

async function checkModel(name: string) {
  const box = (await screen.findByLabelText(name)) as HTMLInputElement;
  if (!box.checked) box.click();
  await waitFor(() => expect(box.checked).toBe(true));
}

describe("ProviderSetupFlow: local server", () => {
  it("detects Strata, lists its model with its context window, and saves it", async () => {
    const { messenger, saves } = messengerWith();
    const onDone = vi.fn();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openai-compatible" onDone={onDone} />,
      { mockIdeMessenger: messenger },
    );

    await user.click(screen.getByRole("button", { name: "Detect" }));
    const found = await screen.findByRole("list", { name: "Found servers" });
    expect(found.textContent).toContain("Strata");
    expect(found.textContent).toContain("http://127.0.0.1:8083/v1/");
    // The only server with a model is used straight away.
    const address = screen.getByLabelText("Server address") as HTMLInputElement;
    await waitFor(() =>
      expect(address.value).toBe("http://127.0.0.1:8083/v1/"),
    );

    // No key is needed.
    await user.click(screen.getByRole("button", { name: "Next" }));
    await checkModel(STRATA_MODEL.name);
    await toReview(user);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(saves).toHaveLength(1);
    expect(saves[0].provider).toBe("openai");
    expect(saves[0].connection).toEqual({
      apiBase: "http://127.0.0.1:8083/v1/",
    });
    expect(saves[0].key).toBeUndefined();
    // A new connection becomes a provider account, named after the server
    expect(saves[0].account).toEqual({ name: "Strata" });
    const added = saves[0].add.find(
      (m: any) => m.model === STRATA_MODEL.modelId,
    );
    expect(added).toMatchObject({
      provider: "openai",
      apiBase: "http://127.0.0.1:8083/v1/",
      contextLength: 524288,
      // From /props: agent mode and images work without editing the config
      capabilities: { tools: true, uploadImage: true },
    });
  });

  it("selects the server's own models, not the provider's presets", async () => {
    const { messenger, saves } = messengerWith();
    const onDone = vi.fn();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openai-compatible" onDone={onDone} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    const box = (await screen.findByLabelText(
      STRATA_MODEL.name,
    )) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    expect(screen.getByTestId("model-checklist").textContent).toContain(
      "1 model selected",
    );
    await toReview(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(saves[0].add.map((m: any) => m.model)).toEqual([
      STRATA_MODEL.modelId,
    ]);
  });

  it("names the account after a server that says what it is, without Detect", async () => {
    const { messenger, saves } = messengerWith();
    messenger.responseHandlers["models/fetch"] = async () => [
      { ...STRATA_MODEL, server: "Strata" },
    ];
    const onDone = vi.fn();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openai-compatible" onDone={onDone} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await checkModel(STRATA_MODEL.name);
    await toReview(user);
    expect((await screen.findByTestId("review-account")).textContent).toContain(
      'the account "Strata"',
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(saves[0].account).toEqual({ name: "Strata" });
  });

  it("lists the models at the default address (port 8080) on Next", async () => {
    const { messenger, fetches } = messengerWith();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow
        initialProvider="openai-compatible"
        onDone={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    const address = screen.getByLabelText("Server address") as HTMLInputElement;
    expect(address.value).toBe("http://127.0.0.1:8080/v1/");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText(STRATA_MODEL.name);
    expect(fetches.find((f) => f.provider === "openai")).toMatchObject({
      apiBase: "http://127.0.0.1:8080/v1/",
    });
  });

  it("opened at the checklist (Manage models), lists the configured server's models", async () => {
    const { messenger, fetches } = messengerWith({
      ...EMPTY_SETUP,
      connections: [
        {
          provider: "openai",
          connection: { apiBase: "http://127.0.0.1:8083/v1" },
          account: "strata",
          models: [{ name: "Old", model: "old-model" }],
          key: { state: "none" },
        },
      ],
    });
    await renderWithProviders(
      <ProviderSetupFlow
        initialProvider="openai"
        initialConnection={{ apiBase: "http://127.0.0.1:8083/v1" }}
        initialStep="models"
        onDone={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    await screen.findByLabelText(STRATA_MODEL.name);
    const openaiFetches = fetches.filter((f) => f.provider === "openai");
    expect(openaiFetches).toHaveLength(1);
    expect(openaiFetches[0].apiBase).toMatch(/^http:\/\/127\.0\.0\.1:8083\/v1/);
  });

  it("chooses a usual address with one click", async () => {
    const { messenger } = messengerWith();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow
        initialProvider="openai-compatible"
        onDone={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "LM Studio (1234)" }));
    const address = screen.getByLabelText("Server address") as HTMLInputElement;
    await waitFor(() =>
      expect(address.value).toBe("http://127.0.0.1:1234/v1/"),
    );
  });

  it("keeps a local server's key apart from the OpenAI key", async () => {
    const { messenger, saves } = messengerWith();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow
        initialProvider="openai-compatible"
        onDone={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    await user.type(screen.getByLabelText("API key"), "local-secret");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await checkModel(STRATA_MODEL.name);
    await toReview(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].key).toMatchObject({
      secretName: "CONTINUOUS_LOCAL_API_KEY",
      value: "local-secret",
    });
  });

  it("opens a configured openai connection to another server as a local server", async () => {
    const { messenger } = messengerWith({
      ...EMPTY_SETUP,
      connections: [
        {
          provider: "openai",
          connection: { apiBase: "http://127.0.0.1:8083/v1" },
          models: [{ name: "Strata", model: STRATA_MODEL.modelId }],
          key: { state: "none" },
        },
      ],
    });
    await renderWithProviders(
      <ProviderSetupFlow
        initialProvider="openai"
        initialConnection={{ apiBase: "http://127.0.0.1:8083/v1" }}
        onDone={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    expect(
      screen.getByRole("heading", {
        name: "Edit Local server (OpenAI-compatible)",
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("local-server-picker")).toBeTruthy();
  });
});

describe("ProviderSetupFlow: catalogue fetch only on request", () => {
  beforeEach(() => resetCatalogueAnswers());

  const NEW_MODEL = {
    id: "zz-test/new-model",
    name: "ZZ Test: New Model",
    contextLength: 8192,
    supportsTools: true,
    pricing: { prompt: 0.000001, completion: 0.000002 },
  };

  function setup(
    opts: {
      fail?: boolean;
      policy?: "automatic" | "ask" | "never" | "off";
      cached?: boolean;
    } = {},
  ) {
    const { messenger, fetches } = messengerWith();
    const pulls: unknown[] = [];
    const policies: unknown[] = [];
    messenger.responseHandlers["models/fetch"] = async (req) => {
      fetches.push(req);
      if (opts.fail) throw new Error("offline");
      return [
        {
          name: "zz-test/new-model",
          modelId: "zz-test/new-model",
          contextLength: 8192,
        },
      ];
    };
    messenger.responseHandlers["modelCatalog/status"] = async () => ({
      policy: opts.policy ?? "ask",
      refreshHours: 24,
      ...(opts.cached
        ? {
            openrouter: { fetchedAt: "2026-11-01T00:00:00.000Z", count: 1 },
          }
        : {}),
    });
    messenger.responseHandlers["modelCatalog/cached"] = async () =>
      opts.cached
        ? { fetchedAt: "2026-11-01T00:00:00.000Z", models: [NEW_MODEL] }
        : null;
    messenger.responseHandlers["modelCatalog/pull"] = async () => {
      pulls.push(1);
      if (opts.fail) return { ok: false, error: "offline" };
      return {
        ok: true,
        fetchedAt: "2026-11-12T00:00:00.000Z",
        models: [NEW_MODEL],
      };
    };
    messenger.responseHandlers["modelCatalog/setPolicy"] = async (req) => {
      policies.push(req.policy);
      return { saved: true };
    };
    return { messenger, fetches, pulls, policies };
  }

  const idle = () => new Promise((r) => setTimeout(r, 50));
  const promptRegion = () =>
    screen.queryByRole("region", { name: "Pull model information" });

  it("sends no catalogue request on mount, for any provider", async () => {
    for (const initialProvider of [undefined, "openrouter", "ollama"]) {
      resetCatalogueAnswers();
      const { messenger, fetches, pulls } = setup();
      const { unmount } = await renderWithProviders(
        <ProviderSetupFlow
          initialProvider={initialProvider}
          onDone={vi.fn()}
        />,
        { mockIdeMessenger: messenger },
      );
      await idle();
      expect(fetches).toHaveLength(0);
      expect(pulls).toHaveLength(0);
      unmount();
    }
  });

  it("ollama: prompt sends nothing; Download one request; Refresh one per click", async () => {
    const { messenger, fetches } = setup();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="ollama" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await idle();
    expect(screen.getByText(/latest model list from ollama.com/)).toBeTruthy();
    expect(fetches).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(fetches).toHaveLength(1));
    expect(fetches[0].provider).toBe("ollama");
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    const btn = await screen.findByRole("button", {
      name: "Refresh from ollama.com",
    });
    await user.click(btn);
    await waitFor(() => expect(fetches).toHaveLength(2));
    await user.click(btn);
    await waitFor(() => expect(fetches).toHaveLength(3));
  });

  it("openrouter: the dialog asks once; Pull now sends exactly one request", async () => {
    const { messenger, fetches, pulls, policies } = setup();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    const region = await screen.findByRole("region", {
      name: "Pull model information",
    });
    expect(region.textContent).toContain(
      "Pull the latest model information from OpenRouter?",
    );
    expect(region.textContent).toContain(
      "This contacts openrouter.ai once to get the public model list: names, context sizes and prices. No account, key or prompt is sent. Prices are estimates and are stored on this computer with the date.",
    );
    await idle();
    expect(pulls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Pull now" }));
    await waitFor(() => expect(pulls).toHaveLength(1));
    await idle();
    expect(pulls).toHaveLength(1);
    expect(fetches).toHaveLength(0);
    expect(policies).toHaveLength(0);
    expect(promptRegion()).toBeNull();

    await user.type(screen.getByLabelText(/API key/i), "test-key");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByLabelText(NEW_MODEL.name)).toBeTruthy();
    expect(
      await screen.findByText(/OpenRouter model information/),
    ).toBeTruthy();
    // The Refresh button stays for later: one request per click
    await user.click(
      screen.getByRole("button", { name: "Refresh from openrouter.ai" }),
    );
    await waitFor(() => expect(pulls).toHaveLength(2));
  });

  it("openrouter: Not now sends nothing, persists nothing, and does not ask again this session", async () => {
    const { messenger, fetches, pulls, policies } = setup();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(promptRegion()).toBeNull();
    await user.type(screen.getByLabelText(/API key/i), "test-key");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Model list not downloaded/)).toBeTruthy();
    await idle();
    expect(pulls).toHaveLength(0);
    expect(fetches).toHaveLength(0);
    expect(policies).toHaveLength(0);
  });

  it("openrouter: Don't ask again persists the choice, and a saved 'never' suppresses the dialog", async () => {
    const first = setup();
    const { user, unmount } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: first.messenger },
    );
    await user.click(await screen.findByLabelText("Don't ask again"));
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(first.policies).toEqual(["never"]));
    expect(first.pulls).toHaveLength(0);
    unmount();

    resetCatalogueAnswers(); // a new app session
    const second = setup({ policy: "never" });
    await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: second.messenger },
    );
    await idle();
    expect(promptRegion()).toBeNull();
    expect(second.pulls).toHaveLength(0);
  });

  it("openrouter: a downloaded copy on this computer is used and nothing is asked", async () => {
    const { messenger, pulls } = setup({ cached: true });
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await idle();
    expect(promptRegion()).toBeNull();
    await user.type(screen.getByLabelText(/API key/i), "test-key");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByLabelText(NEW_MODEL.name)).toBeTruthy();
    expect(pulls).toHaveLength(0);
  });

  it("openrouter: a failed pull keeps the list and says so inline", async () => {
    const { messenger, pulls } = setup({ fail: true });
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(await screen.findByRole("button", { name: "Pull now" }));
    await user.type(screen.getByLabelText(/API key/i), "test-key");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByText(/Could not reach openrouter.ai \(offline\)/),
    ).toBeTruthy();
    expect(pulls).toHaveLength(1);
    expect(screen.getByText(/Model list not downloaded/)).toBeTruthy();
  });

  it("keeps the bundled list and says so when Ollama is offline", async () => {
    const { messenger, fetches } = setup({ fail: true });
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="ollama" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "Download" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Could not reach ollama.com/)).toBeTruthy();
    expect(fetches).toHaveLength(1);
    expect(screen.getByTestId("model-checklist")).toBeTruthy();
  });

  it("openrouter, updates automatic: nothing is asked, and with no list yet one pull is made", async () => {
    const { messenger, fetches, pulls } = setup({ policy: "automatic" });
    await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await waitFor(() => expect(pulls).toHaveLength(1));
    await idle();
    expect(promptRegion()).toBeNull();
    expect(pulls).toHaveLength(1);
    expect(fetches).toHaveLength(0);
  });

  it("openrouter, updates automatic with a list on this computer: no prompt, no request", async () => {
    const { messenger, pulls } = setup({ policy: "automatic", cached: true });
    await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await idle();
    expect(promptRegion()).toBeNull();
    expect(pulls).toHaveLength(0);
  });

  it("openrouter, updates off: no prompt, no Refresh, no request", async () => {
    const { messenger, fetches, pulls } = setup({ policy: "off" });
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="openrouter" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await idle();
    expect(promptRegion()).toBeNull();
    await user.type(screen.getByLabelText(/API key/i), "test-key");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByText(/Model information updates are off/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh now" })).toBeNull();
    await idle();
    expect(pulls).toHaveLength(0);
    expect(fetches).toHaveLength(0);
  });

  it("ollama is not covered by Automatic: it still asks and fetches nothing on open", async () => {
    const { messenger, fetches, pulls } = setup({ policy: "automatic" });
    await renderWithProviders(
      <ProviderSetupFlow initialProvider="ollama" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await idle();
    expect(screen.getByText(/latest model list from ollama.com/)).toBeTruthy();
    expect(fetches).toHaveLength(0);
    expect(pulls).toHaveLength(0);
  });

  it("Not now on Ollama sends nothing and keeps the bundled list", async () => {
    const { messenger, fetches } = setup();
    const { user } = await renderWithProviders(
      <ProviderSetupFlow initialProvider="ollama" onDone={vi.fn()} />,
      { mockIdeMessenger: messenger },
    );
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByTestId("model-checklist")).toBeTruthy();
    await idle();
    expect(fetches).toHaveLength(0);
  });
});
