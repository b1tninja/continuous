import { screen, waitFor, within } from "@testing-library/react";
import type { ProviderSetupInfo } from "core/config/providerSetup";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { CONFIG_ROUTES } from "../../../util/navigation";
import { renderWithProviders } from "../../../util/test/render";
import ConfigPage from "../index";
import { topTabSections } from "../configTabs";
import { ProvidersSection } from "./ProvidersSection";

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

describe("Settings > Providers", () => {
  it("lists each configured connection with its auth kind and model count, and no key", async () => {
    await renderWithProviders(<ProvidersSection />, {
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
    const { user, store } = await renderWithProviders(<ProvidersSection />, {
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
    const { user, store } = await renderWithProviders(<ProvidersSection />, {
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
    const { user, store } = await renderWithProviders(<ProvidersSection />, {
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
    const { user, store } = await renderWithProviders(<ProvidersSection />, {
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
    const { user } = await renderWithProviders(<ProvidersSection />, {
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
    const { user } = await renderWithProviders(<ProvidersSection />, {
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

describe("Providers in the Settings navigation", () => {
  it("is a tab right after Models, at /config?tab=providers", () => {
    const blocks = topTabSections.find((s) => s.id === "blocks")!;
    const ids = blocks.tabs.map((t) => t.id);
    expect(ids.slice(0, 2)).toEqual(["models", "providers"]);
    expect(blocks.tabs[1].label).toBe("Providers");
    expect(CONFIG_ROUTES.PROVIDERS).toBe("/config?tab=providers");
  });

  it("opens the Providers page from the route", async () => {
    await renderWithProviders(<ConfigPage />, {
      mockIdeMessenger: messenger().m,
      routerProps: { initialEntries: [CONFIG_ROUTES.PROVIDERS] } as never,
    });
    const tab = screen.getByRole("tab", { name: "Providers" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(await row("anthropic")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Providers" })).toBeTruthy();
  });
});
