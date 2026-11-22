import { act, screen, waitFor, within } from "@testing-library/react";
import type { ProviderSetupInfo } from "core/config/providerSetup";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { CONFIG_ROUTES } from "../../../util/navigation";
import { renderWithProviders } from "../../../util/test/render";
import ConfigPage from "../index";
import { getAllTabs, topTabSections } from "../configTabs";
import {
  accountsSummary,
  modeModelsSummary,
  modelInformationSummary,
  rolesSummary,
} from "../modelsSummaries";
import { ModelsSection } from "./ModelsSection";

const SETUP: ProviderSetupInfo = {
  connections: [
    {
      provider: "anthropic",
      connection: {},
      account: "anthropic-work",
      models: [
        { name: "Opus", model: "claude-opus" },
        { name: "Sonnet", model: "claude-sonnet" },
      ],
      key: {
        state: "secret",
        secretName: "CONTINUOUS_ANTHROPIC_API_KEY",
        storedIn: { secure: true, env: false },
      },
    },
    {
      provider: "bedrock",
      connection: { region: "us-east-1", profile: "work" },
      models: [{ name: "Bedrock Opus", model: "anthropic.claude-opus" }],
      key: { state: "none" },
    },
    {
      provider: "openai",
      connection: { apiBase: "http://localhost:1234/v1" },
      models: [{ name: "Local", model: "qwen" }],
      key: {
        state: "secret",
        secretName: "LOCAL_KEY",
        storedIn: { secure: false, env: false },
      },
    },
  ],
  secureStorageAvailable: true,
  preferredKeyStorage: "secure",
  editable: true,
};

function messenger(setup: ProviderSetupInfo = SETUP) {
  const m = new MockIdeMessenger();
  const sent: { type: string; data: unknown }[] = [];
  m.responseHandlers["config/getProviderSetup"] = async () => setup;
  m.responseHandlers["providers/list"] = async () => ({
    instances: [],
    globalFileUri: "file:///home/u/.continuous/providers.yaml",
    secureStorageAvailable: true,
  });
  m.responseHandlers["config/removeProviderConnection"] = async (data) => {
    sent.push({ type: "config/removeProviderConnection", data });
    return { removed: ["Opus", "Sonnet"] };
  };
  return { m, sent };
}

const row = (provider: string) =>
  screen.findByTestId(`provider-row-${provider}`);

