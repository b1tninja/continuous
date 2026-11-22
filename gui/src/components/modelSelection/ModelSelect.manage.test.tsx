import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import ModelSelect from "./ModelSelect";

const model = (title: string, extra: Record<string, unknown> = {}) =>
  ({
    title,
    model: title,
    provider: "bedrock-mantle",
    underlyingProvider: "bedrock-mantle",
    underlyingProviderName: "bedrock-mantle",
    configurationStatus: "valid",
    ...extra,
  }) as any;

async function setup(
  models: any[],
  selected: any,
  connections: unknown[] | "fail" = [],
) {
  const ideMessenger = new MockIdeMessenger();
  if (connections !== "fail") {
    ideMessenger.responses["config/getProviderSetup"] = {
      connections,
      secureStorageAvailable: false,
    } as any;
  }
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(<ModelSelect />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: models },
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: selected,
        },
      }),
    );
  });
  await view.user.click(screen.getByTestId("model-select-button"));
  return { ...view, store };
}

describe("model picker: window unknown", () => {
  it("tags a model with no known context window", async () => {
    const m = model("Daybreak", { contextLengthSource: "unknown" });
    await setup([m], m);
    expect(screen.getByTestId("model-option-window-unknown")).toBeTruthy();
  });

  it("does not tag a model whose window is known", async () => {
    const m = model("Opus", { contextLengthSource: "config" });
    await setup([m], m);
    expect(screen.queryByTestId("model-option-window-unknown")).toBeNull();
  });
});

describe("model picker: the window a local server reported", () => {
  const local = (extra: Record<string, unknown>) =>
    model("Llama 3.1 8B", {
      provider: "ollama",
      underlyingProviderName: "ollama",
      model: "llama3.1:8b",
      ...extra,
    });

  it("gives the number and where it came from", async () => {
    const m = local({ contextLength: 4096, contextLengthSource: "provider" });
    await setup([m], m);
    const tag = screen.getByTestId("model-option-server-window");
    expect(tag.textContent).toBe("(4,096 tokens, from the server)");
    expect(screen.queryByTestId("model-option-window-unknown")).toBeNull();
  });

  it("appears when a config update brings the learned window", async () => {
    const before = local({
      contextLength: 131072,
      contextLengthSource: "published",
    });
    const { store } = await setup([before], before);
    expect(screen.queryByTestId("model-option-server-window")).toBeNull();

    const after = local({
      contextLength: 4096,
      contextLengthSource: "provider",
    });
    await act(async () => {
      store.dispatch(
        updateConfig({
          ...EMPTY_CONFIG,
          modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [after] },
          selectedModelByRole: {
            ...EMPTY_CONFIG.selectedModelByRole,
            chat: after,
          },
        }),
      );
    });
    expect(
      screen.getByTestId("model-option-server-window").textContent,
    ).toContain("4,096");
  });

  it("says nothing for a window the person set or a cloud provider reported", async () => {
    const set = local({ contextLength: 16384, contextLengthSource: "config" });
    const cloud = model("Opus", {
      contextLength: 200000,
      contextLengthSource: "provider",
    });
    await setup([set, cloud], set);
    expect(screen.queryByTestId("model-option-server-window")).toBeNull();
  });
});

describe("model picker: Add a model", () => {
  it("opens the setup flow at its start screen, whatever the current model", async () => {
    const m = model("Daybreak");
    const { user, store } = await setup([m], m, [
      {
        provider: "bedrock-mantle",
        connection: { region: "us-east-2" },
        models: [{ name: "Daybreak", model: "openai.gpt-daybreak" }],
      },
    ]);
    await user.click(screen.getByText("Add a model..."));
    await waitFor(() => expect(store.getState().ui.showDialog).toBe(true));
    // No provider, connection or step: the flow asks what the person has
    const props = store.getState().ui.dialogMessage?.props;
    expect(props.initialProvider).toBeUndefined();
    expect(props.initialConnection).toBeUndefined();
    expect(props.initialStep).toBeUndefined();
  });
});

describe("model picker: Manage models", () => {
  const connection = {
    provider: "bedrock-mantle",
    connection: { region: "us-east-2" },
    models: [{ name: "Daybreak", model: "openai.gpt-daybreak" }],
  };

  it("opens the setup flow on the model checklist of the current model's connection", async () => {
    const m = model("Daybreak");
    const { user, store } = await setup([m], m, [connection]);
    await user.click(screen.getByText("Manage models..."));
    await waitFor(() =>
      expect(store.getState().ui.dialogMessage?.props).toMatchObject({
        initialProvider: "bedrock-mantle",
        initialConnection: { region: "us-east-2" },
        initialStep: "models",
      }),
    );
  });

  it("opens the plain add-provider flow when no connection lists the model", async () => {
    const m = model("Unlisted");
    const { user, store } = await setup([m], m, [connection]);
    await user.click(screen.getByText("Manage models..."));
    await waitFor(() => expect(store.getState().ui.showDialog).toBe(true));
    const props = store.getState().ui.dialogMessage?.props;
    expect(props.initialConnection).toBeUndefined();
    expect(props.initialStep).toBeUndefined();
  });

  it("falls back to the plain flow when the setup lookup fails", async () => {
    const m = model("Daybreak");
    const { user, store } = await setup([m], m, "fail");
    await user.click(screen.getByText("Manage models..."));
    await waitFor(() => expect(store.getState().ui.showDialog).toBe(true));
    expect(store.getState().ui.dialogMessage?.props.initialConnection).toBe(
      undefined,
    );
  });
});
