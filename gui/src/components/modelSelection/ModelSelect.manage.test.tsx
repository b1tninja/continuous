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