// What the Providers tab held, now on the Models tab under "In use"
describe("Settings > Models: Connections and Accounts", () => {
  it("lists each configured connection with its auth kind and model count, and no key", async () => {
    await renderWithProviders(<ModelsSection />, {
      mockIdeMessenger: messenger().m,
    });
    const anthropic = await row("anthropic");
    expect(anthropic.textContent).toContain("Anthropic");
    expect(anthropic.textContent).toContain("Account anthropic-work");
    expect(within(anthropic).getByTestId("provider-auth").textContent).toBe(
      "Key CONTINUOUS_ANTHROPIC_API_KEY in secure storage",
    );
    expect(
      within(anthropic).getByTestId("provider-model-count").textContent,
    ).toBe("2 models enabled");

    const bedrock = await row("bedrock");
    expect(bedrock.textContent).toContain("us-east-1");
    expect(within(bedrock).getByTestId("provider-auth").textContent).toBe(
      "AWS profile work",
    );

    // An "openai" connection elsewhere is the local server entry; its key is
    // in neither store, which is flagged
    const local = await row("openai");
    expect(local.textContent).toContain("Local server (OpenAI-compatible)");
    expect(local.textContent).toContain("http://localhost:1234/v1");
    const auth = within(local).getByTestId("provider-auth");
    expect(auth.textContent).toMatch(/LOCAL_KEY from the environment/);
    expect(auth.className).toContain("text-warning");

    expect(screen.getByText("Provider accounts")).toBeTruthy();
  });

  it("shows an empty state whose Add a provider opens the flow at the provider choice", async () => {
    const { m } = messenger({ ...SETUP, connections: [] });
    const { user, store } = await renderWithProviders(<ModelsSection />, {
      mockIdeMessenger: m,
    });
    const empty = await screen.findByTestId("providers-empty");
    expect(empty.textContent).toMatch(/No providers are set up/);
    await user.click(
      within(empty).getByRole("button", { name: "Add a provider" }),
    );
    expect(store.getState().ui.showDialog).toBe(true);
    const props = store.getState().ui.dialogMessage?.props;
    expect(props.initialProvider).toBeUndefined();
    expect(props.initialConnection).toBeUndefined();
  });

  it("Manage models opens the flow at the model checklist of that connection", async () => {
    const { user, store } = await renderWithProviders(<ModelsSection />, {
      mockIdeMessenger: messenger().m,
    });
    await user.click(
      within(await row("bedrock")).getByRole("button", {
        name: "Manage models",
      }),
    );
    expect(store.getState().ui.dialogMessage?.props).toMatchObject({
      initialProvider: "bedrock",
      initialConnection: { region: "us-east-1", profile: "work" },
      initialStep: "models",
    });
  });

  it("Edit connection opens the flow at the credentials", async () => {
    const { user, store } = await renderWithProviders(<ModelsSection />, {
      mockIdeMessenger: messenger().m,
    });
    await user.click(
      within(await row("openai")).getByRole("button", {
        name: "Edit connection",
      }),
    );
    expect(store.getState().ui.dialogMessage?.props).toMatchObject({
      initialProvider: "openai",
      initialConnection: { apiBase: "http://localhost:1234/v1" },
      initialStep: "credentials",
    });
  });

  it("Test connection opens the first model's settings, as the palette command does", async () => {
    const { user, store } = await renderWithProviders(<ModelsSection />, {
      mockIdeMessenger: messenger().m,
    });
    await user.click(
      within(await row("anthropic")).getByRole("button", {
        name: "Test connection",
      }),
    );
    expect(store.getState().ui.showDialog).toBe(true);
    expect(store.getState().ui.dialogMessage?.props.title).toBe("Opus");
  });

  it("Remove says what leaves config.yaml and that keys stay, and sends only after confirming", async () => {
    const { m, sent } = messenger();
    const { user } = await renderWithProviders(<ModelsSection />, {
      mockIdeMessenger: m,
    });
    await user.click(
      within(await row("anthropic")).getByRole("button", { name: "Remove" }),
    );
    const confirm = screen.getByTestId("remove-provider-confirm");
    expect(confirm.textContent).toContain(
      "Remove Anthropic (Account anthropic-work)?",
    );
    expect(confirm.textContent).toContain(
      "This takes its 2 models (Opus, Sonnet) out of config.yaml and out of the mode model lists.",
    );
    expect(confirm.textContent).toContain(
      "The account anthropic-work in ~/.continuous/providers.yaml and its catalog models stay",
    );
    expect(confirm.textContent).toContain(
      "Stored keys are not deleted: CONTINUOUS_ANTHROPIC_API_KEY stays in secure storage.",
    );
    expect(sent).toEqual([]);

    await user.click(
      within(confirm).getByRole("button", { name: "Remove from config" }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].data).toEqual({
      provider: "anthropic",
      connection: {},
      account: "anthropic-work",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("remove-provider-confirm")).toBeNull(),
    );
  });

  it("Remove can be cancelled, and shows core's error", async () => {
    const { m, sent } = messenger();
    m.responseHandlers["config/removeProviderConnection"] = async (data) => {
      sent.push({ type: "remove", data });
      return {
        removed: [],
        error: "The selected config is not a local YAML file",
      };
    };
    const { user } = await renderWithProviders(<ModelsSection />, {
      mockIdeMessenger: m,
    });
    const bedrock = await row("bedrock");
    await user.click(within(bedrock).getByRole("button", { name: "Remove" }));
    await user.click(
      within(screen.getByTestId("remove-provider-confirm")).getByRole(
        "button",
        { name: "Cancel" },
      ),
    );
    expect(sent).toEqual([]);

    await user.click(within(bedrock).getByRole("button", { name: "Remove" }));
    await user.click(
      screen.getByRole("button", { name: "Remove from config" }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /not a local YAML file/,
    );
    expect(sent[0].data).toEqual({
      provider: "bedrock",
      connection: { region: "us-east-1", profile: "work" },
    });
  });
});

describe("Providers merged into Models", () => {
  it("is no longer a tab; Models is first", () => {
    const ids = getAllTabs()
      .filter((t) => !t.action)
      .map((t) => t.id);
    expect(ids).not.toContain("providers");
    expect(ids).toEqual([
      "models",
      "tools",
      "permissions",
      "rules",
      "configs",
      "general",
      "help",
    ]);
    expect(topTabSections.find((s) => s.id === "blocks")!.tabs[0].id).toBe(
      "models",
    );
    expect(CONFIG_ROUTES.PROVIDERS).toBe(
      "/config?tab=models&section=connections",
    );
  });

  it("the old Providers link opens Models, with the connections on it", async () => {
    await renderWithProviders(<ConfigPage />, {
      mockIdeMessenger: messenger().m,
      routerProps: { initialEntries: ["/config?tab=providers"] } as never,
    });
    const tab = screen.getByRole("tab", { name: "Models" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "Providers" })).toBeNull();
    expect(await row("anthropic")).toBeTruthy();
    expect(screen.getByTestId("models-connections").textContent).toContain(
      "Connections",
    );
    expect(screen.getByRole("heading", { name: "Models" })).toBeTruthy();
  });

  it("the link the product itself uses lands on the same place", async () => {
    await renderWithProviders(<ConfigPage />, {
      mockIdeMessenger: messenger().m,
      routerProps: { initialEntries: [CONFIG_ROUTES.PROVIDERS] } as never,
    });
    expect(
      screen.getByRole("tab", { name: "Models" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(await row("bedrock")).toBeTruthy();
  });

  it("shows In use, then Connections, then four folds, and no card that links away", async () => {
    await renderWithProviders(<ModelsSection />, {
      mockIdeMessenger: messenger().m,
    });
    await row("anthropic");
    expect(screen.getByRole("heading", { name: "In use" })).toBeTruthy();
    expect(screen.queryByTestId("open-providers")).toBeNull();
    expect(screen.queryByText("Providers…")).toBeNull();
    const folds = [...document.querySelectorAll("[data-testid^=fold-toggle-]")];
    expect(folds.map((f) => f.getAttribute("data-testid"))).toEqual([
      "fold-toggle-modes",
      "fold-toggle-roles",
      "fold-toggle-accounts",
      "fold-toggle-model-information",
    ]);
    for (const f of folds)
      expect(f.getAttribute("aria-expanded")).toBe("false");
    // In use comes before Connections, which comes before the folds
    const inUse = screen.getByRole("heading", { name: "In use" });
    const connections = screen.getByTestId("models-connections");
    expect(
      inUse.compareDocumentPosition(connections) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      connections.compareDocumentPosition(folds[0]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Each part of the two old pages is here once
    expect(screen.getAllByText("Connections")).toHaveLength(1);
    expect(screen.getAllByText("Provider accounts")).toHaveLength(1);
    expect(screen.getAllByText("Additional model roles")).toHaveLength(1);
  });

  it("each fold header is one line of real state", async () => {
    const { m } = messenger();
    m.responseHandlers["providers/list"] = async () =>
      ({
        instances: [
          {
            name: "anthropic-work",
            provider: "anthropic",
            key: { state: "none" },
            source: "global",
            sourceUri: "",
            usedBy: [],
          },
          {
            name: "strata",
            provider: "openai",
            key: { state: "none" },
            source: "global",
            sourceUri: "",
            usedBy: [],
          },
        ],
        globalFileUri: "file:///home/u/.continuous/providers.yaml",
        secureStorageAvailable: true,
      }) as never;
    m.responseHandlers["modelCatalog/status"] = async () => ({
      policy: "automatic",
      refreshHours: 24,
      openrouter: { fetchedAt: "2026-11-20T08:30:00.000Z", count: 300 },
    });
    await renderWithProviders(<ModelsSection />, { mockIdeMessenger: m });
    await row("anthropic");
    await act(async () => {});
    const summary = (id: string) =>
      screen.getByTestId(`fold-summary-${id}`).textContent;
    expect(summary("modes")).toBe(
      "Not set: no mode has a model of its own, so each uses the Chat model selected above",
    );
    expect(summary("roles")).toBe(
      "Apply: not set. Embed: not set. Rerank: not set",
    );
    await waitFor(() =>
      expect(summary("accounts")).toBe(
        "2 accounts in providers.yaml: anthropic-work, strata",
      ),
    );
    await waitFor(() =>
      expect(summary("model-information")).toBe(
        "Automatic, every 24 hours. Last pulled 2026-11-20",
      ),
    );
  });

  it("?section=accounts opens the Accounts fold", async () => {
    await renderWithProviders(<ModelsSection />, {
      mockIdeMessenger: messenger().m,
      routerProps: {
        initialEntries: ["/config?tab=models&section=accounts"],
      } as never,
    });
    expect(
      screen.getByTestId("fold-toggle-accounts").getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("the Models folds' one-line state", () => {
  it("models per mode: each mode's own model, then how many have none", () => {
    expect(
      modeModelsSummary({
        modeModels: {
          plan: { title: "Claude Sonnet" },
          agent: { title: "Qwen", titles: ["Qwen", "Claude Sonnet"] },
          loop: { prompt: "short" },
        },
      } as never),
    ).toBe("Plan: Claude Sonnet. Agent: Qwen. 4 not set");
    expect(modeModelsSummary({ modeModels: undefined } as never)).toMatch(
      /^Not set: no mode has a model of its own/,
    );
  });

  it("roles: the model of each role, the reviewer only while auto approval is on", () => {
    const selected = {
      apply: { title: "Fast Apply" },
      embed: null,
      rerank: null,
      reviewer: { title: "Haiku" },
    };
    expect(
      rolesSummary({
        selectedModelByRole: selected,
        experimental: {},
      } as never),
    ).toBe("Apply: Fast Apply. Embed: not set. Rerank: not set");
    expect(
      rolesSummary({
        selectedModelByRole: selected,
        experimental: { enableAutoApproval: true },
      } as never),
    ).toBe(
      "Apply: Fast Apply. Embed: not set. Rerank: not set. Reviewer: Haiku",
    );
  });

  it("accounts: none, a few, many, and not read yet", () => {
    expect(accountsSummary(undefined)).toBe("Reading providers.yaml…");
    expect(accountsSummary([])).toBe(
      "Not set: no account in providers.yaml. A connection keeps its own address and key",
    );
    expect(accountsSummary(["a"])).toBe("1 account in providers.yaml: a");
    expect(accountsSummary(["a", "b", "c", "d", "e"])).toBe(
      "5 accounts in providers.yaml: a, b, c and 2 more",
    );
  });

  it("model information: the policy, the interval and the last pull", () => {
    expect(modelInformationSummary(undefined)).toBe("Reading the setting…");
    expect(
      modelInformationSummary({ policy: "automatic", refreshHours: 1 }),
    ).toBe(
      "Automatic, every 1 hour. Not pulled yet: the bundled model data is used",
    );
    expect(
      modelInformationSummary({
        policy: "ask",
        refreshHours: 24,
        openrouter: { fetchedAt: "2026-11-02T23:59:00Z", count: 1 },
      }),
    ).toBe("Only when you ask. Last pulled 2026-11-02");
    expect(modelInformationSummary({ policy: "off", refreshHours: 24 })).toBe(
      "Off: openrouter.ai is never contacted. The bundled model data is used",
    );
  });
});
